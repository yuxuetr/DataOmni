//! Neo4j 连接上的命令。连接由 `test_connection` 登记，这里按不带口令的连接串取。

use crate::commands::database_commands::TIMEOUT_OUT_OF_RANGE;
use crate::services::neo4j::{
  self, CypherRequest, CypherResult, Neo4jObject, Neo4jPool, Neo4jRegistry, NEO4J_NOT_CONNECTED,
};
use std::sync::Arc;
use std::time::Duration;
use tauri::State;

/// 结果最多多少行。与执行 SQL 的结果上限同一个范围
const MAX_ROW_LIMIT: u64 = 100_000;

fn pool(registry: &Neo4jRegistry, connection_string: &str) -> Result<Arc<Neo4jPool>, String> {
  registry.get(connection_string).ok_or_else(|| NEO4J_NOT_CONNECTED.to_string())
}

/// 与执行查询同一个范围（`execute_query`）
fn timeout(timeout_ms: u64) -> Result<Duration, String> {
  if !(100..=3_600_000).contains(&timeout_ms) {
    return Err(TIMEOUT_OUT_OF_RANGE.to_string());
  }
  Ok(Duration::from_millis(timeout_ms))
}

/// 空串与没传一样：用连接配置里的库
fn database(database: Option<String>) -> Option<String> {
  database.map(|name| name.trim().to_string()).filter(|name| !name.is_empty())
}

#[tauri::command]
pub async fn neo4j_list_objects(
  connection_string: String,
  timeout_ms: u64,
  registry: State<'_, Neo4jRegistry>,
) -> Result<Vec<Neo4jObject>, String> {
  let pool = pool(&registry, &connection_string)?;
  neo4j::list_objects(pool, timeout(timeout_ms)?).await
}

#[tauri::command]
pub async fn neo4j_run(
  connection_string: String,
  database: Option<String>,
  query: String,
  limit: u64,
  timeout_ms: u64,
  read_all: Option<bool>,
  registry: State<'_, Neo4jRegistry>,
) -> Result<CypherResult, String> {
  let request = CypherRequest {
    database: self::database(database),
    query,
    limit: usize::try_from(limit.clamp(1, MAX_ROW_LIMIT)).unwrap_or(1),
    timeout: timeout(timeout_ms)?,
    read_all: read_all.unwrap_or(false),
  };
  let pool = pool(&registry, &connection_string)?;
  neo4j::run(pool, request).await
}

/// `r` / `w` / `rw` / `s`，服务端说不上来时是 `null`
#[tauri::command]
pub async fn neo4j_query_type(
  connection_string: String,
  database: Option<String>,
  query: String,
  timeout_ms: u64,
  registry: State<'_, Neo4jRegistry>,
) -> Result<Option<&'static str>, String> {
  let pool = pool(&registry, &connection_string)?;
  neo4j::query_type(pool, self::database(database), query, timeout(timeout_ms)?).await
}

#[tauri::command]
pub fn close_neo4j(connection_string: String, registry: State<'_, Neo4jRegistry>) -> bool {
  registry.remove(&connection_string)
}
