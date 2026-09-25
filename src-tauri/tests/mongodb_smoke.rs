//! MongoDB 的真库用例。
//!
//! 默认静默跳过；要跑就在 shell 里设
//! `DATAOMNI_MONGODB_TEST_URL=mongodb://user:password@host:port/authSource`
//! （**不要写进任何文件**），并设 `DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS=1`
//! 让缺了连接串的时候报错而不是跳过。
//!
//! 用例在 `dataomni_test` 库里建自己的集合，开头先删同名的残留。

use dataomni_lib::models::ConnectionProfile;
use dataomni_lib::services::mongo_shell::{self, Layout};
use dataomni_lib::services::mongodb::{
  self as mongo, FindRequest, MongoTarget, MONGO_AUTH_FAILED, MONGO_AUTH_REQUIRED,
  MONGO_DOCUMENT_CHANGED, MONGO_DOCUMENT_GONE, MONGO_ID_CHANGED, MONGO_SERVER_ERROR, MONGO_TIMEOUT,
  MONGO_UNREACHABLE,
};
use mongodb::bson::{doc, Document};
use mongodb::Client;
use serde_json::json;
use std::time::{Duration, Instant};

const URL_ENV: &str = "DATAOMNI_MONGODB_TEST_URL";
const REQUIRE_ENV: &str = "DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS";
const DATABASE: &str = "dataomni_test";

fn profile_from_env() -> Option<ConnectionProfile> {
  let url = match std::env::var(URL_ENV) {
    Ok(url) if !url.is_empty() => url,
    _ if std::env::var(REQUIRE_ENV).as_deref() == Ok("1") => {
      panic!("{URL_ENV} must be set when {REQUIRE_ENV}=1")
    }
    _ => return None,
  };
  let rest = url.strip_prefix("mongodb://").expect("mongodb:// URL");
  let (credentials, address) = rest.rsplit_once('@').expect("user:password@host");
  let (username, password) = credentials.split_once(':').expect("user:password");
  let (host_port, auth_source) = address.split_once('/').expect("host:port/authSource");
  let (host, port) = host_port.rsplit_once(':').expect("host:port");
  let profile = json!({
    "name": "mongodb-smoke",
    "db_type": "mongodb",
    "host": host,
    "port": port.parse::<u16>().expect("port"),
    "database": auth_source,
    "username": username,
    "password": password,
    "ssl": false,
    "tls_mode": "disabled",
    "options": {},
    "tags": []
  });
  Some(serde_json::from_value(profile).expect("profile"))
}

async fn client() -> Option<Client> {
  let profile = profile_from_env()?;
  Some(mongo::connect(&MongoTarget::from_profile(&profile)).await.expect("connect to MongoDB"))
}

/// 每条用例一个集合，先删残留
async fn fresh_collection(client: &Client, name: &str) -> mongodb::Collection<Document> {
  let collection = client.database(DATABASE).collection::<Document>(name);
  collection.drop().await.expect("drop leftover");
  collection
}

fn request(filter: &str, sort: &str, skip: u64, limit: u64) -> FindRequest {
  FindRequest {
    filter: mongo_shell::parse_document(filter).expect("filter"),
    sort: mongo_shell::parse_document(sort).expect("sort"),
    skip,
    limit,
    timeout: Duration::from_secs(10),
  }
}

/// 所有常见类型存进去、按网格给的 `_id` 取回来、读成文档，必须和存进去的一模一样。
/// 这是「显示的写法就是能写回去的写法」在真服务端上的那一半
#[tokio::test]
async fn a_document_read_back_through_the_shell_text_equals_what_was_stored() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_round_trip").await;
  let stored = mongo_shell::parse_document(
    "{
      _id: ObjectId('65a0c0ffee0000000000abcd'),
      int: 30, long: Long('41'), double: 3.0, decimal: Decimal128('12.50'),
      text: 'it\\'s 中文 😀', flag: true, nothing: null,
      at: ISODate('2024-01-05T12:30:45.123Z'),
      bytes: Binary.createFromBase64('AQID', 0), uuid: UUID('00112233-4455-6677-8899-aabbccddeeff'),
      pattern: /^al/i, ts: Timestamp({ t: 1700000000, i: 7 }),
      nested: { city: 'Beijing', tags: ['a', 'b'] }, list: [1, Long('2'), { three: 3.5 }]
    }",
  )
  .expect("literal");
  collection.insert_one(stored.clone()).await.expect("insert");

  let page =
    mongo::find(&client, DATABASE, "smoke_round_trip", request("", "", 0, 10)).await.expect("find");
  assert_eq!(page.documents.len(), 1);
  let row = &page.documents[0];
  assert_eq!(row.fields["long"].text, "Long('41')");
  assert_eq!(row.fields["double"].kind, "double");

  let id = mongo_shell::parse_value(row.id.as_deref().expect("_id")).expect("id text parses");
  let text =
    mongo::document_text(&client, DATABASE, "smoke_round_trip", id, Duration::from_secs(10))
      .await
      .expect("fetch")
      .expect("still there");
  assert_eq!(mongo_shell::parse_document(&text).expect("pretty text parses"), stored, "{text}");
  // 缩进写法也就是编辑框里的样子
  assert_eq!(text, mongo_shell::format_document(&stored, Layout::Indented));
}

#[tokio::test]
async fn paging_filter_sort_and_count_agree() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_paging").await;
  let documents: Vec<Document> =
    (0..25).map(|n| doc! { "n": n, "even": n % 2 == 0, "name": format!("item-{n:02}") }).collect();
  collection.insert_many(documents).await.expect("insert");

  let first =
    mongo::find(&client, DATABASE, "smoke_paging", request("{ even: true }", "{ n: -1 }", 0, 5))
      .await
      .expect("first page");
  let numbers: Vec<&str> =
    first.documents.iter().map(|row| row.fields["n"].text.as_str()).collect();
  assert_eq!(numbers, ["24", "22", "20", "18", "16"]);
  assert!(first.has_more);

  // 偶数一共 13 个：第三页只剩 3 个，而且说没有下一页了
  let last =
    mongo::find(&client, DATABASE, "smoke_paging", request("{ even: true }", "{ n: -1 }", 10, 5))
      .await
      .expect("last page");
  assert_eq!(last.documents.len(), 3);
  assert!(!last.has_more);

  // 恰好整页的时候也不能说还有
  let exact =
    mongo::find(&client, DATABASE, "smoke_paging", request("{ n: { $lt: 5 } }", "", 0, 5))
      .await
      .expect("exact page");
  assert_eq!((exact.documents.len(), exact.has_more), (5, false));

  let regex = mongo::find(
    &client,
    DATABASE,
    "smoke_paging",
    request("{ name: /-0[0-2]$/ }", "{ n: 1 }", 0, 10),
  )
  .await
  .expect("regex filter");
  assert_eq!(regex.documents.len(), 3);

  let timeout = Duration::from_secs(10);
  let even = mongo::count(&client, DATABASE, "smoke_paging", doc! { "even": true }, timeout).await;
  assert_eq!(even, Ok(13));
  let all = mongo::count(&client, DATABASE, "smoke_paging", Document::new(), timeout).await;
  assert_eq!(all, Ok(25));
}

#[tokio::test]
async fn the_object_tree_lists_collections_and_views_by_database() {
  let Some(client) = client().await else { return };
  fresh_collection(&client, "smoke_tree").await.insert_one(doc! { "x": 1 }).await.expect("insert");
  let database = client.database(DATABASE);
  let _ = database.collection::<Document>("smoke_tree_view").drop().await;
  database
    .run_command(doc! { "create": "smoke_tree_view", "viewOn": "smoke_tree", "pipeline": [] })
    .await
    .expect("create view");

  let entries = mongo::list_collections(&client).await.expect("list");
  let find = |name: &str| {
    entries.iter().find(|entry| entry.object_schema == DATABASE && entry.object_name == name)
  };
  assert_eq!(find("smoke_tree").map(|entry| entry.object_kind), Some("collection"));
  assert_eq!(find("smoke_tree_view").map(|entry| entry.object_kind), Some("view"));
  // 视图也能查、能数：估计计数在视图上不可用，要退回精确计数
  let count =
    mongo::count(&client, DATABASE, "smoke_tree_view", Document::new(), Duration::from_secs(10))
      .await;
  assert_eq!(count, Ok(1));
}

#[tokio::test]
async fn a_wrong_password_is_reported_as_an_auth_failure() {
  let Some(mut profile) = profile_from_env() else { return };
  profile.password.push_str("-wrong");
  let error = mongo::connect(&MongoTarget::from_profile(&profile)).await.err().unwrap_or_default();
  assert!(error.starts_with(MONGO_AUTH_FAILED), "{error}");
}

/// 不填用户名连一台开着认证的服务端：`ping` 不要认证，只 ping 的话测试连接会报成功
#[tokio::test]
async fn no_username_against_an_auth_server_fails_at_connect_time() {
  let Some(mut profile) = profile_from_env() else { return };
  profile.username.clear();
  profile.password.clear();
  let error = mongo::connect(&MongoTarget::from_profile(&profile)).await.err().unwrap_or_default();
  assert!(error.starts_with(MONGO_AUTH_REQUIRED), "{error}");
}

#[tokio::test]
async fn a_closed_port_is_reported_as_unreachable_within_the_connect_timeout() {
  let Some(mut profile) = profile_from_env() else { return };
  profile.host = "127.0.0.1".to_string();
  profile.port = 1;
  let started = Instant::now();
  let error = mongo::connect(&MongoTarget::from_profile(&profile)).await.err().unwrap_or_default();
  assert!(error.starts_with(MONGO_UNREACHABLE), "{error}");
  assert!(started.elapsed() < Duration::from_secs(15), "{:?}", started.elapsed());
}

/// 超时要真的在服务端停下，报的是超时而不是一句驱动原话
#[tokio::test]
async fn a_slow_query_stops_at_the_timeout() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_slow").await;
  collection.insert_many((0..5).map(|n| doc! { "n": n })).await.expect("insert");
  let mut slow = request("{ $where: 'sleep(1000) || true' }", "", 0, 10);
  slow.timeout = Duration::from_millis(500);
  let started = Instant::now();
  let error = mongo::find(&client, DATABASE, "smoke_slow", slow).await.err().unwrap_or_default();
  assert!(error.starts_with(MONGO_TIMEOUT), "{error}");
  // 本机那层兜底要多等两秒；两秒内报出来，说明是服务端的 maxTimeMS 停下的
  assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
}

const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// 打开一个文档、在编辑框里改一个字段、存回去：没动的字段类型一个不变。
/// 这是「整篇替换」能成立的前提——编辑框里是文字，存回去的是读回来的文档
#[tokio::test]
async fn editing_one_field_leaves_the_types_of_the_others_alone() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_edit").await;
  let stored = mongo_shell::parse_document(
    "{ _id: 1, name: 'alice', long: Long('41'), whole: 3.0, money: Decimal128('9.90'), at: ISODate('2024-01-05T00:00:00Z'), tags: ['a'] }",
  )
  .expect("literal");
  collection.insert_one(stored.clone()).await.expect("insert");

  let opened = mongo::document_text(
    &client,
    DATABASE,
    "smoke_edit",
    mongodb::bson::Bson::Int32(1),
    WRITE_TIMEOUT,
  )
  .await
  .expect("open")
  .expect("there");
  let edited = opened.replace("'alice'", "'alice cooper'");
  assert_ne!(edited, opened, "编辑框里得真的改到了东西");
  mongo::replace_document(
    &client,
    DATABASE,
    "smoke_edit",
    mongo_shell::parse_document(&opened).expect("original"),
    mongo_shell::parse_document(&edited).expect("replacement"),
    WRITE_TIMEOUT,
  )
  .await
  .expect("replace");

  let now = collection.find_one(doc! { "_id": 1 }).await.expect("read").expect("there");
  let mut expected = stored;
  expected.insert("name", "alice cooper");
  assert_eq!(now, expected);
}

/// 打开之后别人改了它：不覆盖，报「被改过」；别人的改动留着
#[tokio::test]
async fn a_document_changed_elsewhere_is_not_overwritten() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_conflict").await;
  collection.insert_one(doc! { "_id": 1, "stock": 10, "note": "x" }).await.expect("insert");
  let opened = mongo::document_text(
    &client,
    DATABASE,
    "smoke_conflict",
    mongodb::bson::Bson::Int32(1),
    WRITE_TIMEOUT,
  )
  .await
  .expect("open")
  .expect("there");

  // 别处把库存改成了 9
  collection
    .update_one(doc! { "_id": 1 }, doc! { "$set": { "stock": 9 } })
    .await
    .expect("elsewhere");

  let error = mongo::replace_document(
    &client,
    DATABASE,
    "smoke_conflict",
    mongo_shell::parse_document(&opened).expect("original"),
    mongo_shell::parse_document(&opened.replace("'x'", "'y'")).expect("replacement"),
    WRITE_TIMEOUT,
  )
  .await
  .err()
  .unwrap_or_default();
  assert!(error.starts_with(MONGO_DOCUMENT_CHANGED), "{error}");
  let now = collection.find_one(doc! { "_id": 1 }).await.expect("read").expect("there");
  assert_eq!(now, doc! { "_id": 1, "stock": 9, "note": "x" });
}

/// 值里有 `$` 开头的字符串（`'$price'`）时，拿原文档去比不能被当成字段路径
#[tokio::test]
async fn a_dollar_string_in_the_original_is_compared_literally() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_literal").await;
  let stored = doc! { "_id": 1, "expr": "$price", "nested": { "op": "$sum" } };
  collection.insert_one(stored.clone()).await.expect("insert");
  let mut replacement = stored.clone();
  replacement.insert("expr", "$cost");
  mongo::replace_document(
    &client,
    DATABASE,
    "smoke_literal",
    stored,
    replacement.clone(),
    WRITE_TIMEOUT,
  )
  .await
  .expect("replace");
  let now = collection.find_one(doc! { "_id": 1 }).await.expect("read").expect("there");
  assert_eq!(now, replacement);
}

#[tokio::test]
async fn gone_documents_and_changed_ids_are_named_as_such() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_gone").await;
  let stored = doc! { "_id": 1, "x": 1 };
  collection.insert_one(stored.clone()).await.expect("insert");

  let error = mongo::replace_document(
    &client,
    DATABASE,
    "smoke_gone",
    stored.clone(),
    doc! { "_id": 2, "x": 1 },
    WRITE_TIMEOUT,
  )
  .await
  .err()
  .unwrap_or_default();
  assert!(error.starts_with(MONGO_ID_CHANGED), "{error}");

  // 编辑框里删掉 `_id` 那一行是可以的：替换保留原来的 _id
  mongo::replace_document(
    &client,
    DATABASE,
    "smoke_gone",
    stored.clone(),
    doc! { "x": 2 },
    WRITE_TIMEOUT,
  )
  .await
  .expect("replace without _id");
  assert_eq!(
    collection.find_one(doc! { "_id": 1 }).await.expect("read"),
    Some(doc! { "_id": 1, "x": 2 })
  );

  mongo::delete_document(
    &client,
    DATABASE,
    "smoke_gone",
    mongodb::bson::Bson::Int32(1),
    WRITE_TIMEOUT,
  )
  .await
  .expect("delete");
  let again = mongo::delete_document(
    &client,
    DATABASE,
    "smoke_gone",
    mongodb::bson::Bson::Int32(1),
    WRITE_TIMEOUT,
  )
  .await
  .err()
  .unwrap_or_default();
  assert!(again.starts_with(MONGO_DOCUMENT_GONE), "{again}");
  let replace_gone = mongo::replace_document(
    &client,
    DATABASE,
    "smoke_gone",
    doc! { "_id": 1, "x": 2 },
    doc! { "x": 3 },
    WRITE_TIMEOUT,
  )
  .await
  .err()
  .unwrap_or_default();
  assert!(replace_gone.starts_with(MONGO_DOCUMENT_GONE), "{replace_gone}");
}

#[tokio::test]
async fn an_inserted_document_reports_an_id_that_finds_it_again() {
  let Some(client) = client().await else { return };
  fresh_collection(&client, "smoke_insert").await;
  let id_text = mongo::insert_document(
    &client,
    DATABASE,
    "smoke_insert",
    mongo_shell::parse_document("{ name: 'new', n: Long('7') }").expect("literal"),
    WRITE_TIMEOUT,
  )
  .await
  .expect("insert");
  assert!(id_text.starts_with("ObjectId('"), "{id_text}");
  let id = mongo_shell::parse_value(&id_text).expect("id parses");
  let text = mongo::document_text(&client, DATABASE, "smoke_insert", id, WRITE_TIMEOUT)
    .await
    .expect("read")
    .expect("there");
  assert!(text.contains("n: Long('7')"), "{text}");

  // 重复的 _id：服务端的原话带着码名
  let duplicate =
    mongo::insert_document(&client, DATABASE, "smoke_insert", doc! { "_id": 5 }, WRITE_TIMEOUT)
      .await;
  assert!(duplicate.is_ok());
  let error =
    mongo::insert_document(&client, DATABASE, "smoke_insert", doc! { "_id": 5 }, WRITE_TIMEOUT)
      .await
      .err()
      .unwrap_or_default();
  assert!(error.starts_with(MONGO_SERVER_ERROR) || error.contains("E11000"), "{error}");
}

/// 结构页：索引的每一种选项原样出来，校验规则在集合选项里；视图没有索引，定义在选项里
#[tokio::test]
async fn the_structure_shows_indexes_validator_and_view_definition() {
  let Some(client) = client().await else { return };
  let database = client.database(DATABASE);
  let _ = database.collection::<Document>("smoke_structure_view").drop().await;
  let _ = database.collection::<Document>("smoke_structure").drop().await;
  database
    .run_command(doc! {
      "create": "smoke_structure",
      "validator": { "$jsonSchema": { "required": ["name"] } },
      "validationLevel": "moderate",
    })
    .await
    .expect("create with validator");
  database
    .run_command(doc! {
      "createIndexes": "smoke_structure",
      "indexes": [
        { "key": { "name": 1 }, "name": "name_unique", "unique": true },
        { "key": { "status": 1 }, "name": "open_only", "partialFilterExpression": { "status": "open" } },
        { "key": { "at": 1 }, "name": "ttl", "expireAfterSeconds": 3600 },
      ],
    })
    .await
    .expect("create indexes");
  database
    .run_command(doc! { "create": "smoke_structure_view", "viewOn": "smoke_structure", "pipeline": [{ "$match": { "status": "open" } }] })
    .await
    .expect("create view");

  let structure = mongo::collection_structure(&client, DATABASE, "smoke_structure", WRITE_TIMEOUT)
    .await
    .expect("structure");
  let names: Vec<&str> = structure.indexes.iter().map(|index| index.name.as_str()).collect();
  assert_eq!(names, ["_id_", "name_unique", "open_only", "ttl"]);
  let by_name = |name: &str| structure.indexes.iter().find(|index| index.name == name).expect(name);
  assert_eq!(by_name("name_unique").options, "{ unique: true }");
  assert_eq!(by_name("open_only").options, "{ partialFilterExpression: { status: 'open' } }");
  assert_eq!(by_name("ttl").options, "{ expireAfterSeconds: 3600 }");
  assert_eq!(by_name("_id_").keys, "{ _id: 1 }");
  assert!(structure.options.contains("$jsonSchema"), "{}", structure.options);
  assert!(structure.options.contains("validationLevel: 'moderate'"), "{}", structure.options);

  let view = mongo::collection_structure(&client, DATABASE, "smoke_structure_view", WRITE_TIMEOUT)
    .await
    .expect("view structure");
  assert!(view.indexes.is_empty());
  assert!(view.options.contains("viewOn: 'smoke_structure'"), "{}", view.options);
  assert!(view.options.contains("$match"), "{}", view.options);

  // 一个没有任何选项的集合：选项是空串
  fresh_collection(&client, "smoke_plain").await.insert_one(doc! { "x": 1 }).await.expect("insert");
  let plain = mongo::collection_structure(&client, DATABASE, "smoke_plain", WRITE_TIMEOUT)
    .await
    .expect("plain");
  assert_eq!(plain.options, "");
}

fn export_path(name: &str) -> std::path::PathBuf {
  let path = std::env::temp_dir().join(format!("dataomni-{name}-{}.json", std::process::id()));
  std::fs::remove_file(&path).ok();
  path
}

/// 导出要跨过好几批游标（默认一批 101 个），条件与排序照用；canonical 写法按
/// mongoimport 的读法读回来，每个文档都要与库里那份一模一样，类型也算
#[tokio::test]
async fn an_export_writes_every_matching_document_in_order_with_types_intact() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_export").await;
  let stored: Vec<Document> = (0..250)
    .map(|n| {
      mongo_shell::parse_document(&format!(
        "{{ n: {n}, long: Long('{n}'), double: 3.0, decimal: Decimal128('1.50'), \
         at: ISODate('2024-01-05T12:30:45.123Z'), tags: ['a', {{ deep: null }}] }}"
      ))
      .expect("document")
    })
    .collect();
  collection.insert_many(stored).await.expect("insert");
  let path = export_path("export-canonical");
  let filter = doc! { "n": { "$gte": 10 } };
  let sort = doc! { "n": -1 };

  let mut reports = 0;
  let summary = mongo::export_to_file(
    &client,
    DATABASE,
    "smoke_export",
    filter.clone(),
    sort.clone(),
    mongo::ExtendedJson::Canonical,
    &path,
    &mut |_| reports += 1,
    &mut || false,
  )
  .await
  .expect("export");
  assert_eq!(summary.rows_written, 240);
  assert!(reports >= 1, "the final count is always reported");

  let text = std::fs::read_to_string(&path).expect("exported file");
  assert_eq!(summary.bytes_written, text.len() as u64);
  let exported: Vec<Document> = text
    .lines()
    .map(|line| {
      let value: serde_json::Value = serde_json::from_str(line).expect("one JSON value per line");
      match mongodb::bson::Bson::try_from(value).expect("extended JSON") {
        mongodb::bson::Bson::Document(document) => document,
        other => panic!("not a document: {other:?}"),
      }
    })
    .collect();
  let expected: Vec<Document> = futures_util::TryStreamExt::try_collect(
    collection.find(filter).sort(sort).await.expect("find"),
  )
  .await
  .expect("collect");
  assert_eq!(exported, expected);
  assert!(!mongodb_part_path(&path).exists());

  // relaxed 是 mongoexport 的默认：好读，Long 写成普通数字
  let relaxed = export_path("export-relaxed");
  mongo::export_to_file(
    &client,
    DATABASE,
    "smoke_export",
    doc! { "n": 5 },
    Document::new(),
    mongo::ExtendedJson::Relaxed,
    &relaxed,
    &mut |_| {},
    &mut || false,
  )
  .await
  .expect("relaxed export");
  let line = std::fs::read_to_string(&relaxed).expect("relaxed file");
  assert!(line.contains("\"long\":5,"), "{line}");
  assert!(line.contains("\"double\":3.0,"), "{line}");
  std::fs::remove_file(&path).ok();
  std::fs::remove_file(&relaxed).ok();
}

fn mongodb_part_path(path: &std::path::Path) -> std::path::PathBuf {
  let mut name = path.file_name().expect("file name").to_os_string();
  name.push(".part");
  path.with_file_name(name)
}

/// 取消之后既没有目标文件，也没有半份的 `.part`
#[tokio::test]
async fn a_cancelled_export_leaves_no_file_behind() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_export_cancel").await;
  collection.insert_many((0..10).map(|n| doc! { "n": n })).await.expect("insert");
  let path = export_path("export-cancelled");

  let mut asked = 0;
  let error = mongo::export_to_file(
    &client,
    DATABASE,
    "smoke_export_cancel",
    Document::new(),
    Document::new(),
    mongo::ExtendedJson::Relaxed,
    &path,
    &mut |_| {},
    // 写了三个之后按取消
    &mut || {
      asked += 1;
      asked > 3
    },
  )
  .await
  .expect_err("cancelled");
  assert_eq!(error.code.as_deref(), Some("EXPORT_CANCELLED"));
  assert!(!path.exists());
  assert!(!mongodb_part_path(&path).exists());
}

fn import_file(name: &str, text: &str) -> std::path::PathBuf {
  let path = export_path(name);
  std::fs::write(&path, text).expect("write import file");
  path
}

async fn import(
  client: &Client,
  collection: &str,
  mode: mongo::ImportMode,
  path: &std::path::Path,
) -> Result<dataomni_lib::services::csv_import::ImportSummary, String> {
  mongo::import_from_file(
    client,
    DATABASE,
    collection,
    mode,
    path,
    &mut |_| {},
    &mut || false,
    &mut || false,
  )
  .await
  .map_err(|error| error.message)
}

/// 导出的文件原样导回另一个集合，一模一样，类型也算；坏行和重复的 `_id` 按文件里的
/// 行号记下，同一批的其余照常进去
#[tokio::test]
async fn an_exported_file_imports_back_and_bad_lines_are_named_by_line() {
  let Some(client) = client().await else { return };
  let source = fresh_collection(&client, "smoke_import_source").await;
  let stored: Vec<Document> = (0..30)
    .map(|n| {
      mongo_shell::parse_document(&format!(
        "{{ n: {n}, long: Long('{n}'), decimal: Decimal128('1.50'), \
         at: ISODate('2024-01-05T12:30:45.123Z'), tags: ['a', {{ deep: null }}] }}"
      ))
      .expect("document")
    })
    .collect();
  source.insert_many(stored).await.expect("insert");
  let exported = export_path("import-roundtrip");
  mongo::export_to_file(
    &client,
    DATABASE,
    "smoke_import_source",
    Document::new(),
    doc! { "n": 1 },
    mongo::ExtendedJson::Canonical,
    &exported,
    &mut |_| {},
    &mut || false,
  )
  .await
  .expect("export");

  let target = fresh_collection(&client, "smoke_import_target").await;
  let summary = import(&client, "smoke_import_target", mongo::ImportMode::Insert, &exported)
    .await
    .expect("import");
  assert_eq!((summary.rows_read, summary.rows_inserted, summary.rows_failed), (30, 30, 0));
  let expected: Vec<Document> = futures_util::TryStreamExt::try_collect(
    source.find(doc! {}).sort(doc! { "n": 1 }).await.expect("find"),
  )
  .await
  .expect("collect");
  let imported: Vec<Document> = futures_util::TryStreamExt::try_collect(
    target.find(doc! {}).sort(doc! { "n": 1 }).await.expect("find"),
  )
  .await
  .expect("collect");
  assert_eq!(imported, expected);

  // 第 2 行重复了已有的 `_id`，第 3 行是空行，第 4 行不是 JSON，第 5 行是个数组
  let first_line = std::fs::read_to_string(&exported).expect("file");
  let first_line = first_line.lines().next().expect("a line");
  let messy = import_file(
    "import-messy",
    &format!("{{\"n\": 100}}\n{first_line}\n\n{{n: 1}}\n[1, 2]\n{{\"n\": 101}}\n"),
  );
  let summary = import(&client, "smoke_import_target", mongo::ImportMode::Insert, &messy)
    .await
    .expect("import");
  assert_eq!((summary.rows_read, summary.rows_inserted, summary.rows_failed), (5, 2, 3));
  let lines: Vec<u64> = summary.errors.iter().map(|error| error.line).collect();
  assert_eq!(lines, [4, 5, 2], "parse errors are found while reading, the duplicate on write");
  assert!(summary.errors[2].message.contains("E11000"), "{}", summary.errors[2].message);
  assert!(summary.errors[0].message.starts_with(mongo::MONGO_IMPORT_LINE_INVALID));
  assert_eq!(summary.errors[1].values, ["[1, 2]"]);
  assert_eq!(target.count_documents(doc! {}).await.expect("count"), 32);
  for path in [&exported, &messy] {
    std::fs::remove_file(path).ok();
  }
}

/// upsert 按 `_id` 整份替换，没有的新增；没带 `_id` 的照样新增
#[tokio::test]
async fn upsert_replaces_by_id_and_inserts_the_rest() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_import_upsert").await;
  collection
    .insert_many([
      doc! { "_id": 1, "name": "old", "extra": true },
      doc! { "_id": 2, "name": "kept" },
    ])
    .await
    .expect("insert");
  let path = import_file(
    "import-upsert",
    "{\"_id\": 1, \"name\": \"new\"}\n{\"_id\": 3, \"name\": \"added\"}\n{\"name\": \"no id\"}\n",
  );
  let summary =
    import(&client, "smoke_import_upsert", mongo::ImportMode::Upsert, &path).await.expect("import");
  assert_eq!((summary.rows_read, summary.rows_inserted, summary.rows_failed), (3, 3, 0));
  let one = collection.find_one(doc! { "_id": 1 }).await.expect("find").expect("exists");
  assert_eq!(one, doc! { "_id": 1, "name": "new" }, "replaced whole, not merged");
  assert_eq!(collection.count_documents(doc! {}).await.expect("count"), 4);
  let no_id = collection.find_one(doc! { "name": "no id" }).await.expect("find").expect("exists");
  assert!(
    matches!(no_id.get("_id"), Some(mongodb::bson::Bson::ObjectId(_))),
    "a document without _id gets a fresh ObjectId, not null: {no_id:?}"
  );

  // 同一个文件用 insert 再来一遍：带 `_id` 的两行都撞上
  let summary =
    import(&client, "smoke_import_upsert", mongo::ImportMode::Insert, &path).await.expect("import");
  assert_eq!((summary.rows_inserted, summary.rows_failed), (1, 2));
  std::fs::remove_file(&path).ok();
}

/// `--jsonArray` 的文件明确拒绝，而不是把整个数组当成一行坏数据
#[tokio::test]
async fn a_json_array_file_is_refused_up_front() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_import_array").await;
  let path = import_file("import-array", "[\n{\"n\": 1},\n{\"n\": 2}\n]\n");
  let error = import(&client, "smoke_import_array", mongo::ImportMode::Insert, &path)
    .await
    .expect_err("refused");
  assert_eq!(error, mongo::MONGO_IMPORT_JSON_ARRAY);
  assert_eq!(collection.count_documents(doc! {}).await.expect("count"), 0);
  std::fs::remove_file(&path).ok();
}

/// 取消在批与批之间生效：已经写进去的那一批留着，后面的不再写
#[tokio::test]
async fn a_cancelled_import_stops_after_the_batch_in_flight() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_import_cancel").await;
  let text: String = (0..2500).map(|n| format!("{{\"n\": {n}}}\n")).collect();
  let path = import_file("import-cancel", &text);
  let summary = mongo::import_from_file(
    &client,
    DATABASE,
    "smoke_import_cancel",
    mongo::ImportMode::Insert,
    &path,
    &mut |_| {},
    &mut || true,
    &mut || false,
  )
  .await
  .expect("import");
  assert!(summary.cancelled);
  assert_eq!(summary.rows_inserted, 1000);
  assert_eq!(collection.count_documents(doc! {}).await.expect("count"), 1000);
  std::fs::remove_file(&path).ok();
}
