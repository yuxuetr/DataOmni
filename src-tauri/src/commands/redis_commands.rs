//! Redis 连接上的命令。连接由 `test_connection` 登记，这里按不带口令的连接串取。
//!
//! 键以 base64 过来（`RedisBytes::raw`）：键是字节串，界面上那份文字可能是转义过的。

use crate::commands::database_commands::TIMEOUT_OUT_OF_RANGE;
use crate::services::redis::{
  self, KeyspaceEntry, RedisPool, RedisRegistry, RedisValue, ScanPage, ScanRequest, ValueRequest,
  REDIS_NOT_CONNECTED,
};
use std::sync::Arc;
use std::time::Duration;
use tauri::State;

/// 一页最多多少个键或元素。与网格的 `MAX_UNVIRTUALIZED_ROWS` 同值，理由相同
const MAX_PAGE_SIZE: u64 = 200;

fn pool(registry: &RedisRegistry, connection_string: &str) -> Result<Arc<RedisPool>, String> {
  registry.get(connection_string).ok_or_else(|| REDIS_NOT_CONNECTED.to_string())
}

/// 与执行查询同一个范围（`execute_query`）
fn timeout(timeout_ms: u64) -> Result<Duration, String> {
  if !(100..=3_600_000).contains(&timeout_ms) {
    return Err(TIMEOUT_OUT_OF_RANGE.to_string());
  }
  Ok(Duration::from_millis(timeout_ms))
}

#[tauri::command]
pub async fn redis_list_keyspaces(
  connection_string: String,
  registry: State<'_, RedisRegistry>,
) -> Result<Vec<KeyspaceEntry>, String> {
  let pool = pool(&registry, &connection_string)?;
  redis::list_keyspaces(&pool).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn redis_scan(
  connection_string: String,
  database: i64,
  pattern: String,
  cursor: String,
  kind: Option<String>,
  page: u64,
  timeout_ms: u64,
  registry: State<'_, RedisRegistry>,
) -> Result<ScanPage, String> {
  let request = ScanRequest {
    database,
    // 空的模式就是全部；`SCAN MATCH ""` 什么也匹配不到
    pattern: if pattern.is_empty() { "*".to_string() } else { pattern },
    cursor,
    kind: kind.filter(|kind| !kind.is_empty()),
    page: usize::try_from(page.clamp(1, MAX_PAGE_SIZE)).unwrap_or(1),
    timeout: timeout(timeout_ms)?,
  };
  let pool = pool(&registry, &connection_string)?;
  redis::scan(&pool, request).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn redis_read_value(
  connection_string: String,
  database: i64,
  key: String,
  position: Option<String>,
  page: u64,
  timeout_ms: u64,
  registry: State<'_, RedisRegistry>,
) -> Result<RedisValue, String> {
  let request = ValueRequest {
    database,
    key: redis::decode_key(&key)?,
    position,
    page: page.clamp(1, MAX_PAGE_SIZE),
    timeout: timeout(timeout_ms)?,
  };
  let pool = pool(&registry, &connection_string)?;
  redis::read_value(&pool, request).await
}

/// 断开时去掉登记。最后一个引用没了，各库号上的连接随之关闭
#[tauri::command]
pub fn close_redis(connection_string: String, registry: State<'_, RedisRegistry>) -> bool {
  registry.remove(&connection_string)
}
