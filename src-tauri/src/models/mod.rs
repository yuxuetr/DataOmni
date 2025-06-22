use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
  pub id: String,
  pub name: String,
  pub db_type: DatabaseType,
  pub host: String,
  pub port: u16,
  pub database: Option<String>,
  pub username: String,
  pub password: String,
  pub ssl: bool,
  pub options: HashMap<String, String>,
  pub tags: Vec<String>,
  pub created_at: String,
  pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DatabaseType {
  // 关系型数据库
  #[serde(rename = "mysql")]
  MySQL,
  #[serde(rename = "postgresql")]
  PostgreSQL,
  #[serde(rename = "sqlite")]
  SQLite,

  // 非关系型数据库
  #[serde(rename = "mongodb")]
  MongoDB,
  #[serde(rename = "redis")]
  Redis,
  #[serde(rename = "neo4j")]
  Neo4j,

  // 分析平台
  #[serde(rename = "duckdb")]
  DuckDB,
  #[serde(rename = "clickhouse")]
  ClickHouse,
  #[serde(rename = "elasticsearch")]
  Elasticsearch,
}

#[derive(Debug, Serialize)]
pub struct QueryResult {
  pub columns: Vec<String>,
  pub rows: Vec<Vec<serde_json::Value>>,
  pub affected_rows: u64,
  pub execution_time: u64, // 毫秒
}

#[derive(Debug, Serialize)]
pub struct DatabaseInfo {
  pub name: String,
  pub charset: Option<String>,
  pub collation: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DatabaseMetadata {
  pub schemas: Vec<SchemaInfo>,
  pub tables: Vec<TableInfo>,
  pub views: Vec<ViewInfo>,
  pub functions: Vec<FunctionInfo>,
  pub indexes: Vec<IndexInfo>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SchemaInfo {
  pub name: String,
  pub owner: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TableInfo {
  pub schema: Option<String>,
  pub name: String,
  pub table_type: String,
  pub columns: Vec<ColumnInfo>,
  pub row_count: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ColumnInfo {
  pub name: String,
  pub data_type: String,
  pub is_nullable: bool,
  pub is_primary_key: bool,
  pub default_value: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ViewInfo {
  pub schema: Option<String>,
  pub name: String,
  pub definition: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FunctionInfo {
  pub schema: Option<String>,
  pub name: String,
  pub return_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IndexInfo {
  pub schema: Option<String>,
  pub name: String,
  pub table_name: Option<String>,
}

impl DatabaseType {
  pub fn get_default_port(&self) -> u16 {
    match self {
      DatabaseType::MySQL => 3306,
      DatabaseType::PostgreSQL => 5432,
      DatabaseType::SQLite => 0, // SQLite 不需要端口
      DatabaseType::MongoDB => 27017,
      DatabaseType::Redis => 6379,
      DatabaseType::Neo4j => 7687,      // Neo4j Bolt 端口
      DatabaseType::DuckDB => 0,        // DuckDB 不需要端口
      DatabaseType::ClickHouse => 9000, // ClickHouse 默认端口
      DatabaseType::Elasticsearch => 9200,
    }
  }

  pub fn to_connection_string(&self, config: &ConnectionConfig) -> String {
    match self {
      DatabaseType::MySQL => {
        format!(
          "mysql://{}:{}@{}:{}/{}",
          config.username,
          config.password,
          config.host,
          config.port,
          config.database.as_ref().unwrap_or(&"mysql".to_string())
        )
      }
      DatabaseType::PostgreSQL => {
        format!(
          "postgres://{}:{}@{}:{}/{}",
          config.username,
          config.password,
          config.host,
          config.port,
          config.database.as_ref().unwrap_or(&"postgres".to_string())
        )
      }
      DatabaseType::SQLite => {
        format!(
          "sqlite:{}",
          config.database.as_ref().unwrap_or(&":memory:".to_string())
        )
      }
      DatabaseType::MongoDB => {
        if !config.username.is_empty() && !config.password.is_empty() {
          format!(
            "mongodb://{}:{}@{}:{}/{}",
            config.username,
            config.password,
            config.host,
            config.port,
            config.database.as_ref().unwrap_or(&"admin".to_string())
          )
        } else {
          format!(
            "mongodb://{}:{}/{}",
            config.host,
            config.port,
            config.database.as_ref().unwrap_or(&"admin".to_string())
          )
        }
      }
      DatabaseType::Redis => {
        if !config.username.is_empty() && !config.password.is_empty() {
          format!(
            "redis://{}:{}@{}:{}/{}",
            config.username,
            config.password,
            config.host,
            config.port,
            config.database.as_ref().unwrap_or(&"0".to_string())
          )
        } else {
          format!(
            "redis://{}:{}/{}",
            config.host,
            config.port,
            config.database.as_ref().unwrap_or(&"0".to_string())
          )
        }
      }
      DatabaseType::Neo4j => {
        format!(
          "bolt://{}:{}@{}:{}/{}",
          config.username,
          config.password,
          config.host,
          config.port,
          config.database.as_ref().unwrap_or(&"neo4j".to_string())
        )
      }
      DatabaseType::DuckDB => {
        format!(
          "duckdb:{}",
          config.database.as_ref().unwrap_or(&":memory:".to_string())
        )
      }
      DatabaseType::ClickHouse => {
        format!(
          "clickhouse://{}:{}@{}:{}/{}",
          config.username,
          config.password,
          config.host,
          config.port,
          config.database.as_ref().unwrap_or(&"default".to_string())
        )
      }
      DatabaseType::Elasticsearch => {
        if !config.username.is_empty() && !config.password.is_empty() {
          format!(
            "http://{}:{}@{}:{}",
            config.username, config.password, config.host, config.port
          )
        } else {
          format!("http://{}:{}", config.host, config.port)
        }
      }
    }
  }
}

impl Default for ConnectionConfig {
  fn default() -> Self {
    Self {
      id: uuid::Uuid::new_v4().to_string(),
      name: "新连接".to_string(),
      db_type: DatabaseType::SQLite,
      host: "localhost".to_string(),
      port: 0,
      database: None,
      username: "".to_string(),
      password: "".to_string(),
      ssl: false,
      options: HashMap::new(),
      tags: Vec::new(),
      created_at: chrono::Utc::now().to_rfc3339(),
      updated_at: chrono::Utc::now().to_rfc3339(),
    }
  }
}
