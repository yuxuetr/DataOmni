//! MongoDB：第一种非关系型库。
//!
//! 连接由后端持有，和 SQL Server / Oracle 同一个办法：`test_connection` 连上之后
//! 把 `Client` 登记在 [`MongoRegistry`] 里，键是不带口令的
//! `mongodb://user@host:port/authSource`，其余命令按同一个键取。`Client` 自己就是
//! 连接池，登记一个就够了。
//!
//! 和关系库不同、值得记住的：
//! - **总是直连（`directConnection=true`）。** 表单上只有一个主机。不直连的话，驱动
//!   会按服务端报上来的副本集成员名去连——经 SSH 隧道或 NAT 时那些名字在本机
//!   根本解析不到，表现是「服务器选择超时」，而地址明明填对了。
//! - **值的文字写法是 mongosh 的**，见 `mongo_shell`。界面上显示的、筛选框里输入的、
//!   改文档时编辑的，都是这一种，而且往返不丢类型。

use crate::models::{ConnectionProfile, TlsMode};
use crate::services::mongo_shell::{self, Layout};
use crate::services::pool_registry::PoolRegistry;
use futures_util::TryStreamExt;
use indexmap::IndexMap;
use mongodb::bson::{doc, Bson, Document};
use mongodb::options::{ClientOptions, Credential, ServerAddress, Tls, TlsOptions};
use mongodb::results::CollectionType;
use mongodb::Client;
use serde::Serialize;
use std::time::Duration;

/// 与前端 `MONGODB_SCHEME` 一致：连接串以它开头就归这里管
pub const MONGODB_SCHEME: &str = "mongodb://";

/// 登录被拒：用户名、口令或认证库不对
pub const MONGO_AUTH_FAILED: &str = "DATAOMNI_MONGO_AUTH_FAILED";
/// 没填用户名，而服务端开着认证。`ping` 不要认证，不另查一次的话测试连接会报成功，
/// 展开对象树时才报「未授权」
pub const MONGO_AUTH_REQUIRED: &str = "DATAOMNI_MONGO_AUTH_REQUIRED";
/// 在时限内没找到能用的服务端：地址不通、TLS 对不上、服务没起
pub const MONGO_UNREACHABLE: &str = "DATAOMNI_MONGO_UNREACHABLE";
/// 服务端执行命令报错，冒号后面是 `codeName: message`
pub const MONGO_SERVER_ERROR: &str = "DATAOMNI_MONGO_SERVER_ERROR";
/// 超过了查询时限（服务端 `maxTimeMS` 或本机等待）
pub const MONGO_TIMEOUT: &str = "DATAOMNI_MONGO_TIMEOUT";
/// 要改、要删的那个文档已经不在了
pub const MONGO_DOCUMENT_GONE: &str = "DATAOMNI_MONGO_DOCUMENT_GONE";
/// 要改的文档在打开之后被别处改过；不覆盖别人的改动
pub const MONGO_DOCUMENT_CHANGED: &str = "DATAOMNI_MONGO_DOCUMENT_CHANGED";
/// 编辑时改了 `_id`。服务端不许改它，这里先拦下、说人话
pub const MONGO_ID_CHANGED: &str = "DATAOMNI_MONGO_ID_CHANGED";
/// 连接串对应的连接不在（断开之后还有请求过来）
pub const MONGO_NOT_CONNECTED: &str = "DATAOMNI_DB_SESSION_NOT_CONNECTED";

/// 连接与选服务端的等待上限。和前端建立会话的 15 秒错开，让这里先报出原因
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 一个单元格最多带多少个字符过来。整格的值要看就打开文档，网格上只是一眼
const CELL_TEXT_LIMIT: usize = 2_000;

pub type MongoRegistry = PoolRegistry<Client>;

pub struct MongoTarget {
  host: String,
  port: u16,
  username: String,
  password: String,
  /// 认证库。表单上「数据库」那一格填的就是它，默认 `admin`
  auth_source: String,
  tls: TlsMode,
  ca_certificate_path: Option<String>,
}

impl MongoTarget {
  pub fn from_profile(profile: &ConnectionProfile) -> Self {
    Self {
      host: profile.host.clone(),
      port: profile.port,
      username: profile.username.clone(),
      password: profile.password.clone(),
      auth_source: profile
        .database
        .clone()
        .filter(|database| !database.is_empty())
        .unwrap_or_else(|| "admin".to_string()),
      tls: profile.effective_tls_mode(),
      ca_certificate_path: profile.ca_certificate_path.clone().filter(|path| !path.is_empty()),
    }
  }

  fn options(&self) -> ClientOptions {
    let mut options = ClientOptions::default();
    options.hosts = vec![ServerAddress::Tcp { host: self.host.clone(), port: Some(self.port) }];
    options.direct_connection = Some(true);
    options.app_name = Some("DataOmni".to_string());
    options.connect_timeout = Some(CONNECT_TIMEOUT);
    options.server_selection_timeout = Some(CONNECT_TIMEOUT);
    // 与另外几家池子同一个回收时限：经 VPN / NAT 空闲几分钟的连接会被悄悄丢掉
    options.max_idle_time = Some(crate::services::sqlx_pool::IDLE_TIMEOUT);
    if !self.username.is_empty() {
      let mut credential = Credential::default();
      credential.username = Some(self.username.clone());
      credential.password = Some(self.password.clone());
      credential.source = Some(self.auth_source.clone());
      options.credential = Some(credential);
    }
    options.tls = tls_options(self.tls, self.ca_certificate_path.as_deref());
    options
  }
}

/// TLS 档位 → 驱动的设置。
///
/// MongoDB 没有「能加密就加密，不行就明文」这一档，`Preferred` 只能当 `Required`：
/// 退回明文要驱动先失败一次再重连，而它不做这件事。与另外几家一致，`Required`
/// 只加密不校验，`VerifyFull` 校验证书链和主机名。
///
/// `VerifyCa`（只校验证书链、不校验主机名）也按完整校验：驱动只在 OpenSSL 那一版
/// 里能单独放过主机名，rustls 这一版没有这个开关。往严里走——证书上没写这个
/// 地址时连接失败、报的是主机名不符，而不是悄悄少校验一项
fn tls_options(mode: TlsMode, ca_certificate_path: Option<&str>) -> Option<Tls> {
  let mut options = TlsOptions::default();
  options.ca_file_path = ca_certificate_path.map(std::path::PathBuf::from);
  match mode {
    TlsMode::Disabled => return Some(Tls::Disabled),
    TlsMode::Preferred | TlsMode::Required => options.allow_invalid_certificates = Some(true),
    TlsMode::VerifyCa | TlsMode::VerifyFull => {}
  }
  Some(Tls::Enabled(options))
}

/// 连上并确认服务端真的可用。
///
/// `Client::with_options` 不碰网络，第一次操作才连；所以这里发一次 `ping`。
/// 带了凭据时握手就会认证，口令错在这一步报出来——不发的话要等到展开对象树
pub async fn connect(target: &MongoTarget) -> Result<Client, String> {
  let client = Client::with_options(target.options()).map_err(describe_error)?;
  client.database("admin").run_command(doc! { "ping": 1 }).await.map_err(describe_error)?;
  if target.username.is_empty() {
    // 13 是 Unauthorized：服务端开着认证，不带凭据什么都读不了
    if let Err(error) = client.list_database_names().authorized_databases(true).await {
      return Err(match *error.kind {
        mongodb::error::ErrorKind::Command(ref command) if command.code == 13 => {
          format!("{MONGO_AUTH_REQUIRED}: {}", command.message)
        }
        _ => describe_error(error),
      });
    }
  }
  Ok(client)
}

/// 驱动的错误 → 带码的一句话。认不出的原样给，比翻错强
pub fn describe_error(error: mongodb::error::Error) -> String {
  use mongodb::error::ErrorKind;
  match *error.kind {
    ErrorKind::Authentication { message, .. } => format!("{MONGO_AUTH_FAILED}: {message}"),
    ErrorKind::ServerSelection { message, .. } => format!("{MONGO_UNREACHABLE}: {message}"),
    // 50 是 MaxTimeMSExpired
    ErrorKind::Command(command) if command.code == 50 => {
      format!("{MONGO_TIMEOUT}: {}", command.message)
    }
    ErrorKind::Command(command) => {
      format!("{MONGO_SERVER_ERROR}: {}: {}", command.code_name, command.message)
    }
    other => other.to_string(),
  }
}

/// 对象树的一行，形状与关系库的对象目录一致（`object_schema` 是库名），前端
/// 那一套建树、筛选、键盘导航直接用得上
#[derive(Debug, Serialize, PartialEq)]
pub struct CollectionEntry {
  pub object_schema: String,
  pub object_name: String,
  /// `collection` 或 `view`；时序集合也是 `collection`——它能照常查
  pub object_kind: &'static str,
  pub object_id: String,
}

/// 列出能看到的库与每个库里的集合。
///
/// `authorizedDatabases`：只有某几个库权限的用户，`listDatabases` 默认会被拒，
/// 带上它服务端只列这个用户有权限的库。
pub async fn list_collections(client: &Client) -> Result<Vec<CollectionEntry>, String> {
  let names =
    client.list_database_names().authorized_databases(true).await.map_err(describe_error)?;
  let per_database = futures_util::future::try_join_all(names.into_iter().map(|name| async move {
    let specifications: Vec<_> = client
      .database(&name)
      .list_collections()
      .await
      .map_err(describe_error)?
      .try_collect()
      .await
      .map_err(describe_error)?;
    Ok::<_, String>(
      specifications
        .into_iter()
        .map(|specification| CollectionEntry {
          object_id: format!("{name}.{}", specification.name),
          object_schema: name.clone(),
          object_kind: match specification.collection_type {
            CollectionType::View => "view",
            _ => "collection",
          },
          object_name: specification.name,
        })
        .collect::<Vec<_>>(),
    )
  }))
  .await?;
  // 顺序由前端定（`trailingSchemas`：服务端自己的库排最后），这里只给个稳定的次序
  let mut entries: Vec<CollectionEntry> = per_database.into_iter().flatten().collect();
  entries.sort_by(|left, right| {
    (&left.object_schema, &left.object_name).cmp(&(&right.object_schema, &right.object_name))
  });
  Ok(entries)
}

/// 网格上的一格
#[derive(Debug, Serialize, PartialEq)]
pub struct MongoCell {
  /// 见 `mongo_shell::value_kind`
  pub kind: &'static str,
  /// 一行的 mongosh 写法
  pub text: String,
  /// 超过 [`CELL_TEXT_LIMIT`] 被截了
  pub truncated: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct MongoDocumentRow {
  /// `_id` 的写法，定位这一个文档用。视图的结果可以没有 `_id`
  pub id: Option<String>,
  /// 顶层字段，按文档里的顺序
  pub fields: IndexMap<String, MongoCell>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct MongoFindPage {
  pub documents: Vec<MongoDocumentRow>,
  /// 这一页之后还有没有。多取一条来判断，不为这个另数一遍
  pub has_more: bool,
}

pub struct FindRequest {
  pub filter: Document,
  pub sort: Document,
  pub skip: u64,
  pub limit: u64,
  pub timeout: Duration,
}

pub async fn find(
  client: &Client,
  database: &str,
  collection: &str,
  request: FindRequest,
) -> Result<MongoFindPage, String> {
  let collection = client.database(database).collection::<Document>(collection);
  let limit = request.limit.max(1);
  let query = async {
    let mut action = collection
      .find(request.filter)
      .skip(request.skip)
      .limit(i64::try_from(limit + 1).unwrap_or(i64::MAX))
      .max_time(request.timeout);
    if !request.sort.is_empty() {
      action = action.sort(request.sort);
    }
    let documents: Vec<Document> =
      action.await.map_err(describe_error)?.try_collect().await.map_err(describe_error)?;
    Ok::<_, String>(documents)
  };
  let mut documents = with_deadline(request.timeout, query).await?;
  let has_more = documents.len() as u64 > limit;
  documents.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
  Ok(MongoFindPage { documents: documents.iter().map(document_row).collect(), has_more })
}

/// 符合条件的文档数。条件为空时先用元数据里的估计值——大集合上精确计数要扫全表，
/// 而空条件下两者只在异常关机后才会不一致；视图不支持估计，退回精确计数
pub async fn count(
  client: &Client,
  database: &str,
  collection: &str,
  filter: Document,
  timeout: Duration,
) -> Result<u64, String> {
  let collection = client.database(database).collection::<Document>(collection);
  let query = async {
    if filter.is_empty() {
      if let Ok(count) = collection.estimated_document_count().max_time(timeout).await {
        return Ok(count);
      }
    }
    collection.count_documents(filter).max_time(timeout).await.map_err(describe_error)
  };
  with_deadline(timeout, query).await
}

/// 按 `_id` 取一个完整的文档，缩进的写法。找不到是 `None`：别人刚删了它
pub async fn document_text(
  client: &Client,
  database: &str,
  collection: &str,
  id: Bson,
  timeout: Duration,
) -> Result<Option<String>, String> {
  let collection = client.database(database).collection::<Document>(collection);
  let query = async {
    collection.find_one(doc! { "_id": id }).max_time(timeout).await.map_err(describe_error)
  };
  let found = with_deadline(timeout, query).await?;
  Ok(found.map(|document| mongo_shell::format_document(&document, Layout::Indented)))
}

/// 集合的一个索引
#[derive(Debug, Serialize, PartialEq)]
pub struct MongoIndex {
  pub name: String,
  /// 键的写法，`{ status: 1, createdAt: -1 }`
  pub keys: String,
  /// 其余选项（`unique`、`partialFilterExpression`、`expireAfterSeconds`……），一行；没有就是空串
  pub options: String,
}

/// 集合的「结构」：索引，加上建集合时的选项（校验规则、上限、时序、视图定义）
#[derive(Debug, Serialize, PartialEq)]
pub struct MongoCollectionStructure {
  pub indexes: Vec<MongoIndex>,
  /// `listCollections` 给的 `options`，缩进写法；没有任何选项时是空串
  pub options: String,
}

/// 取索引与选项。
///
/// 直接发 `listIndexes` / `listCollections` 两条命令、按原样显示，不经驱动的类型化结构：
/// 那些结构只认它知道的字段，部分索引的条件、通配索引的投影这类新一点的选项会被丢掉，
/// 而这一页正是为了让人看到集合上到底有什么
pub async fn collection_structure(
  client: &Client,
  database: &str,
  collection: &str,
  timeout: Duration,
) -> Result<MongoCollectionStructure, String> {
  let db = client.database(database);
  let work = async {
    let listed = db
      .run_command(
        doc! { "listCollections": 1, "filter": { "name": collection }, "nameOnly": false },
      )
      .await
      .map_err(describe_error)?;
    let specification = first_batch(&listed).into_iter().next().unwrap_or_default();
    let is_view = specification.get_str("type").is_ok_and(|kind| kind == "view");
    let options = specification.get_document("options").cloned().unwrap_or_default();
    // 视图没有索引，`listIndexes` 在它上面会报错
    let indexes = if is_view {
      Vec::new()
    } else {
      let listed =
        db.run_command(doc! { "listIndexes": collection }).await.map_err(describe_error)?;
      first_batch(&listed).iter().map(index_row).collect()
    };
    Ok(MongoCollectionStructure {
      indexes,
      options: if options.is_empty() {
        String::new()
      } else {
        mongo_shell::format_document(&options, Layout::Indented)
      },
    })
  };
  with_deadline(timeout, work).await
}

/// 命令结果里 `cursor.firstBatch` 那一批。索引与单个集合的说明都装得进第一批
fn first_batch(reply: &Document) -> Vec<Document> {
  reply
    .get_document("cursor")
    .ok()
    .and_then(|cursor| cursor.get_array("firstBatch").ok())
    .map(|batch| batch.iter().filter_map(|item| item.as_document().cloned()).collect())
    .unwrap_or_default()
}

fn index_row(index: &Document) -> MongoIndex {
  let mut options = index.clone();
  // 版本号与命名空间对人没有信息量；名字和键单独成列
  for key in ["v", "key", "name", "ns"] {
    options.remove(key);
  }
  MongoIndex {
    name: index.get_str("name").unwrap_or_default().to_string(),
    keys: index
      .get_document("key")
      .map(|keys| mongo_shell::format_document(keys, Layout::OneLine))
      .unwrap_or_default(),
    options: if options.is_empty() {
      String::new()
    } else {
      mongo_shell::format_document(&options, Layout::OneLine)
    },
  }
}

/// 整篇替换一个文档。
///
/// 条件除了 `_id` 还要求文档与打开时**完全一样**（`$$ROOT` 与 `original` 相等，
/// 字段顺序也算）。否则别人在这期间改过的字段会被这次的整篇替换悄悄盖掉——而编辑框
/// 里那份是打开时的样子，用户根本看不到别人改了什么。`original` 是打开时拿到的文字
/// 读回来的，写法往返无损（`mongo_shell`），所以它就是当时存着的那一份。
///
/// 没匹配上时再看一眼文档还在不在，把「被删了」和「被改了」分开说
pub async fn replace_document(
  client: &Client,
  database: &str,
  collection: &str,
  original: Document,
  replacement: Document,
  timeout: Duration,
) -> Result<(), String> {
  let id = original.get("_id").cloned().ok_or_else(|| MONGO_DOCUMENT_GONE.to_string())?;
  if replacement.get("_id").is_some_and(|replacement_id| *replacement_id != id) {
    return Err(format!("{MONGO_ID_CHANGED}: {}", mongo_shell::format_value(&id, Layout::OneLine)));
  }
  let collection = client.database(database).collection::<Document>(collection);
  let filter = doc! { "_id": id.clone(), "$expr": { "$eq": ["$$ROOT", { "$literal": original }] } };
  let write = async {
    let result = collection.replace_one(filter, replacement).await.map_err(describe_error)?;
    if result.matched_count == 1 {
      return Ok(());
    }
    let still_there =
      collection.count_documents(doc! { "_id": id.clone() }).await.map_err(describe_error)?;
    let id_text = mongo_shell::format_value(&id, Layout::OneLine);
    Err(if still_there > 0 {
      format!("{MONGO_DOCUMENT_CHANGED}: {id_text}")
    } else {
      format!("{MONGO_DOCUMENT_GONE}: {id_text}")
    })
  };
  with_deadline(timeout, write).await
}

/// 插入一个文档，返回它的 `_id` 写法（没写 `_id` 时是服务端生成的那个）
pub async fn insert_document(
  client: &Client,
  database: &str,
  collection: &str,
  document: Document,
  timeout: Duration,
) -> Result<String, String> {
  let collection = client.database(database).collection::<Document>(collection);
  let write = async {
    let result = collection.insert_one(document).await.map_err(describe_error)?;
    Ok(mongo_shell::format_value(&result.inserted_id, Layout::OneLine))
  };
  with_deadline(timeout, write).await
}

/// 按 `_id` 删一个文档。一个都没删到就说「已经不在了」，而不是报成功
pub async fn delete_document(
  client: &Client,
  database: &str,
  collection: &str,
  id: Bson,
  timeout: Duration,
) -> Result<(), String> {
  let collection = client.database(database).collection::<Document>(collection);
  let id_text = mongo_shell::format_value(&id, Layout::OneLine);
  let write = async {
    let result = collection.delete_one(doc! { "_id": id }).await.map_err(describe_error)?;
    if result.deleted_count == 1 {
      Ok(())
    } else {
      Err(format!("{MONGO_DOCUMENT_GONE}: {id_text}"))
    }
  };
  with_deadline(timeout, write).await
}

/// 服务端的 `maxTimeMS` 管不到网络：一条被丢掉的连接上请求能一直挂着。本机再
/// 套一层，多给两秒，让服务端的超时先报出来（它的消息更具体）
async fn with_deadline<T>(
  timeout: Duration,
  work: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
  match tokio::time::timeout(timeout + Duration::from_secs(2), work).await {
    Ok(result) => result,
    Err(_) => Err(format!("{MONGO_TIMEOUT}: {}ms", timeout.as_millis())),
  }
}

fn document_row(document: &Document) -> MongoDocumentRow {
  MongoDocumentRow {
    id: document.get("_id").map(|id| mongo_shell::format_value(id, Layout::OneLine)),
    fields: document.iter().map(|(key, value)| (key.clone(), cell(value))).collect(),
  }
}

fn cell(value: &Bson) -> MongoCell {
  let text = mongo_shell::format_value(value, Layout::OneLine);
  let truncated = text.chars().count() > CELL_TEXT_LIMIT;
  MongoCell {
    kind: mongo_shell::value_kind(value),
    text: if truncated { text.chars().take(CELL_TEXT_LIMIT).collect() } else { text },
    truncated,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use mongodb::bson::oid::ObjectId;

  #[test]
  fn a_row_keeps_field_order_and_an_id_that_parses_back() {
    let id = ObjectId::new();
    let row = document_row(&doc! { "_id": id, "name": "alice", "age": 41_i64 });
    assert_eq!(row.fields.keys().collect::<Vec<_>>(), ["_id", "name", "age"]);
    assert_eq!(
      row.fields["age"],
      MongoCell { kind: "long", text: "Long('41')".to_string(), truncated: false }
    );
    let id_text = row.id.unwrap_or_default();
    assert_eq!(mongo_shell::parse_value(&id_text), Ok(Bson::ObjectId(id)));
  }

  #[test]
  fn a_huge_cell_is_cut_and_says_so() {
    let row = document_row(&doc! { "blob": "x".repeat(CELL_TEXT_LIMIT * 2) });
    let cell = &row.fields["blob"];
    assert!(cell.truncated);
    assert_eq!(cell.text.chars().count(), CELL_TEXT_LIMIT);
  }

  #[test]
  fn an_index_row_splits_name_and_keys_from_the_rest() {
    let row = index_row(&doc! {
      "v": 2,
      "key": { "status": 1, "createdAt": -1 },
      "name": "status_1_createdAt_-1",
      "unique": true,
      "partialFilterExpression": { "status": { "$exists": true } },
    });
    assert_eq!(row.name, "status_1_createdAt_-1");
    assert_eq!(row.keys, "{ status: 1, createdAt: -1 }");
    assert_eq!(
      row.options,
      "{ unique: true, partialFilterExpression: { status: { $exists: true } } }"
    );
    // 只有名字和键的（`_id_`）：选项是空串，不是 `{}`
    assert_eq!(index_row(&doc! { "v": 2, "key": { "_id": 1 }, "name": "_id_" }).options, "");
  }

  #[test]
  fn a_view_result_without_id_has_no_id() {
    assert_eq!(document_row(&doc! { "total": 3 }).id, None);
  }

  #[test]
  fn tls_modes_map_to_what_the_other_databases_mean_by_them() {
    assert!(matches!(tls_options(TlsMode::Disabled, None), Some(Tls::Disabled)));
    let Some(Tls::Enabled(required)) = tls_options(TlsMode::Required, None) else {
      panic!("要求 TLS 就该开着");
    };
    assert_eq!(required.allow_invalid_certificates, Some(true));
    let Some(Tls::Enabled(verify_ca)) = tls_options(TlsMode::VerifyCa, Some("/ca.pem")) else {
      panic!("校验 CA 就该开着");
    };
    assert_eq!(verify_ca.allow_invalid_certificates, None);
    assert_eq!(verify_ca.ca_file_path, Some(std::path::PathBuf::from("/ca.pem")));
    let Some(Tls::Enabled(full)) = tls_options(TlsMode::VerifyFull, None) else {
      panic!("完整校验就该开着");
    };
    assert_eq!(full.allow_invalid_certificates, None);
  }

  #[test]
  fn the_auth_database_defaults_to_admin() {
    let profile = ConnectionProfile { database: Some(String::new()), ..Default::default() };
    assert_eq!(MongoTarget::from_profile(&profile).auth_source, "admin");
    let profile = ConnectionProfile { database: Some("app".to_string()), ..Default::default() };
    assert_eq!(MongoTarget::from_profile(&profile).auth_source, "app");
  }
}
