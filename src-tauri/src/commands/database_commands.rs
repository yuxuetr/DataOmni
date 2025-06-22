use crate::commands::connection_commands::ConnectionServiceState;
// use crate::models::{ColumnInfo, ConnectionConfig, DatabaseInfo, QueryResult, TableInfo};
// use crate::services::{ConnectionService, DatabaseService};
use tauri::{AppHandle, State};

// 全局数据库服务状态
// pub type DatabaseServiceState = Mutex<crate::services::DatabaseService>;

#[tauri::command]
pub fn get_databases_query(
  connection_id: String,
  _app_handle: AppHandle,
  connection_service_state: State<'_, ConnectionServiceState>,
) -> Result<String, String> {
  println!("📋 获取数据库查询语句 - 连接ID: {}", connection_id);

  // 获取连接配置
  let connection_service_guard = connection_service_state
    .lock()
    .map_err(|e| format!("获取连接服务状态失败: {}", e))?;
  let connection_config = if let Some(service) = connection_service_guard.as_ref() {
    service
      .get_connection(&connection_id)
      .ok_or_else(|| "连接不存在".to_string())?
      .clone()
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
  println!(
    "📋 获取表查询语句 - 连接ID: {}, 数据库: {}",
    connection_id, database
  );

  // 获取连接配置
  let connection_service_guard = connection_service_state
    .lock()
    .map_err(|e| format!("获取连接服务状态失败: {}", e))?;
  let connection_config = if let Some(service) = connection_service_guard.as_ref() {
    service
      .get_connection(&connection_id)
      .ok_or_else(|| "连接不存在".to_string())?
      .clone()
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
  println!(
    "📋 获取表列查询语句 - 连接ID: {}, 数据库: {}, 表: {}",
    connection_id, database, table
  );

  // 获取连接配置
  let connection_service_guard = connection_service_state
    .lock()
    .map_err(|e| format!("获取连接服务状态失败: {}", e))?;
  let connection_config = if let Some(service) = connection_service_guard.as_ref() {
    service
      .get_connection(&connection_id)
      .ok_or_else(|| "连接不存在".to_string())?
      .clone()
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
  let connection_service_guard = connection_service_state
    .lock()
    .map_err(|e| format!("获取连接服务状态失败: {}", e))?;
  let connection_config = if let Some(service) = connection_service_guard.as_ref() {
    service
      .get_connection(&connection_id)
      .ok_or_else(|| "连接不存在".to_string())?
      .clone()
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
  let connection_service_guard = connection_service_state
    .lock()
    .map_err(|e| format!("获取连接服务状态失败: {}", e))?;
  let connection_config = if let Some(service) = connection_service_guard.as_ref() {
    service
      .get_connection(&connection_id)
      .ok_or_else(|| "连接不存在".to_string())?
      .clone()
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
  let connection_service_guard = connection_service_state
    .lock()
    .map_err(|e| format!("获取连接服务状态失败: {}", e))?;
  let connection_config = if let Some(service) = connection_service_guard.as_ref() {
    service
      .get_connection(&connection_id)
      .ok_or_else(|| "连接不存在".to_string())?
      .clone()
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
  println!(
    "📊 获取表快速查看查询语句 - 连接ID: {}, 表: {}",
    connection_id, table_name
  );

  // 获取连接配置
  let connection_service_guard = connection_service_state
    .lock()
    .map_err(|e| format!("获取连接服务状态失败: {}", e))?;
  let connection_config = if let Some(service) = connection_service_guard.as_ref() {
    service
      .get_connection(&connection_id)
      .ok_or_else(|| "连接不存在".to_string())?
      .clone()
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
    crate::models::DatabaseType::Redis => {
      format!("// Redis 查询: 需要特殊处理")
    }
    crate::models::DatabaseType::Neo4j => {
      format!("// Neo4j Cypher 查询: MATCH (n) RETURN n LIMIT 100")
    }
    crate::models::DatabaseType::DuckDB => {
      format!("SELECT * FROM {} LIMIT 100", table_name)
    }
    crate::models::DatabaseType::ClickHouse => {
      format!("SELECT * FROM {} LIMIT 100", table_name)
    }
    crate::models::DatabaseType::Elasticsearch => {
      format!("// Elasticsearch 查询: 需要特殊处理")
    }
  };

  Ok(query)
}
