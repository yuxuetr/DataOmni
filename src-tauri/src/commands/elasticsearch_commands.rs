//! Elasticsearch 连接上的命令。连接由 `test_connection` 登记，这里按不带口令的连接串取。

use crate::commands::database_commands::TIMEOUT_OUT_OF_RANGE;
use crate::services::elasticsearch::{
  self, EsObject, EsPool, EsRegistry, EsRequest, EsResponse, ES_NOT_CONNECTED,
};
use std::sync::Arc;
use std::time::Duration;
use tauri::State;

fn pool(registry: &EsRegistry, connection_string: &str) -> Result<Arc<EsPool>, String> {
  registry.get(connection_string).ok_or_else(|| ES_NOT_CONNECTED.to_string())
}

/// 与执行查询同一个范围（`execute_query`）
fn timeout(timeout_ms: u64) -> Result<Duration, String> {
  if !(100..=3_600_000).contains(&timeout_ms) {
    return Err(TIMEOUT_OUT_OF_RANGE.to_string());
  }
  Ok(Duration::from_millis(timeout_ms))
}

#[tauri::command]
pub async fn elasticsearch_list_objects(
  connection_string: String,
  timeout_ms: u64,
  registry: State<'_, EsRegistry>,
) -> Result<Vec<EsObject>, String> {
  let pool = pool(&registry, &connection_string)?;
  elasticsearch::list_objects(pool, timeout(timeout_ms)?).await
}

#[tauri::command]
pub async fn elasticsearch_run(
  connection_string: String,
  method: String,
  path: String,
  body: Option<String>,
  ndjson: bool,
  timeout_ms: u64,
  registry: State<'_, EsRegistry>,
) -> Result<EsResponse, String> {
  let request = EsRequest { method, path, body, ndjson, timeout: timeout(timeout_ms)? };
  let pool = pool(&registry, &connection_string)?;
  elasticsearch::run(pool, request).await
}

#[tauri::command]
pub fn close_elasticsearch(connection_string: String, registry: State<'_, EsRegistry>) -> bool {
  registry.remove(&connection_string)
}
