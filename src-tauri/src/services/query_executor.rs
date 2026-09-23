use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use serde::Serialize;
use serde_json::{Map, Value as JsonValue};
use sqlx::{
  mysql::{MySqlRow, MySqlValueRef},
  postgres::{PgRow, PgValueRef},
  sqlite::{SqliteRow, SqliteValueRef},
  Column, Executor, MySql, MySqlConnection, PgConnection, Pool, Postgres, Row, Sqlite,
  SqliteConnection, TypeInfo, Value, ValueRef,
};
use std::future::Future;
use tauri_plugin_sql::DbPool;
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time};
use tokio::time::{timeout, Duration};

/// 查询超时。数据是配置的毫秒数——`code` 字段另有 `QUERY_TIMEOUT_CODE`，
/// 这里管的是**消息**，此前它是一句中文
pub const QUERY_TIMEOUT: &str = "DATAOMNI_QUERY_TIMEOUT";
/// 某一列解码不出来。数据是 `列名 · 数据库给的类型 · 驱动的原因`。
/// 三种库共用一条：对用户来说「这一列读不出来」是同一件事
pub const COLUMN_DECODE_FAILED: &str = "DATAOMNI_COLUMN_DECODE_FAILED";

/// 解码不了的列类型。数据里带的是数据库给的类型名——三种库共用一条：
/// 对用户来说「这一列读不出来」是同一件事，而类型名已经说明了是哪种库
pub const UNSUPPORTED_COLUMN_TYPE: &str = "DATAOMNI_UNSUPPORTED_COLUMN_TYPE";

pub use crate::services::query_error::{QueryError, QUERY_TIMEOUT_CODE};
pub const DEFAULT_QUERY_ROW_LIMIT: usize = 1_000;
pub const DEFAULT_QUERY_BATCH_SIZE: usize = 250;
pub const DEFAULT_QUERY_BYTE_LIMIT: usize = 16 * 1024 * 1024;

pub type QueryRow = Map<String, JsonValue>;

#[derive(Debug, Clone, Serialize)]
pub struct QueryColumnMetadata {
  pub name: String,
  pub ordinal: usize,
  pub database_type: String,
  pub logical_type: String,
  pub nullable: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryResultBatch {
  pub index: usize,
  pub offset: usize,
  pub rows: Vec<QueryRow>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryTruncationReason {
  RowLimit,
  ByteLimit,
}

/// 语句不返回结果集时怎么办。
///
/// 谁也无法只看 SQL 文本就断定它返不返回行——`WITH ... SELECT` 返回，
/// `WITH ... DELETE` 不返回，而两者开头一样。唯一权威的回答来自数据库自己：
/// `describe` 报了 0 列就是不返回。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NonQueryHandling {
  /// 照常执行，回报受影响行数。编辑器里执行一条 UPDATE 走这条。
  Execute,
  /// 拒绝执行。导出走这条：点一下「导出」不该让一条 DELETE 真把数据删掉。
  Refuse,
}

/// 流式读的四个旋钮。
///
/// 合成一个结构不是为了抽象，是因为位置参数已经排到第六个——
/// `(connection, sql, 100000, 16777216, 250, sink)` 里哪个是哪个，读的人得回去数。
#[derive(Debug, Clone, Copy)]
pub struct StreamOptions {
  pub row_limit: usize,
  pub byte_limit: usize,
  pub batch_size: usize,
  pub non_query: NonQueryHandling,
  /// 这是取执行计划的那一次执行。各家要照顾的地方不同：
  ///
  /// - MySQL 在预处理 `EXPLAIN FORMAT=JSON` 时报告 **0 列**，而它执行起来确实
  ///   返回一行 JSON。按 describe 的说法走会拿回一个 `Affected`，执行计划就此
  ///   消失——所以 describe 说「没有列」时仍然去取结果集。
  /// - SQL Server 没有 `EXPLAIN`：语句原样，前后各发一批 `SET SHOWPLAN_XML`，
  ///   服务端只编译不执行，返回一份 XML 计划。
  pub explain_plan: bool,
}

impl StreamOptions {
  pub fn limited(row_limit: usize, byte_limit: usize, batch_size: usize) -> Self {
    Self {
      row_limit,
      byte_limit,
      batch_size,
      non_query: NonQueryHandling::Execute,
      explain_plan: false,
    }
  }

  /// 见 [`StreamOptions::explain_plan`]
  pub fn for_explain(mut self) -> Self {
    self.explain_plan = true;
    self
  }

  /// 导出用：行数与字节都不设限，且拒绝执行不返回结果集的语句。
  pub fn unlimited_export(batch_size: usize) -> Self {
    Self {
      row_limit: usize::MAX,
      byte_limit: usize::MAX,
      batch_size,
      non_query: NonQueryHandling::Refuse,
      explain_plan: false,
    }
  }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryExecutionSummary {
  Rows {
    columns: Vec<String>,
    column_metadata: Vec<QueryColumnMetadata>,
    row_count: usize,
    batch_count: usize,
    truncated: bool,
    truncation_reason: Option<QueryTruncationReason>,
    row_limit: usize,
    byte_limit: usize,
    bytes_read: usize,
  },
  Affected {
    rows_affected: u64,
  },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryExecutionResult {
  Rows {
    columns: Vec<String>,
    column_metadata: Vec<QueryColumnMetadata>,
    rows: Vec<Map<String, JsonValue>>,
    truncated: bool,
    truncation_reason: Option<QueryTruncationReason>,
    row_limit: usize,
    byte_limit: usize,
    bytes_read: usize,
  },
  Affected {
    rows_affected: u64,
  },
}

pub async fn execute_query(pool: &DbPool, sql: &str) -> Result<QueryExecutionResult, QueryError> {
  execute_query_with_limit(pool, sql, DEFAULT_QUERY_ROW_LIMIT).await
}

pub async fn execute_query_with_limit(
  pool: &DbPool,
  sql: &str,
  row_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  execute_query_with_limits(pool, sql, row_limit, DEFAULT_QUERY_BYTE_LIMIT).await
}

pub async fn execute_query_with_limits(
  pool: &DbPool,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  match pool {
    DbPool::Sqlite(pool) => execute_sqlite(pool, sql, row_limit, byte_limit).await,
    DbPool::MySql(pool) => execute_mysql(pool, sql, row_limit, byte_limit).await,
    DbPool::Postgres(pool) => execute_postgres(pool, sql, row_limit, byte_limit).await,
  }
}

/// 一条连接从哪个池子来：插件管的 sqlx 三家，或者后端自己持有的 SQL Server。
///
/// 插件的 `DbPool` 是别人的枚举，加不进第四个变体，所以包一层。只有要
/// **开一条会话连接**的地方需要它（`SessionConnection::acquire`）；只接受
/// `&DbPool` 的调用方经 `From` 照旧编译。
#[derive(Clone, Copy)]
pub enum PoolRef<'a> {
  Sqlx(&'a DbPool),
  SqlServer(&'a std::sync::Arc<crate::services::sql_server::SqlServerPool>),
  Oracle(&'a std::sync::Arc<crate::services::oracle::OraclePool>),
}

impl<'a> From<&'a DbPool> for PoolRef<'a> {
  fn from(pool: &'a DbPool) -> Self {
    Self::Sqlx(pool)
  }
}

pub enum SessionConnection {
  Sqlite(sqlx::pool::PoolConnection<Sqlite>),
  MySql(sqlx::pool::PoolConnection<MySql>),
  Postgres(sqlx::pool::PoolConnection<Postgres>),
  /// 装箱：tiberius 的客户端比 sqlx 的池连接大得多，不装箱的话每个变体都按它付内存
  SqlServer(Box<crate::services::sql_server::SqlServerConnection>),
  Oracle(Box<crate::services::oracle::OracleConnection>),
}

impl SessionConnection {
  pub async fn acquire<'a>(pool: impl Into<PoolRef<'a>>) -> Result<Self, QueryError> {
    match pool.into() {
      PoolRef::Sqlx(DbPool::Sqlite(pool)) => {
        pool.acquire().await.map(Self::Sqlite).map_err(display_error)
      }
      PoolRef::Sqlx(DbPool::MySql(pool)) => {
        pool.acquire().await.map(Self::MySql).map_err(display_error)
      }
      PoolRef::Sqlx(DbPool::Postgres(pool)) => {
        pool.acquire().await.map(Self::Postgres).map_err(display_error)
      }
      PoolRef::SqlServer(pool) => {
        pool.acquire_for_session().await.map(|connection| Self::SqlServer(Box::new(connection)))
      }
      PoolRef::Oracle(pool) => {
        pool.acquire_for_session().await.map(|connection| Self::Oracle(Box::new(connection)))
      }
    }
  }

  pub async fn execute(
    &mut self,
    sql: &str,
    row_limit: usize,
  ) -> Result<QueryExecutionResult, QueryError> {
    match self {
      Self::Sqlite(connection) => execute_sqlite_connection(connection, sql, row_limit).await,
      Self::MySql(connection) => execute_mysql_connection(connection, sql, row_limit).await,
      Self::Postgres(connection) => execute_postgres_connection(connection, sql, row_limit).await,
      Self::SqlServer(connection) => {
        let mut rows = Vec::new();
        let summary = connection
          .execute_streaming(
            sql,
            StreamOptions::limited(row_limit, DEFAULT_QUERY_BYTE_LIMIT, row_limit.max(1)),
            &mut |batch| {
              rows.extend(batch.rows);
              Ok(())
            },
          )
          .await?;
        summary_with_rows(summary, rows)
      }
      Self::Oracle(connection) => {
        let mut rows = Vec::new();
        let summary = connection
          .execute_streaming(
            sql,
            StreamOptions::limited(row_limit, DEFAULT_QUERY_BYTE_LIMIT, row_limit.max(1)),
            &mut |batch| {
              rows.extend(batch.rows);
              Ok(())
            },
          )
          .await?;
        summary_with_rows(summary, rows)
      }
    }
  }

  /// 只问「这条语句返回哪些列」，不取任何一行。
  ///
  /// 导出要先写 CSV 表头，而表头必须在第一批数据之前就写出去。三种驱动的
  /// `describe` 都是 prepare 而非执行，所以拿列名不会让语句真的跑起来。
  pub async fn describe_columns(
    &mut self,
    sql: &str,
  ) -> Result<Vec<QueryColumnMetadata>, QueryError> {
    match self {
      Self::Sqlite(connection) => describe_sqlite_columns(connection, sql).await,
      Self::MySql(connection) => describe_mysql_columns(connection, sql).await,
      Self::Postgres(connection) => describe_postgres_columns(connection, sql).await,
      Self::SqlServer(connection) => connection.describe_columns(sql).await,
      // 导出要先写表头，在第三阶段
      Self::Oracle(_) => Err(crate::services::oracle::unsupported("describe")),
    }
  }

  /// 在这条连接上执行一条带参数的语句，返回影响行数。
  ///
  /// 与 `execute` 的区别只在参数，而这个区别是导入的全部安全性所在：CSV 里的
  /// 一个单引号拼进 SQL 就能把语句改写成别的意思。值一律是 `Option<String>`——
  /// CSV 给出来的本来就是文本与「没有值」两种，再包一层 JSON 只是多一次转换。
  pub async fn execute_with_params(
    &mut self,
    sql: &str,
    params: &[Option<String>],
  ) -> Result<u64, QueryError> {
    match self {
      Self::Sqlite(connection) => {
        let mut query = sqlx::query(sql);
        for param in params {
          query = query.bind(param.clone());
        }
        connection.execute(query).await.map(|done| done.rows_affected()).map_err(display_error)
      }
      Self::MySql(connection) => {
        let mut query = sqlx::query(sql);
        for param in params {
          query = query.bind(param.clone());
        }
        connection.execute(query).await.map(|done| done.rows_affected()).map_err(display_error)
      }
      Self::Postgres(connection) => {
        let mut query = sqlx::query(sql);
        for param in params {
          query = query.bind(param.clone());
        }
        connection.execute(query).await.map(|done| done.rows_affected()).map_err(display_error)
      }
      Self::SqlServer(connection) => connection.execute_with_params(sql, params).await,
      // CSV 导入，在第三阶段
      Self::Oracle(_) => Err(crate::services::oracle::unsupported("import")),
    }
  }

  /// 不经预处理直接发一条语句，返回影响行数。
  ///
  /// 事务与保存点控制必须走这条路：MySQL 的预处理协议**不收** `BEGIN` 与
  /// `SAVEPOINT` 这类命令，报的是 1295「This command is not supported in the
  /// prepared statement protocol yet」——一句完全不指向真正原因的错。
  /// 这些语句本来也没有参数，预处理对它们只有坏处。
  pub async fn execute_unprepared(&mut self, sql: &str) -> Result<u64, QueryError> {
    match self {
      Self::Sqlite(connection) => {
        connection.execute(sql).await.map(|done| done.rows_affected()).map_err(display_error)
      }
      Self::MySql(connection) => {
        connection.execute(sql).await.map(|done| done.rows_affected()).map_err(display_error)
      }
      Self::Postgres(connection) => {
        connection.execute(sql).await.map(|done| done.rows_affected()).map_err(display_error)
      }
      Self::SqlServer(connection) => connection.execute_batch(sql).await,
      Self::Oracle(connection) => connection.execute_batch(sql).await,
    }
  }

  /// 这个方言会不会因为一条语句出错就把整个事务废掉。
  ///
  /// 只有 PostgreSQL 是：事务里任何一条语句报错之后，后续语句一律 25P02，
  /// 只有回滚能出去。MySQL 与 SQLite 不是这样，在那两家标成「事务已失败」
  /// 是在说假话。
  pub fn aborts_transaction_on_error(&self) -> bool {
    matches!(self, Self::Postgres(_))
  }

  /// 这个方言的 DDL 会不会隐式提交当前事务。
  ///
  /// 只有 MySQL 是。PostgreSQL 与 SQLite 的 DDL 在事务里，`DROP TABLE`
  /// 能回滚。见 `transaction_state::commits_implicitly`。
  pub fn commits_implicitly_on_ddl(&self) -> bool {
    matches!(self, Self::MySql(_))
  }

  /// 关掉自动提交时补的那一句。T-SQL 里单独一个 `BEGIN` 是语句块的开头，
  /// 不开事务
  ///
  /// Oracle 没有这一句：事务随第一条 DML 开始，自动提交由连接自己按开关决定
  pub fn begin_statement(&self) -> Option<&'static str> {
    match self {
      Self::SqlServer(_) => Some("BEGIN TRANSACTION"),
      Self::Oracle(_) => None,
      _ => Some("BEGIN"),
    }
  }

  /// 把这一次执行的自动提交开关交给连接。只有 Oracle 要：另外几家的自动提交在
  /// 服务端，靠补一句 `BEGIN` 关掉
  pub fn set_autocommit(&mut self, autocommit: bool) {
    if let Self::Oracle(connection) = self {
      connection.set_autocommit(autocommit);
    }
  }

  /// 这条语句自己就在开、关事务，前面不用补 `BEGIN`
  pub fn controls_transaction(&self, sql: &str) -> bool {
    use crate::services::transaction_state::{transaction_effect, TransactionEffect};
    match self {
      Self::SqlServer(_) => crate::services::sql_server::controls_transaction(sql),
      Self::Oracle(_) => crate::services::oracle::controls_transaction(sql),
      _ => transaction_effect(sql) != TransactionEffect::None,
    }
  }

  /// 服务端报的事务状态。只有 SQL Server 有（`@@TRANCOUNT`）；另外三家
  /// 没有可移植的查法，状态由 `TransactionState` 从语句推出来
  pub fn observed_transaction(
    &self,
  ) -> Option<crate::services::transaction_state::TransactionState> {
    match self {
      Self::SqlServer(connection) => Some(connection.transaction()),
      Self::Oracle(connection) => Some(connection.transaction()),
      _ => None,
    }
  }

  pub async fn execute_streaming(
    &mut self,
    sql: &str,
    options: StreamOptions,
    sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
  ) -> Result<QueryExecutionSummary, QueryError> {
    match self {
      Self::Sqlite(connection) => {
        execute_sqlite_connection_streaming(connection, sql, options, sink).await
      }
      Self::MySql(connection) => {
        execute_mysql_connection_streaming(connection, sql, options, sink).await
      }
      Self::Postgres(connection) => {
        execute_postgres_connection_streaming(connection, sql, options, sink).await
      }
      Self::SqlServer(connection) => connection.execute_streaming(sql, options, sink).await,
      Self::Oracle(connection) => connection.execute_streaming(sql, options, sink).await,
    }
  }
}

pub async fn execute_query_with_timeout(
  pool: &DbPool,
  sql: &str,
  timeout_duration: Duration,
) -> Result<QueryExecutionResult, QueryError> {
  with_timeout(execute_query(pool, sql), timeout_duration).await
}

async fn with_timeout<F, T>(future: F, timeout_duration: Duration) -> Result<T, QueryError>
where
  F: Future<Output = Result<T, QueryError>>,
{
  timeout(timeout_duration, future).await.map_err(|_| {
    QueryError::with_code(
      QUERY_TIMEOUT_CODE,
      format!("{QUERY_TIMEOUT}: {}", timeout_duration.as_millis()),
    )
  })?
}

async fn execute_sqlite(
  pool: &Pool<Sqlite>,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  let mut connection = pool.acquire().await.map_err(QueryError::from)?;
  execute_sqlite_connection_with_limits(&mut connection, sql, row_limit, byte_limit).await
}

async fn execute_sqlite_connection(
  connection: &mut SqliteConnection,
  sql: &str,
  row_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  execute_sqlite_connection_with_limits(connection, sql, row_limit, DEFAULT_QUERY_BYTE_LIMIT).await
}

async fn execute_sqlite_connection_with_limits(
  connection: &mut SqliteConnection,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  let mut rows = Vec::new();
  let summary = execute_sqlite_connection_streaming(
    connection,
    sql,
    StreamOptions::limited(row_limit, byte_limit, row_limit.max(1)),
    &mut |batch| {
      rows.extend(batch.rows);
      Ok(())
    },
  )
  .await?;
  summary_with_rows(summary, rows)
}

async fn describe_sqlite_columns(
  connection: &mut SqliteConnection,
  sql: &str,
) -> Result<Vec<QueryColumnMetadata>, QueryError> {
  let description = (&mut *connection).describe(sql).await.map_err(QueryError::from)?;
  Ok(
    description
      .columns()
      .iter()
      .enumerate()
      .map(|(ordinal, column)| QueryColumnMetadata {
        name: column.name().to_string(),
        ordinal,
        database_type: column.type_info().name().to_string(),
        logical_type: sqlite_logical_type(column.type_info().name()).to_string(),
        nullable: description.nullable(ordinal),
      })
      .collect(),
  )
}

async fn execute_sqlite_connection_streaming(
  connection: &mut SqliteConnection,
  sql: &str,
  options: StreamOptions,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
) -> Result<QueryExecutionSummary, QueryError> {
  if is_transaction_control_statement(sql) {
    refuse_non_query(options.non_query)?;
    let result = (&mut *connection).execute(sql).await.map_err(QueryError::from)?;
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
  }

  let column_metadata = describe_sqlite_columns(connection, sql).await?;
  let columns = column_metadata.iter().map(|column| column.name.clone()).collect::<Vec<_>>();

  if columns.is_empty() && !options.explain_plan {
    refuse_non_query(options.non_query)?;
    let result = (&mut *connection).execute(sql).await.map_err(QueryError::from)?;
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
  }

  let mut stream = (&mut *connection).fetch(sqlx::query(sql));
  let mut rows = Vec::with_capacity(options.batch_size);
  let mut row_count = 0;
  let mut batch_count = 0;
  let mut bytes_read: usize = 0;
  let mut truncation_reason = None;
  while row_count < options.row_limit {
    let Some(row) = stream.try_next().await.map_err(QueryError::from)? else {
      break;
    };
    let row = decode_sqlite_row(&row)?;
    if !admit_row_bytes(&row, options.byte_limit, &mut bytes_read)? {
      truncation_reason = Some(QueryTruncationReason::ByteLimit);
      break;
    }
    rows.push(row);
    row_count += 1;
    flush_full_batch(&mut rows, options.batch_size, &mut batch_count, row_count, sink)?;
  }
  if truncation_reason.is_none()
    && row_count == options.row_limit
    && stream.try_next().await.map_err(QueryError::from)?.is_some()
  {
    truncation_reason = Some(QueryTruncationReason::RowLimit);
  }
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

async fn execute_mysql(
  pool: &Pool<MySql>,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  let mut connection = pool.acquire().await.map_err(QueryError::from)?;
  execute_mysql_connection_with_limits(&mut connection, sql, row_limit, byte_limit).await
}

async fn execute_mysql_connection(
  connection: &mut MySqlConnection,
  sql: &str,
  row_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  execute_mysql_connection_with_limits(connection, sql, row_limit, DEFAULT_QUERY_BYTE_LIMIT).await
}

async fn execute_mysql_connection_with_limits(
  connection: &mut MySqlConnection,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  let mut rows = Vec::new();
  let summary = execute_mysql_connection_streaming(
    connection,
    sql,
    StreamOptions::limited(row_limit, byte_limit, row_limit.max(1)),
    &mut |batch| {
      rows.extend(batch.rows);
      Ok(())
    },
  )
  .await?;
  summary_with_rows(summary, rows)
}

async fn describe_mysql_columns(
  connection: &mut MySqlConnection,
  sql: &str,
) -> Result<Vec<QueryColumnMetadata>, QueryError> {
  let description = (&mut *connection).describe(sql).await.map_err(QueryError::from)?;
  Ok(
    description
      .columns()
      .iter()
      .enumerate()
      .map(|(ordinal, column)| QueryColumnMetadata {
        name: column.name().to_string(),
        ordinal,
        database_type: column.type_info().name().to_string(),
        logical_type: mysql_logical_type(column.type_info().name()).to_string(),
        nullable: description.nullable(ordinal),
      })
      .collect(),
  )
}

async fn execute_mysql_connection_streaming(
  connection: &mut MySqlConnection,
  sql: &str,
  options: StreamOptions,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
) -> Result<QueryExecutionSummary, QueryError> {
  refuse_use_statement(sql)?;
  if is_transaction_control_statement(sql) {
    refuse_non_query(options.non_query)?;
    let result = (&mut *connection).execute(sql).await.map_err(QueryError::from)?;
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
  }

  let column_metadata = describe_mysql_columns(connection, sql).await?;
  let columns = column_metadata.iter().map(|column| column.name.clone()).collect::<Vec<_>>();

  if columns.is_empty() && !options.explain_plan {
    refuse_non_query(options.non_query)?;
    let result = (&mut *connection).execute(sql).await.map_err(QueryError::from)?;
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
  }

  let mut stream = (&mut *connection).fetch(sqlx::query(sql));
  let mut rows = Vec::with_capacity(options.batch_size);
  let mut row_count = 0;
  let mut batch_count = 0;
  let mut bytes_read: usize = 0;
  let mut truncation_reason = None;
  while row_count < options.row_limit {
    let Some(row) = stream.try_next().await.map_err(QueryError::from)? else {
      break;
    };
    let row = decode_mysql_row(&row)?;
    if !admit_row_bytes(&row, options.byte_limit, &mut bytes_read)? {
      truncation_reason = Some(QueryTruncationReason::ByteLimit);
      break;
    }
    rows.push(row);
    row_count += 1;
    flush_full_batch(&mut rows, options.batch_size, &mut batch_count, row_count, sink)?;
  }
  if truncation_reason.is_none()
    && row_count == options.row_limit
    && stream.try_next().await.map_err(QueryError::from)?.is_some()
  {
    truncation_reason = Some(QueryTruncationReason::RowLimit);
  }
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

async fn execute_postgres(
  pool: &Pool<Postgres>,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  let mut connection = pool.acquire().await.map_err(QueryError::from)?;
  execute_postgres_connection_with_limits(&mut connection, sql, row_limit, byte_limit).await
}

async fn execute_postgres_connection(
  connection: &mut PgConnection,
  sql: &str,
  row_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  execute_postgres_connection_with_limits(connection, sql, row_limit, DEFAULT_QUERY_BYTE_LIMIT)
    .await
}

async fn execute_postgres_connection_with_limits(
  connection: &mut PgConnection,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  let mut rows = Vec::new();
  let summary = execute_postgres_connection_streaming(
    connection,
    sql,
    StreamOptions::limited(row_limit, byte_limit, row_limit.max(1)),
    &mut |batch| {
      rows.extend(batch.rows);
      Ok(())
    },
  )
  .await?;
  summary_with_rows(summary, rows)
}

async fn describe_postgres_columns(
  connection: &mut PgConnection,
  sql: &str,
) -> Result<Vec<QueryColumnMetadata>, QueryError> {
  let description = (&mut *connection).describe(sql).await.map_err(QueryError::from)?;
  Ok(
    description
      .columns()
      .iter()
      .enumerate()
      .map(|(ordinal, column)| QueryColumnMetadata {
        name: column.name().to_string(),
        ordinal,
        database_type: column.type_info().name().to_string(),
        logical_type: postgres_logical_type(column.type_info().name()).to_string(),
        nullable: description.nullable(ordinal),
      })
      .collect(),
  )
}

async fn execute_postgres_connection_streaming(
  connection: &mut PgConnection,
  sql: &str,
  options: StreamOptions,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
) -> Result<QueryExecutionSummary, QueryError> {
  if is_transaction_control_statement(sql) {
    refuse_non_query(options.non_query)?;
    let result = (&mut *connection).execute(sql).await.map_err(QueryError::from)?;
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
  }

  let column_metadata = describe_postgres_columns(connection, sql).await?;
  let columns = column_metadata.iter().map(|column| column.name.clone()).collect::<Vec<_>>();

  if columns.is_empty() && !options.explain_plan {
    refuse_non_query(options.non_query)?;
    let result = (&mut *connection).execute(sql).await.map_err(QueryError::from)?;
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
  }

  let mut stream = (&mut *connection).fetch(sqlx::query(sql));
  let mut rows = Vec::with_capacity(options.batch_size);
  let mut row_count = 0;
  let mut batch_count = 0;
  let mut bytes_read: usize = 0;
  let mut truncation_reason = None;
  while row_count < options.row_limit {
    let Some(row) = stream.try_next().await.map_err(QueryError::from)? else {
      break;
    };
    let row = decode_postgres_row(&row)?;
    if !admit_row_bytes(&row, options.byte_limit, &mut bytes_read)? {
      truncation_reason = Some(QueryTruncationReason::ByteLimit);
      break;
    }
    rows.push(row);
    row_count += 1;
    flush_full_batch(&mut rows, options.batch_size, &mut batch_count, row_count, sink)?;
  }
  if truncation_reason.is_none()
    && row_count == options.row_limit
    && stream.try_next().await.map_err(QueryError::from)?.is_some()
  {
    truncation_reason = Some(QueryTruncationReason::RowLimit);
  }
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

pub(crate) fn flush_full_batch(
  rows: &mut Vec<QueryRow>,
  batch_size: usize,
  batch_count: &mut usize,
  row_count: usize,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
) -> Result<(), QueryError> {
  if rows.len() < batch_size.max(1) {
    return Ok(());
  }
  send_batch(rows, batch_count, row_count, sink)
}

pub(crate) fn flush_remaining_batch(
  rows: &mut Vec<QueryRow>,
  batch_count: &mut usize,
  row_count: usize,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
) -> Result<(), QueryError> {
  if rows.is_empty() {
    return Ok(());
  }
  send_batch(rows, batch_count, row_count, sink)
}

fn send_batch(
  rows: &mut Vec<QueryRow>,
  batch_count: &mut usize,
  row_count: usize,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
) -> Result<(), QueryError> {
  let batch_rows = std::mem::take(rows);
  let offset = row_count - batch_rows.len();
  sink(QueryResultBatch { index: *batch_count, offset, rows: batch_rows })?;
  *batch_count += 1;
  Ok(())
}

/// 把这一行计入字节预算；超出预算时返回 false，调用方据此停止读取。
///
/// `usize::MAX` 表示不设限（导出路径）。这时不能只是「比较结果恒为假」就算了——
/// `serialized_row_size` 会把整行再序列化一遍，而结果会被直接丢掉。一次全表
/// 导出就是白做几百万次。
pub(crate) fn admit_row_bytes(
  row: &QueryRow,
  byte_limit: usize,
  bytes_read: &mut usize,
) -> Result<bool, QueryError> {
  if byte_limit == usize::MAX {
    return Ok(true);
  }
  let row_bytes = serialized_row_size(row)?;
  if bytes_read.saturating_add(row_bytes) > byte_limit {
    return Ok(false);
  }
  *bytes_read += row_bytes;
  Ok(true)
}

/// 不返回结果集时给出的话。导出路径有两处会说这句（先探列、再流式读），
/// 同一件事说两种话会让人以为是两个不同的问题。
pub const NON_QUERY_MESSAGE: &str = "DATAOMNI_NON_QUERY";

/// MySQL 方言下拒绝 `USE`，见 `refuse_use_statement`。
pub const USE_STATEMENT_REFUSED: &str = "DATAOMNI_USE_STATEMENT_REFUSED";

/// MySQL 方言下不让 `USE` 跑到服务端。
///
/// 编辑器与对象树、补全、ER 图共用一个池子，目录查询按 `DATABASE()` 取当前库。
/// 一条被 `USE` 挪走的连接还回池子，下一次拿到它的目录查询就列出另一个库的
/// 表，而界面上的库名没变。MySQL 的预处理协议本来就拒绝 `USE`（1295），
/// MariaDB 的不拒，所以这一道由我们自己挡，两家说同一句话。
pub(crate) fn refuse_use_statement(sql: &str) -> Result<(), QueryError> {
  match crate::services::transaction_state::leading_keywords(sql).0.as_str() {
    "USE" => Err(QueryError::message(USE_STATEMENT_REFUSED)),
    _ => Ok(()),
  }
}

/// 导出路径遇到不返回结果集的语句时提前退出，不让它执行。
pub(crate) fn refuse_non_query(handling: NonQueryHandling) -> Result<(), QueryError> {
  match handling {
    NonQueryHandling::Execute => Ok(()),
    NonQueryHandling::Refuse => Err(QueryError::message(NON_QUERY_MESSAGE)),
  }
}

fn serialized_row_size(row: &QueryRow) -> Result<usize, QueryError> {
  serde_json::to_vec(row).map(|bytes| bytes.len()).map_err(display_error)
}

fn sqlite_logical_type(database_type: &str) -> &'static str {
  match database_type {
    "BOOLEAN" => "boolean",
    "INTEGER" => "integer",
    "REAL" | "NUMERIC" => "decimal",
    "BLOB" => "binary",
    "DATE" => "date",
    "TIME" => "time",
    "DATETIME" => "datetime",
    "TEXT" => "text",
    _ => "unknown",
  }
}

fn mysql_logical_type(database_type: &str) -> &'static str {
  match database_type {
    "BOOLEAN" => "boolean",
    "TINYINT" | "SMALLINT" | "INT" | "MEDIUMINT" | "BIGINT" | "TINYINT UNSIGNED"
    | "SMALLINT UNSIGNED" | "INT UNSIGNED" | "MEDIUMINT UNSIGNED" | "BIGINT UNSIGNED" | "YEAR" => {
      "integer"
    }
    "DECIMAL" | "FLOAT" | "DOUBLE" => "decimal",
    "TINYBLOB" | "MEDIUMBLOB" | "BLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" => "binary",
    "DATE" => "date",
    "TIME" => "time",
    "DATETIME" | "TIMESTAMP" => "datetime",
    "JSON" => "json",
    "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => "text",
    "BIT" => "integer",
    "GEOMETRY" => "binary",
    _ => "unknown",
  }
}

fn postgres_logical_type(database_type: &str) -> &'static str {
  match database_type {
    "BOOL" => "boolean",
    "INT2" | "INT4" | "INT8" => "integer",
    "NUMERIC" | "FLOAT4" | "FLOAT8" => "decimal",
    "BYTEA" => "binary",
    "INTERVAL" => "time",
    "TEXT[]" | "VARCHAR[]" | "NAME[]" | "INT2[]" | "INT4[]" | "INT8[]" => "unknown",
    "DATE" => "date",
    "TIME" | "TIMETZ" => "time",
    "TIMESTAMP" | "TIMESTAMPTZ" => "datetime",
    "JSON" | "JSONB" => "json",
    "CHAR" | "VARCHAR" | "TEXT" | "NAME" | "UUID" => "text",
    _ => "unknown",
  }
}

fn summary_with_rows(
  summary: QueryExecutionSummary,
  rows: Vec<QueryRow>,
) -> Result<QueryExecutionResult, QueryError> {
  match summary {
    QueryExecutionSummary::Rows {
      columns,
      column_metadata,
      truncated,
      truncation_reason,
      row_limit,
      byte_limit,
      bytes_read,
      ..
    } => Ok(QueryExecutionResult::Rows {
      columns,
      column_metadata,
      rows,
      truncated,
      truncation_reason,
      row_limit,
      byte_limit,
      bytes_read,
    }),
    QueryExecutionSummary::Affected { rows_affected } => {
      Ok(QueryExecutionResult::Affected { rows_affected })
    }
  }
}

fn is_transaction_control_statement(sql: &str) -> bool {
  let normalized = sql.trim().trim_end_matches(';').trim().to_ascii_uppercase();
  [
    "BEGIN",
    "START TRANSACTION",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "RELEASE SAVEPOINT",
    "SET TRANSACTION",
  ]
  .iter()
  .any(|keyword| normalized == *keyword || normalized.starts_with(&format!("{keyword} ")))
}

fn decode_sqlite_row(row: &SqliteRow) -> Result<Map<String, JsonValue>, QueryError> {
  let mut values = Map::new();
  for (index, column) in row.columns().iter().enumerate() {
    let value = row.try_get_raw(index).map_err(QueryError::from)?;
    let decoded = decode_sqlite(value).map_err(|error| {
      format!("{COLUMN_DECODE_FAILED}: {} · {} · {error}", column.name(), column.type_info().name())
    })?;
    values.insert(column.name().to_string(), decoded);
  }
  Ok(values)
}

fn decode_mysql_row(row: &MySqlRow) -> Result<Map<String, JsonValue>, QueryError> {
  let mut values = Map::new();
  for (index, column) in row.columns().iter().enumerate() {
    let value = row.try_get_raw(index).map_err(QueryError::from)?;
    let decoded = decode_mysql(value).map_err(|error| {
      format!("{COLUMN_DECODE_FAILED}: {} · {} · {error}", column.name(), column.type_info().name())
    })?;
    values.insert(column.name().to_string(), decoded);
  }
  Ok(values)
}

fn decode_postgres_row(row: &PgRow) -> Result<Map<String, JsonValue>, QueryError> {
  let mut values = Map::new();
  for (index, column) in row.columns().iter().enumerate() {
    let value = row.try_get_raw(index).map_err(QueryError::from)?;
    let decoded = decode_postgres(value).map_err(|error| {
      format!("{COLUMN_DECODE_FAILED}: {} · {} · {error}", column.name(), column.type_info().name())
    })?;
    values.insert(column.name().to_string(), decoded);
  }
  Ok(values)
}

fn decode_sqlite(value: SqliteValueRef<'_>) -> Result<JsonValue, QueryError> {
  if value.is_null() {
    return Ok(JsonValue::Null);
  }

  match value.type_info().name() {
    "TEXT" => json_value(ValueRef::to_owned(&value).try_decode::<String>()),
    "INTEGER" | "NUMERIC" => {
      tagged_display_value("bigint", ValueRef::to_owned(&value).try_decode::<i64>())
    }
    "REAL" => json_value(ValueRef::to_owned(&value).try_decode::<f64>()),
    "BOOLEAN" => json_value(ValueRef::to_owned(&value).try_decode::<bool>()),
    "DATE" => {
      tagged_formatted_value("date", ValueRef::to_owned(&value).try_decode::<Date>(), format_date)
    }
    "TIME" => {
      tagged_formatted_value("time", ValueRef::to_owned(&value).try_decode::<Time>(), format_time)
    }
    "DATETIME" => tagged_formatted_value(
      "datetime",
      ValueRef::to_owned(&value).try_decode::<PrimitiveDateTime>(),
      format_datetime,
    ),
    "BLOB" => tagged_binary_value(ValueRef::to_owned(&value).try_decode::<Vec<u8>>()),
    "NULL" => Ok(JsonValue::Null),
    type_name => Err(QueryError::message(format!("{UNSUPPORTED_COLUMN_TYPE}: {type_name}"))),
  }
}

fn decode_mysql(value: MySqlValueRef<'_>) -> Result<JsonValue, QueryError> {
  if value.is_null() {
    return Ok(JsonValue::Null);
  }

  let type_info = value.type_info();
  let type_name = type_info.name();
  match type_name {
    "JSON" => tagged_json_value(ValueRef::to_owned(&value).try_decode::<JsonValue>()),
    "DECIMAL" => tagged_display_value(
      "decimal",
      ValueRef::to_owned(&value).try_decode::<sqlx::types::BigDecimal>(),
    ),
    "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "INT UNSIGNED" | "MEDIUMINT UNSIGNED"
    | "BIGINT UNSIGNED" | "YEAR" => {
      tagged_display_value("bigint", ValueRef::to_owned(&value).try_decode::<u64>())
    }
    "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
      json_value(ValueRef::to_owned(&value).try_decode::<String>())
    }
    // BIT(n) 按无符号整数取值，保持精确；BIT(64) 仍在 u64 范围内
    "BIT" => tagged_display_value("bigint", ValueRef::to_owned(&value).try_decode::<u64>()),
    "TINYINT" | "SMALLINT" | "INT" | "MEDIUMINT" | "BIGINT" => {
      tagged_display_value("bigint", ValueRef::to_owned(&value).try_decode::<i64>())
    }
    "FLOAT" => json_value(ValueRef::to_owned(&value).try_decode::<f32>()),
    "DOUBLE" => json_value(ValueRef::to_owned(&value).try_decode::<f64>()),
    "BOOLEAN" => json_value(ValueRef::to_owned(&value).try_decode::<bool>()),
    "DATE" => {
      tagged_formatted_value("date", ValueRef::to_owned(&value).try_decode::<Date>(), format_date)
    }
    // MySQL 的 TIME 是时长而非时刻（-838:59:59 ~ 838:59:59），装不进 time::Time
    "TIME" => {
      let duration =
        ValueRef::to_owned(&value).try_decode::<time::Duration>().map_err(QueryError::from)?;
      Ok(tagged_value("time", format_mysql_time(duration)))
    }
    "DATETIME" => tagged_formatted_value(
      "datetime",
      ValueRef::to_owned(&value).try_decode::<PrimitiveDateTime>(),
      format_datetime,
    ),
    "TIMESTAMP" => {
      // sqlx 连接时把会话时区设成 +00:00，读出来的就是 UTC；按 MySQL 自己的文本
      // 形式不带时区写出，写回时同一个会话按同一个时区解释，往返不变
      tagged_formatted_value(
        "datetime",
        ValueRef::to_owned(&value).try_decode::<OffsetDateTime>(),
        |value| {
          let utc = value.to_offset(time::UtcOffset::UTC);
          format_datetime(PrimitiveDateTime::new(utc.date(), utc.time()))
        },
      )
    }
    "TINYBLOB" | "MEDIUMBLOB" | "BLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" | "GEOMETRY" => {
      tagged_binary_value(ValueRef::to_owned(&value).try_decode::<Vec<u8>>())
    }
    "NULL" => Ok(JsonValue::Null),
    _ => Err(QueryError::message(format!("{UNSUPPORTED_COLUMN_TYPE}: {type_name}"))),
  }
}

fn decode_postgres(value: PgValueRef<'_>) -> Result<JsonValue, QueryError> {
  if value.is_null() {
    return Ok(JsonValue::Null);
  }

  let type_info = value.type_info();
  let type_name = type_info.name();
  match type_name {
    "INT2" => json_value(ValueRef::to_owned(&value).try_decode::<i16>()),
    "INT4" => json_value(ValueRef::to_owned(&value).try_decode::<i32>()),
    "JSON" | "JSONB" => tagged_json_value(ValueRef::to_owned(&value).try_decode::<JsonValue>()),
    "CHAR" | "VARCHAR" | "TEXT" | "NAME" => {
      json_value(ValueRef::to_owned(&value).try_decode::<String>())
    }
    // UUID 此前与字符串共用分支，但 sqlx 不允许把 UUID 解成 String，
    // 任何 uuid 列都会报 mismatched types
    "UUID" => tagged_display_value("text", ValueRef::to_owned(&value).try_decode::<uuid::Uuid>()),
    "INT8" => tagged_display_value("bigint", ValueRef::to_owned(&value).try_decode::<i64>()),
    "NUMERIC" => {
      let decimal = ValueRef::to_owned(&value)
        .try_decode::<sqlx::types::BigDecimal>()
        .map_err(QueryError::from)?;
      let decimal = match pg_numeric_display_scale(&value) {
        Some(scale) => decimal.with_scale(scale),
        None => decimal,
      };
      Ok(tagged_value("decimal", decimal.to_string()))
    }
    "FLOAT4" => json_value(ValueRef::to_owned(&value).try_decode::<f32>()),
    "FLOAT8" => json_value(ValueRef::to_owned(&value).try_decode::<f64>()),
    "BOOL" => json_value(ValueRef::to_owned(&value).try_decode::<bool>()),
    "DATE" => {
      tagged_formatted_value("date", ValueRef::to_owned(&value).try_decode::<Date>(), format_date)
    }
    "TIME" => {
      tagged_formatted_value("time", ValueRef::to_owned(&value).try_decode::<Time>(), format_time)
    }
    "TIMESTAMP" => tagged_formatted_value(
      "datetime",
      ValueRef::to_owned(&value).try_decode::<PrimitiveDateTime>(),
      format_datetime,
    ),
    "TIMESTAMPTZ" => {
      let value =
        ValueRef::to_owned(&value).try_decode::<DateTime<Utc>>().map_err(QueryError::from)?;
      Ok(tagged_value("datetime", value.to_rfc3339()))
    }
    "BYTEA" => tagged_binary_value(ValueRef::to_owned(&value).try_decode::<Vec<u8>>()),
    "TEXT[]" | "VARCHAR[]" | "NAME[]" => {
      json_value(ValueRef::to_owned(&value).try_decode::<Vec<String>>())
    }
    "INT2[]" => json_value(ValueRef::to_owned(&value).try_decode::<Vec<i16>>()),
    "INT4[]" => json_value(ValueRef::to_owned(&value).try_decode::<Vec<i32>>()),
    "INT8[]" => json_value(ValueRef::to_owned(&value).try_decode::<Vec<i64>>()),
    "INTERVAL" => {
      let interval = ValueRef::to_owned(&value)
        .try_decode::<sqlx::postgres::types::PgInterval>()
        .map_err(QueryError::from)?;
      Ok(tagged_value("time", format_pg_interval(&interval)))
    }
    "VOID" => Ok(JsonValue::Null),
    _ => Err(QueryError::message(format!("{UNSUPPORTED_COLUMN_TYPE}: {type_name}"))),
  }
}

/// `time` 的 Display 是给人读的调试形态：`7:04:05.0`——小时不补零、秒后面恒带
/// 小数，`OffsetDateTime` 还挂一段 ` +00:00:00`。数据库自己不这么写，日期选择器
/// 认不出（小时要两位），拿它去比较或写回也要赌服务端的宽容。
/// 这里照数据库的文本输出：两位小时，小数秒只在非零时出现并去掉末尾的 0
/// （PostgreSQL 就是这么输出的；MySQL 按列的精度补 0，值相同）。
pub(crate) fn format_date(date: Date) -> String {
  format!("{:04}-{:02}-{:02}", date.year(), u8::from(date.month()), date.day())
}

pub(crate) fn format_time(time: Time) -> String {
  let whole = format!("{:02}:{:02}:{:02}", time.hour(), time.minute(), time.second());
  match time.microsecond() {
    0 => whole,
    micros => format!("{whole}.{}", format!("{micros:06}").trim_end_matches('0')),
  }
}

pub(crate) fn format_datetime(value: PrimitiveDateTime) -> String {
  format!("{} {}", format_date(value.date()), format_time(value.time()))
}

/// PostgreSQL 二进制 NUMERIC 头里的 `dscale`：声明的（或字面量自带的）小数位数。
///
/// sqlx 0.8 转 BigDecimal 时不看它，标度按万进制数字组的个数算：`NUMERIC(10,2)`
/// 的 `10.50` 读成 `10.5000`，`10.00` 读成 `10`，`10000` 的标度是负的。PostgreSQL
/// 自己的文本输出正是按 dscale 写的，这里照它重设标度。重设不丢值：dscale 之外
/// 的数字按协议恒为 0。
///
/// 头部是四个 16 位大端整数：ndigits、weight、sign、dscale。文本格式的值没有这个头。
fn pg_numeric_display_scale(value: &PgValueRef<'_>) -> Option<i64> {
  if value.format() != sqlx::postgres::PgValueFormat::Binary {
    return None;
  }
  match value.as_bytes().ok()? {
    [_, _, _, _, _, _, high, low, ..] => Some(i64::from(u16::from_be_bytes([*high, *low]))),
    _ => None,
  }
}

/// MySQL 的 TIME 是带符号时长，按它自己的 `[-]HH:MM:SS` 文本形式呈现。
fn format_mysql_time(duration: time::Duration) -> String {
  let sign = if duration.is_negative() { "-" } else { "" };
  let total = duration.abs();
  let hours = total.whole_hours();
  let minutes = total.whole_minutes() % 60;
  let seconds = total.whole_seconds() % 60;
  format!("{sign}{hours:02}:{minutes:02}:{seconds:02}")
}

/// PostgreSQL 的 interval 由「月 / 日 / 微秒」三段组成，没有统一的标量表示，
/// 这里按 PostgreSQL 自己的文本形式拼回去。
fn format_pg_interval(interval: &sqlx::postgres::types::PgInterval) -> String {
  let mut parts = Vec::new();
  if interval.months != 0 {
    parts.push(format!("{} mons", interval.months));
  }
  if interval.days != 0 {
    parts.push(format!("{} days", interval.days));
  }
  if interval.microseconds != 0 || parts.is_empty() {
    let total_seconds = interval.microseconds as f64 / 1_000_000.0;
    parts.push(format!("{total_seconds} secs"));
  }
  parts.join(" ")
}

fn json_value<T, E>(value: Result<T, E>) -> Result<JsonValue, QueryError>
where
  T: Serialize,
  E: std::fmt::Display,
{
  let decoded = value.map_err(display_error)?;
  serde_json::to_value(decoded).map_err(display_error)
}

fn tagged_display_value<T, E>(
  value_type: &str,
  value: Result<T, E>,
) -> Result<JsonValue, QueryError>
where
  T: std::fmt::Display,
  E: std::fmt::Display,
{
  value.map(|value| tagged_value(value_type, value.to_string())).map_err(display_error)
}

fn tagged_formatted_value<T, E>(
  value_type: &str,
  value: Result<T, E>,
  format: impl FnOnce(T) -> String,
) -> Result<JsonValue, QueryError>
where
  E: std::fmt::Display,
{
  value.map(|value| tagged_value(value_type, format(value))).map_err(display_error)
}

fn tagged_json_value<E>(value: Result<JsonValue, E>) -> Result<JsonValue, QueryError>
where
  E: std::fmt::Display,
{
  let value = value.map_err(display_error)?;
  let serialized = serde_json::to_string(&value).map_err(display_error)?;
  Ok(tagged_value("json", serialized))
}

fn tagged_binary_value<E>(value: Result<Vec<u8>, E>) -> Result<JsonValue, QueryError>
where
  E: std::fmt::Display,
{
  value
    .map(|bytes| {
      let encoded = bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
      tagged_value("binary", encoded)
    })
    .map_err(display_error)
}

/// 解码失败、序列化失败这类：错误来自我们这一侧，没有数据库给的结构可取，
/// 只留一句话。和 `QueryError::from(sqlx::Error)` 分开是为了不把
/// 「数据库说的」和「我们说的」混成一种东西。
pub(crate) fn display_error(error: impl std::fmt::Display) -> QueryError {
  QueryError::message(error.to_string())
}

pub(crate) fn tagged_value(value_type: &str, value: String) -> JsonValue {
  JsonValue::Object(Map::from_iter([
    ("type".to_string(), JsonValue::String(value_type.to_string())),
    ("value".to_string(), JsonValue::String(value)),
  ]))
}

#[cfg(test)]
mod tests {
  use super::*;
  use sqlx::sqlite::SqlitePoolOptions;
  use std::future::pending;

  #[test]
  fn date_and_time_values_come_out_the_way_the_database_writes_them() {
    let date = Date::from_calendar_date(2026, time::Month::September, 3).expect("valid date");
    let morning = Time::from_hms(7, 4, 5).expect("valid time");
    assert_eq!(format_date(date), "2026-09-03");
    assert_eq!(format_time(morning), "07:04:05");
    assert_eq!(format_datetime(PrimitiveDateTime::new(date, morning)), "2026-09-03 07:04:05");
    // 小数秒去掉末尾的 0，但不丢前导 0
    let fractional = Time::from_hms_micro(0, 0, 0, 50_000).expect("valid time");
    assert_eq!(format_time(fractional), "00:00:00.05");
    let micro = Time::from_hms_micro(23, 59, 59, 1).expect("valid time");
    assert_eq!(format_time(micro), "23:59:59.000001");
  }

  #[test]
  fn refuses_use_but_not_statements_that_merely_start_like_it() {
    for sql in ["USE other_db", "use `other db`;", "-- 切库\nUSE other_db", "/* x */ Use other_db"]
    {
      assert!(refuse_use_statement(sql).is_err(), "expected refusal: {sql}");
    }
    for sql in ["SELECT 'USE other_db'", "USER_DEFINED", "UPDATE users SET name = 'use'"] {
      assert!(refuse_use_statement(sql).is_ok(), "expected pass-through: {sql}");
    }
  }

  #[test]
  fn recognizes_transaction_control_statements_without_matching_prefixes() {
    for sql in [
      "BEGIN",
      "begin transaction;",
      "START TRANSACTION",
      "COMMIT WORK",
      "ROLLBACK TO SAVEPOINT before_update",
      "SAVEPOINT before_update",
      "RELEASE SAVEPOINT before_update",
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
    ] {
      assert!(is_transaction_control_statement(sql), "expected transaction SQL: {sql}");
    }

    assert!(!is_transaction_control_statement("SELECT 'BEGIN'"));
    assert!(!is_transaction_control_statement("BEGINNING"));
  }

  #[test]
  fn maps_driver_types_to_logical_types() {
    assert_eq!(sqlite_logical_type("INTEGER"), "integer");
    assert_eq!(sqlite_logical_type("BLOB"), "binary");
    assert_eq!(mysql_logical_type("DECIMAL"), "decimal");
    assert_eq!(mysql_logical_type("JSON"), "json");
    assert_eq!(postgres_logical_type("TIMESTAMPTZ"), "datetime");
    assert_eq!(postgres_logical_type("UUID"), "text");
    assert_eq!(postgres_logical_type("CUSTOM"), "unknown");
  }

  #[tokio::test]
  async fn uses_driver_metadata_for_empty_result_sets() {
    let pool = SqlitePoolOptions::new()
      .max_connections(1)
      .connect("sqlite::memory:")
      .await
      .expect("connect to SQLite");
    let result = execute_query(&DbPool::Sqlite(pool), "SELECT 1 AS value WHERE 1 = 0")
      .await
      .expect("execute empty query");

    match result {
      QueryExecutionResult::Rows { columns, rows, truncated, row_limit, .. } => {
        assert_eq!(columns, vec!["value"]);
        assert!(rows.is_empty());
        assert!(!truncated);
        assert_eq!(row_limit, DEFAULT_QUERY_ROW_LIMIT);
      }
      QueryExecutionResult::Affected { .. } => panic!("expected a row result"),
    }
  }

  #[tokio::test]
  async fn stops_fetching_after_the_configured_row_limit() {
    let pool = SqlitePoolOptions::new()
      .max_connections(1)
      .connect("sqlite::memory:")
      .await
      .expect("connect to SQLite");
    let result = execute_query_with_limit(
      &DbPool::Sqlite(pool),
      "SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3",
      2,
    )
    .await
    .expect("execute limited query");

    match result {
      QueryExecutionResult::Rows { rows, truncated, row_limit, .. } => {
        assert_eq!(rows.len(), 2);
        assert!(truncated);
        assert_eq!(row_limit, 2);
      }
      QueryExecutionResult::Affected { .. } => panic!("expected a row result"),
    }
  }

  #[tokio::test]
  async fn streams_ordered_result_batches() {
    let pool = SqlitePoolOptions::new()
      .max_connections(1)
      .connect("sqlite::memory:")
      .await
      .expect("connect to SQLite");
    let mut connection = pool.acquire().await.expect("acquire SQLite connection");
    let mut batches = Vec::new();
    let summary = execute_sqlite_connection_streaming(
      &mut connection,
      "SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5",
      StreamOptions::limited(5, DEFAULT_QUERY_BYTE_LIMIT, 2),
      &mut |batch| {
        batches.push(batch);
        Ok(())
      },
    )
    .await
    .expect("stream rows");

    match summary {
      QueryExecutionSummary::Rows { row_count, batch_count, truncated, .. } => {
        assert_eq!(row_count, 5);
        assert_eq!(batch_count, 3);
        assert!(!truncated);
      }
      QueryExecutionSummary::Affected { .. } => panic!("expected rows"),
    }
    assert_eq!(batches.iter().map(|batch| batch.offset).collect::<Vec<_>>(), vec![0, 2, 4]);
    assert_eq!(batches.iter().map(|batch| batch.rows.len()).collect::<Vec<_>>(), vec![2, 2, 1]);
  }

  #[tokio::test]
  async fn stops_streaming_before_exceeding_the_byte_budget() {
    let pool = SqlitePoolOptions::new()
      .max_connections(1)
      .connect("sqlite::memory:")
      .await
      .expect("connect to SQLite");
    let mut connection = pool.acquire().await.expect("acquire SQLite connection");
    let mut batches = Vec::new();
    let summary = execute_sqlite_connection_streaming(
      &mut connection,
      "SELECT 'a value larger than the budget' AS value",
      StreamOptions::limited(100, 1, 10),
      &mut |batch| {
        batches.push(batch);
        Ok(())
      },
    )
    .await
    .expect("enforce byte budget");

    match summary {
      QueryExecutionSummary::Rows {
        row_count, truncated, truncation_reason, bytes_read, ..
      } => {
        assert_eq!(row_count, 0);
        assert!(truncated);
        assert_eq!(truncation_reason, Some(QueryTruncationReason::ByteLimit));
        assert_eq!(bytes_read, 0);
      }
      QueryExecutionSummary::Affected { .. } => panic!("expected rows"),
    }
    assert!(batches.is_empty());
  }

  #[tokio::test]
  async fn distinguishes_affected_rows_from_returning_rows() {
    let pool = SqlitePoolOptions::new()
      .max_connections(1)
      .connect("sqlite::memory:")
      .await
      .expect("connect to SQLite");
    sqlx::query("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
      .execute(&pool)
      .await
      .expect("create table");
    let pool = DbPool::Sqlite(pool);

    let affected =
      execute_query(&pool, "INSERT INTO items (name) VALUES ('first')").await.expect("insert row");
    assert!(matches!(affected, QueryExecutionResult::Affected { rows_affected: 1 }));

    let returned =
      execute_query(&pool, "INSERT INTO items (name) VALUES ('second') RETURNING id, name")
        .await
        .expect("insert returning row");
    match returned {
      QueryExecutionResult::Rows { columns, rows, .. } => {
        assert_eq!(columns, vec!["id", "name"]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], "second");
      }
      QueryExecutionResult::Affected { .. } => panic!("expected returned rows"),
    }
  }

  #[tokio::test]
  async fn reports_timeout_with_a_stable_error_code() {
    let error = with_timeout(
      async {
        pending::<()>().await;
        Ok::<(), QueryError>(())
      },
      Duration::from_millis(1),
    )
    .await;

    let error = error.expect_err("pending query should time out");
    // 码单独成一个字段，不再拼在消息前缀里：消息是要翻译的，
    // 按前缀匹配等于把「这是超时」的判断绑在某一种语言上
    assert_eq!(error.code.as_deref(), Some(QUERY_TIMEOUT_CODE));
    assert_eq!(error.message, format!("{QUERY_TIMEOUT}: 1"));
  }
}
