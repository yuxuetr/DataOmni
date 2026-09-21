use crate::commands::connection_commands::ConnectionServiceState;
use crate::services::{
  csv_import, export_writer, write_batch, CsvPreview, ExportOptions, ExportProgress, ExportSummary,
  ImportProgress, ImportRequest, ImportSummary, QueryExecutionSummary, QueryResultBatch,
  QuerySessionState, StreamingQueryOptions, WriteBatchError, WriteStatement,
  DEFAULT_QUERY_BATCH_SIZE,
};
// use crate::services::{ConnectionService, DatabaseService};
use serde::Deserialize;
use std::collections::HashMap;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_sql::DbInstances;
use tokio::sync::{oneshot, Mutex};
use tokio::time::Duration;

// 全局数据库服务状态
// pub type DatabaseServiceState = Mutex<crate::services::DatabaseService>;

pub const QUERY_CANCELLED_CODE: &str = "QUERY_CANCELLED";

use crate::services::QueryError;

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
      return Err("查询执行 ID 已存在".to_string());
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

#[tauri::command]
pub async fn execute_query(
  request: QueryExecutionRequest,
  on_batch: Channel<QueryResultBatch>,
  connection_service_state: State<'_, ConnectionServiceState>,
  database_instances: State<'_, DbInstances>,
  cancellation_state: State<'_, QueryCancellationState>,
  query_session_state: State<'_, QuerySessionState>,
) -> Result<QueryExecutionSummary, QueryError> {
  if !(100..=3_600_000).contains(&request.timeout_ms) {
    return Err(QueryError::message("查询超时必须在 100 毫秒到 1 小时之间"));
  }
  if !(1..=100_000).contains(&request.row_limit) {
    return Err(QueryError::message("结果行数上限必须在 1 到 100000 之间"));
  }
  if !(1_048_576..=67_108_864).contains(&request.byte_limit) {
    return Err(QueryError::message("结果内存上限必须在 1 MiB 到 64 MiB 之间"));
  }

  let connection_string = {
    let connection_service_guard = connection_service_state
      .lock()
      .map_err(|e| QueryError::message(format!("获取连接服务状态失败: {e}")))?;
    let service =
      connection_service_guard.as_ref().ok_or_else(|| QueryError::message("连接服务未初始化"))?;
    service.resolve_connection_string(&request.connection_id).map_err(QueryError::message)?
  };

  let instances = database_instances.0.read().await;
  let pool =
    instances.get(&connection_string).ok_or_else(|| QueryError::message("数据库会话未连接"))?;
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
    _ = receiver => Err(QueryError::with_code(QUERY_CANCELLED_CODE, "查询已取消")),
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
  database_instances: State<'_, DbInstances>,
) -> Result<Vec<u64>, WriteBatchError> {
  let connection_string = {
    let connection_service_guard = connection_service_state
      .lock()
      .map_err(|e| batch_error(format!("获取连接服务状态失败: {e}")))?;
    let service =
      connection_service_guard.as_ref().ok_or_else(|| batch_error("连接服务未初始化"))?;
    service.resolve_connection_string(&connection_id).map_err(batch_error)?
  };

  let instances = database_instances.0.read().await;
  let pool = instances.get(&connection_string).ok_or_else(|| batch_error("数据库会话未连接"))?;
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
  database_instances: State<'_, DbInstances>,
  cancellation_state: State<'_, QueryCancellationState>,
) -> Result<ExportSummary, QueryError> {
  let connection_string = {
    let connection_service_guard = connection_service_state
      .lock()
      .map_err(|e| QueryError::message(format!("获取连接服务状态失败: {e}")))?;
    let service =
      connection_service_guard.as_ref().ok_or_else(|| QueryError::message("连接服务未初始化"))?;
    service.resolve_connection_string(&request.connection_id).map_err(QueryError::message)?
  };

  let instances = database_instances.0.read().await;
  let pool =
    instances.get(&connection_string).ok_or_else(|| QueryError::message("数据库会话未连接"))?;

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
      _ => return Err(QueryError::message(format!("分隔符必须是一个字符: {text:?}"))),
    },
    None => None,
  };

  let path = std::path::PathBuf::from(&request.path);
  // 阻塞的文件读放到阻塞线程池：几十 MB 的文件在异步线程上读会把整个运行时卡住
  tokio::task::spawn_blocking(move || {
    csv_import::preview_csv(&path, delimiter, request.has_header, csv_import::PREVIEW_ROWS)
  })
  .await
  .map_err(|error| QueryError::message(format!("预览 CSV 失败: {error}")))?
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
  database_instances: State<'_, DbInstances>,
  cancellation_state: State<'_, QueryCancellationState>,
  pause_state: State<'_, ImportPauseState>,
) -> Result<ImportSummary, QueryError> {
  let connection_string = {
    let connection_service_guard = connection_service_state
      .lock()
      .map_err(|e| QueryError::message(format!("获取连接服务状态失败: {e}")))?;
    let service =
      connection_service_guard.as_ref().ok_or_else(|| QueryError::message("连接服务未初始化"))?;
    service.resolve_connection_string(&request.connection_id).map_err(QueryError::message)?
  };

  let instances = database_instances.0.read().await;
  let pool =
    instances.get(&connection_string).ok_or_else(|| QueryError::message("数据库会话未连接"))?;

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

#[tauri::command]
pub fn get_databases_query(
  connection_id: String,
  _app_handle: AppHandle,
  connection_service_state: State<'_, ConnectionServiceState>,
) -> Result<String, String> {
  println!("📋 获取数据库查询语句 - 连接ID: {}", connection_id);

  // 获取连接配置
  let connection_service_guard =
    connection_service_state.lock().map_err(|e| format!("获取连接服务状态失败: {}", e))?;
  let connection_config = if let Some(service) = connection_service_guard.as_ref() {
    service.get_connection(&connection_id).ok_or_else(|| "连接不存在".to_string())?.clone()
  } else {
    return Err("连接服务未初始化".to_string());
  };
  drop(connection_service_guard);

  // 返回查询语句
  let _database_service = crate::services::DatabaseService::new();
  Ok(_database_service.get_databases_query(&connection_config.db_type))
}

#[tauri::command]
pub fn get_tables_query(
  connection_id: String,
  database: String,
  _app_handle: AppHandle,
  connection_service_state: State<'_, ConnectionServiceState>,
) -> Result<String, String> {
  println!("📋 获取表查询语句 - 连接ID: {}, 数据库: {}", connection_id, database);

  // 获取连接配置
  let connection_service_guard =
    connection_service_state.lock().map_err(|e| format!("获取连接服务状态失败: {}", e))?;
  let connection_config = if let Some(service) = connection_service_guard.as_ref() {
    service.get_connection(&connection_id).ok_or_else(|| "连接不存在".to_string())?.clone()
  } else {
    return Err("连接服务未初始化".to_string());
  };
  drop(connection_service_guard);

  // 返回查询语句
  let _database_service = crate::services::DatabaseService::new();
  Ok(_database_service.get_tables_query(&connection_config.db_type, &database))
}

#[tauri::command]
pub fn get_table_columns_query(
  connection_id: String,
  database: String,
  table: String,
  _app_handle: AppHandle,
  connection_service_state: State<'_, ConnectionServiceState>,
) -> Result<String, String> {
  println!("📋 获取表列查询语句 - 连接ID: {}, 数据库: {}, 表: {}", connection_id, database, table);

  // 获取连接配置
  let connection_service_guard =
    connection_service_state.lock().map_err(|e| format!("获取连接服务状态失败: {}", e))?;
  let connection_config = if let Some(service) = connection_service_guard.as_ref() {
    service.get_connection(&connection_id).ok_or_else(|| "连接不存在".to_string())?.clone()
  } else {
    return Err("连接服务未初始化".to_string());
  };
  drop(connection_service_guard);

  // 返回查询语句
  let _database_service = crate::services::DatabaseService::new();
  Ok(_database_service.get_table_columns_query(&connection_config.db_type, &database, &table))
}

#[tauri::command]
pub fn get_table_data_query(
  connection_id: String,
  database: String,
  table: String,
  limit: u32,
  offset: u32,
  _app_handle: AppHandle,
  connection_service_state: State<'_, ConnectionServiceState>,
) -> Result<String, String> {
  println!(
    "📋 获取表数据查询语句 - 连接ID: {}, 数据库: {}, 表: {}",
    connection_id, database, table
  );

  // 获取连接配置
  let connection_service_guard =
    connection_service_state.lock().map_err(|e| format!("获取连接服务状态失败: {}", e))?;
  let connection_config = if let Some(service) = connection_service_guard.as_ref() {
    service.get_connection(&connection_id).ok_or_else(|| "连接不存在".to_string())?.clone()
  } else {
    return Err("连接服务未初始化".to_string());
  };
  drop(connection_service_guard);

  // 返回查询语句
  let _database_service = crate::services::DatabaseService::new();
  Ok(_database_service.get_table_data_query(
    &connection_config.db_type,
    &database,
    &table,
    limit,
    offset,
  ))
}

#[tauri::command]
pub fn validate_query(query: String) -> Result<bool, String> {
  println!("🔍 验证查询: {}", query);

  let _database_service = crate::services::DatabaseService::new();
  // 移除 async 调用
  let query = query.trim().to_lowercase();

  // 检查是否为危险操作
  let dangerous_keywords = vec!["drop", "delete", "truncate", "alter"];
  for keyword in dangerous_keywords {
    if query.starts_with(keyword) {
      return Err(format!("危险操作被禁止: {}", keyword));
    }
  }

  Ok(true)
}

// 简化的数据库元数据获取命令
#[tauri::command]
pub fn get_table_list_query(
  connection_id: String,
  _app_handle: AppHandle,
  connection_service_state: State<'_, ConnectionServiceState>,
) -> Result<String, String> {
  println!("📋 获取表列表查询语句 - 连接ID: {}", connection_id);

  // 获取连接配置
  let connection_service_guard =
    connection_service_state.lock().map_err(|e| format!("获取连接服务状态失败: {}", e))?;
  let connection_config = if let Some(service) = connection_service_guard.as_ref() {
    service.get_connection(&connection_id).ok_or_else(|| "连接不存在".to_string())?.clone()
  } else {
    return Err("连接服务未初始化".to_string());
  };
  drop(connection_service_guard);

  // 根据数据库类型返回不同的查询语句
  let query = match connection_config.db_type {
    crate::models::DatabaseType::PostgreSQL => {
      "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name".to_string()
    },
    crate::models::DatabaseType::MySQL => {
      "SHOW TABLES".to_string()
    },
    crate::models::DatabaseType::SQLite => {
      "SELECT name as table_name, 'BASE TABLE' as table_type FROM sqlite_master WHERE type='table' ORDER BY name".to_string()
    },
    // 新增数据库类型的处理
    crate::models::DatabaseType::MongoDB => {
      "// MongoDB 不支持传统SQL查询，需要特殊处理".to_string()
    },
    crate::models::DatabaseType::Redis => {
      "// Redis 不支持传统SQL查询，需要特殊处理".to_string()
    },
    crate::models::DatabaseType::Neo4j => {
      "// Neo4j 使用Cypher查询语言，需要特殊处理".to_string()
    },
    crate::models::DatabaseType::DuckDB => {
      "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name".to_string()
    },
    crate::models::DatabaseType::ClickHouse => {
      "SELECT name as table_name, 'BASE TABLE' as table_type FROM system.tables WHERE database = currentDatabase() ORDER BY name".to_string()
    },
    crate::models::DatabaseType::Elasticsearch => {
      "// Elasticsearch 不支持传统SQL查询，需要特殊处理".to_string()
    },
  };

  Ok(query)
}

#[tauri::command]
pub fn get_database_metadata_query(
  connection_id: String,
  _app_handle: AppHandle,
  connection_service_state: State<'_, ConnectionServiceState>,
) -> Result<String, String> {
  println!("📋 获取数据库元数据查询语句 - 连接ID: {}", connection_id);

  // 获取连接配置
  let connection_service_guard =
    connection_service_state.lock().map_err(|e| format!("获取连接服务状态失败: {}", e))?;
  let connection_config = if let Some(service) = connection_service_guard.as_ref() {
    service.get_connection(&connection_id).ok_or_else(|| "连接不存在".to_string())?.clone()
  } else {
    return Err("连接服务未初始化".to_string());
  };
  drop(connection_service_guard);

  // 根据数据库类型返回不同的查询语句
  let query = match connection_config.db_type {
    crate::models::DatabaseType::PostgreSQL => "SELECT 
        'schema' as object_type,
        schema_name as name,
        null as parent_schema,
        null as parent_name
      FROM information_schema.schemata 
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
      UNION ALL
      SELECT 
        'table' as object_type,
        table_name as name,
        table_schema as parent_schema,
        null as parent_name
      FROM information_schema.tables 
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema') 
        AND table_type = 'BASE TABLE'
      UNION ALL
      SELECT 
        'view' as object_type,
        table_name as name,
        table_schema as parent_schema,
        null as parent_name
      FROM information_schema.tables 
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema') 
        AND table_type = 'VIEW'
      ORDER BY object_type, parent_schema, name"
      .to_string(),
    crate::models::DatabaseType::MySQL => "SELECT 
        'database' as object_type,
        SCHEMA_NAME as name,
        null as parent_schema,
        null as parent_name
      FROM information_schema.SCHEMATA
      WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      ORDER BY name"
      .to_string(),
    crate::models::DatabaseType::SQLite => "SELECT 
        'table' as object_type,
        name,
        null as parent_schema,
        null as parent_name
      FROM sqlite_master 
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      UNION ALL
      SELECT 
        'view' as object_type,
        name,
        null as parent_schema,
        null as parent_name
      FROM sqlite_master 
      WHERE type = 'view'
      ORDER BY object_type, name"
      .to_string(),
    // 新增数据库类型的处理
    crate::models::DatabaseType::MongoDB => "// MongoDB 元数据查询需要特殊处理".to_string(),
    crate::models::DatabaseType::Redis => "// Redis 元数据查询需要特殊处理".to_string(),
    crate::models::DatabaseType::Neo4j => "// Neo4j 元数据查询需要特殊处理".to_string(),
    crate::models::DatabaseType::DuckDB => "SELECT 
        'table' as object_type,
        table_name as name,
        table_schema as parent_schema,
        null as parent_name
      FROM information_schema.tables 
      WHERE table_schema = 'main'
      ORDER BY table_name"
      .to_string(),
    crate::models::DatabaseType::ClickHouse => "SELECT 
        'table' as object_type,
        name,
        database as parent_schema,
        null as parent_name
      FROM system.tables 
      WHERE database = currentDatabase()
      ORDER BY name"
      .to_string(),
    crate::models::DatabaseType::Elasticsearch => {
      "// Elasticsearch 元数据查询需要特殊处理".to_string()
    }
  };

  Ok(query)
}

#[tauri::command]
pub fn get_table_quick_view_query(
  connection_id: String,
  table_name: String,
  schema: Option<String>,
  _app_handle: AppHandle,
  connection_service_state: State<'_, ConnectionServiceState>,
) -> Result<String, String> {
  println!("📊 获取表快速查看查询语句 - 连接ID: {}, 表: {}", connection_id, table_name);

  // 获取连接配置
  let connection_service_guard =
    connection_service_state.lock().map_err(|e| format!("获取连接服务状态失败: {}", e))?;
  let connection_config = if let Some(service) = connection_service_guard.as_ref() {
    service.get_connection(&connection_id).ok_or_else(|| "连接不存在".to_string())?.clone()
  } else {
    return Err("连接服务未初始化".to_string());
  };
  drop(connection_service_guard);

  // 构建查询语句
  let query = match connection_config.db_type {
    crate::models::DatabaseType::PostgreSQL | crate::models::DatabaseType::MySQL => {
      if let Some(schema_name) = schema {
        format!("SELECT * FROM {}.{} LIMIT 100", schema_name, table_name)
      } else {
        format!("SELECT * FROM {} LIMIT 100", table_name)
      }
    }
    crate::models::DatabaseType::SQLite => {
      format!("SELECT * FROM {} LIMIT 100", table_name)
    }
    // 新增数据库类型的处理
    crate::models::DatabaseType::MongoDB => {
      format!("// MongoDB 查询: db.{}.find().limit(100)", table_name)
    }
    crate::models::DatabaseType::Redis => "// Redis 查询: 需要特殊处理".to_string(),
    crate::models::DatabaseType::Neo4j => {
      "// Neo4j Cypher 查询: MATCH (n) RETURN n LIMIT 100".to_string()
    }
    crate::models::DatabaseType::DuckDB => {
      format!("SELECT * FROM {} LIMIT 100", table_name)
    }
    crate::models::DatabaseType::ClickHouse => {
      format!("SELECT * FROM {} LIMIT 100", table_name)
    }
    crate::models::DatabaseType::Elasticsearch => "// Elasticsearch 查询: 需要特殊处理".to_string(),
  };

  Ok(query)
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
    .ok_or_else(|| format!("{:?} 尚未支持结构浏览", db_type))
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
  database_instances: State<'_, DbInstances>,
  query_session_state: State<'_, QuerySessionState>,
) -> Result<crate::services::explain::QueryPlan, QueryError> {
  let (connection_string, db_type) = {
    let connection_service_guard = connection_service_state
      .lock()
      .map_err(|e| QueryError::message(format!("获取连接服务状态失败: {e}")))?;
    let service =
      connection_service_guard.as_ref().ok_or_else(|| QueryError::message("连接服务未初始化"))?;
    let connection = service
      .get_connection(&request.connection_id)
      .ok_or_else(|| QueryError::message("找不到这个连接"))?;
    let db_type = connection.db_type.clone();
    (
      service.resolve_connection_string(&request.connection_id).map_err(QueryError::message)?,
      db_type,
    )
  };

  let statement =
    crate::services::explain::explain_statement(&db_type, &request.sql, request.analyze)?;

  let instances = database_instances.0.read().await;
  let pool =
    instances.get(&connection_string).ok_or_else(|| QueryError::message("数据库会话未连接"))?;
  // 走 streaming 而不是 execute：要带上 assume_rows。MySQL 在预处理
  // `EXPLAIN FORMAT=JSON` 时报告 0 列，按 describe 的说法走会拿回一个
  // Affected，计划就此消失
  let mut rows = Vec::new();
  query_session_state
    .execute_streaming(
      StreamingQueryOptions {
        session_id: &request.session_id,
        pool_key: &connection_string,
        pool,
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
    .ok_or_else(|| format!("{:?} 尚未支持对象浏览", db_type))
}

/// 取该方言的整库 ER 图查询。与另外两个目录命令一样只回 SQL 文本。
#[tauri::command]
pub fn get_er_diagram_queries(
  db_type: crate::models::DatabaseType,
) -> Result<crate::services::ErDiagramQueries, String> {
  crate::services::er_diagram_queries(&db_type)
    .ok_or_else(|| format!("{:?} 尚未支持 ER 关系图", db_type))
}

/// 取该方言的补全目录查询。与另外三个目录命令一样只回 SQL 文本。
#[tauri::command]
pub fn get_completion_catalog_query(
  db_type: crate::models::DatabaseType,
) -> Result<crate::services::CompletionCatalogQuery, String> {
  crate::services::completion_catalog_query(&db_type)
    .ok_or_else(|| format!("{:?} 尚未支持 SQL 补全目录", db_type))
}

/// 取该方言的会话目标查询。与另外几个目录命令一样只回 SQL 文本。
#[tauri::command]
pub fn get_session_target_query(
  db_type: crate::models::DatabaseType,
) -> Result<crate::services::SessionTargetQuery, String> {
  crate::services::session_target_query(&db_type)
    .ok_or_else(|| format!("{:?} 尚未支持会话目标查询", db_type))
}
