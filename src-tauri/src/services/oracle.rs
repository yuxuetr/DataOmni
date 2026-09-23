//! Oracle：插件之外的第五种关系库，驱动是 ODPI-C（`oracle` crate）。
//!
//! 和 SQL Server 一样由后端自己持有连接（见 [`crate::services::pool_registry`]），
//! 不同的有三处：
//!
//! - **驱动是阻塞的。** 每一次调用都放进 `spawn_blocking`；结果集由阻塞那一侧
//!   一行行读、成批送过通道，限额与分批仍在异步这一侧，用的是和另外几家同一套
//!   `flush_full_batch` / `admit_row_bytes`。
//! - **要一份 Instant Client。** ODPI-C 在运行时 dlopen `libclntsh`，文件随安装包
//!   发（见 [`set_client_dir`]），找不到就报 [`ORACLE_CLIENT_MISSING`] 并说出找的是
//!   哪个目录。
//! - **取消是真的取消。** 执行的 future 被丢掉（超时、取消）时发一次
//!   `break_execution`，服务端那条语句随之停下（实验：CPU 密集的查询 1.5 秒打断，
//!   `v$session` 里不再有它）。连接随后丢掉不用：一条被打断的调用之后连接处于
//!   什么状态，阻塞线程结束之前说不清。
//!
//! 事务这一阶段不开放：连接不开驱动的自动提交，每条非查询语句成功之后由这里
//! 提交，界面上的事务开关在第二阶段接上。

use crate::models::ConnectionProfile;
use crate::services::query_error::QueryErrorDetails;
use crate::services::query_error::{CONNECTION_LOST, CONNECTION_LOST_CODE};
use crate::services::query_executor::{
  admit_row_bytes, flush_full_batch, flush_remaining_batch, tagged_value, QueryColumnMetadata,
  QueryExecutionSummary, QueryResultBatch, QueryRow, QueryTruncationReason, StreamOptions,
};
use crate::services::QueryError;
use oracle::sql_type::{OracleType, Timestamp};
use oracle::{Connection, Connector, InitParams, SqlValue};
use serde_json::{Map, Value as JsonValue};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

pub type OracleRegistry = crate::services::pool_registry::PoolRegistry<OraclePool>;

/// 列类型的完整写法，`VARCHAR2(20 CHAR)`、`NUMBER(10,2)`、`RAW(8)`。
///
/// `ALL_TAB_COLUMNS.DATA_TYPE` 只给名字（时间类型例外，`TIMESTAMP(6)` 本身带精度），
/// 长度精度在另外几列里；字符型按字符还是按字节计由 `CHAR_USED` 说了算。
/// 引用的别名固定是 `c`。
macro_rules! oracle_type_name {
  () => {
    "CASE
    WHEN c.data_type IN ('VARCHAR2', 'CHAR')
      THEN c.data_type || '(' || c.char_length || CASE WHEN c.char_used = 'C' THEN ' CHAR' END || ')'
    WHEN c.data_type IN ('NVARCHAR2', 'NCHAR') THEN c.data_type || '(' || c.char_length || ')'
    WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL
      THEN 'NUMBER(' || c.data_precision || CASE WHEN c.data_scale > 0 THEN ',' || c.data_scale END || ')'
    WHEN c.data_type = 'NUMBER' AND c.data_scale = 0 THEN 'INTEGER'
    WHEN c.data_type IN ('RAW', 'UROWID') THEN c.data_type || '(' || c.data_length || ')'
    WHEN c.data_type = 'FLOAT' THEN 'FLOAT(' || c.data_precision || ')'
    ELSE c.data_type
  END"
  };
}
pub(crate) use oracle_type_name;

/// 不是 Oracle 自带的 schema。`ALL_OBJECTS` 里 SYS 一家就有几万个对象，
/// 不筛掉的话对象树与补全目录全被它们占满。别名固定是 `u`
macro_rules! oracle_user_schemas {
  () => {
    "u.oracle_maintained = 'N'"
  };
}
pub(crate) use oracle_user_schemas;

/// 当前 schema。目录查询的第二个参数是 schema，前端不给（`null`）时落在这里
macro_rules! oracle_current_schema {
  () => {
    "SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')"
  };
}
pub(crate) use oracle_current_schema;

/// 连接串的 scheme。前端据此认出这条连接不归插件管
pub const ORACLE_SCHEME: &str = "oracle://";

/// 找不到 Instant Client。数据是找过的目录
pub const ORACLE_CLIENT_MISSING: &str = "DATAOMNI_ORACLE_CLIENT_MISSING";
/// Instant Client 在，但加载失败（缺系统库、平台不对）。数据是 ODPI-C 的原话
pub const ORACLE_CLIENT_LOAD_FAILED: &str = "DATAOMNI_ORACLE_CLIENT_LOAD_FAILED";
/// 这一阶段还没接上的操作。数据是操作名
pub const ORACLE_UNSUPPORTED: &str = "DATAOMNI_ORACLE_UNSUPPORTED";

/// 开发与测试时覆盖 Instant Client 的位置
const CLIENT_DIR_ENV: &str = "DATAOMNI_ORACLE_CLIENT_DIR";

/// 空闲连接留几条。Oracle 的一次登录要几百毫秒，目录查询是零星的，四条够了
const MAX_IDLE: usize = 4;

/// 每次往返取多少行
const FETCH_ARRAY_SIZE: u32 = 256;

static CLIENT_DIR: OnceLock<PathBuf> = OnceLock::new();
static CLIENT: OnceLock<Result<(), QueryError>> = OnceLock::new();

/// 应用启动时告诉这里：安装包里的 Instant Client 在哪个目录。
///
/// 只在第一次连 Oracle 时才真的加载——不连 Oracle 的用户不该为它付启动时间，
/// 也不该因为它缺了什么而启动失败。
pub fn set_client_dir(dir: PathBuf) {
  let _ = CLIENT_DIR.set(dir);
}

fn client_dir() -> Option<PathBuf> {
  std::env::var_os(CLIENT_DIR_ENV).map(PathBuf::from).or_else(|| CLIENT_DIR.get().cloned())
}

/// 加载 Instant Client。整个进程只能做一次（ODPI-C 的全局上下文），失败也记住：
/// 同一个目录里缺的文件不会在第二次连接时自己长出来。
fn ensure_client() -> Result<(), QueryError> {
  CLIENT
    .get_or_init(|| {
      let dir =
        client_dir().ok_or_else(|| QueryError::message(format!("{ORACLE_CLIENT_MISSING}: -")))?;
      if !has_client_library(&dir) {
        return Err(QueryError::message(format!("{ORACLE_CLIENT_MISSING}: {}", dir.display())));
      }
      let dir = loadable_dir(&dir)
        .map_err(|error| QueryError::message(format!("{ORACLE_CLIENT_LOAD_FAILED}: {error}")))?;
      InitParams::new()
        .oracle_client_lib_dir(&dir)
        .and_then(|params| params.default_driver_name("DataOmni"))
        .and_then(|params| params.init())
        .map(|_| ())
        .map_err(|error| QueryError::message(format!("{ORACLE_CLIENT_LOAD_FAILED}: {error}")))
    })
    .clone()
}

/// ODPI-C 按目录找的是**不带版本号**的名字（`libclntsh.dylib`、`libclntsh.so`），
/// Instant Client 里它是指向 `…23.1` 的符号链接。安装包里放不了符号链接：打包时
/// 会被当成文件再拷一份（macOS 上多出 56 MB）；也不能改名：依赖它的库（libociicus）
/// 按原名找它，只剩改过名的那一份时进程直接崩（实验：SIGSEGV）。
///
/// 所以安装包里只放原样的文件，第一次加载时在临时目录里铺一层符号链接——每个文件
/// 链回原处，再补上那个不带版本号的名字。文件本身一个字节都不动（许可要求原样分发）。
#[cfg(unix)]
fn loadable_dir(dir: &Path) -> std::io::Result<PathBuf> {
  let plain = if cfg!(target_os = "macos") { "libclntsh.dylib" } else { "libclntsh.so" };
  if dir.join(plain).exists() {
    return Ok(dir.to_path_buf());
  }
  let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(dir)?.flatten().collect();
  let versioned = entries
    .iter()
    .find(|entry| entry.file_name().to_string_lossy().starts_with(&format!("{plain}.")))
    .map(std::fs::DirEntry::path)
    .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, plain))?;

  // 按来源目录区分，同一份安装包每次落在同一个地方；两个进程同时铺也不打架：
  // 已经在、而且指对了的链接直接用
  let digest = dir
    .to_string_lossy()
    .bytes()
    .fold(0u64, |hash, byte| hash.wrapping_mul(31).wrapping_add(u64::from(byte)));
  let shadow = std::env::temp_dir().join(format!("dataomni-instantclient-{digest:016x}"));
  std::fs::create_dir_all(&shadow)?;
  let links = entries
    .iter()
    .map(|entry| (entry.path(), shadow.join(entry.file_name())))
    .chain(std::iter::once((versioned, shadow.join(plain))));
  for (source, link) in links {
    if std::fs::read_link(&link).is_ok_and(|current| current == source) {
      continue;
    }
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&source, &link)?;
  }
  Ok(shadow)
}

#[cfg(not(unix))]
fn loadable_dir(dir: &Path) -> std::io::Result<PathBuf> {
  Ok(dir.to_path_buf())
}

/// 带版本号的文件名也算：安装包里不放符号链接（打包时会被当成文件再拷一份，
/// libclntsh 一个就 100 MB），ODPI-C 自己会按版本号去找
fn has_client_library(dir: &Path) -> bool {
  std::fs::read_dir(dir).is_ok_and(|entries| {
    entries.flatten().any(|entry| {
      let name = entry.file_name();
      let name = name.to_string_lossy();
      name.starts_with("libclntsh.") || name.eq_ignore_ascii_case("oci.dll")
    })
  })
}

/// 连上一台 Oracle 需要知道的全部。
///
/// 用 Easy Connect（`//host:port/service`）：`database` 那一格填的是服务名。
/// 按 SID 连、TLS（要钱包）这一阶段不做。
#[derive(Clone)]
pub struct OracleTarget {
  connect_string: String,
  username: String,
  password: String,
}

impl OracleTarget {
  pub fn from_profile(profile: &ConnectionProfile) -> Self {
    Self {
      connect_string: format!(
        "//{}:{}/{}",
        profile.host,
        profile.port,
        profile.database.as_deref().unwrap_or("")
      ),
      username: profile.username.clone(),
      password: profile.password.clone(),
    }
  }
}

pub async fn connect(target: &OracleTarget) -> Result<Arc<Connection>, QueryError> {
  let target = target.clone();
  blocking(move || {
    ensure_client()?;
    Connector::new(&target.username, &target.password, &target.connect_string)
      .connect()
      .map(Arc::new)
      .map_err(|error| query_error(&error, None))
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

/// 一台服务器的连接：一份连接参数，加几条空闲连接（目录查询用）。
pub struct OraclePool {
  target: OracleTarget,
  idle: Mutex<Vec<Arc<Connection>>>,
}

impl OraclePool {
  /// `first` 是测试连接时连上的那一条，直接留着用，省一次登录
  pub fn new(target: OracleTarget, first: Arc<Connection>) -> Arc<Self> {
    Arc::new(Self { target, idle: Mutex::new(vec![first]) })
  }

  /// 给一个会话用的连接：用完不放回，理由和 SQL Server 一样——会话上可能开着
  /// 事务、改过 `ALTER SESSION`
  pub async fn acquire_for_session(&self) -> Result<OracleConnection, QueryError> {
    Ok(OracleConnection {
      connection: Some(connect(&self.target).await?),
      target: self.target.clone(),
    })
  }

  /// 目录查询：带 `:1`、`:2` 绑定参数，返回**不带类型标签**的值，和插件 `select`
  /// 的形状一样
  pub async fn select(
    self: &Arc<Self>,
    sql: &str,
    params: &[JsonValue],
  ) -> Result<Vec<QueryRow>, QueryError> {
    let idle = self.idle.lock().ok().and_then(|mut idle| idle.pop());
    let connection = match idle {
      Some(connection) => connection,
      None => connect(&self.target).await?,
    };
    let sql = sql.to_string();
    let params = params.to_vec();
    let worker = Arc::clone(&connection);
    let result = blocking(move || select_rows(&worker, &sql, &params)).await;
    if keeps_connection(&result) {
      if let Ok(mut idle) = self.idle.lock() {
        if idle.len() < MAX_IDLE {
          idle.push(connection);
        }
      }
    }
    result
  }
}

fn select_rows(
  connection: &Connection,
  sql: &str,
  params: &[JsonValue],
) -> Result<Vec<QueryRow>, QueryError> {
  let binds = bind_values(params)?;
  let bind_refs: Vec<&dyn oracle::sql_type::ToSql> =
    binds.iter().map(|value| value as &dyn oracle::sql_type::ToSql).collect();
  let rows = connection.query(sql, &bind_refs).map_err(|error| query_error(&error, Some(sql)))?;
  let columns: Vec<(String, OracleType)> = rows
    .column_info()
    .iter()
    .map(|info| (info.name().to_string(), info.oracle_type().clone()))
    .collect();
  let mut result = Vec::new();
  for row in rows {
    let row = row.map_err(|error| query_error(&error, Some(sql)))?;
    let mut values = Map::new();
    for ((name, oracle_type), value) in columns.iter().zip(row.sql_values()) {
      values.insert(name.clone(), untagged(decode(oracle_type, value)?));
    }
    result.push(values);
  }
  Ok(result)
}

/// 绑定参数：只认标量，理由同 `write_batch` 的 `bind_params!`
enum Bind {
  Null(Option<String>),
  Text(String),
  Integer(i64),
  Float(f64),
  Boolean(bool),
}

/// 文本按 VARCHAR2 绑，不用驱动默认的 NVARCHAR2：目录里的名字都是 VARCHAR2，
/// NVARCHAR2 的参数在 `COALESCE(:2, SYS_CONTEXT(...))` 里报 ORA-12704（字符集
/// 不一致），在 `table_name = :1` 里让服务端把**列**转成 NVARCHAR2——数据字典上
/// 的索引就用不上了
impl oracle::sql_type::ToSql for Bind {
  fn oratype(&self, conn: &Connection) -> oracle::Result<OracleType> {
    match self {
      Bind::Null(_) => Ok(OracleType::Varchar2(1)),
      Bind::Text(value) => {
        Ok(OracleType::Varchar2(u32::try_from(value.len().max(1)).unwrap_or(u32::MAX)))
      }
      Bind::Integer(value) => value.oratype(conn),
      Bind::Float(value) => value.oratype(conn),
      Bind::Boolean(value) => value.oratype(conn),
    }
  }

  fn to_sql(&self, value: &mut SqlValue) -> oracle::Result<()> {
    match self {
      Bind::Null(inner) => inner.to_sql(value),
      Bind::Text(inner) => inner.to_sql(value),
      Bind::Integer(inner) => inner.to_sql(value),
      Bind::Float(inner) => inner.to_sql(value),
      Bind::Boolean(inner) => inner.to_sql(value),
    }
  }
}

impl oracle::sql_type::ToSqlNull for Bind {
  fn oratype_for_null(_conn: &Connection) -> oracle::Result<OracleType> {
    Ok(OracleType::Varchar2(1))
  }
}

fn bind_values(params: &[JsonValue]) -> Result<Vec<Bind>, QueryError> {
  params
    .iter()
    .map(|param| match param {
      JsonValue::Null => Ok(Bind::Null(None)),
      JsonValue::Bool(value) => Ok(Bind::Boolean(*value)),
      JsonValue::Number(number) => Ok(match number.as_i64() {
        Some(integer) => Bind::Integer(integer),
        None => Bind::Float(number.as_f64().unwrap_or(f64::NAN)),
      }),
      JsonValue::String(text) => Ok(Bind::Text(text.clone())),
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
/// 和 SQL Server 一样，执行期间把连接取出来：执行的 future 被丢掉时它就回不来了，
/// 下一次用的时候重连。
pub struct OracleConnection {
  connection: Option<Arc<Connection>>,
  target: OracleTarget,
}

/// future 被丢掉时（超时、取消）打断服务端那条语句。
///
/// 阻塞线程还在等驱动返回，拿不回来；但它手里的是同一条连接，`break_execution`
/// 可以从别的线程调。
struct BreakOnDrop {
  connection: Arc<Connection>,
  finished: bool,
}

impl Drop for BreakOnDrop {
  fn drop(&mut self) {
    if !self.finished {
      let _ = self.connection.break_execution();
    }
  }
}

/// 阻塞那一侧送过来的东西
enum Fetched {
  Columns(Vec<QueryColumnMetadata>, Vec<String>),
  Row(QueryRow),
}

impl OracleConnection {
  async fn take_connection(&mut self) -> Result<Arc<Connection>, QueryError> {
    match self.connection.take() {
      Some(connection) => Ok(connection),
      None => connect(&self.target).await,
    }
  }

  pub async fn execute_streaming(
    &mut self,
    sql: &str,
    options: StreamOptions,
    sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
  ) -> Result<QueryExecutionSummary, QueryError> {
    if options.explain_plan {
      return Err(unsupported("explain"));
    }
    let connection = self.take_connection().await?;
    let mut guard = BreakOnDrop { connection: Arc::clone(&connection), finished: false };
    let statement = statement_text(sql);
    let refuse_non_query = options.non_query == crate::services::NonQueryHandling::Refuse;

    // 通道留几批的余量：阻塞那一侧可以先读着，异步这一侧到了上限就丢掉接收端，
    // 那一侧下一次送不出去就停
    let (sender, mut receiver) =
      tokio::sync::mpsc::channel::<Fetched>(options.batch_size.max(1) * 2);
    let worker = Arc::clone(&connection);
    let task = tokio::task::spawn_blocking(move || -> Result<Option<u64>, QueryError> {
      let mut prepared = worker
        .statement(&statement)
        .fetch_array_size(FETCH_ARRAY_SIZE)
        .build()
        .map_err(|error| query_error(&error, Some(&statement)))?;
      if !prepared.is_query() {
        if refuse_non_query {
          return Err(QueryError::message(crate::services::query_executor::NON_QUERY_MESSAGE));
        }
        prepared.execute(&[]).map_err(|error| query_error(&error, Some(&statement)))?;
        // PL/SQL 块的「影响行数」驱动恒报 1，那不是任何一张表上的行数
        let affected = if prepared.is_plsql() {
          0
        } else {
          prepared.row_count().map_err(|error| query_error(&error, None))?
        };
        worker.commit().map_err(|error| query_error(&error, None))?;
        return Ok(Some(affected));
      }
      let rows = prepared.query(&[]).map_err(|error| query_error(&error, Some(&statement)))?;
      let columns: Vec<(String, OracleType, bool)> = rows
        .column_info()
        .iter()
        .map(|info| (info.name().to_string(), info.oracle_type().clone(), info.nullable()))
        .collect();
      let names = label_columns(columns.iter().map(|(name, _, _)| name.as_str()));
      let metadata = columns
        .iter()
        .zip(&names)
        .enumerate()
        .map(|(ordinal, ((_, oracle_type, nullable), name))| QueryColumnMetadata {
          name: name.clone(),
          ordinal,
          database_type: oracle_type.to_string(),
          logical_type: logical_type(oracle_type).to_string(),
          nullable: Some(*nullable),
        })
        .collect();
      if sender.blocking_send(Fetched::Columns(metadata, names.clone())).is_err() {
        return Ok(None);
      }
      for row in rows {
        let row = row.map_err(|error| query_error(&error, Some(&statement)))?;
        let mut values = Map::new();
        for ((name, (_, oracle_type, _)), value) in names.iter().zip(&columns).zip(row.sql_values())
        {
          values.insert(name.clone(), decode(oracle_type, value)?);
        }
        if sender.blocking_send(Fetched::Row(values)).is_err() {
          break;
        }
      }
      Ok(None)
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
    // 到了上限就不再要：接收端一丢，阻塞那一侧下一次送不出去就停下，游标随
    // 语句一起关掉。和 TDS 不同，Oracle 不要求把剩下的行读完
    drop(receiver);
    let outcome = task.await.map_err(|error| {
      QueryError::with_code(CONNECTION_LOST_CODE, format!("{CONNECTION_LOST}: {error}"))
    })?;
    guard.finished = true;

    let keep = keeps_connection(&outcome);
    if keep {
      self.connection = Some(connection);
    }
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

pub(crate) fn unsupported(operation: &str) -> QueryError {
  QueryError::message(format!("{ORACLE_UNSUPPORTED}: {operation}"))
}

/// 发给服务端的那段文本。
///
/// 编辑器按分号切语句，每条后面补一个分号；Oracle 的 SQL 语句**不收**结尾的
/// 分号（ORA-00933 / ORA-00911），而 PL/SQL 块正相反，`END;` 的分号是块的一部分。
fn statement_text(sql: &str) -> String {
  let trimmed = sql.trim();
  if is_plsql(trimmed) {
    return trimmed.to_string();
  }
  trimmed.trim_end_matches(|c: char| c == ';' || c.is_whitespace()).to_string()
}

fn is_plsql(sql: &str) -> bool {
  let (first, second) = crate::services::transaction_state::leading_keywords(sql);
  match first.as_str() {
    "BEGIN" | "DECLARE" => true,
    "CREATE" => {
      let words: Vec<String> =
        sql.split_whitespace().take(6).map(|word| word.to_ascii_uppercase()).collect();
      let kind_at = if second == "OR" { 3 } else { 1 };
      words.get(kind_at).is_some_and(|kind| {
        matches!(kind.as_str(), "PROCEDURE" | "FUNCTION" | "PACKAGE" | "TRIGGER" | "TYPE")
      }) || words.iter().any(|word| word == "EDITIONABLE" || word == "NONEDITIONABLE")
    }
    _ => false,
  }
}

/// 同名的列用编号区分，理由同 SQL Server：结果行按列名做键
fn label_columns<'a>(names: impl Iterator<Item = &'a str>) -> Vec<String> {
  let mut seen = std::collections::HashMap::<String, usize>::new();
  names
    .map(|name| {
      let count = seen.entry(name.to_string()).or_insert(0);
      *count += 1;
      if *count == 1 {
        name.to_string()
      } else {
        format!("{name} {count}")
      }
    })
    .collect()
}

fn logical_type(oracle_type: &OracleType) -> &'static str {
  match oracle_type {
    OracleType::Number(_, 0) | OracleType::Int64 | OracleType::UInt64 => "integer",
    OracleType::Number(_, _)
    | OracleType::Float(_)
    | OracleType::BinaryFloat
    | OracleType::BinaryDouble => "decimal",
    OracleType::Date
    | OracleType::Timestamp(_)
    | OracleType::TimestampTZ(_)
    | OracleType::TimestampLTZ(_) => "datetime",
    OracleType::Raw(_) | OracleType::LongRaw | OracleType::BLOB | OracleType::BFILE => "binary",
    OracleType::Boolean => "boolean",
    OracleType::Json => "json",
    OracleType::Varchar2(_)
    | OracleType::NVarchar2(_)
    | OracleType::Char(_)
    | OracleType::NChar(_)
    | OracleType::Long
    | OracleType::CLOB
    | OracleType::NCLOB
    | OracleType::Rowid
    | OracleType::Xml
    | OracleType::IntervalDS(_, _)
    | OracleType::IntervalYM(_) => "text",
    _ => "unknown",
  }
}

/// JavaScript 数能精确表示的最大整数
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// 一个单元格。约定和另外几家相同：超出安全整数的、小数、时间与二进制带类型
/// 标签，以文本传；其余是裸值。
fn decode(oracle_type: &OracleType, value: &SqlValue) -> Result<JsonValue, QueryError> {
  if value.is_null().map_err(|error| query_error(&error, None))? {
    return Ok(JsonValue::Null);
  }
  let text = || value.get::<String>().map_err(|error| query_error(&error, None));
  Ok(match oracle_type {
    OracleType::Number(_, scale) if *scale > 0 => {
      tagged_value("decimal", with_scale(&text()?, usize::from(scale.unsigned_abs())))
    }
    OracleType::Number(_, 0) | OracleType::Int64 | OracleType::UInt64 => {
      let digits = text()?;
      match digits.parse::<i64>() {
        Ok(integer) if integer.abs() <= MAX_SAFE_INTEGER => JsonValue::from(integer),
        _ => tagged_value("bigint", digits),
      }
    }
    // 不带精度的 NUMBER、FLOAT：服务端给什么位数就是什么位数
    OracleType::Number(_, _) | OracleType::Float(_) => {
      tagged_value("decimal", leading_zero(&text()?))
    }
    OracleType::BinaryFloat | OracleType::BinaryDouble => {
      let number = value.get::<f64>().map_err(|error| query_error(&error, None))?;
      serde_json::Number::from_f64(number)
        .map(JsonValue::Number)
        .unwrap_or_else(|| JsonValue::from(number.to_string()))
    }
    OracleType::Date => {
      let stamp = value.get::<Timestamp>().map_err(|error| query_error(&error, None))?;
      tagged_value("datetime", format_timestamp(&stamp, false))
    }
    OracleType::Timestamp(_) | OracleType::TimestampLTZ(_) => {
      let stamp = value.get::<Timestamp>().map_err(|error| query_error(&error, None))?;
      tagged_value("datetime", format_timestamp(&stamp, false))
    }
    OracleType::TimestampTZ(_) => {
      let stamp = value.get::<Timestamp>().map_err(|error| query_error(&error, None))?;
      tagged_value("datetime", format_timestamp(&stamp, true))
    }
    OracleType::Raw(_) | OracleType::LongRaw | OracleType::BLOB => {
      let bytes = value.get::<Vec<u8>>().map_err(|error| query_error(&error, None))?;
      tagged_value("binary", bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }
    OracleType::Boolean => {
      JsonValue::from(value.get::<bool>().map_err(|error| query_error(&error, None))?)
    }
    _ => JsonValue::from(text()?),
  })
}

/// `NUMBER(10,2)` 的 10.50 驱动给的是 `10.5`：按列声明的标度补齐小数位，和
/// 另外几家（以及 Oracle 自己的 SQL*Plus 按列格式）显示的一致
fn with_scale(text: &str, scale: usize) -> String {
  let text = leading_zero(text);
  let (whole, fraction) = text.split_once('.').unwrap_or((&text, ""));
  if fraction.len() >= scale {
    return text.clone();
  }
  format!("{whole}.{fraction:0<scale$}")
}

/// Oracle 把 0.5 写成 `.5`，-0.5 写成 `-.5`
fn leading_zero(text: &str) -> String {
  if let Some(rest) = text.strip_prefix("-.") {
    return format!("-0.{rest}");
  }
  if let Some(rest) = text.strip_prefix('.') {
    return format!("0.{rest}");
  }
  text.to_string()
}

/// 照另外几家的写法：两位小时，小数秒只在非零时出现并去掉末尾的 0
fn format_timestamp(stamp: &Timestamp, with_zone: bool) -> String {
  let mut text = format!(
    "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
    stamp.year(),
    stamp.month(),
    stamp.day(),
    stamp.hour(),
    stamp.minute(),
    stamp.second()
  );
  if stamp.nanosecond() > 0 {
    let fraction = format!("{:09}", stamp.nanosecond());
    text.push('.');
    text.push_str(fraction.trim_end_matches('0'));
  }
  if with_zone {
    let offset = stamp.tz_offset();
    let sign = if offset < 0 { '-' } else { '+' };
    let minutes = offset.unsigned_abs() / 60;
    text.push_str(&format!(" {sign}{:02}:{:02}", minutes / 60, minutes % 60));
  }
  text
}

fn keeps_connection<T>(result: &Result<T, QueryError>) -> bool {
  !matches!(result, Err(error) if error.code.as_deref() == Some(CONNECTION_LOST_CODE))
}

/// 这些错误说的是「连接没了」，不是「语句错了」
const LOST_CONNECTION_CODES: [i32; 8] = [3113, 3114, 3135, 3156, 12170, 12514, 12541, 28547];

/// 驱动的错误 → 应用的查询错误。
///
/// 服务端错误带 ORA 码与**出错位置**（从 0 起的字符偏移），错误面板按从 1 起的
/// 字符位置标出错处。码写成 `ORA-00942`：那是每个 Oracle 用户认得的写法。
fn query_error(error: &oracle::Error, sql: Option<&str>) -> QueryError {
  let Some(db_error) = error.db_error() else {
    // DPI-1080（连接被服务端关了）、DPI-1010（没连上）这一类
    let text = error.to_string();
    if text.contains("DPI-1080") || text.contains("DPI-1010") || text.contains("DPI-1067") {
      return QueryError::with_code(CONNECTION_LOST_CODE, format!("{CONNECTION_LOST}: {text}"));
    }
    return QueryError::message(text);
  };
  let code = db_error.code();
  let message = db_error.message().to_string();
  if LOST_CONNECTION_CODES.contains(&code) || message.contains("DPI-1080") {
    return QueryError::with_code(CONNECTION_LOST_CODE, format!("{CONNECTION_LOST}: {message}"));
  }
  let position = sql
    .filter(|sql| db_error.offset() > 0 && (db_error.offset() as usize) < sql.chars().count())
    .map(|_| db_error.offset() + 1);
  QueryError {
    message,
    code: (code != 0).then(|| format!("ORA-{code:05}")),
    details: position.map(|position| {
      Box::new(QueryErrorDetails { position: Some(position), ..Default::default() })
    }),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn numbers_keep_their_declared_scale_and_a_leading_zero() {
    assert_eq!(with_scale("10.5", 2), "10.50");
    assert_eq!(with_scale("10", 2), "10.00");
    assert_eq!(with_scale(".5", 2), "0.50");
    assert_eq!(with_scale("-.5", 1), "-0.5");
    assert_eq!(with_scale("1.234", 2), "1.234", "多出来的位数照原样，不截");
    assert_eq!(leading_zero("-.25"), "-0.25");
  }

  #[test]
  fn sql_loses_its_trailing_semicolon_but_plsql_keeps_it() {
    assert_eq!(statement_text("SELECT 1 FROM dual;"), "SELECT 1 FROM dual");
    assert_eq!(statement_text("DELETE FROM t ;  "), "DELETE FROM t");
    assert_eq!(statement_text("BEGIN NULL; END;"), "BEGIN NULL; END;");
    assert_eq!(
      statement_text("declare x number; begin null; end;"),
      "declare x number; begin null; end;"
    );
    assert_eq!(
      statement_text("CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;"),
      "CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;"
    );
    assert_eq!(statement_text("CREATE TABLE t (id NUMBER);"), "CREATE TABLE t (id NUMBER)");
  }

  #[test]
  fn duplicate_column_names_get_numbered() {
    assert_eq!(label_columns(["A", "B", "A"].into_iter()), ["A", "B", "A 2"]);
  }
}
