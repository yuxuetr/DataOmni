use crate::commands::connection_commands::{ConnectionServiceState, SERVICE_STATE_UNAVAILABLE};
use crate::services::connection_service::CONNECTION_NOT_FOUND;
use crate::services::{
  csv_import, export_writer, write_batch, CsvPreview, ExportOptions, ExportProgress, ExportSummary,
  ImportProgress, ImportRequest, ImportSummary, QueryExecutionSummary, QueryResultBatch,
  QuerySessionState, StreamingQueryOptions, WriteBatchError, WriteStatement,
  DEFAULT_QUERY_BATCH_SIZE,
};
use serde::Deserialize;
use std::collections::HashMap;
use tauri::{ipc::Channel, State};
use tauri_plugin_sql::DbInstances;
use tokio::sync::{oneshot, Mutex};
use tokio::time::Duration;

pub const QUERY_CANCELLED_CODE: &str = "QUERY_CANCELLED";

use crate::services::query_executor::{sql_server_unsupported, PoolRef};
use crate::services::{QueryError, SqlServerRegistry, TunnelRegistry, SQL_SERVER_SCHEME};

/// 池子按连接串做键，查不到说明前端 `Database.load` 用的串和这里算的不是
/// 同一个。写成码是为了英文界面上不要印中文——见 `utils/backendError.ts`。
pub const DB_SESSION_NOT_CONNECTED: &str = "DATAOMNI_DB_SESSION_NOT_CONNECTED";
/// 同一个执行 ID 又来了一次。这是前端的 bug，用户无从下手，但也不该看见中文
pub const EXECUTION_ID_IN_USE: &str = "DATAOMNI_EXECUTION_ID_IN_USE";
pub const TIMEOUT_OUT_OF_RANGE: &str = "DATAOMNI_TIMEOUT_OUT_OF_RANGE";
pub const ROW_LIMIT_OUT_OF_RANGE: &str = "DATAOMNI_ROW_LIMIT_OUT_OF_RANGE";
pub const BYTE_LIMIT_OUT_OF_RANGE: &str = "DATAOMNI_BYTE_LIMIT_OUT_OF_RANGE";
/// 连接服务的锁拿不到 / 还没建起来
pub const SERVICE_NOT_READY: &str = "DATAOMNI_SERVICE_NOT_READY";
/// 用户按了取消。不是失败，界面上不该标红
pub const QUERY_CANCELLED: &str = "DATAOMNI_QUERY_CANCELLED";
pub const CSV_DELIMITER_INVALID: &str = "DATAOMNI_CSV_DELIMITER_INVALID";
pub const CSV_PREVIEW_FAILED: &str = "DATAOMNI_CSV_PREVIEW_FAILED";
/// 这几条的数据都是数据库类型名。分成五条而不是一条带「功能」数据：
/// 功能名本身就是要翻译的句子，塞进数据里等于又把中文搬回了后端
pub const SCHEMA_BROWSE_UNSUPPORTED: &str = "DATAOMNI_SCHEMA_BROWSE_UNSUPPORTED";
pub const OBJECT_BROWSE_UNSUPPORTED: &str = "DATAOMNI_OBJECT_BROWSE_UNSUPPORTED";
pub const ER_DIAGRAM_UNSUPPORTED: &str = "DATAOMNI_ER_DIAGRAM_UNSUPPORTED";
pub const COMPLETION_CATALOG_UNSUPPORTED: &str = "DATAOMNI_COMPLETION_CATALOG_UNSUPPORTED";
pub const SESSION_TARGET_UNSUPPORTED: &str = "DATAOMNI_SESSION_TARGET_UNSUPPORTED";

/// 这条连接串对应的池子在哪儿。
///
/// sqlx 三家的池子在插件的 `DbInstances` 里（前端 `Database.load` 打开的），
/// SQL Server 的在后端自己的 [`SqlServerRegistry`] 里（`test_connection` 打开的）。
/// 键都是 `connection_string_via` 算出来的同一个串。
enum ResolvedPool<'a> {
  Sqlx(tokio::sync::RwLockReadGuard<'a, HashMap<String, tauri_plugin_sql::DbPool>>, String),
  SqlServer(std::sync::Arc<crate::services::SqlServerPool>),
}

impl ResolvedPool<'_> {
  async fn resolve<'a>(
    connection_string: String,
    database_instances: &'a DbInstances,
    sql_server: &SqlServerRegistry,
  ) -> Result<ResolvedPool<'a>, QueryError> {
    if connection_string.starts_with(SQL_SERVER_SCHEME) {
      return sql_server
        .get(&connection_string)
        .map(ResolvedPool::SqlServer)
        .ok_or_else(|| QueryError::message(DB_SESSION_NOT_CONNECTED));
    }
    Ok(ResolvedPool::Sqlx(database_instances.0.read().await, connection_string))
  }

  fn pool_ref(&self) -> Result<PoolRef<'_>, QueryError> {
    match self {
      Self::Sqlx(instances, key) => instances
        .get(key)
        .map(PoolRef::Sqlx)
        .ok_or_else(|| QueryError::message(DB_SESSION_NOT_CONNECTED)),
      Self::SqlServer(pool) => Ok(PoolRef::SqlServer(pool)),
    }
  }
}

/// 写入、导出、导入还没接到 SQL Server 上（第三、第四阶段）。不在这里拦的话，
/// 它们去插件的 `DbInstances` 里找池子找不到，报的是「会话未连接」——
/// 而界面上连接明明是绿的
fn refuse_sql_server(connection_string: &str, operation: &str) -> Result<(), QueryError> {
  if connection_string.starts_with(SQL_SERVER_SCHEME) {
    return Err(sql_server_unsupported(operation));
  }
  Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryExecutionRequest {
  connection_id: String,
  session_id: String,
  execution_id: String,
  sql: String,
  timeout_ms: u64,
  row_limit: usize,
  byte_limit: usize,
  /// 关掉之后，不在事务里的语句前面会先发一条 `BEGIN`。
  ///
  /// 旧的调用方不带这个字段，默认 true——把默认值定成 false 会让所有没改过
  /// 的调用方悄悄开始攒事务，而没有任何地方会提交它们。
  #[serde(default = "default_autocommit")]
  autocommit: bool,
}

fn default_autocommit() -> bool {
  true
}

#[derive(Default)]
pub struct QueryCancellationState {
  senders: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl QueryCancellationState {
  async fn register(&self, execution_id: &str) -> Result<oneshot::Receiver<()>, String> {
    let (sender, receiver) = oneshot::channel();
    let mut senders = self.senders.lock().await;
    if senders.contains_key(execution_id) {
      return Err(EXECUTION_ID_IN_USE.to_string());
    }
    senders.insert(execution_id.to_string(), sender);
    Ok(receiver)
  }

  async fn cancel(&self, execution_id: &str) -> bool {
    self
      .senders
      .lock()
      .await
      .remove(execution_id)
      .map(|sender| sender.send(()).is_ok())
      .unwrap_or(false)
  }

  async fn finish(&self, execution_id: &str) {
    self.senders.lock().await.remove(execution_id);
  }
}

// 参数都是 Tauri 注入的 State，由框架按类型逐个填，合不成一个结构
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn execute_query(
  request: QueryExecutionRequest,
  on_batch: Channel<QueryResultBatch>,
  connection_service_state: State<'_, ConnectionServiceState>,
  tunnels: State<'_, TunnelRegistry>,
  database_instances: State<'_, DbInstances>,
  cancellation_state: State<'_, QueryCancellationState>,
  query_session_state: State<'_, QuerySessionState>,
  sql_server: State<'_, SqlServerRegistry>,
) -> Result<QueryExecutionSummary, QueryError> {
  if !(100..=3_600_000).contains(&request.timeout_ms) {
    return Err(QueryError::message(TIMEOUT_OUT_OF_RANGE));
  }
  if !(1..=100_000).contains(&request.row_limit) {
    return Err(QueryError::message(ROW_LIMIT_OUT_OF_RANGE));
  }
  if !(1_048_576..=67_108_864).contains(&request.byte_limit) {
    return Err(QueryError::message(BYTE_LIMIT_OUT_OF_RANGE));
  }

  // 隧道端口先查出来：下面那个块里拿着 std 的锁，不能 await
  let tunnel_port = tunnels.local_port(&request.connection_id).await;
  let connection_string = {
    let connection_service_guard = connection_service_state
      .lock()
      .map_err(|e| QueryError::message(format!("{SERVICE_STATE_UNAVAILABLE}: {e}")))?;
    let service =
      connection_service_guard.as_ref().ok_or_else(|| QueryError::message(SERVICE_NOT_READY))?;
    service
      .resolve_connection_string(&request.connection_id, tunnel_port)
      .map_err(QueryError::message)?
  };

  let resolved =
    ResolvedPool::resolve(connection_string.clone(), &database_instances, &sql_server).await?;
  let pool = resolved.pool_ref()?;
  let receiver =
    cancellation_state.register(&request.execution_id).await.map_err(QueryError::message)?;
  let mut send_batch =
    |batch| on_batch.send(batch).map_err(|error| QueryError::message(error.to_string()));

  let result = tokio::select! {
    result = query_session_state.execute_streaming(
      StreamingQueryOptions {
        session_id: &request.session_id,
        pool_key: &connection_string,
        pool,
        sql: &request.sql,
        autocommit: request.autocommit,
        assume_rows: false,
        row_limit: request.row_limit,
        byte_limit: request.byte_limit,
        batch_size: DEFAULT_QUERY_BATCH_SIZE,
        timeout_duration: Duration::from_millis(request.timeout_ms),
      },
      &mut send_batch
    ) => result,
    _ = receiver => Err(QueryError::with_code(QUERY_CANCELLED_CODE, QUERY_CANCELLED)),
  };
  cancellation_state.finish(&request.execution_id).await;
  result
}

/// 一次提交，要么全成要么全不成。
///
/// 不走 `execute_query`：那条命令是流式读，按一条语句设计，而且是自动提交的。
/// 网格里的一批变更必须共用一个事务，否则中途失败会把数据停在一个用户没打算
/// 要的中间状态。
#[tauri::command]
pub async fn execute_write_batch(
  connection_id: String,
  statements: Vec<WriteStatement>,
  connection_service_state: State<'_, ConnectionServiceState>,
  tunnels: State<'_, TunnelRegistry>,
  database_instances: State<'_, DbInstances>,
) -> Result<Vec<u64>, WriteBatchError> {
  // 隧道端口先查出来：下面那个块里拿着 std 的锁，不能 await
  let tunnel_port = tunnels.local_port(&connection_id).await;
  let connection_string = {
    let connection_service_guard = connection_service_state
      .lock()
      .map_err(|e| batch_error(format!("{SERVICE_STATE_UNAVAILABLE}: {e}")))?;
    let service =
      connection_service_guard.as_ref().ok_or_else(|| batch_error(SERVICE_NOT_READY))?;
    service.resolve_connection_string(&connection_id, tunnel_port).map_err(batch_error)?
  };

  refuse_sql_server(&connection_string, "write")
    .map_err(|error| WriteBatchError { statement_index: 0, error })?;
  let instances = database_instances.0.read().await;
  let pool =
    instances.get(&connection_string).ok_or_else(|| batch_error(DB_SESSION_NOT_CONNECTED))?;
  write_batch::execute_write_batch(pool, &statements).await
}

/// 还没轮到任何一条语句就失败了，序号记在第 0 条上——界面会把整批标成失败，
/// 而不是指着某一条说它有问题
fn batch_error(message: impl Into<String>) -> WriteBatchError {
  WriteBatchError { statement_index: 0, error: QueryError::message(message) }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
  connection_id: String,
  export_id: String,
  sql: String,
  path: String,
  options: ExportOptions,
}

/// 把一条查询的**全部**结果流式写成文件。
///
/// 不走 `execute_query`：那条命令按「结果要回到界面上」设计，行数与字节都被
/// 上限钉死，而整表导出的行数正是未知且可能很大的那一类。这里一行都不进内存，
/// 也一行都不过 IPC。
#[tauri::command]
pub async fn export_query_to_file(
  request: ExportRequest,
  on_progress: Channel<ExportProgress>,
  connection_service_state: State<'_, ConnectionServiceState>,
  tunnels: State<'_, TunnelRegistry>,
  database_instances: State<'_, DbInstances>,
  cancellation_state: State<'_, QueryCancellationState>,
) -> Result<ExportSummary, QueryError> {
  // 隧道端口先查出来：下面那个块里拿着 std 的锁，不能 await
  let tunnel_port = tunnels.local_port(&request.connection_id).await;
  let connection_string = {
    let connection_service_guard = connection_service_state
      .lock()
      .map_err(|e| QueryError::message(format!("{SERVICE_STATE_UNAVAILABLE}: {e}")))?;
    let service =
      connection_service_guard.as_ref().ok_or_else(|| QueryError::message(SERVICE_NOT_READY))?;
    service
      .resolve_connection_string(&request.connection_id, tunnel_port)
      .map_err(QueryError::message)?
  };

  refuse_sql_server(&connection_string, "export")?;
  let instances = database_instances.0.read().await;
  let pool = instances
    .get(&connection_string)
    .ok_or_else(|| QueryError::message(DB_SESSION_NOT_CONNECTED))?;

  // 取消与查询共用同一个登记表：取消的语义、重复 ID 的检查、结束时的清理
  // 都已经在那里了，再立一套只会多出一处要同步的状态。
  let mut receiver =
    cancellation_state.register(&request.export_id).await.map_err(QueryError::message)?;
  let mut report = |progress| {
    // 进度送不出去（窗口关了）不该让导出失败——文件照样写完才是用户要的
    on_progress.send(progress).ok();
  };
  let mut cancelled = || !matches!(receiver.try_recv(), Err(oneshot::error::TryRecvError::Empty));

  let result = export_writer::export_query(
    pool,
    &request.sql,
    std::path::Path::new(&request.path),
    request.options,
    &mut report,
    &mut cancelled,
  )
  .await;
  cancellation_state.finish(&request.export_id).await;
  result
}

/// 取消一次导出。与 `cancel_query` 共用登记表，所以这里只是换个名字说同一件事。
#[tauri::command]
pub async fn cancel_export(
  export_id: String,
  cancellation_state: State<'_, QueryCancellationState>,
) -> Result<bool, String> {
  Ok(cancellation_state.cancel(&export_id).await)
}

/// 正在暂停的导入。
///
/// 取消用的是一次性的 oneshot，暂停不是——它要能来回切。所以另开一张表，
/// 里面只有导入任务的 ID。
#[derive(Default)]
pub struct ImportPauseState {
  paused: Mutex<std::collections::HashSet<String>>,
}

impl ImportPauseState {
  async fn is_paused(&self, import_id: &str) -> bool {
    self.paused.lock().await.contains(import_id)
  }

  async fn set(&self, import_id: &str, paused: bool) {
    let mut set = self.paused.lock().await;
    if paused {
      set.insert(import_id.to_string());
    } else {
      set.remove(import_id);
    }
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreviewRequest {
  path: String,
  /// 不给就嗅探
  delimiter: Option<String>,
  has_header: bool,
}

/// 读 CSV 的开头，给出表头与前几十行。
///
/// 不走 `read_text_file`：那条命令把整个文件读进字符串，而导入要面对的正是
/// 大到不该整份进内存的文件。这里只读开头。
#[tauri::command]
pub async fn preview_csv_file(request: CsvPreviewRequest) -> Result<CsvPreview, QueryError> {
  let delimiter = match request.delimiter.as_deref() {
    Some(text) => match text.as_bytes() {
      [single] => Some(*single),
      _ => return Err(QueryError::message(format!("{CSV_DELIMITER_INVALID}: {text:?}"))),
    },
    None => None,
  };

  let path = std::path::PathBuf::from(&request.path);
  // 阻塞的文件读放到阻塞线程池：几十 MB 的文件在异步线程上读会把整个运行时卡住
  tokio::task::spawn_blocking(move || {
    csv_import::preview_csv(&path, delimiter, request.has_header, csv_import::PREVIEW_ROWS)
  })
  .await
  .map_err(|error| QueryError::message(format!("{CSV_PREVIEW_FAILED}: {error}")))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvImportRequest {
  connection_id: String,
  import_id: String,
  #[serde(flatten)]
  import: ImportRequest,
}

/// 把一个 CSV 文件导入一张表。
#[tauri::command]
pub async fn import_csv_file(
  request: CsvImportRequest,
  on_progress: Channel<ImportProgress>,
  connection_service_state: State<'_, ConnectionServiceState>,
  tunnels: State<'_, TunnelRegistry>,
  database_instances: State<'_, DbInstances>,
  cancellation_state: State<'_, QueryCancellationState>,
  pause_state: State<'_, ImportPauseState>,
) -> Result<ImportSummary, QueryError> {
  // 隧道端口先查出来：下面那个块里拿着 std 的锁，不能 await
  let tunnel_port = tunnels.local_port(&request.connection_id).await;
  let connection_string = {
    let connection_service_guard = connection_service_state
      .lock()
      .map_err(|e| QueryError::message(format!("{SERVICE_STATE_UNAVAILABLE}: {e}")))?;
    let service =
      connection_service_guard.as_ref().ok_or_else(|| QueryError::message(SERVICE_NOT_READY))?;
    service
      .resolve_connection_string(&request.connection_id, tunnel_port)
      .map_err(QueryError::message)?
  };

  refuse_sql_server(&connection_string, "import")?;
  let instances = database_instances.0.read().await;
  let pool = instances
    .get(&connection_string)
    .ok_or_else(|| QueryError::message(DB_SESSION_NOT_CONNECTED))?;

  let mut receiver =
    cancellation_state.register(&request.import_id).await.map_err(QueryError::message)?;
  let mut report = |progress| {
    // 进度送不出去（窗口关了）不该让导入失败——已经开着的事务要正常收尾
    on_progress.send(progress).ok();
  };
  let mut cancelled = || !matches!(receiver.try_recv(), Err(oneshot::error::TryRecvError::Empty));
  // 暂停是个可以来回切的开关，只能现问。`try_lock` 读不到就当作没暂停：
  // 宁可多写一批，也不要为了读一个布尔值把导入卡在这里
  let mut paused =
    || pause_state.paused.try_lock().map(|set| set.contains(&request.import_id)).unwrap_or(false);

  let result =
    csv_import::import_csv(pool, &request.import, &mut report, &mut cancelled, &mut paused).await;
  cancellation_state.finish(&request.import_id).await;
  pause_state.set(&request.import_id, false).await;
  result
}

/// 取消一次导入。与 `cancel_query` 共用登记表。
#[tauri::command]
pub async fn cancel_import(
  import_id: String,
  cancellation_state: State<'_, QueryCancellationState>,
) -> Result<bool, String> {
  Ok(cancellation_state.cancel(&import_id).await)
}

/// 暂停 / 继续一次导入。
///
/// 暂停只在批次之间生效——一条语句发出去就不能中途停下。单事务策略下暂停
/// 意味着那个事务一直开着，界面必须把这件事说出来。
#[tauri::command]
pub async fn set_import_paused(
  import_id: String,
  paused: bool,
  pause_state: State<'_, ImportPauseState>,
) -> Result<bool, String> {
  pause_state.set(&import_id, paused).await;
  Ok(pause_state.is_paused(&import_id).await)
}

#[tauri::command]
pub async fn release_database_session(
  session_id: String,
  query_session_state: State<'_, QuerySessionState>,
) -> Result<bool, String> {
  Ok(query_session_state.release(&session_id).await)
}

#[tauri::command]
pub async fn cancel_query(
  execution_id: String,
  cancellation_state: State<'_, QueryCancellationState>,
) -> Result<bool, String> {
  Ok(cancellation_state.cancel(&execution_id).await)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn cancellation_requests_are_acknowledged_once() {
    let state = QueryCancellationState::default();
    let receiver = state.register("execution-1").await.expect("register execution");

    assert!(state.cancel("execution-1").await);
    assert!(receiver.await.is_ok());
    assert!(!state.cancel("execution-1").await);
  }
}

/// 取该方言的结构目录查询。
///
/// 只回三段 SQL 文本，不查连接服务：调用方本来就知道自己连的是什么类型，
/// 再查一次连接配置只是多一处可失败的地方。SQL 住在 Rust 侧是为了让
/// `tests/database_smoke.rs` 能拿真库跑它们。
#[tauri::command]
pub fn get_schema_metadata_queries(
  db_type: crate::models::DatabaseType,
) -> Result<crate::services::SchemaMetadataQueries, String> {
  crate::services::schema_metadata_queries(&db_type)
    .ok_or_else(|| format!("{SCHEMA_BROWSE_UNSUPPORTED}: {db_type:?}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainRequest {
  connection_id: String,
  session_id: String,
  sql: String,
  /// 真的把语句跑一遍。只有 PostgreSQL 支持，且**写语句会真的写进去**
  analyze: bool,
  /// 跟着编辑器当前的自动提交设置走：关掉时这次 EXPLAIN ANALYZE 会落在
  /// 一个事务里，用户可以回滚掉它写进去的东西
  #[serde(default = "default_autocommit")]
  autocommit: bool,
}

/// 取一条语句的执行计划。
///
/// 走 session 连接而不是另开一条：计划受当前事务里的临时表、未提交的 DDL
/// 与会话参数影响，另开一条连接算出来的是另一个环境下的计划。
///
/// 超时用固定的一分钟：`EXPLAIN ANALYZE` 会真的跑，而它跑多久取决于那条语句。
#[tauri::command]
pub async fn explain_query(
  request: ExplainRequest,
  connection_service_state: State<'_, ConnectionServiceState>,
  tunnels: State<'_, TunnelRegistry>,
  database_instances: State<'_, DbInstances>,
  query_session_state: State<'_, QuerySessionState>,
) -> Result<crate::services::explain::QueryPlan, QueryError> {
  // 隧道端口先查出来：下面那个块里拿着 std 的锁，不能 await
  let tunnel_port = tunnels.local_port(&request.connection_id).await;
  let (connection_string, db_type) = {
    let connection_service_guard = connection_service_state
      .lock()
      .map_err(|e| QueryError::message(format!("{SERVICE_STATE_UNAVAILABLE}: {e}")))?;
    let service =
      connection_service_guard.as_ref().ok_or_else(|| QueryError::message(SERVICE_NOT_READY))?;
    let connection = service
      .get_connection(&request.connection_id)
      .ok_or_else(|| QueryError::message(CONNECTION_NOT_FOUND))?;
    let db_type = connection.db_type.clone();
    (
      service
        .resolve_connection_string(&request.connection_id, tunnel_port)
        .map_err(QueryError::message)?,
      db_type,
    )
  };

  let statement =
    crate::services::explain::explain_statement(&db_type, &request.sql, request.analyze)?;

  let instances = database_instances.0.read().await;
  let pool = instances
    .get(&connection_string)
    .ok_or_else(|| QueryError::message(DB_SESSION_NOT_CONNECTED))?;
  // 走 streaming 而不是 execute：要带上 assume_rows。MySQL 在预处理
  // `EXPLAIN FORMAT=JSON` 时报告 0 列，按 describe 的说法走会拿回一个
  // Affected，计划就此消失
  let mut rows = Vec::new();
  query_session_state
    .execute_streaming(
      StreamingQueryOptions {
        session_id: &request.session_id,
        pool_key: &connection_string,
        pool: PoolRef::Sqlx(pool),
        sql: &statement,
        autocommit: request.autocommit,
        assume_rows: true,
        row_limit: EXPLAIN_ROW_LIMIT,
        byte_limit: EXPLAIN_BYTE_LIMIT,
        batch_size: DEFAULT_QUERY_BATCH_SIZE,
        timeout_duration: Duration::from_secs(60),
      },
      &mut |batch| {
        rows.extend(batch.rows);
        Ok(())
      },
    )
    .await?;
  crate::services::explain::parse_plan(&db_type, &rows, request.analyze)
}

/// 计划的行数上限。SQLite 的 `EXPLAIN QUERY PLAN` 一行一步，复杂查询几十行；
/// 一万行足够，而不设上限意味着一条畸形语句能把内存吃光。
const EXPLAIN_ROW_LIMIT: usize = 10_000;

/// 计划本身的内存上限。PostgreSQL 的 VERBOSE JSON 在几十张表的查询上能到
/// 几 MB，16 MiB 留足余量，同时挡住失控的情况。
const EXPLAIN_BYTE_LIMIT: usize = 16 * 1024 * 1024;

/// 这条 session 现在在不在事务里。
///
/// 每执行完一条语句问一次（成功和失败都问）：失败那一条恰恰是 PostgreSQL
/// 把事务标成废止的时刻，而失败路径上没有结果可以捎带这个状态。查的是内存里
/// 的一个值，不发任何数据库往返。
#[tauri::command]
pub async fn get_session_transaction(
  session_id: String,
  query_session_state: State<'_, QuerySessionState>,
) -> Result<crate::services::transaction_state::TransactionState, String> {
  Ok(query_session_state.transaction(&session_id).await)
}

/// 取该方言的库级对象目录查询。与 `get_schema_metadata_queries` 同样只回 SQL 文本。
#[tauri::command]
pub fn get_object_catalog_queries(
  db_type: crate::models::DatabaseType,
) -> Result<crate::services::ObjectCatalogQueries, String> {
  crate::services::object_catalog_queries(&db_type)
    .ok_or_else(|| format!("{OBJECT_BROWSE_UNSUPPORTED}: {db_type:?}"))
}

/// 取该方言的整库 ER 图查询。与另外两个目录命令一样只回 SQL 文本。
#[tauri::command]
pub fn get_er_diagram_queries(
  db_type: crate::models::DatabaseType,
) -> Result<crate::services::ErDiagramQueries, String> {
  crate::services::er_diagram_queries(&db_type)
    .ok_or_else(|| format!("{ER_DIAGRAM_UNSUPPORTED}: {db_type:?}"))
}

/// 取该方言的补全目录查询。与另外三个目录命令一样只回 SQL 文本。
#[tauri::command]
pub fn get_completion_catalog_query(
  db_type: crate::models::DatabaseType,
) -> Result<crate::services::CompletionCatalogQuery, String> {
  crate::services::completion_catalog_query(&db_type)
    .ok_or_else(|| format!("{COMPLETION_CATALOG_UNSUPPORTED}: {db_type:?}"))
}

/// 取该方言的会话目标查询。与另外几个目录命令一样只回 SQL 文本。
#[tauri::command]
pub fn get_session_target_query(
  db_type: crate::models::DatabaseType,
) -> Result<crate::services::SessionTargetQuery, String> {
  crate::services::session_target_query(&db_type)
    .ok_or_else(|| format!("{SESSION_TARGET_UNSUPPORTED}: {db_type:?}"))
}
