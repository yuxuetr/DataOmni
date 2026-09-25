//! Elasticsearch 的真库用例。
//!
//! 默认静默跳过；要跑就在 shell 里设
//! `DATAOMNI_ELASTICSEARCH_TEST_URL=https://user:password@host:port`（`http://` 就是不加密；
//! **不要写进任何文件**），并设 `DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS=1` 让缺了连接串的时候
//! 报错而不是跳过。用户要能建索引、建角色与用户（`elastic` 就行）。
//!
//! 可选：`DATAOMNI_ELASTICSEARCH_TEST_CA` 是服务端 CA 的 PEM（ES 8 起自动生成的 `http_ca.crt`），
//! 设了才跑「按 CA 完整校验」那一条。
//!
//! 每条用例用自己的索引名（`smoke_<名字>`），开头先删掉同名的残留。

use dataomni_lib::models::ConnectionProfile;
use dataomni_lib::services::elasticsearch::{
  self as es, EsPool, EsRequest, EsResponse, EsTarget, ES_AUTH_FAILED, ES_NO_PERMISSION,
  ES_REQUEST_INVALID, ES_TIMEOUT, ES_UNREACHABLE,
};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

const URL_ENV: &str = "DATAOMNI_ELASTICSEARCH_TEST_URL";
const CA_ENV: &str = "DATAOMNI_ELASTICSEARCH_TEST_CA";
const REQUIRE_ENV: &str = "DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS";
const TIMEOUT: Duration = Duration::from_secs(30);

fn profile() -> Option<ConnectionProfile> {
  let url = match std::env::var(URL_ENV) {
    Ok(url) if !url.is_empty() => url,
    _ if std::env::var(REQUIRE_ENV).as_deref() == Ok("1") => {
      panic!("{URL_ENV} must be set when {REQUIRE_ENV}=1")
    }
    _ => return None,
  };
  let (tls, rest) = match url.split_once("://").expect("scheme://") {
    ("https", rest) => ("required", rest),
    ("http", rest) => ("disabled", rest),
    (scheme, _) => panic!("unsupported scheme {scheme}"),
  };
  let (credentials, address) = rest.rsplit_once('@').expect("user:password@host");
  let (username, password) = credentials.split_once(':').expect("user:password");
  let (host, port) = address.trim_end_matches('/').rsplit_once(':').expect("host:port");
  Some(
    serde_json::from_value(json!({
      "name": "elasticsearch-smoke",
      "db_type": "elasticsearch",
      "host": host,
      "port": port.parse::<u16>().expect("port"),
      "username": username,
      "password": password,
      "ssl": tls != "disabled",
      "tls_mode": tls,
      "options": {},
      "tags": []
    }))
    .expect("profile"),
  )
}

async fn pool(profile: &ConnectionProfile) -> Arc<EsPool> {
  Arc::new(es::connect(EsTarget::from_profile(profile, None)).await.expect("connect"))
}

async fn send(
  pool: &Arc<EsPool>,
  method: &str,
  path: &str,
  body: Option<&str>,
  timeout: Duration,
) -> Result<EsResponse, String> {
  es::run(
    Arc::clone(pool),
    EsRequest {
      method: method.to_string(),
      path: path.to_string(),
      ndjson: path.contains("_bulk"),
      body: body.map(str::to_string),
      timeout,
    },
  )
  .await
}

/// 期望成功（2xx）的请求，回答解析成 JSON
async fn ok(pool: &Arc<EsPool>, method: &str, path: &str, body: Option<&str>) -> Value {
  let response =
    send(pool, method, path, body, TIMEOUT).await.unwrap_or_else(|error| panic!("{path}: {error}"));
  assert!(
    (200..300).contains(&response.status),
    "{method} {path}: {} {}",
    response.status,
    response.body
  );
  serde_json::from_str(&response.body).unwrap_or(Value::Null)
}

/// `GET /` 的 `version.distribution`：OpenSearch 写着 `opensearch`，ES 没有这一项
async fn is_opensearch(pool: &Arc<EsPool>) -> bool {
  ok(pool, "GET", "/", None).await["version"]["distribution"] == json!("opensearch")
}

/// 删掉上次留下的同名索引（不存在时是 404，不算错）
async fn fresh_index(pool: &Arc<EsPool>, index: &str) {
  send(pool, "DELETE", &format!("/{index}"), None, TIMEOUT).await.expect("delete leftover");
}

#[tokio::test]
async fn a_wrong_password_a_closed_port_and_a_wrong_scheme_are_named() {
  let Some(profile) = profile() else { return };

  let mut wrong = profile.clone();
  wrong.password.push_str("-wrong");
  let error = es::connect(EsTarget::from_profile(&wrong, None)).await.err().unwrap_or_default();
  assert!(error.starts_with(ES_AUTH_FAILED), "{error}");

  let mut closed = profile.clone();
  closed.host = "127.0.0.1".to_string();
  closed.port = 1;
  let started = Instant::now();
  let error = es::connect(EsTarget::from_profile(&closed, None)).await.err().unwrap_or_default();
  assert!(error.starts_with(ES_UNREACHABLE), "{error}");
  assert!(started.elapsed() < Duration::from_secs(12), "{:?}", started.elapsed());

  // 加不加密填反了：说连不上，并带着底层的原因
  let mut flipped = profile.clone();
  let https = profile.effective_tls_mode() != dataomni_lib::models::TlsMode::Disabled;
  flipped.tls_mode = Some(if https {
    dataomni_lib::models::TlsMode::Disabled
  } else {
    dataomni_lib::models::TlsMode::Required
  });
  let error = es::connect(EsTarget::from_profile(&flipped, None)).await.err().unwrap_or_default();
  assert!(
    error.starts_with(ES_UNREACHABLE) || error.contains("DATAOMNI_ES_NOT_ELASTICSEARCH"),
    "{error}"
  );

  // 自签证书按系统 CA 完整校验：连不上；给了 CA 就能连
  if https {
    let mut strict = profile.clone();
    strict.tls_mode = Some(dataomni_lib::models::TlsMode::VerifyFull);
    let error = es::connect(EsTarget::from_profile(&strict, None)).await.err().unwrap_or_default();
    assert!(error.starts_with(ES_UNREACHABLE), "{error}");
    if let Ok(ca) = std::env::var(CA_ENV) {
      strict.ca_certificate_path = Some(ca);
      for mode in
        [dataomni_lib::models::TlsMode::VerifyCa, dataomni_lib::models::TlsMode::VerifyFull]
      {
        strict.tls_mode = Some(mode);
        es::connect(EsTarget::from_profile(&strict, None))
          .await
          .unwrap_or_else(|error| panic!("{mode:?} with CA: {error}"));
      }
    }
  }
}

#[tokio::test]
async fn a_reader_without_monitor_still_connects_and_sees_its_objects() {
  let Some(profile) = profile() else { return };
  let admin = pool(&profile).await;
  fresh_index(&admin, "smoke_reader").await;
  ok(&admin, "PUT", "/smoke_reader", None).await;
  // 造一个只有这个索引读权限的用户：ES 与 OpenSearch 的权限 API 不是同一套
  let password = format!("Pw-{}-reader!", std::process::id());
  let opensearch = is_opensearch(&admin).await;
  if opensearch {
    let role =
      r#"{"index_permissions":[{"index_patterns":["smoke_reader"],"allowed_actions":["read"]}]}"#;
    ok(&admin, "PUT", "/_plugins/_security/api/roles/smoke_reader", Some(role)).await;
    let user = json!({ "password": password }).to_string();
    ok(&admin, "PUT", "/_plugins/_security/api/internalusers/smoke_reader", Some(&user)).await;
    let mapping = r#"{"users":["smoke_reader"]}"#;
    ok(&admin, "PUT", "/_plugins/_security/api/rolesmapping/smoke_reader", Some(mapping)).await;
  } else {
    let role = r#"{"indices":[{"names":["smoke_reader"],"privileges":["read"]}]}"#;
    ok(&admin, "PUT", "/_security/role/smoke_reader", Some(role)).await;
    let user = json!({ "password": password, "roles": ["smoke_reader"] }).to_string();
    ok(&admin, "PUT", "/_security/user/smoke_reader", Some(&user)).await;
  }

  let mut reader = profile.clone();
  reader.username = "smoke_reader".to_string();
  reader.password = password;
  // `GET /` 对它是 403：认证过了，照样算连上
  let reader = pool(&reader).await;
  let root = send(&reader, "GET", "/", None, TIMEOUT).await.expect("root");
  assert_eq!(root.status, 403, "{}", root.body);
  let listed = es::list_objects(Arc::clone(&reader), TIMEOUT).await;
  if opensearch {
    // OpenSearch 的 read 不含 indices:admin/resolve/index：树列不出来，要说清楚是权限，不是回答读不懂
    let error = listed.err().unwrap_or_default();
    assert!(error.starts_with(ES_NO_PERMISSION), "{error}");
  } else {
    let names: Vec<String> = listed
      .expect("list")
      .into_iter()
      .map(|object| format!("{}:{}", object.object_kind, object.object_name))
      .collect();
    assert_eq!(names, ["index:smoke_reader"]);
  }
  // 控制台照样能查它有权限的索引
  let search = send(&reader, "GET", "/smoke_reader/_search", None, TIMEOUT).await.expect("search");
  assert_eq!(search.status, 200, "{}", search.body);

  if opensearch {
    for kind in ["rolesmapping", "internalusers", "roles"] {
      ok(&admin, "DELETE", &format!("/_plugins/_security/api/{kind}/smoke_reader"), None).await;
    }
  } else {
    ok(&admin, "DELETE", "/_security/user/smoke_reader", None).await;
    ok(&admin, "DELETE", "/_security/role/smoke_reader", None).await;
  }
  fresh_index(&admin, "smoke_reader").await;
}

#[tokio::test]
async fn the_tree_lists_indices_aliases_and_data_streams_but_not_hidden_ones() {
  let Some(profile) = profile() else { return };
  let pool = pool(&profile).await;
  fresh_index(&pool, "smoke_tree").await;
  send(&pool, "DELETE", "/_data_stream/smoke-ds-tree", None, TIMEOUT).await.expect("leftover");
  ok(&pool, "PUT", "/smoke_tree", Some(r#"{"aliases":{"smoke_tree_alias":{}}}"#)).await;
  ok(
    &pool,
    "PUT",
    "/_index_template/smoke-ds",
    Some(r#"{"index_patterns":["smoke-ds-*"],"data_stream":{},"priority":900}"#),
  )
  .await;
  ok(&pool, "POST", "/smoke-ds-tree/_doc", Some(r#"{"@timestamp":"2026-09-25T10:00:00Z"}"#)).await;

  let objects = es::list_objects(Arc::clone(&pool), TIMEOUT).await.expect("list");
  let has = |kind: &str, name: &str| {
    objects.iter().any(|object| object.object_kind == kind && object.object_name == name)
  };
  assert!(has("index", "smoke_tree"));
  assert!(has("alias", "smoke_tree_alias"));
  assert!(has("data-stream", "smoke-ds-tree"));
  assert!(objects.iter().all(|object| !object.object_name.starts_with('.')), "hidden ones listed");

  ok(&pool, "DELETE", "/_data_stream/smoke-ds-tree", None).await;
  ok(&pool, "DELETE", "/_index_template/smoke-ds", None).await;
  fresh_index(&pool, "smoke_tree").await;
}

#[tokio::test]
async fn the_console_sends_what_was_written_and_brings_back_the_body_as_is() {
  let Some(profile) = profile() else { return };
  let pool = pool(&profile).await;
  fresh_index(&pool, "smoke_console").await;

  // NDJSON：每行一份，最后要有换行
  let bulk = concat!(
    r#"{"index":{"_index":"smoke_console","_id":"1"}}"#,
    "\n",
    r#"{"title":"Dune","snowflake":9007199254740993}"#,
    "\n",
    r#"{"index":{"_index":"smoke_console","_id":"2"}}"#,
    "\n",
    r#"{"title":"Emma","snowflake":1}"#,
    "\n",
  );
  let result = ok(&pool, "POST", "/_bulk?refresh=true", Some(bulk)).await;
  assert_eq!(result["errors"], json!(false), "{result}");

  // 放不进 double 的整数原样回来：解析交给前端
  let response = send(&pool, "GET", "/smoke_console/_doc/1", None, TIMEOUT).await.expect("get");
  assert_eq!(response.status, 200);
  assert!(response.body.contains("9007199254740993"), "{}", response.body);

  // GET 带请求体（Dev Tools 的写法）
  let hits =
    ok(&pool, "GET", "/smoke_console/_search", Some(r#"{"query":{"match":{"title":"emma"}}}"#))
      .await;
  assert_eq!(hits["hits"]["total"]["value"], json!(1), "{hits}");

  // 4xx 是服务端的回答，不是命令的错误
  let missing =
    send(&pool, "GET", "/smoke_no_such_index/_search", None, TIMEOUT).await.expect("404");
  assert_eq!(missing.status, 404);
  assert!(missing.body.contains("index_not_found_exception"), "{}", missing.body);
  let head = send(&pool, "HEAD", "/smoke_console", None, TIMEOUT).await.expect("head");
  assert_eq!((head.status, head.body.as_str()), (200, ""));

  // 路径必须留在这台服务端上
  let error = send(&pool, "GET", "//example.com/", None, TIMEOUT).await.err().unwrap_or_default();
  assert!(error.starts_with(ES_REQUEST_INVALID), "{error}");
  let error = send(&pool, "TRACE", "/", None, TIMEOUT).await.err().unwrap_or_default();
  assert!(error.starts_with(ES_REQUEST_INVALID), "{error}");

  fresh_index(&pool, "smoke_console").await;
}

/// 本机到点放弃之后，服务端那次搜索也被取消——时限只在客户端就是靠这一条
#[tokio::test]
async fn a_timed_out_search_stops_on_the_server_too() {
  let Some(profile) = profile() else { return };
  let pool = pool(&profile).await;
  fresh_index(&pool, "smoke_slow").await;
  let mut bulk = String::new();
  for n in 0..500 {
    bulk.push_str("{\"index\":{\"_index\":\"smoke_slow\"}}\n");
    bulk.push_str(&format!("{{\"n\":{n}}}\n"));
  }
  let result = ok(&pool, "POST", "/_bulk?refresh=true", Some(&bulk)).await;
  assert_eq!(result["errors"], json!(false));

  // 每份文档拼一段越来越长的字符串再打分：五百份要半分钟以上（cu 上 2000 份 160 秒）。
  // 文档少是因为测试机到服务端的链路慢，两万份的 bulk 本身就要超时
  let slow = r#"{"size":1,"query":{"script_score":{"query":{"match_all":{}},
    "script":{"source":"String t = ''; for (int i = 0; i < 12000; i++) { t = t + i; } return t.length();"}}}}"#;
  let started = Instant::now();
  let error = send(&pool, "POST", "/smoke_slow/_search", Some(slow), Duration::from_secs(3))
    .await
    .err()
    .unwrap_or_default();
  assert!(error.starts_with(ES_TIMEOUT), "{error}");
  assert!(started.elapsed() < Duration::from_secs(6), "{:?}", started.elapsed());

  // 连接一断，服务端就把这次搜索标成取消。停得多快看版本：9.5 一秒内就没了；8.19 标了取消，
  // `script_score` 打分时却不看这个标，照样跑完（实测 25 秒后还在）。两边都成立的是「标了取消」
  let mut uncancelled = Vec::new();
  for _ in 0..10 {
    tokio::time::sleep(Duration::from_millis(500)).await;
    let tasks = ok(&pool, "GET", "/_tasks?actions=*search*&detailed", None).await;
    uncancelled = tasks["nodes"]
      .as_object()
      .into_iter()
      .flat_map(|nodes| nodes.values())
      .filter_map(|node| node["tasks"].as_object())
      .flat_map(|tasks| tasks.values())
      .filter(|task| task["description"].as_str().is_some_and(|text| text.contains("smoke_slow")))
      .filter(|task| task["cancelled"] != json!(true))
      .map(|task| task["action"].to_string())
      .collect();
    if uncancelled.is_empty() {
      break;
    }
  }
  assert!(uncancelled.is_empty(), "still running and not cancelled: {uncancelled:?}");
  fresh_index(&pool, "smoke_slow").await;
}

/// 界面上改文档靠的服务端行为：带过期的版本写会被 409 拒掉、带对版本能删、
/// 按自定义路由写的文档在命中里带着 `_routing`、带上它读得到
#[tokio::test]
async fn documents_are_written_only_with_the_version_that_was_read() {
  let Some(profile) = profile() else { return };
  let pool = pool(&profile).await;
  fresh_index(&pool, "smoke_doc").await;
  ok(&pool, "PUT", "/smoke_doc/_doc/1?refresh=true", Some(r#"{"n":1}"#)).await;
  let read = ok(&pool, "GET", "/smoke_doc/_doc/1", None).await;
  let (seq_no, term) = (read["_seq_no"].clone(), read["_primary_term"].clone());

  // 别人先写了一次
  ok(&pool, "PUT", "/smoke_doc/_doc/1", Some(r#"{"n":2}"#)).await;
  let stale =
    format!("/smoke_doc/_doc/1?if_seq_no={seq_no}&if_primary_term={term}&refresh=wait_for");
  let refused = send(&pool, "PUT", &stale, Some(r#"{"n":3}"#), TIMEOUT).await.expect("stale write");
  assert_eq!(refused.status, 409, "{}", refused.body);
  assert_eq!(ok(&pool, "GET", "/smoke_doc/_doc/1", None).await["_source"]["n"], json!(2));

  let fresh = ok(&pool, "GET", "/smoke_doc/_doc/1", None).await;
  let delete = format!(
    "/smoke_doc/_doc/1?if_seq_no={}&if_primary_term={}&refresh=wait_for",
    fresh["_seq_no"], fresh["_primary_term"]
  );
  ok(&pool, "DELETE", &delete, None).await;
  let gone = send(&pool, "GET", "/smoke_doc/_doc/1", None, TIMEOUT).await.expect("gone");
  assert_eq!(gone.status, 404);

  // 自定义路由：读的时候要带上同一个路由；命中里带着 `_routing`，编辑框就从那里拿
  fresh_index(&pool, "smoke_doc").await;
  ok(
    &pool,
    "PUT",
    "/smoke_doc",
    Some(r#"{"settings":{"number_of_shards":2,"number_of_replicas":0}}"#),
  )
  .await;
  let routing = "user-7";
  ok(
    &pool,
    "PUT",
    &format!("/smoke_doc/_doc/r?routing={routing}&refresh=true"),
    Some(r#"{"n":1}"#),
  )
  .await;
  let routed = ok(&pool, "GET", &format!("/smoke_doc/_doc/r?routing={routing}"), None).await;
  assert_eq!(routed["found"], json!(true));
  assert_eq!(routed["_routing"], json!(routing));
  let hits = ok(&pool, "GET", "/smoke_doc/_search?q=n:1", None).await;
  assert_eq!(
    hits["hits"]["hits"][0]["_routing"],
    json!(routing),
    "hits carry _routing for the editor"
  );
  fresh_index(&pool, "smoke_doc").await;
}
