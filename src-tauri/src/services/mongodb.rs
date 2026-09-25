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
use crate::services::csv_import::{
  ImportProgress, ImportRowError, ImportSummary, FILE_OPEN_FAILED, FILE_READ_FAILED,
  MAX_RECORDED_ERRORS, PAUSE_POLL,
};
use crate::services::export_writer::{
  part_path_for, ExportProgress, ExportSummary, PartFile, DIRECTORY_MISSING, EXPORT_CANCELLED,
  EXPORT_CANCELLED_CODE, EXPORT_WRITE_FAILED, FILE_CREATE_FAILED, FILE_RENAME_FAILED,
  PROGRESS_INTERVAL,
};
use crate::services::mongo_shell::{self, Layout};
use crate::services::pool_registry::PoolRegistry;
use crate::services::query_error::QueryError;
use futures_util::TryStreamExt;
use indexmap::IndexMap;
use mongodb::bson::{doc, Bson, Document};
use mongodb::options::{ClientOptions, Credential, ServerAddress, Tls, TlsOptions};
use mongodb::results::CollectionType;
use mongodb::Client;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
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

/// 键是空文档：索引总得建在某个字段上
pub const MONGO_INDEX_KEYS_EMPTY: &str = "DATAOMNI_MONGO_INDEX_KEYS_EMPTY";
/// 一模一样的索引已经有了，服务端什么都没做。数据是索引名
pub const MONGO_INDEX_EXISTS: &str = "DATAOMNI_MONGO_INDEX_EXISTS";

/// 建索引。`keys` 与 `options` 就是 mongosh 里 `createIndex(keys, options)` 的两个参数，
/// 返回索引名。
///
/// 发 `createIndexes` 命令本身，选项原样并进索引说明里——和结构页只读原样一个道理，
/// 驱动的 `IndexOptions` 只认它知道的那些。`maxTimeMS` 照查询超时给：大集合上建得太久
/// 就让服务端停下这次建索引，而不是在本机放弃等待、留服务端接着建
pub async fn create_index(
  client: &Client,
  database: &str,
  collection: &str,
  keys: Document,
  options: Document,
  timeout: Duration,
) -> Result<String, String> {
  if keys.is_empty() {
    return Err(MONGO_INDEX_KEYS_EMPTY.to_string());
  }
  let name = match options.get_str("name") {
    Ok(name) => name.to_string(),
    Err(_) => default_index_name(&keys),
  };
  let mut index = doc! { "key": keys, "name": name.as_str() };
  index.extend(options);
  let command = doc! {
    "createIndexes": collection,
    "indexes": [index],
    "maxTimeMS": i64::try_from(timeout.as_millis()).unwrap_or(i64::MAX),
  };
  let db = client.database(database);
  let work = async {
    let reply = db.run_command(command).await.map_err(describe_error)?;
    // 键和选项都相同的索引已经在了：服务端回答 ok，只多一句 note
    if reply_integer(&reply, "numIndexesBefore") == reply_integer(&reply, "numIndexesAfter") {
      return Err(format!("{MONGO_INDEX_EXISTS}: {name}"));
    }
    Ok(name.clone())
  };
  with_deadline(timeout, work).await
}

/// 按名字删索引。`_id_` 服务端自己会拒绝，界面上也不给删的按钮
pub async fn drop_index(
  client: &Client,
  database: &str,
  collection: &str,
  name: &str,
  timeout: Duration,
) -> Result<(), String> {
  let command = doc! {
    "dropIndexes": collection,
    "index": name,
    "maxTimeMS": i64::try_from(timeout.as_millis()).unwrap_or(i64::MAX),
  };
  let db = client.database(database);
  let work = async {
    db.run_command(command).await.map_err(describe_error)?;
    Ok(())
  };
  with_deadline(timeout, work).await
}

/// 没给名字时 mongosh 起的名字：`字段_方向` 用下划线连起来（`status_1_createdAt_-1`、
/// `title_text`）。同一套命名，建出来的索引在别的工具里看着也一样
fn default_index_name(keys: &Document) -> String {
  keys
    .iter()
    .map(|(field, direction)| {
      let direction = match direction {
        Bson::Int32(value) => value.to_string(),
        Bson::Int64(value) => value.to_string(),
        Bson::Double(value) if value.fract() == 0.0 => format!("{value:.0}"),
        Bson::String(kind) => kind.clone(),
        other => mongo_shell::format_value(other, Layout::OneLine),
      };
      format!("{field}_{direction}")
    })
    .collect::<Vec<_>>()
    .join("_")
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

/// 导出文件里每个文档的 JSON 写法，即 mongoexport 的 `--jsonFormat`
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ExtendedJson {
  /// mongoexport 的默认：数字、日期写成普通 JSON，好读；读回来 `Long(5)` 会变成 Int32
  Relaxed,
  /// 每个值都带类型（`{"$numberLong":"5"}`），mongoimport 读回来与原来一模一样
  Canonical,
}

/// 把符合条件的**全部**文档按排序写成文件，每行一个，与 `mongoexport` 的默认输出同一种
/// 格式，`mongoimport` 直接读得回去。
///
/// 不设时限：导出一个大集合要多久是未知的，停下来靠取消。和 SQL 的导出一样先写
/// `.part` 再改名，中途失败或取消时那半份文件被删掉
#[allow(clippy::too_many_arguments)]
pub async fn export_to_file(
  client: &Client,
  database: &str,
  collection: &str,
  filter: Document,
  sort: Document,
  format: ExtendedJson,
  path: &Path,
  progress: &mut (dyn FnMut(ExportProgress) + Send),
  cancelled: &mut (dyn FnMut() -> bool + Send),
) -> Result<ExportSummary, QueryError> {
  if let Some(parent) = path.parent() {
    if !parent.as_os_str().is_empty() && !parent.exists() {
      return Err(QueryError::message(format!("{DIRECTORY_MISSING}: {}", parent.display())));
    }
  }
  let collection = client.database(database).collection::<Document>(collection);
  let mut action = collection.find(filter);
  if !sort.is_empty() {
    action = action.sort(sort);
  }
  let mut cursor = action.await.map_err(|error| QueryError::message(describe_error(error)))?;

  let part_path = part_path_for(path);
  let mut guard = PartFile { path: part_path.clone(), armed: true };
  let file = std::fs::File::create(&part_path).map_err(|error| {
    QueryError::message(format!("{FILE_CREATE_FAILED}: {} · {error}", part_path.display()))
  })?;
  let mut writer = BufWriter::new(file);
  let write_failed =
    |error: std::io::Error| QueryError::message(format!("{EXPORT_WRITE_FAILED}: {error}"));

  let mut rows_written = 0u64;
  let mut bytes_written = 0u64;
  let mut last_report = std::time::Instant::now();
  while let Some(document) =
    cursor.try_next().await.map_err(|error| QueryError::message(describe_error(error)))?
  {
    if cancelled() {
      return Err(QueryError::with_code(EXPORT_CANCELLED_CODE, EXPORT_CANCELLED));
    }
    let value = match format {
      ExtendedJson::Relaxed => Bson::Document(document).into_relaxed_extjson(),
      ExtendedJson::Canonical => Bson::Document(document).into_canonical_extjson(),
    };
    let mut line = serde_json::to_vec(&value)
      .map_err(|error| QueryError::message(format!("{EXPORT_WRITE_FAILED}: {error}")))?;
    line.push(b'\n');
    writer.write_all(&line).map_err(write_failed)?;
    rows_written += 1;
    bytes_written += line.len() as u64;
    if last_report.elapsed() >= PROGRESS_INTERVAL {
      last_report = std::time::Instant::now();
      progress(ExportProgress { rows_written, bytes_written });
    }
  }
  writer.flush().map_err(write_failed)?;
  drop(writer);
  std::fs::rename(&part_path, path).map_err(|error| {
    QueryError::message(format!("{FILE_RENAME_FAILED}: {} · {error}", path.display()))
  })?;
  guard.armed = false;

  progress(ExportProgress { rows_written, bytes_written });
  Ok(ExportSummary { rows_written, bytes_written, path: path.to_string_lossy().to_string() })
}

/// 文件以 `[` 开头：那是 `mongoexport --jsonArray` 的输出，这里只读每行一个文档的那种
pub const MONGO_IMPORT_JSON_ARRAY: &str = "DATAOMNI_MONGO_IMPORT_JSON_ARRAY";
/// 这一行读不成一个文档。数据是解析器的原话
pub const MONGO_IMPORT_LINE_INVALID: &str = "DATAOMNI_MONGO_IMPORT_LINE_INVALID";

/// 一次写命令最多带多少个文档、多少字节的 JSON。服务端一条命令的上限是 16 MB，
/// 字节数按文件里的文字算，与 BSON 的大小差不多，留一半的余量
const IMPORT_BATCH_DOCUMENTS: usize = 1000;
const IMPORT_BATCH_BYTES: usize = 8 * 1024 * 1024;
/// 出错的行带回去多少个字符给人看。一行可以是一个 16 MB 的文档
const IMPORT_ERROR_PREVIEW_CHARS: usize = 200;

/// `_id` 已经在库里的文档怎么办，即 mongoimport 的 `--mode`
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
  /// 只新增：`_id` 已存在的那一行记成失败，库里那份不动。mongoimport 的默认
  Insert,
  /// 按 `_id` 整份替换，没有的新增。没带 `_id` 的文档照常新增
  Upsert,
}

/// 读出来还没写的一行
struct PendingDocument {
  line: u64,
  document: Document,
  /// 出错时带回去的那一段原文
  preview: String,
}

#[derive(Default)]
struct ImportTally {
  rows_read: u64,
  rows_written: u64,
  rows_failed: u64,
  errors: Vec<ImportRowError>,
  errors_truncated: bool,
}

impl ImportTally {
  fn fail(&mut self, line: u64, message: String, preview: String) {
    self.rows_failed += 1;
    if self.errors.len() < MAX_RECORDED_ERRORS {
      self.errors.push(ImportRowError { line, message, values: vec![preview] });
    } else {
      self.errors_truncated = true;
    }
  }

  fn progress(&self) -> ImportProgress {
    ImportProgress {
      rows_read: self.rows_read,
      rows_inserted: self.rows_written,
      rows_failed: self.rows_failed,
    }
  }
}

/// 读一行 Extended JSON。relaxed 与 canonical 都认，和 mongoimport 一样
fn parse_import_line(text: &str) -> Result<Document, String> {
  let value: serde_json::Value =
    serde_json::from_str(text).map_err(|error| format!("{MONGO_IMPORT_LINE_INVALID}: {error}"))?;
  match Bson::try_from(value) {
    Ok(Bson::Document(document)) => Ok(document),
    Ok(other) => Err(format!("{MONGO_IMPORT_LINE_INVALID}: {}", mongo_shell::value_kind(&other))),
    Err(error) => Err(format!("{MONGO_IMPORT_LINE_INVALID}: {error}")),
  }
}

/// 把一个 mongoexport 格式的文件（每行一个文档）写进集合。
///
/// 分批发写命令，`ordered: false`：一个文档坏了（`_id` 重复、过不了校验规则）只记下
/// 它自己，同一批的其余照常写进去，与 mongoimport 的做法一样。没有事务——取消或出错时
/// 已经写进去的留在库里，`rows_inserted` 是真正写进去的数。
///
/// 发的是 `insert` / `update` 命令本身而不是驱动的 `insert_many`：两种模式的回答
/// 都带 `writeErrors[].index`，才能对回文件里的行号
#[allow(clippy::too_many_arguments)]
pub async fn import_from_file(
  client: &Client,
  database: &str,
  collection: &str,
  mode: ImportMode,
  path: &Path,
  progress: &mut (dyn FnMut(ImportProgress) + Send),
  cancelled: &mut (dyn FnMut() -> bool + Send),
  paused: &mut (dyn FnMut() -> bool + Send),
) -> Result<ImportSummary, QueryError> {
  let file = std::fs::File::open(path).map_err(|error| {
    QueryError::message(format!("{FILE_OPEN_FAILED}: {} · {error}", path.display()))
  })?;
  let mut reader = BufReader::new(file);
  let database = client.database(database);

  let mut tally = ImportTally::default();
  let mut batch: Vec<PendingDocument> = Vec::new();
  let mut batch_bytes = 0usize;
  let mut buffer = String::new();
  let mut line = 0u64;
  let mut was_cancelled = false;
  let mut last_report = std::time::Instant::now();
  loop {
    buffer.clear();
    let read = reader
      .read_line(&mut buffer)
      .map_err(|error| QueryError::message(format!("{FILE_READ_FAILED}: {error}")))?;
    if read == 0 {
      break;
    }
    line += 1;
    let text = buffer.trim();
    if text.is_empty() {
      continue;
    }
    if tally.rows_read == 0 && text.starts_with('[') {
      return Err(QueryError::message(MONGO_IMPORT_JSON_ARRAY));
    }
    tally.rows_read += 1;
    let preview: String = text.chars().take(IMPORT_ERROR_PREVIEW_CHARS).collect();
    match parse_import_line(text) {
      Ok(document) => {
        batch_bytes += text.len();
        batch.push(PendingDocument { line, document, preview });
      }
      Err(message) => tally.fail(line, message, preview),
    }
    if batch.len() < IMPORT_BATCH_DOCUMENTS && batch_bytes < IMPORT_BATCH_BYTES {
      continue;
    }

    write_import_batch(&database, collection, mode, std::mem::take(&mut batch), &mut tally).await?;
    batch_bytes = 0;
    if cancelled() {
      was_cancelled = true;
      break;
    }
    while paused() {
      if cancelled() {
        was_cancelled = true;
        break;
      }
      tokio::time::sleep(PAUSE_POLL).await;
    }
    if was_cancelled {
      break;
    }
    if last_report.elapsed() >= PROGRESS_INTERVAL {
      last_report = std::time::Instant::now();
      progress(tally.progress());
    }
  }
  if !was_cancelled && !batch.is_empty() {
    write_import_batch(&database, collection, mode, batch, &mut tally).await?;
  }

  progress(tally.progress());
  Ok(ImportSummary {
    rows_read: tally.rows_read,
    rows_inserted: tally.rows_written,
    rows_failed: tally.rows_failed,
    errors: tally.errors,
    errors_truncated: tally.errors_truncated,
    rolled_back: false,
    cancelled: was_cancelled,
  })
}

/// 发一批。命令本身失败（没有权限、连接断了）就停下整个导入：下一批只会以同样的
/// 原因失败；单个文档的失败在回答的 `writeErrors` 里，按下标记到行上
async fn write_import_batch(
  database: &mongodb::Database,
  collection: &str,
  mode: ImportMode,
  batch: Vec<PendingDocument>,
  tally: &mut ImportTally,
) -> Result<(), QueryError> {
  let mut lines = Vec::with_capacity(batch.len());
  let mut documents = Vec::with_capacity(batch.len());
  for pending in batch {
    lines.push((pending.line, pending.preview));
    documents.push(pending.document);
  }
  let command = match mode {
    ImportMode::Insert => doc! { "insert": collection, "documents": documents, "ordered": false },
    ImportMode::Upsert => {
      let updates: Vec<Document> = documents
        .into_iter()
        .map(|document| {
          // 没有 `_id` 就按不出「同一个」，先给它一个，结果就是新增
          let document = if document.contains_key("_id") {
            document
          } else {
            let mut with_id = doc! { "_id": mongodb::bson::oid::ObjectId::new() };
            with_id.extend(document);
            with_id
          };
          let id = document.get("_id").cloned().unwrap_or(Bson::Null);
          doc! { "q": { "_id": id }, "u": document, "upsert": true }
        })
        .collect();
      doc! { "update": collection, "updates": updates, "ordered": false }
    }
  };
  let reply = database
    .run_command(command)
    .await
    .map_err(|error| QueryError::message(describe_error(error)))?;
  if let Ok(concern) = reply.get_document("writeConcernError") {
    return Err(QueryError::message(format!(
      "{MONGO_SERVER_ERROR}: {}",
      concern.get_str("errmsg").unwrap_or_default()
    )));
  }

  if let Ok(write_errors) = reply.get_array("writeErrors") {
    for error in write_errors.iter().filter_map(Bson::as_document) {
      let index = reply_integer(error, "index");
      let Some((line, preview)) = usize::try_from(index).ok().and_then(|index| lines.get(index))
      else {
        continue;
      };
      let message = format!(
        "{MONGO_SERVER_ERROR}: {} (code {})",
        error.get_str("errmsg").unwrap_or_default(),
        reply_integer(error, "code")
      );
      tally.fail(*line, message, preview.clone());
    }
  }
  // `n` 在 update 里是「匹配到的加新增的」，正好是写进去的文档数
  tally.rows_written += u64::try_from(reply_integer(&reply, "n")).unwrap_or(0);
  Ok(())
}

/// 服务端回答里的整数可能是 Int32 也可能是 Int64
fn reply_integer(document: &Document, key: &str) -> i64 {
  match document.get(key) {
    Some(Bson::Int32(value)) => i64::from(*value),
    Some(Bson::Int64(value)) => *value,
    Some(Bson::Double(value)) => *value as i64,
    _ => 0,
  }
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
  fn an_import_line_reads_both_extended_json_forms_and_nothing_but_documents() {
    let canonical = parse_import_line(r#"{"n":{"$numberLong":"5"},"d":{"$numberDouble":"3.0"}}"#);
    assert_eq!(canonical, Ok(doc! { "n": 5_i64, "d": 3.0 }));
    let relaxed = parse_import_line(r#"{"n":5,"at":{"$date":"2024-01-05T12:30:45.123Z"}}"#);
    assert!(matches!(
      relaxed.as_ref().map(|document| document.get("at")),
      Ok(Some(Bson::DateTime(_)))
    ));
    for bad in ["[1, 2]", "42", "{n: 1}"] {
      let error = parse_import_line(bad).expect_err(bad);
      assert!(error.starts_with(MONGO_IMPORT_LINE_INVALID), "{bad}: {error}");
    }
  }

  #[test]
  fn an_unnamed_index_is_named_the_way_mongosh_names_it() {
    assert_eq!(default_index_name(&doc! { "status": 1, "createdAt": -1 }), "status_1_createdAt_-1");
    assert_eq!(default_index_name(&doc! { "title": "text" }), "title_text");
    assert_eq!(default_index_name(&doc! { "n": 1.0, "at": Bson::Int64(-1) }), "n_1_at_-1");
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
