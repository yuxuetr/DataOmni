//! DuckDB：进程内的分析库，libduckdb 编进可执行文件（`duckdb` crate 的 `bundled`）。
//!
//! 和 Oracle 一样由后端自己持有库（见 [`crate::services::pool_registry`]），不同的是：
//!
//! - **没有网络。** 一个文件就是一个库；连上就是打开它，打开着就占着文件锁。
//!   锁是进程级、排他的：另一个进程以读写打开着，这边只读也打不开（实验：报
//!   「Could not set lock on file … Conflicting lock is held in <程序> (PID n)」）。
//!   所以断开时要真的关掉库——池子里的根连接和每条会话连接都 drop 之后锁才还回去。
//! - **结果要流式读。** `query()` 把整个结果在客户端物化，`SELECT * FROM 'big.parquet'`
//!   能把内存吃光。这里 `stream_arrow` 执行、丢掉它的迭代器（取数出错时 panic），
//!   再用 `raw_query()` 逐行读（返回错误）。
//! - **没有公开的「语句类型」。** 非查询语句流式执行也给结果集：DDL 是一列 `Count`
//!   零行，DML 是一行 `Count`，`SET` 是 `Success`。所以按开头的关键字分，见
//!   [`statement_kind`]。
//! - **取消是真的取消，而且连接还能用。** 执行的 future 被丢掉时从别的线程
//!   `interrupt()`，那条语句报「INTERRUPT Error」停下（实验：CPU 密集的查询 0.5 秒）。
//!
//! 事务语义和 PostgreSQL 一样：事务里一条出错，之后只能回滚；DDL 在事务里。
//! 状态从语句推出来（`TransactionState`），不问服务端——没有可问的。

use crate::services::query_error::QueryErrorDetails;
use crate::services::query_error::{CONNECTION_LOST, CONNECTION_LOST_CODE};
use crate::services::query_executor::{
  admit_row_bytes, flush_full_batch, flush_remaining_batch, number_duplicate_columns, tagged_value,
  QueryColumnMetadata, QueryExecutionSummary, QueryResultBatch, QueryRow, QueryTruncationReason,
  StreamOptions,
};
use crate::services::write_batch::{
  WriteBatchError, WriteStatement, ROW_COUNT_MISMATCH, ROW_COUNT_MISMATCH_CODE,
};
use crate::services::QueryError;
use duckdb::core::{LogicalTypeHandle, LogicalTypeId};
use duckdb::types::{TimeUnit, Value};
use duckdb::{Connection, InterruptHandle};
use serde_json::{Map, Value as JsonValue};
use std::sync::{Arc, Mutex};

pub type DuckDbRegistry = crate::services::pool_registry::PoolRegistry<DuckDbPool>;

/// 连接串的 scheme，后面跟的是文件路径（或 `:memory:`）。前端据此认出这条连接归后端管
pub const DUCKDB_SCHEME: &str = "duckdb:";

/// 文件被另一个进程锁着。数据是 DuckDB 报的持有者：`<程序> (PID n)`
pub const DUCKDB_FILE_LOCKED: &str = "DATAOMNI_DUCKDB_FILE_LOCKED";

/// 连接或会话的锁拿不到——上一次持有它的线程 panic 了
const CONNECTION_POISONED: &str = "DuckDB connection lock poisoned";

/// 打开一个库。文件不存在时 DuckDB 会建一个，和 SQLite 那一格的行为一致。
pub async fn open(path: &str) -> Result<Arc<DuckDbPool>, QueryError> {
  let path = path.to_string();
  blocking(move || {
    let connection =
      if path == ":memory:" { Connection::open_in_memory() } else { Connection::open(&path) }
        .map_err(|error| query_error(&error, None))?;
    Ok(Arc::new(DuckDbPool { root: Mutex::new(connection) }))
  })
  .await
}

/// 跑一段阻塞的驱动调用。线程池那一侧 panic 了也要变成一条错误——
/// 不然这次调用永远不回来
async fn blocking<T: Send + 'static>(
  work: impl FnOnce() -> Result<T, QueryError> + Send + 'static,
) -> Result<T, QueryError> {
  tokio::task::spawn_blocking(work).await.map_err(|error| {
    QueryError::with_code(CONNECTION_LOST_CODE, format!("{CONNECTION_LOST}: {error}"))
  })?
}

/// 一个打开着的库。
///
/// 只存一条根连接：其余的（会话、目录查询、写入）都从它 `try_clone`——同一个库
/// 上再开一条连接不碰文件，是微秒级的事。驱动的 `Connection` 能跨线程移动但不能
/// 共享，所以包一把锁。
pub struct DuckDbPool {
  root: Mutex<Connection>,
}

impl DuckDbPool {
  fn clone_connection(&self) -> Result<Connection, QueryError> {
    let root = self.root.lock().map_err(|_| QueryError::message(CONNECTION_POISONED))?;
    root.try_clone().map_err(|error| query_error(&error, None))
  }

  /// 给一个会话用的连接。它上面的事务、`SET`、`USE`、临时表都只属于这个会话
  pub fn acquire_for_session(&self) -> Result<DuckDbConnection, QueryError> {
    let connection = self.clone_connection()?;
    let interrupt = connection.interrupt_handle();
    Ok(DuckDbConnection { connection: Arc::new(Mutex::new(connection)), interrupt })
  }

  /// 目录查询：带 `$1`、`$2` 绑定参数，返回**不带类型标签**的值，和插件 `select`
  /// 的形状一样。结果都很小，照常物化
  pub async fn select(
    self: &Arc<Self>,
    sql: &str,
    params: &[JsonValue],
  ) -> Result<Vec<QueryRow>, QueryError> {
    let connection = self.clone_connection()?;
    let sql = sql.to_string();
    let params = bind_values(params)?;
    blocking(move || select_rows(&connection, &sql, params)).await
  }

  /// 一批写入，一个事务，要么全成要么全不成。约定与 `write_batch::execute_write_batch`
  /// 相同：每条语句可以要求恰好影响几行，对不上整批回滚；出错的标在那一条上，
  /// 提交失败标在 `statements.len()`。
  pub async fn write_batch(
    self: &Arc<Self>,
    statements: &[WriteStatement],
  ) -> Result<Vec<u64>, WriteBatchError> {
    if statements.is_empty() {
      return Ok(Vec::new());
    }
    let connection = self.clone_connection().map_err(|error| WriteBatchError::at(0, error))?;
    let mut batch = Vec::with_capacity(statements.len());
    for (index, statement) in statements.iter().enumerate() {
      let params =
        bind_values(&statement.params).map_err(|error| WriteBatchError::at(index, error))?;
      batch.push((statement.sql.clone(), params, statement.expect_rows));
    }
    blocking(move || Ok(write_in_transaction(&connection, &batch)))
      .await
      .map_err(|error| WriteBatchError::at(0, error))?
      .map_err(|(index, error)| WriteBatchError::at(index, error))
  }
}

fn write_in_transaction(
  connection: &Connection,
  batch: &[(String, Vec<Value>, Option<u64>)],
) -> Result<Vec<u64>, (usize, QueryError)> {
  connection.execute_batch("BEGIN TRANSACTION").map_err(|error| (0, query_error(&error, None)))?;
  let mut affected = Vec::with_capacity(batch.len());
  for (index, (sql, params, expect_rows)) in batch.iter().enumerate() {
    let step = || -> Result<u64, QueryError> {
      let mut prepared = connection.prepare(sql).map_err(|error| query_error(&error, Some(sql)))?;
      let rows = prepared
        .execute(duckdb::params_from_iter(params.iter()))
        .map_err(|error| query_error(&error, Some(sql)))? as u64;
      if let Some(expected) = expect_rows {
        if rows != *expected {
          return Err(QueryError::with_code(
            ROW_COUNT_MISMATCH_CODE,
            format!("{ROW_COUNT_MISMATCH}: {expected} · {rows}"),
          ));
        }
      }
      Ok(rows)
    };
    match step() {
      Ok(rows) => affected.push(rows),
      Err(error) => {
        let _ = connection.execute_batch("ROLLBACK");
        return Err((index, error));
      }
    }
  }
  connection.execute_batch("COMMIT").map_err(|error| {
    let _ = connection.execute_batch("ROLLBACK");
    (batch.len(), query_error(&error, None))
  })?;
  Ok(affected)
}

fn select_rows(
  connection: &Connection,
  sql: &str,
  params: Vec<Value>,
) -> Result<Vec<QueryRow>, QueryError> {
  let mut prepared = connection.prepare(sql).map_err(|error| query_error(&error, Some(sql)))?;
  let mut rows = prepared
    .query(duckdb::params_from_iter(params.iter()))
    .map_err(|error| query_error(&error, Some(sql)))?;
  let mut columns: Option<Vec<(String, LogicalTypeId)>> = None;
  let mut result = Vec::new();
  while let Some(row) = rows.next().map_err(|error| query_error(&error, Some(sql)))? {
    let columns = match &columns {
      Some(columns) => columns,
      None => columns.insert(result_columns(row.as_ref())),
    };
    let mut values = Map::new();
    for (index, (name, type_id)) in columns.iter().enumerate() {
      let value: Value = row.get(index).map_err(|error| query_error(&error, None))?;
      values.insert(name.clone(), untagged(decode(&value, *type_id)));
    }
    result.push(values);
  }
  Ok(result)
}

/// 已执行的语句的列：名字（同名的编上号）与逻辑类型
fn result_columns(statement: &duckdb::Statement<'_>) -> Vec<(String, LogicalTypeId)> {
  let names = statement.column_names();
  let labels = number_duplicate_columns(names.iter().map(String::as_str));
  labels
    .into_iter()
    .enumerate()
    .map(|(index, name)| (name, statement.column_logical_type(index).id()))
    .collect()
}

/// 绑定参数：只认标量，理由同 `write_batch` 的 `bind_params!`
fn bind_values(params: &[JsonValue]) -> Result<Vec<Value>, QueryError> {
  params
    .iter()
    .map(|param| match param {
      JsonValue::Null => Ok(Value::Null),
      JsonValue::Bool(value) => Ok(Value::Boolean(*value)),
      JsonValue::Number(number) => Ok(match number.as_i64() {
        Some(integer) => Value::BigInt(integer),
        None => Value::Double(number.as_f64().unwrap_or(f64::NAN)),
      }),
      JsonValue::String(text) => Ok(Value::Text(text.clone())),
      other => Err(QueryError::message(format!(
        "{}: {other}",
        crate::services::write_batch::UNSUPPORTED_PARAMETER_TYPE
      ))),
    })
    .collect()
}

/// 插件的解码器返回的是裸值；我们的解码器给精度敏感的类型挂了标签
fn untagged(value: JsonValue) -> JsonValue {
  match value {
    JsonValue::Object(mut map) if map.contains_key("type") => {
      map.remove("value").unwrap_or(JsonValue::Null)
    }
    other => other,
  }
}

/// 一个会话的连接。
///
/// 连接放在锁里跨线程共享：执行时阻塞线程持有它，异步这一侧只留着打断用的句柄。
/// future 被丢掉（超时、取消）时打断那条语句，阻塞线程随即放开锁，下一条语句
/// 还是这条连接——事务、`SET` 都还在。和 Oracle 不同，不用丢掉连接重连。
pub struct DuckDbConnection {
  connection: Arc<Mutex<Connection>>,
  interrupt: Arc<InterruptHandle>,
}

/// future 被丢掉时（超时、取消）打断正在跑的那条语句
struct InterruptOnDrop {
  handle: Arc<InterruptHandle>,
  finished: bool,
}

impl Drop for InterruptOnDrop {
  fn drop(&mut self) {
    if !self.finished {
      self.handle.interrupt();
    }
  }
}

/// 阻塞那一侧送过来的东西
enum Fetched {
  Columns(Vec<QueryColumnMetadata>, Vec<String>),
  Row(QueryRow),
}

impl DuckDbConnection {
  pub async fn execute_streaming(
    &mut self,
    sql: &str,
    options: StreamOptions,
    sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
  ) -> Result<QueryExecutionSummary, QueryError> {
    let statement = sql.trim().to_string();
    let kind = statement_kind(&statement);
    if kind == StatementKind::NonQuery
      && options.non_query == crate::services::NonQueryHandling::Refuse
    {
      return Err(QueryError::message(crate::services::query_executor::NON_QUERY_MESSAGE));
    }

    // 通道留几批的余量：阻塞那一侧可以先读着，异步这一侧到了上限就丢掉接收端，
    // 那一侧下一次送不出去就停
    let (sender, mut receiver) =
      tokio::sync::mpsc::channel::<Fetched>(options.batch_size.max(1) * 2);
    let mut guard = InterruptOnDrop { handle: Arc::clone(&self.interrupt), finished: false };
    let worker = Arc::clone(&self.connection);
    let task = tokio::task::spawn_blocking(move || {
      let connection = worker.lock().map_err(|_| QueryError::message(CONNECTION_POISONED))?;
      run_statement(&connection, &statement, kind, &sender)
    });

    let mut header: Option<(Vec<QueryColumnMetadata>, Vec<String>)> = None;
    let mut rows = Vec::with_capacity(options.batch_size);
    let mut row_count = 0;
    let mut batch_count = 0;
    let mut bytes_read: usize = 0;
    let mut truncation_reason = None;
    let mut sink_error = None;

    while let Some(fetched) = receiver.recv().await {
      match fetched {
        Fetched::Columns(metadata, names) => header = Some((metadata, names)),
        Fetched::Row(values) => {
          if row_count >= options.row_limit {
            truncation_reason = Some(QueryTruncationReason::RowLimit);
            break;
          }
          match admit_row_bytes(&values, options.byte_limit, &mut bytes_read) {
            Ok(true) => {}
            Ok(false) => {
              truncation_reason = Some(QueryTruncationReason::ByteLimit);
              break;
            }
            Err(error) => {
              sink_error = Some(error);
              break;
            }
          }
          rows.push(values);
          row_count += 1;
          if let Err(error) =
            flush_full_batch(&mut rows, options.batch_size, &mut batch_count, row_count, sink)
          {
            sink_error = Some(error);
            break;
          }
        }
      }
    }
    // 到了上限就不再要：接收端一丢，阻塞那一侧下一次送不出去就停下
    drop(receiver);
    let outcome = task.await.map_err(|error| {
      QueryError::with_code(CONNECTION_LOST_CODE, format!("{CONNECTION_LOST}: {error}"))
    })?;
    guard.finished = true;

    if let Some(error) = sink_error {
      return Err(error);
    }
    if let Some(affected) = outcome? {
      return Ok(QueryExecutionSummary::Affected { rows_affected: affected });
    }
    let Some((column_metadata, columns)) = header else {
      return Ok(QueryExecutionSummary::Affected { rows_affected: 0 });
    };
    flush_remaining_batch(&mut rows, &mut batch_count, row_count, sink)?;
    Ok(QueryExecutionSummary::Rows {
      columns,
      column_metadata,
      row_count,
      batch_count,
      truncated: truncation_reason.is_some(),
      truncation_reason,
      row_limit: options.row_limit,
      byte_limit: options.byte_limit,
      bytes_read,
    })
  }

  /// 同一条语句按多行参数执行（CSV 导入走这里），返回影响行数。`params` 按语句的
  /// 绑定个数一行接一行地排；值一律按文本绑，由 DuckDB 转成列的类型
  pub async fn execute_with_params(
    &mut self,
    sql: &str,
    params: &[Option<String>],
  ) -> Result<u64, QueryError> {
    let mut guard = InterruptOnDrop { handle: Arc::clone(&self.interrupt), finished: false };
    let worker = Arc::clone(&self.connection);
    let sql = sql.to_string();
    let params: Vec<Value> =
      params.iter().map(|value| value.clone().map_or(Value::Null, Value::Text)).collect();
    let outcome = blocking(move || {
      let connection = worker.lock().map_err(|_| QueryError::message(CONNECTION_POISONED))?;
      let mut prepared =
        connection.prepare(&sql).map_err(|error| query_error(&error, Some(&sql)))?;
      let width = prepared.parameter_count();
      if width == 0 || !params.len().is_multiple_of(width) {
        return Err(QueryError::message(format!(
          "{} parameters do not fill rows of the statement's {width} binds",
          params.len()
        )));
      }
      let mut affected = 0u64;
      for row in params.chunks_exact(width) {
        affected += prepared
          .execute(duckdb::params_from_iter(row.iter()))
          .map_err(|error| query_error(&error, None))? as u64;
      }
      Ok(affected)
    })
    .await;
    guard.finished = true;
    outcome
  }

  /// 只问「这条语句返回哪些列」，一行都不取（导出要先写表头）。
  ///
  /// 流式执行只把执行计划跑到能交出第一块为止，列信息随之就有了；不取就不往下算。
  /// 不是查询的语句不执行
  pub async fn describe_columns(
    &mut self,
    sql: &str,
  ) -> Result<Vec<QueryColumnMetadata>, QueryError> {
    let statement = sql.trim().to_string();
    if statement_kind(&statement) == StatementKind::NonQuery {
      return Ok(Vec::new());
    }
    let mut guard = InterruptOnDrop { handle: Arc::clone(&self.interrupt), finished: false };
    let worker = Arc::clone(&self.connection);
    let outcome = blocking(move || {
      let connection = worker.lock().map_err(|_| QueryError::message(CONNECTION_POISONED))?;
      let mut prepared =
        connection.prepare(&statement).map_err(|error| query_error(&error, Some(&statement)))?;
      drop(prepared.stream_arrow([]).map_err(|error| query_error(&error, Some(&statement)))?);
      Ok(column_header(&prepared).0)
    })
    .await;
    guard.finished = true;
    outcome
  }

  /// 一次没有结果集可言的执行（事务控制这类）
  pub async fn execute_batch(&mut self, sql: &str) -> Result<u64, QueryError> {
    let mut rows = Vec::new();
    let summary = self
      .execute_streaming(sql, StreamOptions::limited(1, 1 << 20, 1), &mut |batch| {
        rows.extend(batch.rows);
        Ok(())
      })
      .await?;
    Ok(match summary {
      QueryExecutionSummary::Affected { rows_affected } => rows_affected,
      QueryExecutionSummary::Rows { .. } => 0,
    })
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatementKind {
  Query,
  NonQuery,
}

/// 查询还是非查询。
///
/// DuckDB 的 C API 有语句类型，Rust 这层没有暴露出来；结果集的形状也分不开
/// （`INSERT` 给一行 `Count`，`SELECT count(*) AS "Count"` 也是）。所以按开头的
/// 关键字分：这些关键字开头的不是查询，其余的都当查询——`SHOW`、`DESCRIBE`、
/// `PRAGMA`、`CALL`、`EXPLAIN`、`SUMMARIZE`、`FROM t`（DuckDB 允许省掉 SELECT）
/// 都返回行。
///
/// 带 `RETURNING` 的 DML 返回的是真正的列，当查询。`WITH … INSERT` 这种写法当查询
/// 走，结果是一行 `Count`——看起来怪，但不丢东西。
fn statement_kind(sql: &str) -> StatementKind {
  let (first, _) = crate::services::transaction_state::leading_keywords(sql);
  let non_query = matches!(
    first.as_str(),
    "INSERT"
      | "UPDATE"
      | "DELETE"
      | "MERGE"
      | "TRUNCATE"
      | "CREATE"
      | "DROP"
      | "ALTER"
      | "COMMENT"
      | "SET"
      | "RESET"
      | "USE"
      | "BEGIN"
      | "START"
      | "COMMIT"
      | "END"
      | "ROLLBACK"
      | "ABORT"
      | "SAVEPOINT"
      | "RELEASE"
      | "CHECKPOINT"
      | "FORCE"
      | "VACUUM"
      | "ANALYZE"
      | "ATTACH"
      | "DETACH"
      | "INSTALL"
      | "LOAD"
      | "COPY"
      | "EXPORT"
      | "IMPORT"
      | "PREPARE"
      | "DEALLOCATE"
  );
  if non_query && !has_returning(sql) {
    StatementKind::NonQuery
  } else {
    StatementKind::Query
  }
}

/// 语句里有没有 `RETURNING` 这个词（引号与注释里的不算）。只在 DML 上问，
/// 不必懂语法：别的位置上出现这个关键字本来就是语法错误
fn has_returning(sql: &str) -> bool {
  let mut words = Vec::new();
  let mut chars = sql.chars().peekable();
  let mut word = String::new();
  while let Some(c) = chars.next() {
    match c {
      '\'' | '"' => {
        let quote = c;
        while let Some(inner) = chars.next() {
          if inner == quote {
            if chars.peek() == Some(&quote) {
              chars.next();
            } else {
              break;
            }
          }
        }
      }
      '-' if chars.peek() == Some(&'-') => {
        for inner in chars.by_ref() {
          if inner == '\n' {
            break;
          }
        }
      }
      '/' if chars.peek() == Some(&'*') => {
        chars.next();
        let mut previous = ' ';
        for inner in chars.by_ref() {
          if previous == '*' && inner == '/' {
            break;
          }
          previous = inner;
        }
      }
      c if c.is_alphanumeric() || c == '_' => {
        word.push(c);
        continue;
      }
      _ => {}
    }
    if !word.is_empty() {
      words.push(std::mem::take(&mut word));
    }
  }
  if !word.is_empty() {
    words.push(word);
  }
  words.iter().any(|word| word.eq_ignore_ascii_case("RETURNING"))
}

/// 执行一条语句（阻塞那一侧）。查询的行一行行送进通道
fn run_statement(
  connection: &Connection,
  statement: &str,
  kind: StatementKind,
  sender: &tokio::sync::mpsc::Sender<Fetched>,
) -> Result<Option<u64>, QueryError> {
  let mut prepared =
    connection.prepare(statement).map_err(|error| query_error(&error, Some(statement)))?;
  if kind == StatementKind::NonQuery {
    let affected =
      prepared.execute([]).map_err(|error| query_error(&error, Some(statement)))? as u64;
    return Ok(Some(affected));
  }
  drop(prepared.stream_arrow([]).map_err(|error| query_error(&error, Some(statement)))?);
  let (metadata, names) = column_header(&prepared);
  let type_ids: Vec<LogicalTypeId> =
    (0..names.len()).map(|index| prepared.column_logical_type(index).id()).collect();
  if sender.blocking_send(Fetched::Columns(metadata, names.clone())).is_err() {
    return Ok(None);
  }
  let mut rows = prepared.raw_query();
  while let Some(row) = rows.next().map_err(|error| query_error(&error, Some(statement)))? {
    let mut values = Map::new();
    for (index, (name, type_id)) in names.iter().zip(&type_ids).enumerate() {
      let value: Value = row.get(index).map_err(|error| query_error(&error, None))?;
      values.insert(name.clone(), decode(&value, *type_id));
    }
    if sender.blocking_send(Fetched::Row(values)).is_err() {
      break;
    }
  }
  Ok(None)
}

/// 结果集的列：同名的编上号，元数据与行里的键用的是同一份名字
fn column_header(statement: &duckdb::Statement<'_>) -> (Vec<QueryColumnMetadata>, Vec<String>) {
  let names = number_duplicate_columns(statement.column_names().iter().map(String::as_str));
  let metadata = names
    .iter()
    .enumerate()
    .map(|(ordinal, name)| {
      let logical = statement.column_logical_type(ordinal);
      QueryColumnMetadata {
        name: name.clone(),
        ordinal,
        database_type: type_name(&logical),
        logical_type: logical_type(logical.id()).to_string(),
        // 结果集不带可空性：DuckDB 的结果列类型里没有这一项
        nullable: None,
      }
    })
    .collect();
  (metadata, names)
}

/// 结果列头上显示的类型名，照 DuckDB 自己的写法（`DECIMAL(10,2)`、`INTEGER[]`）
fn type_name(logical: &LogicalTypeHandle) -> String {
  if let Some(alias) = logical.get_alias() {
    return alias.to_ascii_uppercase();
  }
  let id = logical.id();
  match id {
    LogicalTypeId::Decimal => {
      format!("DECIMAL({},{})", logical.decimal_width(), logical.decimal_scale())
    }
    LogicalTypeId::List | LogicalTypeId::Array if logical.num_children() == 1 => {
      format!("{}[]", type_name(&logical.child(0)))
    }
    LogicalTypeId::Struct => {
      let fields: Vec<String> = (0..logical.num_children())
        .map(|index| format!("{} {}", logical.child_name(index), type_name(&logical.child(index))))
        .collect();
      format!("STRUCT({})", fields.join(", "))
    }
    LogicalTypeId::TimestampTZ => "TIMESTAMP WITH TIME ZONE".to_string(),
    LogicalTypeId::TimeTZ => "TIME WITH TIME ZONE".to_string(),
    LogicalTypeId::TimestampS => "TIMESTAMP_S".to_string(),
    LogicalTypeId::TimestampMs => "TIMESTAMP_MS".to_string(),
    LogicalTypeId::TimestampNs => "TIMESTAMP_NS".to_string(),
    LogicalTypeId::UTinyint => "UTINYINT".to_string(),
    LogicalTypeId::USmallint => "USMALLINT".to_string(),
    LogicalTypeId::UInteger => "UINTEGER".to_string(),
    LogicalTypeId::UBigint => "UBIGINT".to_string(),
    LogicalTypeId::UHugeint => "UHUGEINT".to_string(),
    other => format!("{other:?}").to_ascii_uppercase(),
  }
}

fn logical_type(id: LogicalTypeId) -> &'static str {
  match id {
    LogicalTypeId::Boolean => "boolean",
    LogicalTypeId::Tinyint
    | LogicalTypeId::Smallint
    | LogicalTypeId::Integer
    | LogicalTypeId::Bigint
    | LogicalTypeId::UTinyint
    | LogicalTypeId::USmallint
    | LogicalTypeId::UInteger
    | LogicalTypeId::UBigint
    | LogicalTypeId::Hugeint
    | LogicalTypeId::UHugeint
    | LogicalTypeId::Bignum => "integer",
    LogicalTypeId::Float | LogicalTypeId::Double | LogicalTypeId::Decimal => "decimal",
    LogicalTypeId::Date => "date",
    LogicalTypeId::Time | LogicalTypeId::TimeTZ | LogicalTypeId::TimeNs => "time",
    LogicalTypeId::Timestamp
    | LogicalTypeId::TimestampS
    | LogicalTypeId::TimestampMs
    | LogicalTypeId::TimestampNs
    | LogicalTypeId::TimestampTZ => "datetime",
    LogicalTypeId::Blob | LogicalTypeId::Geometry => "binary",
    LogicalTypeId::List | LogicalTypeId::Array | LogicalTypeId::Struct | LogicalTypeId::Union => {
      "json"
    }
    // MAP 按 DuckDB 自己的写法显示（见 `map_text`），不是 JSON
    LogicalTypeId::Map
    | LogicalTypeId::Varchar
    | LogicalTypeId::Enum
    | LogicalTypeId::Uuid
    | LogicalTypeId::Interval
    | LogicalTypeId::Bit => "text",
    _ => "unknown",
  }
}

/// JavaScript 数能精确表示的最大整数
const MAX_SAFE_INTEGER: i128 = (1 << 53) - 1;

/// 一个单元格。约定和另外几家相同：超出安全整数的、小数、时间与二进制带类型
/// 标签，以文本传；其余是裸值。嵌套类型（LIST / STRUCT / MAP / UNION）整个写成
/// 一段 JSON 文本，标成 `json`。
fn decode(value: &Value, type_id: LogicalTypeId) -> JsonValue {
  match value {
    Value::Null => JsonValue::Null,
    Value::Boolean(value) => JsonValue::from(*value),
    Value::TinyInt(value) => JsonValue::from(*value),
    Value::SmallInt(value) => JsonValue::from(*value),
    Value::Int(value) => JsonValue::from(*value),
    Value::UTinyInt(value) => JsonValue::from(*value),
    Value::USmallInt(value) => JsonValue::from(*value),
    Value::UInt(value) => JsonValue::from(*value),
    Value::BigInt(value) => integer(i128::from(*value)),
    Value::UBigInt(value) => integer(i128::from(*value)),
    Value::HugeInt(value) => integer(*value),
    // u128 放不进 i128 的那一半本来就超出安全整数
    Value::UHugeInt(value) => match i128::try_from(*value) {
      Ok(value) => integer(value),
      Err(_) => tagged_value("bigint", value.to_string()),
    },
    Value::Float(value) => float(f64::from(*value)),
    Value::Double(value) => float(*value),
    Value::Decimal(decimal) => tagged_value("decimal", decimal.to_string()),
    Value::Timestamp(unit, value) => {
      let text = format_timestamp(*unit, *value);
      // 不编 ICU 扩展，带时区的时间在库里就是 UTC；照 DuckDB 自己的写法补上 `+00`
      if type_id == LogicalTypeId::TimestampTZ && !text.ends_with("infinity") {
        tagged_value("datetime", format!("{text}+00"))
      } else {
        tagged_value("datetime", text)
      }
    }
    Value::Date32(days) => tagged_value("date", format_date(*days)),
    Value::Time64(unit, value) => tagged_value("time", format_time_of_day(unit.to_micros(*value))),
    Value::Interval { months, days, nanos } => {
      tagged_value("time", format_interval(*months, *days, *nanos))
    }
    Value::Text(text) | Value::Enum(text) => JsonValue::from(text.clone()),
    Value::Blob(bytes) if type_id == LogicalTypeId::Bit => JsonValue::from(format_bits(bytes)),
    Value::Blob(bytes) | Value::Geometry(bytes) => {
      tagged_value("binary", bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }
    Value::Map(entries) => JsonValue::from(map_text(entries)),
    nested => tagged_value("json", plain(nested).to_string()),
  }
}

/// MAP 照 DuckDB 自己的写法：`{k=1, other=2}`。
///
/// 列表与结构体写成 JSON 之后原样填回去，DuckDB 转得回列的类型；MAP 不行——
/// `{"k":1}` 报「can't be cast to the destination type MAP」，`{k=1}` 可以（都实验过）。
/// 表格里改一格就是把显示的文字填回去，所以 MAP 用它认的那种。
fn map_text(entries: &duckdb::types::OrderedMap<Value, Value>) -> String {
  let part = |value: &Value| match value {
    Value::Null => "NULL".to_string(),
    Value::Text(text) | Value::Enum(text) => text.clone(),
    other => match plain(other) {
      JsonValue::String(text) => text,
      json => json.to_string(),
    },
  };
  let pairs: Vec<String> =
    entries.iter().map(|(key, value)| format!("{}={}", part(key), part(value))).collect();
  format!("{{{}}}", pairs.join(", "))
}

fn integer(value: i128) -> JsonValue {
  match i64::try_from(value) {
    Ok(small) if value.abs() <= MAX_SAFE_INTEGER => JsonValue::from(small),
    _ => tagged_value("bigint", value.to_string()),
  }
}

fn float(value: f64) -> JsonValue {
  serde_json::Number::from_f64(value)
    .map(JsonValue::Number)
    .unwrap_or_else(|| JsonValue::from(value.to_string()))
}

/// 嵌套值里的一格，写成 JSON 本身的值：数照样是数（超出安全整数的写成字符串，
/// 免得 JSON.parse 丢精度），其余照 DuckDB 的文本写法
fn plain(value: &Value) -> JsonValue {
  match value {
    Value::Null => JsonValue::Null,
    Value::Boolean(value) => JsonValue::from(*value),
    Value::Float(value) => float(f64::from(*value)),
    Value::Double(value) => float(*value),
    Value::List(items) | Value::Array(items) => JsonValue::Array(items.iter().map(plain).collect()),
    Value::Struct(fields) => {
      JsonValue::Object(fields.iter().map(|(name, value)| (name.clone(), plain(value))).collect())
    }
    // 键都是文本时写成对象，和 DuckDB 显示的 `{k=1}` 同一个样子；否则一对一对地列
    Value::Map(entries) => {
      let by_text_key: Option<Map<String, JsonValue>> = entries
        .iter()
        .map(|(key, value)| match key {
          Value::Text(key) => Some((key.clone(), plain(value))),
          _ => None,
        })
        .collect();
      by_text_key.map(JsonValue::Object).unwrap_or_else(|| {
        JsonValue::Array(
          entries
            .iter()
            .map(|(key, value)| JsonValue::Array(vec![plain(key), plain(value)]))
            .collect(),
        )
      })
    }
    Value::Union(inner) => plain(inner),
    scalar => match decode(scalar, LogicalTypeId::Invalid) {
      JsonValue::Object(mut tagged) if tagged.contains_key("type") => {
        let kind = tagged.get("type").and_then(JsonValue::as_str).map(str::to_string);
        let text = tagged.remove("value").unwrap_or(JsonValue::Null);
        match (kind.as_deref(), &text) {
          (Some("bigint"), _) | (Some("decimal"), _) => text,
          (Some("binary"), JsonValue::String(hex)) => JsonValue::from(format!("\\x{hex}")),
          _ => text,
        }
      }
      other => other,
    },
  }
}

/// 照另外几家的写法：两位小时，小数秒只在非零时出现并去掉末尾的 0
fn format_timestamp(unit: TimeUnit, value: i64) -> String {
  // DuckDB 的 infinity / -infinity 是 i64 的两端
  if value == i64::MAX {
    return "infinity".to_string();
  }
  if value == -i64::MAX || value == i64::MIN {
    return "-infinity".to_string();
  }
  let (seconds, nanos) = match unit {
    TimeUnit::Second => (value, 0),
    TimeUnit::Millisecond => (value.div_euclid(1_000), value.rem_euclid(1_000) * 1_000_000),
    TimeUnit::Microsecond => (value.div_euclid(1_000_000), value.rem_euclid(1_000_000) * 1_000),
    TimeUnit::Nanosecond => (value.div_euclid(1_000_000_000), value.rem_euclid(1_000_000_000)),
  };
  let Some(stamp) = chrono::DateTime::from_timestamp(seconds, nanos as u32) else {
    return value.to_string();
  };
  let mut text = stamp.format("%Y-%m-%d %H:%M:%S").to_string();
  push_fraction(&mut text, nanos as u32);
  text
}

fn format_date(days: i32) -> String {
  if days == i32::MAX {
    return "infinity".to_string();
  }
  if days == -i32::MAX || days == i32::MIN {
    return "-infinity".to_string();
  }
  chrono::NaiveDate::from_ymd_opt(1970, 1, 1)
    .and_then(|epoch| epoch.checked_add_signed(chrono::TimeDelta::days(i64::from(days))))
    .map(|date| date.format("%Y-%m-%d").to_string())
    .unwrap_or_else(|| days.to_string())
}

/// 一天里的时刻，微秒计
fn format_time_of_day(micros: i64) -> String {
  let seconds = micros.div_euclid(1_000_000);
  let mut text = format!("{:02}:{:02}:{:02}", seconds / 3600, (seconds / 60) % 60, seconds % 60);
  push_fraction(&mut text, (micros.rem_euclid(1_000_000) * 1_000) as u32);
  text
}

fn push_fraction(text: &mut String, nanos: u32) {
  if nanos > 0 {
    let fraction = format!("{nanos:09}");
    text.push('.');
    text.push_str(fraction.trim_end_matches('0'));
  }
}

/// 照 DuckDB 的写法：`1 year 2 months 3 days 04:05:06`，全是零时是 `00:00:00`
fn format_interval(months: i32, days: i32, nanos: i64) -> String {
  let plural = |count: i64, unit: &str| {
    if count.abs() == 1 {
      format!("{count} {unit}")
    } else {
      format!("{count} {unit}s")
    }
  };
  let mut parts = Vec::new();
  let (years, months) = (i64::from(months) / 12, i64::from(months) % 12);
  if years != 0 {
    parts.push(plural(years, "year"));
  }
  if months != 0 {
    parts.push(plural(months, "month"));
  }
  if days != 0 {
    parts.push(plural(i64::from(days), "day"));
  }
  if nanos != 0 || parts.is_empty() {
    let sign = if nanos < 0 { "-" } else { "" };
    parts.push(format!("{sign}{}", format_time_of_day(nanos.abs() / 1_000)));
  }
  parts.join(" ")
}

/// BIT 的存法：第一个字节是最高字节里要跳过的填充位数，后面是位本身
fn format_bits(bytes: &[u8]) -> String {
  let Some((&padding, data)) = bytes.split_first() else {
    return String::new();
  };
  let bits: String = data.iter().map(|byte| format!("{byte:08b}")).collect();
  bits.chars().skip(usize::from(padding)).collect()
}

/// 驱动的错误 → 应用的查询错误。
///
/// DuckDB 的错误没有码，开头是类别：「Catalog Error: …」「Parser Error: …」。类别
/// 作码，余下的作消息；「Did you mean …」那一行是提示。出错位置在后面的
/// `LINE n: …` 与一行 `^` 里，见 [`caret_position`]。
fn query_error(error: &duckdb::Error, sql: Option<&str>) -> QueryError {
  let duckdb::Error::DuckDBFailure(_, Some(text)) = error else {
    return QueryError::message(error.to_string());
  };
  if let Some(holder) = lock_holder(text) {
    return QueryError::message(format!("{DUCKDB_FILE_LOCKED}: {holder}"));
  }
  let (body, context) = match text.split_once("\n\nLINE ") {
    Some((body, context)) => (body, Some(context)),
    None => (text.as_str(), None),
  };
  let (first_line, rest) = body.split_once('\n').unwrap_or((body, ""));
  let (code, message) = match first_line.split_once(": ") {
    Some((category, message)) if category.ends_with(" Error") => {
      (Some(category.to_string()), message.to_string())
    }
    _ => (None, first_line.to_string()),
  };
  let hint = Some(rest.trim()).filter(|hint| !hint.is_empty()).map(str::to_string);
  let position = sql.zip(context).and_then(|(sql, context)| caret_position(sql, context));
  let details = (position.is_some() || hint.is_some())
    .then(|| Box::new(QueryErrorDetails { position, hint, ..Default::default() }));
  QueryError { message, code, details }
}

/// 「Could not set lock on file "…": Conflicting lock is held in <程序> (PID n) by user x」
/// 里的持有者
fn lock_holder(text: &str) -> Option<String> {
  let (_, after) = text.split_once("Conflicting lock is held in ")?;
  let holder = after.split(" by user").next().unwrap_or(after);
  let holder = holder.split(". See also").next().unwrap_or(holder);
  text.contains("Could not set lock on file").then(|| holder.trim().to_string())
}

/// 出错处在语句里的字符位置，从 1 起。
///
/// `context` 是 `LINE ` 之后那一段：`3:   nosuch\n          ^`。那一行太长时两头被
/// 截成 `...`，`^` 的列数按显示宽度算（中文占两格）。所以先把 `^` 换成那一行里的
/// 第几个字符，再到语句的第 n 行里找这段文字在哪。找不到就不给位置，免得标错地方。
fn caret_position(sql: &str, context: &str) -> Option<u32> {
  let (line_number, rest) = context.split_once(": ")?;
  let line_number: usize = line_number.trim().parse().ok()?;
  let (shown, caret_line) = rest.split_once('\n')?;
  let prefix_width = format!("LINE {line_number}: ").chars().count();
  let caret_column = caret_line.find('^')?.checked_sub(prefix_width)?;

  let lead = if shown.starts_with("...") { 3 } else { 0 };
  let fragment = shown[lead..].strip_suffix("...").unwrap_or(&shown[lead..]);
  let mut width = lead;
  let mut offset_in_fragment = None;
  for (index, c) in fragment.chars().enumerate() {
    if width >= caret_column {
      offset_in_fragment = Some(index);
      break;
    }
    width += display_width(c);
  }
  let offset_in_fragment = offset_in_fragment?;

  let line = sql.split('\n').nth(line_number.checked_sub(1)?)?;
  let start = line.find(fragment)?;
  let chars_before_line: usize =
    sql.split('\n').take(line_number - 1).map(|line| line.chars().count() + 1).sum();
  let column = line[..start].chars().count() + offset_in_fragment;
  u32::try_from(chars_before_line + column + 1).ok()
}

/// 终端里占几格。DuckDB 用 utf8proc 算，这里只分两种：东亚宽字符与全角占两格
fn display_width(c: char) -> usize {
  let code = u32::from(c);
  let wide = matches!(code,
    0x1100..=0x115F
      | 0x2E80..=0xA4CF
      | 0xAC00..=0xD7A3
      | 0xF900..=0xFAFF
      | 0xFE30..=0xFE4F
      | 0xFF00..=0xFF60
      | 0xFFE0..=0xFFE6
      | 0x1F300..=0x1F64F
      | 0x1F900..=0x1F9FF
      | 0x20000..=0x3FFFD
  );
  if wide {
    2
  } else {
    1
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn statements_are_told_apart_by_their_leading_keyword() {
    for sql in [
      "SELECT 1",
      "from t",
      "WITH a AS (SELECT 1) SELECT * FROM a",
      "SHOW TABLES",
      "DESCRIBE t",
      "PRAGMA table_info('t')",
      "EXPLAIN SELECT 1",
      "SUMMARIZE t",
      "VALUES (1)",
      "-- 注释\nSELECT 1",
      "INSERT INTO t VALUES (1) RETURNING id",
      "UPDATE t SET a = 1\nRETURNING *",
    ] {
      assert_eq!(statement_kind(sql), StatementKind::Query, "{sql}");
    }
    for sql in [
      "INSERT INTO t VALUES (1)",
      "update t set a = 'returning'",
      "CREATE TABLE t (id INT)",
      "DROP TABLE t",
      "SET threads = 2",
      "BEGIN",
      "COMMIT",
      "ATTACH 'x.db'",
      "COPY t TO 'x.csv'",
      "/* c */ DELETE FROM t",
      "DELETE FROM t -- returning",
    ] {
      assert_eq!(statement_kind(sql), StatementKind::NonQuery, "{sql}");
    }
  }

  #[test]
  fn errors_keep_the_category_as_code_and_the_suggestion_as_hint() {
    let text = "Catalog Error: Table with name nosuch does not exist!\nDid you mean \"pg_tables\"?\n\nLINE 1: SELECT * FROM nosuch\n                      ^";
    let error = query_error(
      &duckdb::Error::DuckDBFailure(duckdb::ffi::Error::new(1), Some(text.to_string())),
      Some("SELECT * FROM nosuch"),
    );
    assert_eq!(error.code.as_deref(), Some("Catalog Error"));
    assert_eq!(error.message, "Table with name nosuch does not exist!");
    assert_eq!(error.hint(), Some("Did you mean \"pg_tables\"?"));
    assert_eq!(error.position(), Some(15));
  }

  #[test]
  fn the_caret_maps_back_to_a_character_position() {
    // 第三行、缩进两格
    let sql = "SELECT 1,\n  2,\n  nosuch\nFROM range(1)";
    assert_eq!(
      caret_position(sql, "3:   nosuch\n          ^"),
      Some(sql.find("nosuch").map(|at| at as u32 + 1).unwrap_or(0))
    );
    // 中文占两格：^ 在第 23 列，而 nosuch 是第 14 个字符
    let sql = "SELECT '中文', nosuch FROM range(1)";
    assert_eq!(
      caret_position(sql, "1: SELECT '中文', nosuch FROM range(1)\n                       ^"),
      Some(14)
    );
    // 太长的行两头被截成 ...：在原句里找回那一段
    let sql = format!("SELECT {}nosuch FROM range(1)", "1 + ".repeat(60));
    let shown = format!("...{}nosuch FROM range(1)", &"1 + ".repeat(60)[240 - 67..]);
    let caret = format!("{}^", " ".repeat("LINE 1: ".len() + 3 + 67));
    let expected = sql.find("nosuch").map(|at| at as u32 + 1);
    assert_eq!(caret_position(&sql, &format!("1: {shown}\n{caret}")), expected);
    // 对不上就不给
    assert_eq!(caret_position("SELECT 1", "1: SELECT 2\n        ^"), None);
  }

  #[test]
  fn a_locked_file_names_the_process_holding_it() {
    let text = "IO Error: Could not set lock on file \"/tmp/a.duckdb\": Conflicting lock is held in /opt/homebrew/bin/duckdb (PID 84863) by user hal. See also https://duckdb.org/docs/stable/connect/concurrency";
    let error = query_error(
      &duckdb::Error::DuckDBFailure(duckdb::ffi::Error::new(1), Some(text.to_string())),
      None,
    );
    assert_eq!(
      error.message,
      format!("{DUCKDB_FILE_LOCKED}: /opt/homebrew/bin/duckdb (PID 84863)")
    );
  }

  #[test]
  fn values_come_out_the_way_duckdb_writes_them() {
    assert_eq!(
      format_timestamp(TimeUnit::Microsecond, 1_790_406_245_123_456),
      "2026-09-26 07:04:05.123456"
    );
    assert_eq!(
      format_timestamp(TimeUnit::Nanosecond, 1_767_225_600_123_456_789),
      "2026-01-01 00:00:00.123456789"
    );
    assert_eq!(format_timestamp(TimeUnit::Microsecond, -1), "1969-12-31 23:59:59.999999");
    assert_eq!(format_timestamp(TimeUnit::Microsecond, i64::MAX), "infinity");
    assert_eq!(format_date(20_722), "2026-09-26");
    assert_eq!(format_date(i32::MAX), "infinity");
    assert_eq!(format_time_of_day(25_445_120_000), "07:04:05.12");
    assert_eq!(format_interval(12, 2, 11_045_000_000_000), "1 year 2 days 03:04:05");
    assert_eq!(format_interval(0, 0, 0), "00:00:00");
    assert_eq!(format_interval(-14, 0, -1_000_000_000), "-1 year -2 months -00:00:01");
    assert_eq!(format_bits(&[4, 245]), "0101");
  }

  #[test]
  fn big_numbers_and_nested_values_keep_their_precision() {
    assert_eq!(
      decode(&Value::BigInt(1 << 53), LogicalTypeId::Bigint),
      tagged_value("bigint", (1i64 << 53).to_string())
    );
    assert_eq!(
      decode(&Value::BigInt(-(1 << 52)), LogicalTypeId::Bigint),
      JsonValue::from(-(1i64 << 52))
    );
    assert_eq!(
      decode(&Value::UBigInt(u64::MAX), LogicalTypeId::UBigint),
      tagged_value("bigint", u64::MAX.to_string())
    );
    assert_eq!(
      decode(&Value::Timestamp(TimeUnit::Microsecond, 0), LogicalTypeId::TimestampTZ),
      tagged_value("datetime", "1970-01-01 00:00:00+00".to_string())
    );
    let map = Value::Map(duckdb::types::OrderedMap::from(vec![
      (Value::Text("k".into()), Value::Int(1)),
      (Value::Text("n".into()), Value::Null),
    ]));
    assert_eq!(decode(&map, LogicalTypeId::Map), JsonValue::from("{k=1, n=NULL}"));
    let nested = Value::Struct(duckdb::types::OrderedMap::from(vec![
      ("a".to_string(), Value::HugeInt(1 << 60)),
      ("b".to_string(), Value::List(vec![Value::Int(1), Value::Null])),
    ]));
    assert_eq!(
      decode(&nested, LogicalTypeId::Struct),
      tagged_value("json", r#"{"a":"1152921504606846976","b":[1,null]}"#.to_string())
    );
  }
}
