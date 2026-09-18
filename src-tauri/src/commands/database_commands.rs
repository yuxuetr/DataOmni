use crate::commands::connection_commands::ConnectionServiceState;
use crate::services::{
  QueryExecutionSummary, QueryResultBatch, QuerySessionState, StreamingQueryOptions,
  DEFAULT_QUERY_BATCH_SIZE,
};
// use crate::models::{ColumnInfo, ConnectionConfig, DatabaseInfo, QueryResult, TableInfo};
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryExecutionRequest {
  connection_id: String,
  session_id: String,
  execution_id: String,
  sql: String,
  timeout_ms: u64,
  row_limit: usize,
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
) -> Result<QueryExecutionSummary, String> {
  if !(100..=3_600_000).contains(&request.timeout_ms) {
    return Err("查询超时必须在 100 毫秒到 1 小时之间".to_string());
  }
  if !(1..=100_000).contains(&request.row_limit) {
    return Err("结果行数上限必须在 1 到 100000 之间".to_string());
  }

  let connection_string = {
    let connection_service_guard =
      connection_service_state.lock().map_err(|e| format!("获取连接服务状态失败: {e}"))?;
    let service =
      connection_service_guard.as_ref().ok_or_else(|| "连接服务未初始化".to_string())?;
    service.resolve_connection_string(&request.connection_id)?
  };

  let instances = database_instances.0.read().await;
  let pool = instances.get(&connection_string).ok_or_else(|| "数据库会话未连接".to_string())?;
  let receiver = cancellation_state.register(&request.execution_id).await?;
  let mut send_batch = |batch| on_batch.send(batch).map_err(|error| error.to_string());

  let result = tokio::select! {
    result = query_session_state.execute_streaming(
      StreamingQueryOptions {
        session_id: &request.session_id,
        pool_key: &connection_string,
        pool,
        sql: &request.sql,
        row_limit: request.row_limit,
        batch_size: DEFAULT_QUERY_BATCH_SIZE,
        timeout_duration: Duration::from_millis(request.timeout_ms),
      },
      &mut send_batch
    ) => result,
    _ = receiver => Err(format!("{QUERY_CANCELLED_CODE}: 查询已取消")),
  };
  cancellation_state.finish(&request.execution_id).await;
  result
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
