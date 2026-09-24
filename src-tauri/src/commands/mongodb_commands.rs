//! MongoDB 连接上的命令。连接由 `test_connection` 登记，这里按不带口令的连接串取。
//!
//! 条件、排序、`_id` 都以 mongosh 写法的**文本**过来，在这里解析：解析器只有
//! 一份，报错的位置对着用户输入的那段文字。

use crate::commands::database_commands::TIMEOUT_OUT_OF_RANGE;
use crate::services::mongo_shell;
use crate::services::mongodb::{
  self, CollectionEntry, FindRequest, MongoFindPage, MongoRegistry, MONGO_NOT_CONNECTED,
};
use ::mongodb::Client;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;

/// 一页最多多少个文档。与网格的 `MAX_UNVIRTUALIZED_ROWS` 同值，理由相同
const MAX_PAGE_SIZE: u64 = 200;

fn client(registry: &MongoRegistry, connection_string: &str) -> Result<Arc<Client>, String> {
  registry.get(connection_string).ok_or_else(|| MONGO_NOT_CONNECTED.to_string())
}

/// 与执行查询同一个范围（`execute_query`）
fn timeout(timeout_ms: u64) -> Result<Duration, String> {
  if !(100..=3_600_000).contains(&timeout_ms) {
    return Err(TIMEOUT_OUT_OF_RANGE.to_string());
  }
  Ok(Duration::from_millis(timeout_ms))
}

#[tauri::command]
pub async fn mongodb_list_collections(
  connection_string: String,
  registry: State<'_, MongoRegistry>,
) -> Result<Vec<CollectionEntry>, String> {
  let client = client(&registry, &connection_string)?;
  mongodb::list_collections(&client).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mongodb_find(
  connection_string: String,
  database: String,
  collection: String,
  filter: String,
  sort: String,
  skip: u64,
  limit: u64,
  timeout_ms: u64,
  registry: State<'_, MongoRegistry>,
) -> Result<MongoFindPage, String> {
  let request = FindRequest {
    filter: mongo_shell::parse_document(&filter).map_err(|error| error.to_string())?,
    sort: mongo_shell::parse_document(&sort).map_err(|error| error.to_string())?,
    skip,
    limit: limit.clamp(1, MAX_PAGE_SIZE),
    timeout: timeout(timeout_ms)?,
  };
  let client = client(&registry, &connection_string)?;
  mongodb::find(&client, &database, &collection, request).await
}

#[tauri::command]
pub async fn mongodb_count(
  connection_string: String,
  database: String,
  collection: String,
  filter: String,
  timeout_ms: u64,
  registry: State<'_, MongoRegistry>,
) -> Result<u64, String> {
  let filter = mongo_shell::parse_document(&filter).map_err(|error| error.to_string())?;
  let timeout = timeout(timeout_ms)?;
  let client = client(&registry, &connection_string)?;
  mongodb::count(&client, &database, &collection, filter, timeout).await
}

/// 一个文档的完整内容，缩进写法。`id` 是网格那一行带着的 `_id` 写法
#[tauri::command]
pub async fn mongodb_document(
  connection_string: String,
  database: String,
  collection: String,
  id: String,
  timeout_ms: u64,
  registry: State<'_, MongoRegistry>,
) -> Result<Option<String>, String> {
  let id = mongo_shell::parse_value(&id).map_err(|error| error.to_string())?;
  let timeout = timeout(timeout_ms)?;
  let client = client(&registry, &connection_string)?;
  mongodb::document_text(&client, &database, &collection, id, timeout).await
}

/// 断开时去掉登记。`Client` 的最后一个引用没了，池子里的连接随之关闭
#[tauri::command]
pub fn close_mongodb(connection_string: String, registry: State<'_, MongoRegistry>) -> bool {
  registry.remove(&connection_string)
}
