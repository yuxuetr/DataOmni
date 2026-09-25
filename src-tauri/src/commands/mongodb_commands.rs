//! MongoDB 连接上的命令。连接由 `test_connection` 登记，这里按不带口令的连接串取。
//!
//! 条件、排序、`_id` 都以 mongosh 写法的**文本**过来，在这里解析：解析器只有
//! 一份，报错的位置对着用户输入的那段文字。

use crate::commands::database_commands::{
  ImportPauseState, QueryCancellationState, TIMEOUT_OUT_OF_RANGE,
};
use crate::services::csv_import::{ImportProgress, ImportSummary};
use crate::services::export_writer::{ExportProgress, ExportSummary};
use crate::services::mongo_shell;
use crate::services::mongodb::{
  self, CollectionEntry, ExtendedJson, FindRequest, ImportMode, MongoCollectionStructure,
  MongoFindPage, MongoRegistry, MONGO_NOT_CONNECTED,
};
use crate::services::query_error::QueryError;
use ::mongodb::Client;
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::oneshot;

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

/// 整篇替换一个文档。`original` 是打开时拿到的那份文字（缩进写法），用来确认这期间
/// 没有别人改过它；`replacement` 是编辑框里的
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mongodb_replace_document(
  connection_string: String,
  database: String,
  collection: String,
  original: String,
  replacement: String,
  timeout_ms: u64,
  registry: State<'_, MongoRegistry>,
) -> Result<(), String> {
  let original = mongo_shell::parse_document(&original).map_err(|error| error.to_string())?;
  let replacement = mongo_shell::parse_document(&replacement).map_err(|error| error.to_string())?;
  let timeout = timeout(timeout_ms)?;
  let client = client(&registry, &connection_string)?;
  mongodb::replace_document(&client, &database, &collection, original, replacement, timeout).await
}

/// 插入一个文档，返回它的 `_id` 写法
#[tauri::command]
pub async fn mongodb_insert_document(
  connection_string: String,
  database: String,
  collection: String,
  document: String,
  timeout_ms: u64,
  registry: State<'_, MongoRegistry>,
) -> Result<String, String> {
  let document = mongo_shell::parse_document(&document).map_err(|error| error.to_string())?;
  let timeout = timeout(timeout_ms)?;
  let client = client(&registry, &connection_string)?;
  mongodb::insert_document(&client, &database, &collection, document, timeout).await
}

#[tauri::command]
pub async fn mongodb_delete_document(
  connection_string: String,
  database: String,
  collection: String,
  id: String,
  timeout_ms: u64,
  registry: State<'_, MongoRegistry>,
) -> Result<(), String> {
  let id = mongo_shell::parse_value(&id).map_err(|error| error.to_string())?;
  let timeout = timeout(timeout_ms)?;
  let client = client(&registry, &connection_string)?;
  mongodb::delete_document(&client, &database, &collection, id, timeout).await
}

/// 集合的索引与选项（校验规则、上限、时序、视图定义）
#[tauri::command]
pub async fn mongodb_collection_structure(
  connection_string: String,
  database: String,
  collection: String,
  timeout_ms: u64,
  registry: State<'_, MongoRegistry>,
) -> Result<MongoCollectionStructure, String> {
  let timeout = timeout(timeout_ms)?;
  let client = client(&registry, &connection_string)?;
  mongodb::collection_structure(&client, &database, &collection, timeout).await
}

/// 建索引。键与选项都是 mongosh 写法的文字，即 `createIndex(keys, options)` 的两个参数
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mongodb_create_index(
  connection_string: String,
  database: String,
  collection: String,
  keys: String,
  options: String,
  timeout_ms: u64,
  registry: State<'_, MongoRegistry>,
) -> Result<String, String> {
  let keys = mongo_shell::parse_document(&keys).map_err(|error| error.to_string())?;
  let options = mongo_shell::parse_document(&options).map_err(|error| error.to_string())?;
  let timeout = timeout(timeout_ms)?;
  let client = client(&registry, &connection_string)?;
  mongodb::create_index(&client, &database, &collection, keys, options, timeout).await
}

#[tauri::command]
pub async fn mongodb_drop_index(
  connection_string: String,
  database: String,
  collection: String,
  name: String,
  timeout_ms: u64,
  registry: State<'_, MongoRegistry>,
) -> Result<(), String> {
  let timeout = timeout(timeout_ms)?;
  let client = client(&registry, &connection_string)?;
  mongodb::drop_index(&client, &database, &collection, &name, timeout).await
}

/// 断开时去掉登记。`Client` 的最后一个引用没了，池子里的连接随之关闭
#[tauri::command]
pub fn close_mongodb(connection_string: String, registry: State<'_, MongoRegistry>) -> bool {
  registry.remove(&connection_string)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoExportRequest {
  connection_string: String,
  export_id: String,
  database: String,
  collection: String,
  filter: String,
  sort: String,
  format: ExtendedJson,
  path: String,
}

/// 按条件与排序导出全部文档。取消与 SQL 的导出共用 `cancel_export`：同一张登记表、
/// 同一个「已取消」的码，任务面板不用分两套
#[tauri::command]
pub async fn mongodb_export_to_file(
  request: MongoExportRequest,
  on_progress: Channel<ExportProgress>,
  registry: State<'_, MongoRegistry>,
  cancellation_state: State<'_, QueryCancellationState>,
) -> Result<ExportSummary, QueryError> {
  let filter = mongo_shell::parse_document(&request.filter)
    .map_err(|error| QueryError::message(error.to_string()))?;
  let sort = mongo_shell::parse_document(&request.sort)
    .map_err(|error| QueryError::message(error.to_string()))?;
  let client = client(&registry, &request.connection_string).map_err(QueryError::message)?;

  let mut receiver =
    cancellation_state.register(&request.export_id).await.map_err(QueryError::message)?;
  let mut report = |progress| {
    on_progress.send(progress).ok();
  };
  let mut cancelled = || !matches!(receiver.try_recv(), Err(oneshot::error::TryRecvError::Empty));
  let result = mongodb::export_to_file(
    &client,
    &request.database,
    &request.collection,
    filter,
    sort,
    request.format,
    std::path::Path::new(&request.path),
    &mut report,
    &mut cancelled,
  )
  .await;
  cancellation_state.finish(&request.export_id).await;
  result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoImportRequest {
  connection_string: String,
  import_id: String,
  database: String,
  collection: String,
  mode: ImportMode,
  path: String,
}

/// 把一个 mongoexport 格式的文件导入集合。取消、暂停与 CSV 导入共用
/// `cancel_import` / `set_import_paused`
#[tauri::command]
pub async fn mongodb_import_file(
  request: MongoImportRequest,
  on_progress: Channel<ImportProgress>,
  registry: State<'_, MongoRegistry>,
  cancellation_state: State<'_, QueryCancellationState>,
  pause_state: State<'_, ImportPauseState>,
) -> Result<ImportSummary, QueryError> {
  let client = client(&registry, &request.connection_string).map_err(QueryError::message)?;
  let mut receiver =
    cancellation_state.register(&request.import_id).await.map_err(QueryError::message)?;
  let mut report = |progress| {
    on_progress.send(progress).ok();
  };
  let mut cancelled = || !matches!(receiver.try_recv(), Err(oneshot::error::TryRecvError::Empty));
  let mut paused = || pause_state.paused_now(&request.import_id);
  let result = mongodb::import_from_file(
    &client,
    &request.database,
    &request.collection,
    request.mode,
    std::path::Path::new(&request.path),
    &mut report,
    &mut cancelled,
    &mut paused,
  )
  .await;
  cancellation_state.finish(&request.import_id).await;
  pause_state.set(&request.import_id, false).await;
  result
}
