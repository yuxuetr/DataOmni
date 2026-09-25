//! Neo4j 的真库用例。
//!
//! 默认静默跳过；要跑就在 shell 里设
//! `DATAOMNI_NEO4J_TEST_URL=bolt://user:password@host:port`（**不要写进任何文件**），
//! 并设 `DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS=1` 让缺了连接串的时候报错而不是跳过。
//!
//! 用例跑在用户的主库里，各用一个自己的标签（`Smoke<名字>`），开头先删掉同标签的残留——
//! 并行跑时互不干扰，一次断言失败留下的节点下次开头就清掉。

use dataomni_lib::models::ConnectionProfile;
use dataomni_lib::services::neo4j::{
  self as graph, CypherRequest, CypherResult, CypherValue, Neo4jPool, Neo4jTarget,
  NEO4J_AUTH_FAILED, NEO4J_DATABASE_NOT_FOUND, NEO4J_SERVER_ERROR, NEO4J_TIMEOUT,
  NEO4J_UNREACHABLE,
};
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

const URL_ENV: &str = "DATAOMNI_NEO4J_TEST_URL";
const REQUIRE_ENV: &str = "DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS";
const TIMEOUT: Duration = Duration::from_secs(20);

fn profile() -> Option<ConnectionProfile> {
  let url = match std::env::var(URL_ENV) {
    Ok(url) if !url.is_empty() => url,
    _ if std::env::var(REQUIRE_ENV).as_deref() == Ok("1") => {
      panic!("{URL_ENV} must be set when {REQUIRE_ENV}=1")
    }
    _ => return None,
  };
  let rest = url.strip_prefix("bolt://").expect("bolt:// URL");
  let (credentials, address) = rest.rsplit_once('@').expect("user:password@host");
  let (username, password) = credentials.split_once(':').expect("user:password");
  let (host, port) = address.trim_end_matches('/').rsplit_once(':').expect("host:port");
  Some(
    serde_json::from_value(json!({
      "name": "neo4j-smoke",
      "db_type": "neo4j",
      "host": host,
      "port": port.parse::<u16>().expect("port"),
      "database": "",
      "username": username,
      "password": password,
      "ssl": false,
      "tls_mode": "disabled",
      "options": {},
      "tags": []
    }))
    .expect("profile"),
  )
}

async fn pool(profile: &ConnectionProfile) -> Arc<Neo4jPool> {
  Arc::new(graph::connect(Neo4jTarget::from_profile(profile)).await.expect("connect"))
}

async fn cypher(pool: &Arc<Neo4jPool>, query: &str) -> CypherResult {
  run(pool, query, 1_000, TIMEOUT).await.unwrap_or_else(|error| panic!("{query}: {error}"))
}

async fn run(
  pool: &Arc<Neo4jPool>,
  query: &str,
  limit: usize,
  timeout: Duration,
) -> Result<CypherResult, String> {
  graph::run(
    Arc::clone(pool),
    CypherRequest { database: None, query: query.to_string(), limit, timeout },
  )
  .await
}

/// 这条用例自己的标签：先删掉上次留下的
async fn fresh_label(pool: &Arc<Neo4jPool>, label: &str) {
  cypher(pool, &format!("MATCH (n:{label}) DETACH DELETE n")).await;
}

fn text(value: &CypherValue) -> String {
  serde_json::to_string(value).unwrap_or_default()
}

#[tokio::test]
async fn a_wrong_password_a_closed_port_and_a_missing_database_are_named() {
  let Some(profile) = profile() else { return };

  let mut wrong = profile.clone();
  wrong.password.push_str("-wrong");
  let error = graph::connect(Neo4jTarget::from_profile(&wrong)).await.err().unwrap_or_default();
  assert!(error.starts_with(NEO4J_AUTH_FAILED), "{error}");

  let mut closed = profile.clone();
  closed.host = "127.0.0.1".to_string();
  closed.port = 1;
  let started = Instant::now();
  let error = graph::connect(Neo4jTarget::from_profile(&closed)).await.err().unwrap_or_default();
  assert!(error.starts_with(NEO4J_UNREACHABLE), "{error}");
  assert!(started.elapsed() < Duration::from_secs(15), "{:?}", started.elapsed());

  // 库名写错在连接这一步就报出来，不是等到展开对象树
  let mut missing = profile;
  missing.database = Some("no_such_database".to_string());
  let error = graph::connect(Neo4jTarget::from_profile(&missing)).await.err().unwrap_or_default();
  assert!(error.starts_with(NEO4J_DATABASE_NOT_FOUND), "{error}");
}

#[tokio::test]
async fn every_kind_of_value_comes_back_with_its_kind() {
  let Some(profile) = profile() else { return };
  let pool = pool(&profile).await;
  let result = cypher(
    &pool,
    "RETURN null AS nothing, true AS yes, 9223372036854775807 AS big, 3.0 AS whole, 0.5 AS half, \
     'it\\'s' AS quoted, [1, 'b'] AS list, {b: 1, a: 2} AS map, \
     date('2024-01-02') AS day, localtime('12:34:56.5') AS clock, \
     localdatetime('2024-01-02T03:04:05') AS local, \
     datetime('2024-01-02T03:04:05+08:00') AS fixed, \
     datetime({year: 2024, month: 1, day: 2, hour: 3, timezone: 'Asia/Shanghai'}) AS zoned, \
     duration('P1Y2M3DT4H5M6.5S') AS span, point({x: 1, y: 2.5}) AS flat, \
     point({longitude: 120.5, latitude: 30}) AS earth",
  )
  .await;
  assert_eq!(result.columns.len(), 16);
  let row: Vec<String> = result.rows[0].iter().map(text).collect();
  let expected = [
    r#"{"kind":"null"}"#,
    r#"{"kind":"boolean","value":true}"#,
    r#"{"kind":"integer","value":"9223372036854775807"}"#,
    r#"{"kind":"float","value":"3.0"}"#,
    r#"{"kind":"float","value":"0.5"}"#,
    r#"{"kind":"string","value":"it's"}"#,
    r#"{"kind":"list","items":[{"kind":"integer","value":"1"},{"kind":"string","value":"b"}]}"#,
    r#"{"kind":"map","entries":[["a",{"kind":"integer","value":"2"}],["b",{"kind":"integer","value":"1"}]]}"#,
    r#"{"kind":"temporal","value":"date('2024-01-02')"}"#,
    r#"{"kind":"temporal","value":"localtime('12:34:56.500')"}"#,
    r#"{"kind":"temporal","value":"localdatetime('2024-01-02T03:04:05')"}"#,
    r#"{"kind":"temporal","value":"datetime('2024-01-02T03:04:05+08:00')"}"#,
    r#"{"kind":"temporal","value":"datetime('2024-01-02T03:00:00+08:00[Asia/Shanghai]')"}"#,
    r#"{"kind":"temporal","value":"duration('P1Y2M3DT4H5M6.5S')"}"#,
    r#"{"kind":"point","value":"point({x: 1.0, y: 2.5, srid: 7203})"}"#,
    r#"{"kind":"point","value":"point({longitude: 120.5, latitude: 30.0, srid: 4326})"}"#,
  ];
  for (index, (got, want)) in row.iter().zip(expected).enumerate() {
    assert_eq!(got, want, "column {}", result.columns[index]);
  }
}

#[tokio::test]
async fn nodes_relationships_and_paths_keep_their_ids_and_direction() {
  let Some(profile) = profile() else { return };
  let pool = pool(&profile).await;
  fresh_label(&pool, "SmokeGraph").await;
  let created = cypher(
    &pool,
    "CREATE (a:SmokeGraph {name: 'a'})-[r:SMOKE_KNOWS {since: 2020}]->(b:SmokeGraph:Extra {name: 'b'}) \
     RETURN a, r, b, elementId(a) AS aid, elementId(b) AS bid",
  )
  .await;
  let counters: Vec<(&str, i64)> = created.summary.counters.clone();
  assert!(counters.contains(&("nodesCreated", 2)), "{counters:?}");
  assert!(counters.contains(&("relationshipsCreated", 1)), "{counters:?}");
  assert!(counters.contains(&("propertiesSet", 3)), "{counters:?}");
  assert_eq!(created.summary.query_type, Some("rw"));

  let row = &created.rows[0];
  let (CypherValue::String { value: a_id }, CypherValue::String { value: b_id }) =
    (&row[3], &row[4])
  else {
    panic!("{row:?}")
  };
  match (&row[0], &row[1], &row[2]) {
    (
      CypherValue::Node { element_id, labels, properties },
      CypherValue::Relationship {
        relationship_type,
        start_element_id,
        end_element_id,
        properties: rel,
        ..
      },
      CypherValue::Node { labels: b_labels, .. },
    ) => {
      assert_eq!(element_id, a_id);
      assert_eq!(labels, &vec!["SmokeGraph".to_string()]);
      assert_eq!(text(&properties[0].1), r#"{"kind":"string","value":"a"}"#);
      assert_eq!(relationship_type, "SMOKE_KNOWS");
      assert_eq!((start_element_id, end_element_id), (a_id, b_id));
      assert_eq!(rel[0].0, "since");
      assert_eq!(b_labels.len(), 2);
    }
    other => panic!("{other:?}"),
  }

  // 反着走的路径：关系的起止仍然是 a → b，只是 forward 为假
  let path =
    cypher(&pool, "MATCH p = (:SmokeGraph {name: 'b'})<-[:SMOKE_KNOWS]-(:SmokeGraph) RETURN p")
      .await;
  match &path.rows[0][0] {
    CypherValue::Path { start, segments } => {
      assert!(matches!(start.as_ref(), CypherValue::Node { element_id, .. } if element_id == b_id));
      assert_eq!(segments.len(), 1);
      assert!(!segments[0].forward);
      assert!(matches!(
        &segments[0].relationship,
        CypherValue::Relationship { start_element_id, end_element_id, .. }
          if start_element_id == a_id && end_element_id == b_id
      ));
      assert!(
        matches!(&segments[0].node, CypherValue::Node { element_id, .. } if element_id == a_id)
      );
    }
    other => panic!("{other:?}"),
  }
  fresh_label(&pool, "SmokeGraph").await;
}

#[tokio::test]
async fn rows_stop_at_the_limit_without_reading_the_rest() {
  let Some(profile) = profile() else { return };
  let pool = pool(&profile).await;
  let started = Instant::now();
  let result =
    run(&pool, "UNWIND range(1, 50000000) AS x RETURN x", 5, TIMEOUT).await.expect("run");
  assert_eq!(result.rows.len(), 5);
  assert!(result.truncated);
  // 五千万行整份拉回来要几十秒；早停后服务端丢弃，几秒以内
  assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());

  let exact = run(&pool, "UNWIND range(1, 5) AS x RETURN x", 5, TIMEOUT).await.expect("run");
  assert_eq!(exact.rows.len(), 5);
  assert!(!exact.truncated, "正好五行不是截断");
}

#[tokio::test]
async fn the_server_stops_a_query_at_the_timeout_and_errors_carry_the_position() {
  let Some(profile) = profile() else { return };
  let pool = pool(&profile).await;
  let started = Instant::now();
  let error = run(
    &pool,
    "UNWIND range(1, 2000000000) AS x WITH x WHERE x < 0 RETURN count(*)",
    10,
    Duration::from_secs(1),
  )
  .await
  .err()
  .unwrap_or_default();
  assert!(error.starts_with(NEO4J_TIMEOUT), "{error}");
  assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
  // 超时之后连接照样能用
  assert_eq!(cypher(&pool, "RETURN 1 AS one").await.rows.len(), 1);

  let error = run(&pool, "MATCH (n RETURN n", 10, TIMEOUT).await.err().unwrap_or_default();
  assert!(
    error.starts_with(&format!("{NEO4J_SERVER_ERROR}: Neo.ClientError.Statement.SyntaxError")),
    "{error}"
  );
  assert!(error.contains("line 1, column 10"), "{error}");
}

#[tokio::test]
async fn explain_tells_reads_from_writes_without_running_them() {
  let Some(profile) = profile() else { return };
  let pool = pool(&profile).await;
  fresh_label(&pool, "SmokeExplain").await;
  let ask = |query: &str| graph::query_type(Arc::clone(&pool), None, query.to_string(), TIMEOUT);
  assert_eq!(ask("MATCH (n:SmokeExplain) RETURN n").await, Ok(Some("r")));
  assert_eq!(ask("CREATE (n:SmokeExplain) RETURN n").await, Ok(Some("rw")));
  assert_eq!(ask("MATCH (n:SmokeExplain) DETACH DELETE n").await, Ok(Some("w")));
  assert_eq!(
    ask("CREATE INDEX smoke_explain IF NOT EXISTS FOR (n:SmokeExplain) ON (n.x)").await,
    Ok(Some("s"))
  );
  // 问过之后什么也没发生
  let count = cypher(&pool, "MATCH (n:SmokeExplain) RETURN count(n) AS c").await;
  assert_eq!(text(&count.rows[0][0]), r#"{"kind":"integer","value":"0"}"#);
  let indexes =
    cypher(&pool, "SHOW INDEXES YIELD name WHERE name = 'smoke_explain' RETURN name").await;
  assert!(indexes.rows.is_empty());
}

#[tokio::test]
async fn the_tree_lists_databases_labels_and_relationship_types() {
  let Some(profile) = profile() else { return };
  let pool = pool(&profile).await;
  fresh_label(&pool, "SmokeTree").await;
  cypher(&pool, "CREATE (:SmokeTree)-[:SMOKE_TREE_LINK]->(:SmokeTree)").await;
  let objects = graph::list_objects(Arc::clone(&pool), TIMEOUT).await.expect("list");
  let home = cypher(&pool, "CALL db.info() YIELD name RETURN name").await;
  let CypherValue::String { value: home } = &home.rows[0][0] else { panic!("{home:?}") };
  assert!(objects.iter().any(|object| object.object_schema == *home
    && object.object_kind == "label"
    && object.object_name == "SmokeTree"));
  assert!(objects.iter().any(
    |object| object.object_kind == "relationship-type" && object.object_name == "SMOKE_TREE_LINK"
  ));
  // system 库不进树
  assert!(objects.iter().all(|object| object.object_schema != "system"));
  fresh_label(&pool, "SmokeTree").await;
}
