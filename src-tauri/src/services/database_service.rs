#[derive(Debug)]
pub struct DatabaseService;

impl DatabaseService {
  pub fn new() -> Self {
    Self
  }

  /// 执行SQL查询 - 这个方法将在前端直接使用 Tauri SQL 插件
  /// 后端主要负责连接配置管理
  #[allow(unused)]
  pub async fn validate_query(&self, query: &str) -> Result<bool, String> {
    // 简单的查询验证
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

  /// 获取数据库信息查询语句
  pub fn get_databases_query(&self, db_type: &crate::models::DatabaseType) -> String {
    match db_type {
      crate::models::DatabaseType::MySQL => {
        "SELECT SCHEMA_NAME as name, DEFAULT_CHARACTER_SET_NAME as charset, DEFAULT_COLLATION_NAME as collation FROM information_schema.SCHEMATA".to_string()
      }
      crate::models::DatabaseType::PostgreSQL => {
        "SELECT datname as name, NULL as charset, NULL as collation FROM pg_database WHERE datistemplate = false".to_string()
      }
      crate::models::DatabaseType::SQLite => {
        "SELECT 'main' as name, NULL as charset, NULL as collation".to_string()
      }
      crate::models::DatabaseType::MongoDB => {
        "// MongoDB 不支持传统SQL查询，需要特殊处理".to_string()
      }
      crate::models::DatabaseType::Redis => {
        "// Redis 不支持传统SQL查询，需要特殊处理".to_string()
      }
      crate::models::DatabaseType::Neo4j => {
        "// Neo4j 不支持传统SQL查询，需要特殊处理".to_string()
      }
      crate::models::DatabaseType::DuckDB => {
        "SELECT 'main' as name, NULL as charset, NULL as collation".to_string()
      }
      crate::models::DatabaseType::ClickHouse => {
        "SELECT name, NULL as charset, NULL as collation FROM system.databases".to_string()
      }
      crate::models::DatabaseType::Elasticsearch => {
        "// Elasticsearch 不支持传统SQL查询，需要特殊处理".to_string()
      }
    }
  }

  /// 获取表列表查询语句
  pub fn get_tables_query(&self, db_type: &crate::models::DatabaseType, database: &str) -> String {
    match db_type {
      crate::models::DatabaseType::MySQL => {
        format!(
          "SELECT TABLE_NAME as name, TABLE_SCHEMA as schema, TABLE_TYPE as table_type, TABLE_ROWS as row_count FROM information_schema.TABLES WHERE TABLE_SCHEMA = '{}'",
          database
        )
      }
      crate::models::DatabaseType::PostgreSQL => {
        format!(
          "SELECT tablename as name, schemaname as schema, 'BASE TABLE' as table_type, NULL as row_count FROM pg_tables WHERE schemaname = '{}'
           UNION ALL
           SELECT viewname as name, schemaname as schema, 'VIEW' as table_type, NULL as row_count FROM pg_views WHERE schemaname = '{}'",
          database, database
        )
      }
      crate::models::DatabaseType::SQLite => {
        "SELECT name, NULL as schema, type as table_type, NULL as row_count FROM sqlite_master WHERE type IN ('table', 'view')".to_string()
      }
      crate::models::DatabaseType::MongoDB => {
        format!("// MongoDB 查询: db.{}.getCollectionNames()", database)
      }
      crate::models::DatabaseType::Redis => {
        "// Redis 不支持传统表概念，需要特殊处理".to_string()
      }
      crate::models::DatabaseType::Neo4j => {
        "// Neo4j 查询: SHOW CONSTRAINTS".to_string()
      }
      crate::models::DatabaseType::DuckDB => {
        format!(
          "SELECT table_name as name, table_schema as schema, table_type, NULL as row_count FROM information_schema.tables WHERE table_schema = '{}'",
          database
        )
      }
      crate::models::DatabaseType::ClickHouse => {
        format!(
          "SELECT name, database as schema, 'BASE TABLE' as table_type, NULL as row_count FROM system.tables WHERE database = '{}'",
          database
        )
      }
      crate::models::DatabaseType::Elasticsearch => {
        "// Elasticsearch 查询: GET /_cat/indices".to_string()
      }
    }
  }

  /// 获取表结构查询语句
  pub fn get_table_columns_query(
    &self,
    db_type: &crate::models::DatabaseType,
    database: &str,
    table: &str,
  ) -> String {
    match db_type {
      crate::models::DatabaseType::MySQL => {
        format!(
          "SELECT COLUMN_NAME as name, DATA_TYPE as data_type, IS_NULLABLE as is_nullable, COLUMN_KEY as column_key, COLUMN_DEFAULT as default_value 
           FROM information_schema.COLUMNS 
           WHERE TABLE_SCHEMA = '{}' AND TABLE_NAME = '{}' 
           ORDER BY ORDINAL_POSITION",
          database, table
        )
      }
      crate::models::DatabaseType::PostgreSQL => {
        format!(
          "SELECT column_name as name, data_type, is_nullable, 
           CASE WHEN column_name = ANY(ARRAY(SELECT unnest(conkey) FROM pg_constraint WHERE contype = 'p' AND conrelid = '{}.{}'::regclass)) THEN 'PRI' ELSE '' END as column_key,
           column_default as default_value
           FROM information_schema.columns 
           WHERE table_schema = '{}' AND table_name = '{}' 
           ORDER BY ordinal_position",
          database, table, database, table
        )
      }
      crate::models::DatabaseType::SQLite => {
        format!("PRAGMA table_info('{}')", table)
      }
      crate::models::DatabaseType::MongoDB => {
        format!("// MongoDB 查询: db.{}.findOne()", table)
      }
      crate::models::DatabaseType::Redis => "// Redis 不支持传统列概念，需要特殊处理".to_string(),
      crate::models::DatabaseType::Neo4j => {
        format!("// Neo4j 查询: DESCRIBE {}", table)
      }
      crate::models::DatabaseType::DuckDB => {
        format!(
          "SELECT column_name as name, data_type, is_nullable, '', column_default as default_value 
           FROM information_schema.columns 
           WHERE table_schema = '{}' AND table_name = '{}' 
           ORDER BY ordinal_position",
          database, table
        )
      }
      crate::models::DatabaseType::ClickHouse => {
        format!(
          "SELECT name, type as data_type, 'YES' as is_nullable, '', default_expression as default_value 
           FROM system.columns 
           WHERE database = '{}' AND table = '{}' 
           ORDER BY position",
          database, table
        )
      }
      crate::models::DatabaseType::Elasticsearch => {
        format!("// Elasticsearch 查询: GET /{}/_mapping", table)
      }
    }
  }

  /// 获取表数据查询语句（分页）
  pub fn get_table_data_query(
    &self,
    db_type: &crate::models::DatabaseType,
    database: &str,
    table: &str,
    limit: u32,
    offset: u32,
  ) -> String {
    match db_type {
      crate::models::DatabaseType::MySQL => {
        format!(
          "SELECT * FROM `{}`.`{}` LIMIT {} OFFSET {}",
          database, table, limit, offset
        )
      }
      crate::models::DatabaseType::PostgreSQL => {
        format!(
          "SELECT * FROM \"{}\".\"{}\" LIMIT {} OFFSET {}",
          database, table, limit, offset
        )
      }
      crate::models::DatabaseType::SQLite => {
        format!(
          "SELECT * FROM \"{}\" LIMIT {} OFFSET {}",
          table, limit, offset
        )
      }
      crate::models::DatabaseType::MongoDB => {
        format!(
          "// MongoDB 查询: db.{}.find().skip({}).limit({})",
          table, offset, limit
        )
      }
      crate::models::DatabaseType::Redis => "// Redis 查询: 需要特殊处理".to_string(),
      crate::models::DatabaseType::Neo4j => {
        format!(
          "// Neo4j Cypher 查询: MATCH (n) RETURN n SKIP {} LIMIT {}",
          offset, limit
        )
      }
      crate::models::DatabaseType::DuckDB => {
        format!(
          "SELECT * FROM \"{}\" LIMIT {} OFFSET {}",
          table, limit, offset
        )
      }
      crate::models::DatabaseType::ClickHouse => {
        format!(
          "SELECT * FROM \"{}\" LIMIT {} OFFSET {}",
          table, limit, offset
        )
      }
      crate::models::DatabaseType::Elasticsearch => {
        format!(
          "// Elasticsearch 查询: GET /{}/_search?from={}&size={}",
          table, offset, limit
        )
      }
    }
  }
}
