//! MongoDB 的真库用例。
//!
//! 默认静默跳过；要跑就在 shell 里设
//! `DATAOMNI_MONGODB_TEST_URL=mongodb://user:password@host:port/authSource`
//! （**不要写进任何文件**），并设 `DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS=1`
//! 让缺了连接串的时候报错而不是跳过。
//!
//! 用例在 `dataomni_test` 库里建自己的集合，开头先删同名的残留。
//!
//! SRV 的几条另设 `DATAOMNI_MONGODB_SRV_TEST_URL`（同样的写法），指向一个**副本集**
//! `repl0`，唯一成员名为 `localhost.test.build.10gen.cc:27017`，并把它转发到本机 27017。
//! 借的是 MongoDB 驱动规范测试用的公网记录：`test1`/`test3`/`test5.test.build.10gen.cc`
//! 的 SRV 都指向 `localhost.test.build.10gen.cc`（即 127.0.0.1）的 27017，`test1` 另有
//! 一个没人听的 27018，`test5` 的 TXT 写着 `replicaSet=repl0&authSource=thisDB`。
//! 地址里的主机与端口不用，只取账号与认证库。
//!
//! 客户端证书的几条另设 `DATAOMNI_MONGODB_TLS_TEST_URL`（一台 `requireTLS` 且设了
//! `tlsCAFile`、因而要求客户端证书的服务端）与 `DATAOMNI_MONGODB_TLS_TEST_DIR`：里面有
//! `ca.pem`、`client.pem`（该 CA 签的证书加私钥）、`rogue.pem`（自签的，服务端不认）、
//! `stranger.pem`（同一个 CA 签的，但 `$external` 里没有它的用户）。`client.pem` 的主题
//! `O=DataOmni,OU=test,CN=dataomni-client` 要在 `$external` 里建好用户（X.509 那一条用）。

use dataomni_lib::models::ConnectionProfile;
use dataomni_lib::services::mongo_shell::{self, Layout};
use dataomni_lib::services::mongodb::{
  self as mongo, FindRequest, MongoTarget, MONGO_AUTH_FAILED, MONGO_AUTH_REQUIRED,
  MONGO_DOCUMENT_CHANGED, MONGO_DOCUMENT_GONE, MONGO_ID_CHANGED, MONGO_SERVER_ERROR,
  MONGO_SRV_LOOKUP_FAILED, MONGO_TIMEOUT, MONGO_TLS_FILE_INVALID, MONGO_UNREACHABLE,
  MONGO_X509_REJECTED,
};
use mongodb::bson::{doc, Bson, Document};
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
  Some(profile_from_url(&url))
}

fn profile_from_url(url: &str) -> ConnectionProfile {
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
  serde_json::from_value(profile).expect("profile")
}

/// SRV 那几条：没设就跳过（要本机 27017 上正好是那个副本集）
fn srv_profile(host: &str) -> Option<ConnectionProfile> {
  let url = std::env::var("DATAOMNI_MONGODB_SRV_TEST_URL").ok().filter(|url| !url.is_empty())?;
  let mut profile = profile_from_url(&url);
  profile.host = host.to_string();
  profile.options.insert(dataomni_lib::models::MONGO_SRV_OPTION.to_string(), "true".to_string());
  Some(profile)
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

/// 按 SRV 记录找到副本集并登录。`test1` 有两条记录、其中一台没人听：这正是
/// Atlas 的形状（一组成员），直连只许一台，驱动会拒——所以 SRV 不能照搬直连那套
#[tokio::test]
async fn an_srv_name_is_resolved_to_the_replica_set_behind_it() {
  for host in ["test1.test.build.10gen.cc", "test3.test.build.10gen.cc"] {
    let Some(profile) = srv_profile(host) else { return };
    let client = mongo::connect(&MongoTarget::from_profile(&profile))
      .await
      .unwrap_or_else(|error| panic!("{host}: {error}"));
    let entries = mongo::list_collections(&client).await.expect("list collections");
    assert!(entries.iter().any(|entry| entry.object_schema == DATABASE), "{host}: {entries:?}");
  }
}

/// TXT 记录里的 `authSource` 在认证库那一格空着时生效，填了就以填的为准。
/// `test5` 的 TXT 写的是 `thisDB`，账号却在 `admin`：空着 → 登录被拒，填 `admin` → 连上
#[tokio::test]
async fn the_txt_record_supplies_the_auth_database_unless_one_is_given() {
  let Some(mut profile) = srv_profile("test5.test.build.10gen.cc") else { return };
  let given = mongo::connect(&MongoTarget::from_profile(&profile)).await;
  assert!(given.is_ok(), "{:?}", given.err());
  profile.database = None;
  let error = mongo::connect(&MongoTarget::from_profile(&profile)).await.err().unwrap_or_default();
  assert!(error.starts_with(MONGO_AUTH_FAILED), "{error}");
}

/// 查不到记录，和记录指向别的域（规范要求拒绝：否则谁控制了这条 DNS 记录，
/// 就能把口令引到任意一台机器上）都报成 SRV 的问题，不报成「连不上」
#[tokio::test]
async fn an_srv_name_without_records_or_pointing_elsewhere_is_refused() {
  for host in ["test4.test.build.10gen.cc", "test14.test.build.10gen.cc"] {
    let Some(profile) = srv_profile(host) else { return };
    let error =
      mongo::connect(&MongoTarget::from_profile(&profile)).await.err().unwrap_or_default();
    assert!(error.starts_with(MONGO_SRV_LOOKUP_FAILED), "{host}: {error}");
  }
}

/// 客户端证书那几条：没设就跳过。TLS 按完整校验，CA 用测试目录里那一份
fn tls_profile(client_certificate: Option<&str>) -> Option<ConnectionProfile> {
  let url = std::env::var("DATAOMNI_MONGODB_TLS_TEST_URL").ok().filter(|url| !url.is_empty())?;
  let directory = std::env::var("DATAOMNI_MONGODB_TLS_TEST_DIR").ok()?;
  let mut profile = profile_from_url(&url);
  profile.ssl = true;
  profile.tls_mode = Some(dataomni_lib::models::TlsMode::VerifyFull);
  profile.ca_certificate_path = Some(format!("{directory}/ca.pem"));
  profile.client_certificate_path = client_certificate.map(|name| format!("{directory}/{name}"));
  Some(profile)
}

/// 服务端要求客户端证书：带着 CA 签的那份连得上，不带、或带一份自签的都连不上。
/// 只验前一半的话，一个根本不发证书、而服务端恰好不要求的实现也是绿的
#[tokio::test]
async fn a_client_certificate_is_presented_and_only_the_right_one_gets_in() {
  let Some(profile) = tls_profile(Some("client.pem")) else { return };
  let client = mongo::connect(&MongoTarget::from_profile(&profile)).await;
  assert!(client.is_ok(), "{:?}", client.err());
  for name in [None, Some("rogue.pem")] {
    let Some(profile) = tls_profile(name) else { return };
    let error =
      mongo::connect(&MongoTarget::from_profile(&profile)).await.err().unwrap_or_default();
    assert!(error.starts_with(MONGO_UNREACHABLE), "{name:?}: {error}");
  }
}

/// 拿证书登录（X.509）：身份是证书的主题。表单上残留的用户名、口令不发出去；
/// 同一个 CA 签的另一张证书，`$external` 里没有它的用户，登录被拒
#[tokio::test]
async fn an_x509_login_is_the_certificate_subject() {
  let x509 = |name: &str| {
    tls_profile(Some(name)).map(|mut profile| {
      profile.options.insert(
        dataomni_lib::models::MONGO_AUTH_MECHANISM_OPTION.to_string(),
        dataomni_lib::models::MONGO_X509.to_string(),
      );
      profile.password.push_str("-ignored");
      profile
    })
  };
  let Some(profile) = x509("client.pem") else { return };
  let client = mongo::connect(&MongoTarget::from_profile(&profile))
    .await
    .unwrap_or_else(|error| panic!("x509 login: {error}"));
  let status = client
    .database("admin")
    .run_command(doc! { "connectionStatus": 1 })
    .await
    .expect("connectionStatus");
  let user = status
    .get_document("authInfo")
    .and_then(|info| info.get_array("authenticatedUsers"))
    .ok()
    .and_then(|users| users.first())
    .and_then(Bson::as_document)
    .and_then(|user| user.get_str("user").ok())
    .map(str::to_string);
  assert_eq!(user.as_deref(), Some("O=DataOmni,OU=test,CN=dataomni-client"));

  let Some(profile) = x509("stranger.pem") else { return };
  let error = mongo::connect(&MongoTarget::from_profile(&profile)).await.err().unwrap_or_default();
  assert!(error.starts_with(MONGO_X509_REJECTED), "{error}");
}

/// 证书文件读不了、或读出来不是证书加私钥：说是哪个文件，不等十秒超时
#[tokio::test]
async fn an_unreadable_client_certificate_names_the_file() {
  for name in ["missing.pem", "ca.pem"] {
    let Some(profile) = tls_profile(Some(name)) else { return };
    let started = Instant::now();
    let error =
      mongo::connect(&MongoTarget::from_profile(&profile)).await.err().unwrap_or_default();
    assert!(error.starts_with(MONGO_TLS_FILE_INVALID), "{name}: {error}");
    assert!(error.contains(name), "{name}: {error}");
    assert!(started.elapsed() < Duration::from_secs(3), "{name}: {:?}", started.elapsed());
  }
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

/// 建索引：没给名字就按 mongosh 的规矩起名，选项原样生效（唯一、部分索引），结构页上看得见；
/// 一模一样的再建一次明确说「已经有了」；删掉之后就没了
/// 执行计划：按索引字段查是 IXSCAN 且只看一个键、一个文档；按没索引的字段查是
/// COLLSCAN、看遍整个集合。聚合同样有计划，而且只是看、不写
#[tokio::test]
async fn an_explain_says_whether_an_index_was_used_and_how_much_was_read() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_explain").await;
  let documents: Vec<Document> =
    (0..50).map(|n| doc! { "email": format!("u{n}@x"), "age": n }).collect();
  collection.insert_many(documents).await.expect("seed");
  collection
    .create_index(mongodb::IndexModel::builder().keys(doc! { "email": 1 }).build())
    .await
    .expect("index");
  let timeout = Duration::from_secs(10);
  let explain = |target| mongo::explain(&client, DATABASE, "smoke_explain", target, timeout);

  let indexed =
    explain(mongo::ExplainTarget::Find { filter: doc! { "email": "u7@x" }, sort: doc! {} })
      .await
      .expect("explain indexed");
  assert!(
    indexed
      .stages
      .iter()
      .any(|stage| stage.stage == "IXSCAN" && stage.index.as_deref() == Some("email_1")),
    "{:?}",
    indexed.stages
  );
  assert_eq!(
    (indexed.returned, indexed.keys_examined, indexed.docs_examined),
    (Some(1), Some(1), Some(1))
  );

  let scanned =
    explain(mongo::ExplainTarget::Find { filter: doc! { "age": { "$gte": 40 } }, sort: doc! {} })
      .await
      .expect("explain scan");
  assert!(scanned.stages.iter().any(|stage| stage.stage == "COLLSCAN"), "{:?}", scanned.stages);
  assert_eq!((scanned.returned, scanned.docs_examined), (Some(10), Some(50)));

  let pipeline = vec![
    doc! { "$match": { "age": { "$lt": 5 } } },
    doc! { "$group": { "_id": null, "n": { "$sum": 1 } } },
  ];
  let aggregated =
    explain(mongo::ExplainTarget::Aggregate { pipeline }).await.expect("explain aggregate");
  assert!(!aggregated.stages.is_empty(), "{}", aggregated.text);
  assert_eq!(collection.count_documents(doc! {}).await.expect("count"), 50);
}

/// 建集合时选项原样生效（上限、校验规则），同名再建被拒；在一个还没有的库里建集合，
/// 库就有了——MongoDB 建库就是这样。删掉之后对象树里不再有它
#[tokio::test]
async fn a_collection_is_created_with_its_options_and_dropped() {
  let Some(client) = client().await else { return };
  let scratch = "dataomni_test_created_db";
  client.database(scratch).drop().await.expect("drop leftover database");
  fresh_collection(&client, "smoke_created").await;
  let options = mongo_shell::parse_document(
    "{ capped: true, size: 65536, validator: { $jsonSchema: { required: ['name'] } } }",
  )
  .expect("options");
  let timeout = Duration::from_secs(10);
  mongo::create_collection(&client, DATABASE, "smoke_created", options, timeout)
    .await
    .expect("create");
  let spec = client
    .database(DATABASE)
    .run_command(doc! { "listCollections": 1, "filter": { "name": "smoke_created" } })
    .await
    .expect("listCollections");
  let created = spec
    .get_document("cursor")
    .and_then(|cursor| cursor.get_array("firstBatch"))
    .ok()
    .and_then(|batch| batch.first())
    .and_then(Bson::as_document)
    .and_then(|collection| collection.get_document("options").ok())
    .cloned()
    .unwrap_or_default();
  assert_eq!(created.get_bool("capped"), Ok(true), "{created:?}");
  assert!(created.contains_key("validator"), "{created:?}");

  let again = mongo::create_collection(&client, DATABASE, "smoke_created", doc! {}, timeout).await;
  assert!(again.as_ref().err().is_some_and(|error| error.contains("NamespaceExists")), "{again:?}");

  mongo::create_collection(&client, scratch, "first", doc! {}, timeout).await.expect("new db");
  let names = client.list_database_names().await.expect("list databases");
  assert!(names.iter().any(|name| name == scratch), "{names:?}");

  mongo::drop_collection(&client, DATABASE, "smoke_created", timeout).await.expect("drop");
  let entries = mongo::list_collections(&client).await.expect("list collections");
  assert!(!entries.iter().any(|entry| entry.object_name == "smoke_created"), "{entries:?}");
  client.database(scratch).drop().await.expect("drop scratch database");
}

#[tokio::test]
async fn an_index_is_created_with_its_options_and_dropped_by_name() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_index").await;
  collection.insert_one(doc! { "email": "a@x", "active": true }).await.expect("insert");
  let timeout = Duration::from_secs(10);
  let keys = || mongo_shell::parse_document("{ email: 1, active: -1 }").expect("keys");
  let options = || {
    mongo_shell::parse_document("{ unique: true, partialFilterExpression: { active: true } }")
      .expect("options")
  };

  let name = mongo::create_index(&client, DATABASE, "smoke_index", keys(), options(), timeout)
    .await
    .expect("create");
  assert_eq!(name, "email_1_active_-1");
  let structure = mongo::collection_structure(&client, DATABASE, "smoke_index", timeout)
    .await
    .expect("structure");
  let index = structure.indexes.iter().find(|index| index.name == name).expect("listed");
  assert_eq!(index.keys, "{ email: 1, active: -1 }");
  assert_eq!(index.options, "{ unique: true, partialFilterExpression: { active: true } }");

  // 选项真的生效：active 的两个同 email 撞上，不 active 的不在部分索引里
  let duplicate = collection.insert_one(doc! { "email": "a@x", "active": true }).await;
  assert!(duplicate.is_err(), "unique index is enforced");
  collection.insert_one(doc! { "email": "a@x", "active": false }).await.expect("outside filter");

  let again = mongo::create_index(&client, DATABASE, "smoke_index", keys(), options(), timeout)
    .await
    .expect_err("already there");
  assert_eq!(again, format!("{}: {name}", mongo::MONGO_INDEX_EXISTS));
  let empty = mongo::create_index(
    &client,
    DATABASE,
    "smoke_index",
    Document::new(),
    Document::new(),
    timeout,
  )
  .await
  .expect_err("no keys");
  assert_eq!(empty, mongo::MONGO_INDEX_KEYS_EMPTY);

  // 名字给了就用给的
  let named = mongo::create_index(
    &client,
    DATABASE,
    "smoke_index",
    mongo_shell::parse_document("{ active: 1 }").expect("keys"),
    mongo_shell::parse_document("{ name: 'by_active' }").expect("options"),
    timeout,
  )
  .await
  .expect("create named");
  assert_eq!(named, "by_active");

  mongo::drop_index(&client, DATABASE, "smoke_index", &name, timeout).await.expect("drop");
  let structure = mongo::collection_structure(&client, DATABASE, "smoke_index", timeout)
    .await
    .expect("structure");
  let names: Vec<&str> = structure.indexes.iter().map(|index| index.name.as_str()).collect();
  assert_eq!(names, ["_id_", "by_active"]);
  let missing = mongo::drop_index(&client, DATABASE, "smoke_index", &name, timeout)
    .await
    .expect_err("already dropped");
  assert!(missing.starts_with(MONGO_SERVER_ERROR), "{missing}");
}

/// 按条件改：操作符与管道两种写法；匹配到但没变的不算「改了」；整篇替换的写法发出去之前
/// 就拦下；校验规则挡住其中一个时说清楚停在哪、前面的可能已经改了——服务端这时报的个数是 0，
/// 而库里确实有改掉的，这条用例把这件事钉住
#[tokio::test]
async fn update_many_counts_what_it_changed_and_says_where_it_stopped() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_update_many").await;
  collection.insert_many((0..10).map(|n| doc! { "_id": n, "n": n })).await.expect("insert");
  let timeout = Duration::from_secs(10);
  let parse = |text: &str| mongo_shell::parse_value(text).expect("update");

  let changed = mongo::update_many(
    &client,
    DATABASE,
    "smoke_update_many",
    doc! { "n": { "$gte": 5 } },
    parse("{ $set: { big: true } }"),
    timeout,
  )
  .await
  .expect("update");
  assert_eq!(changed, mongo::UpdateManyResult { matched: 5, modified: 5 });
  let again = mongo::update_many(
    &client,
    DATABASE,
    "smoke_update_many",
    doc! { "n": { "$gte": 5 } },
    parse("{ $set: { big: true } }"),
    timeout,
  )
  .await
  .expect("update");
  assert_eq!(again, mongo::UpdateManyResult { matched: 5, modified: 0 }, "already true");

  let piped = mongo::update_many(
    &client,
    DATABASE,
    "smoke_update_many",
    doc! { "_id": 3 },
    parse("[{ $set: { twice: { $multiply: ['$n', 2] } } }]"),
    timeout,
  )
  .await
  .expect("pipeline");
  assert_eq!(piped.modified, 1);
  let three = collection.find_one(doc! { "_id": 3 }).await.expect("find").expect("exists");
  assert_eq!(three.get_i32("twice").expect("twice"), 6);

  let replacement =
    mongo::update_many(&client, DATABASE, "smoke_update_many", doc! {}, parse("{ n: 0 }"), timeout)
      .await
      .expect_err("replacement is refused");
  assert_eq!(replacement, mongo::MONGO_UPDATE_NOT_OPERATORS);
  let empty =
    mongo::update_many(&client, DATABASE, "smoke_update_many", doc! {}, parse("{}"), timeout)
      .await
      .expect_err("empty update is refused");
  assert_eq!(empty, mongo::MONGO_UPDATE_NOT_OPERATORS);

  // n 不许到 50：加 45 之后 n >= 5 的那几个过不了
  client
    .database(DATABASE)
    .run_command(doc! { "collMod": "smoke_update_many", "validator": { "n": { "$lt": 50 } } })
    .await
    .expect("validator");
  let stopped = mongo::update_many(
    &client,
    DATABASE,
    "smoke_update_many",
    doc! {},
    parse("{ $inc: { n: 45 } }"),
    timeout,
  )
  .await
  .expect_err("stopped by the validator");
  assert!(
    stopped.starts_with(&format!("{}: Document failed validation", mongo::MONGO_BULK_STOPPED)),
    "{stopped}"
  );
  assert!(stopped.contains(" · _id: "), "names the document that stopped it: {stopped}");
  // 服务端回答 nModified: 0，但前面的确实改了：这正是界面上要说「可能已经改了一部分」的原因
  let changed = collection.count_documents(doc! { "n": { "$gte": 45 } }).await.expect("count");
  assert!(changed > 0 && changed < 10, "partially applied: {changed}");
}

/// 按条件删：删了几个就报几个，空条件是整个集合
#[tokio::test]
async fn delete_many_reports_how_many_it_removed() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_delete_many").await;
  collection.insert_many((0..10).map(|n| doc! { "n": n })).await.expect("insert");
  let timeout = Duration::from_secs(10);
  let deleted =
    mongo::delete_many(&client, DATABASE, "smoke_delete_many", doc! { "n": { "$lt": 3 } }, timeout)
      .await
      .expect("delete");
  assert_eq!(deleted, 3);
  assert_eq!(collection.count_documents(doc! {}).await.expect("count"), 7);
  let rest = mongo::delete_many(&client, DATABASE, "smoke_delete_many", doc! {}, timeout)
    .await
    .expect("delete all");
  assert_eq!(rest, 7);
  assert_eq!(collection.count_documents(doc! {}).await.expect("count"), 0);
}

/// 聚合：分组结果按管道自己的排序分页，全文随页带回；写库的阶段在发出去之前就拒绝
#[tokio::test]
async fn an_aggregation_pages_through_its_own_results_and_never_writes() {
  let Some(client) = client().await else { return };
  let collection = fresh_collection(&client, "smoke_aggregate").await;
  collection
    .insert_many((0..30).map(
      |n| doc! { "n": n, "group": i32::try_from(n % 7).expect("small"), "long": Bson::Int64(n) },
    ))
    .await
    .expect("insert");
  let timeout = Duration::from_secs(10);
  let pipeline = |text: &str| {
    mongo::parse_pipeline(mongo_shell::parse_value(text).expect("pipeline")).expect("stages")
  };
  let grouped = "[{ $group: { _id: '$group', total: { $sum: '$long' } } }, { $sort: { _id: 1 } }]";

  let first =
    mongo::aggregate(&client, DATABASE, "smoke_aggregate", pipeline(grouped), 0, 5, timeout)
      .await
      .expect("first page");
  assert!(first.has_more);
  assert_eq!(first.documents.len(), 5);
  assert_eq!(first.texts.len(), 5);
  let second =
    mongo::aggregate(&client, DATABASE, "smoke_aggregate", pipeline(grouped), 5, 5, timeout)
      .await
      .expect("second page");
  assert!(!second.has_more);
  let ids: Vec<String> = first
    .documents
    .iter()
    .chain(&second.documents)
    .map(|row| row.id.clone().expect("group key"))
    .collect();
  assert_eq!(ids, ["0", "1", "2", "3", "4", "5", "6"]);
  // 组 0 是 0、7、14、21、28：Long 求和还是 Long，全文里写得出来
  assert_eq!(first.texts[0], "{\n  _id: 0,\n  total: Long('70')\n}");

  let refused = mongo_shell::parse_value("[{ $match: {} }, { $out: 'smoke_aggregate_copy' }]")
    .map_err(|error| error.to_string())
    .and_then(mongo::parse_pipeline)
    .expect_err("refused");
  assert_eq!(refused, format!("{}: $out", mongo::MONGO_PIPELINE_WRITES));

  let broken = mongo::aggregate(
    &client,
    DATABASE,
    "smoke_aggregate",
    pipeline("[{ $nosuchstage: {} }]"),
    0,
    5,
    timeout,
  )
  .await
  .expect_err("unknown stage");
  assert!(broken.starts_with(MONGO_SERVER_ERROR), "{broken}");
}
