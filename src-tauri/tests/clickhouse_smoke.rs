//! ClickHouse 的真库用例。
//!
//! 和 `database_smoke.rs` 一样默认静默跳过；要跑就在 shell 里设
//! `DATAOMNI_CLICKHOUSE_TEST_URL=http://user:password@host:port`（`https://` 就是加密，
//! **不要写进任何文件**），并设 `DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS=1` 让缺了连接串的时候
//! 报错而不是跳过。那个用户要能建库、建用户（只读账号那一条现建一个）。
//!
//! 用例都在 `dataomni_smoke` 库里，各用各的表名前缀，可以并行跑；开头清掉同名的残留。

use dataomni_lib::models::{ConnectionProfile, DatabaseType};
use dataomni_lib::services::clickhouse::{
  self, ClickHousePool, ClickHouseTarget, CLICKHOUSE_AUTH_FAILED, CLICKHOUSE_ROW_AMBIGUOUS,
  CLICKHOUSE_WRITE_UNVERIFIED,
};
use dataomni_lib::services::{
  completion_catalog_query, er_diagram_queries, execute_write_batch, explain_statement,
  object_catalog_queries, parse_plan, schema_metadata_queries, session_target_query, DdlQuery,
  PoolRef, QueryExecutionResult, QueryExecutionSummary, QueryRow, QuerySessionState,
  QueryTruncationReason, SessionConnection, StreamOptions, StreamingQueryOptions, WriteStatement,
  QUERY_TIMEOUT_CODE, ROW_COUNT_MISMATCH_CODE,
};
use serde_json::{json, Value as JsonValue};
use std::sync::Arc;
use std::time::{Duration, Instant};

const URL_ENV: &str = "DATAOMNI_CLICKHOUSE_TEST_URL";
const REQUIRE_ENV: &str = "DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS";
const DATABASE: &str = "dataomni_smoke";

/// 会压满服务端（停不下来、要靠 KILL 的查询）或者对时间敏感（DESCRIBE 要在几秒内回来）的
/// 用例排队跑：并行时它们互相挤，cu 负载高的时候时红时绿（停查询从 0.1 秒拖到超过 10 秒）。
/// 其余用例照样并行
static HEAVY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// `http://user:password@host:port` → 一份连接配置。口令里可能有 `@`，所以从右边切
fn profile_from_env() -> Option<ConnectionProfile> {
  let url = match std::env::var(URL_ENV) {
    Ok(url) if !url.is_empty() => url,
    _ if std::env::var(REQUIRE_ENV).as_deref() == Ok("1") => {
      panic!("{URL_ENV} must be set when {REQUIRE_ENV}=1")
    }
    _ => return None,
  };
  let (tls, rest) = match url.split_once("://").expect("scheme://") {
    ("https", rest) => ("preferred", rest),
    ("http", rest) => ("disabled", rest),
    (scheme, _) => panic!("unexpected scheme {scheme}"),
  };
  let (credentials, address) = rest.rsplit_once('@').expect("user:password@host:port");
  let (username, password) = credentials.split_once(':').expect("user:password");
  let (host, port) = address.trim_end_matches('/').rsplit_once(':').expect("host:port");
  Some(profile(host, port.parse().expect("port"), username, password, tls))
}

fn profile(host: &str, port: u16, username: &str, password: &str, tls: &str) -> ConnectionProfile {
  serde_json::from_value(json!({
    "name": "clickhouse-smoke",
    "db_type": "clickhouse",
    "host": host,
    "port": port,
    "database": DATABASE,
    "username": username,
    "password": password,
    "ssl": tls != "disabled",
    "tls_mode": tls,
    "options": {},
    "tags": []
  }))
  .expect("profile")
}

/// 先不带库连上、建好 `dataomni_smoke`，再连到它上面
async fn pool() -> Option<Arc<ClickHousePool>> {
  let mut profile = profile_from_env()?;
  profile.database = None;
  let bootstrap =
    clickhouse::connect(ClickHouseTarget::from_profile(&profile, None)).await.expect("connect");
  bootstrap
    .select(&format!("CREATE DATABASE IF NOT EXISTS {DATABASE}"), &[])
    .await
    .expect("create the smoke database");
  profile.database = Some(DATABASE.to_string());
  Some(clickhouse::connect(ClickHouseTarget::from_profile(&profile, None)).await.expect("connect"))
}

fn session(pool: &Arc<ClickHousePool>) -> SessionConnection {
  futures_block(SessionConnection::acquire(PoolRef::ClickHouse(pool))).expect("session")
}

/// `acquire` 对 ClickHouse 不等任何东西；包一层免得每个用例都 `.await`
fn futures_block<F: std::future::Future>(future: F) -> F::Output {
  futures_util::FutureExt::now_or_never(future).expect("acquire does not wait")
}

async fn run(connection: &mut SessionConnection, sql: &str) -> QueryExecutionResult {
  connection.execute(sql, 1000).await.unwrap_or_else(|error| panic!("{sql}: {error:?}"))
}

fn rows_of(result: QueryExecutionResult) -> Vec<QueryRow> {
  match result {
    QueryExecutionResult::Rows { rows, .. } => rows,
    QueryExecutionResult::Affected { rows_affected } => {
      panic!("expected rows, got {rows_affected} affected")
    }
  }
}

fn tagged(kind: &str, value: &str) -> JsonValue {
  json!({ "type": kind, "value": value })
}

/// 服务端上还有没有一条语句里带着 `marker` 的查询在跑
async fn still_running(pool: &Arc<ClickHousePool>, marker: &str) -> u64 {
  let rows = pool
    .select(
      "SELECT count() AS n FROM system.processes WHERE query LIKE {p1:String} AND query NOT LIKE '%system.processes%'",
      &[json!(format!("%{marker}%"))],
    )
    .await
    .expect("processes");
  rows[0]["n"].as_u64().expect("count")
}

/// 断言之前先把残留停掉：断言失败时不能把一条扫一万亿行的查询留在测试库上
async fn stop_marked(pool: &Arc<ClickHousePool>, marker: &str) {
  pool
    .select(
      "KILL QUERY WHERE query LIKE {p1:String} AND query NOT LIKE '%KILL QUERY%' SYNC",
      &[json!(format!("%{marker}%"))],
    )
    .await
    .expect("kill leftovers");
}

#[tokio::test]
async fn clickhouse_decodes_values_the_way_the_other_dialects_do() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool);
  let rows = rows_of(
    run(
      &mut connection,
      "SELECT
         toUInt64(18446744073709551615) AS u64,
         toInt64(42) AS small64,
         toInt32(-7) AS i32,
         toDecimal64('10.50', 2) AS cents,
         1.5::Float64 AS f,
         nan AS n,
         NULL AS nothing,
         toNullable(toUInt8(3)) AS maybe,
         ['x\\ty', 'o''k'] AS arr,
         map('k', 1) AS m,
         (1, 'a') AS tup,
         toDate('2024-01-02') AS d,
         toDateTime64('2024-01-02 03:04:05.123', 3, 'UTC') AS ts,
         toUUID('6f9619ff-8b86-d011-b42d-00c04fc964ff') AS id,
         toIPv4('1.2.3.4') AS ip,
         CAST('b', 'Enum8(\\'a\\' = 1, \\'b\\' = 2)') AS e,
         toLowCardinality('中文') AS lc,
         unhex('ff00') AS bin,
         'line\\nbreak\\\\N' AS escaped,
         '\\\\N' AS not_null,
         true AS flag",
    )
    .await,
  );
  let row = &rows[0];
  assert_eq!(row["u64"], tagged("bigint", "18446744073709551615"));
  assert_eq!(row["small64"], json!(42));
  assert_eq!(row["i32"], json!(-7));
  assert_eq!(row["cents"], tagged("decimal", "10.50"));
  assert_eq!(row["f"], json!(1.5));
  assert_eq!(row["n"], json!("nan"));
  assert_eq!(row["nothing"], JsonValue::Null);
  assert_eq!(row["maybe"], json!(3));
  assert_eq!(row["arr"], json!("['x\\ty','o\\'k']"));
  assert_eq!(row["m"], json!("{'k':1}"));
  assert_eq!(row["tup"], json!("(1,'a')"));
  assert_eq!(row["d"], tagged("date", "2024-01-02"));
  assert_eq!(row["ts"], tagged("datetime", "2024-01-02 03:04:05.123"));
  assert_eq!(row["id"], json!("6f9619ff-8b86-d011-b42d-00c04fc964ff"));
  assert_eq!(row["ip"], json!("1.2.3.4"));
  assert_eq!(row["e"], json!("b"));
  assert_eq!(row["lc"], json!("中文"));
  assert_eq!(row["bin"], tagged("binary", "ff00"));
  assert_eq!(row["escaped"], json!("line\nbreak\\N"));
  assert_eq!(row["not_null"], json!("\\N"));
  assert_eq!(row["flag"], json!(true));
}

#[tokio::test]
async fn clickhouse_errors_carry_the_code_and_the_character_position() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool);
  let error = connection.execute("SELECT '日本' AS a FROMM t", 10).await.expect_err("syntax");
  assert_eq!(error.code.as_deref(), Some("62"));
  assert!(error.message.starts_with("Syntax error"), "{}", error.message);
  assert!(!error.message.contains("(version"), "{}", error.message);
  assert_eq!(error.position(), Some(18), "字节 22 是字符 18");
  // 同一个会话接着能用
  assert_eq!(rows_of(run(&mut connection, "SELECT 1 AS one").await)[0]["one"], json!(1));
}

/// 流到一半才出错：前面的数据已经发出来了，这一次仍然是错误，不是一个少了几行的结果
#[tokio::test]
async fn clickhouse_reports_an_exception_that_arrives_after_the_data() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool);
  let mut rows = 0usize;
  let error = connection
    .execute_streaming(
      "SELECT number, throwIf(number = 50000, 'boom') FROM numbers(200000) SETTINGS max_block_size = 1000",
      StreamOptions::limited(1_000_000, 64 << 20, 1000),
      &mut |batch| {
        rows += batch.rows.len();
        Ok(())
      },
    )
    .await
    .expect_err("the exception must surface");
  assert_eq!(error.code.as_deref(), Some("395"), "{error:?}");
  assert!(error.message.starts_with("boom"), "{}", error.message);
  assert!(rows > 0, "数据先到了：{rows} 行");
}

/// 到了行数上限就不往下读，服务端那条也停下。
///
/// 查询要选「先出一截、之后只算不出」的那种：一直往外写的查询，我们一断开它下一次写就失败、
/// 自己会停（反向验证时试过，去掉 KILL 照样绿）。前面那一截要超过服务端 HTTP 输出的缓冲
/// （约 1 MiB，满了才发），否则一行也到不了这边。这一条先出 30 万行，然后扫一万亿个数、
/// 一行也不再写，服务端发现不了连接断了——不 KILL 它就一直跑，会话也一直锁着
#[tokio::test]
async fn clickhouse_truncates_at_the_row_limit_and_stops_the_server_side_query() {
  let _heavy = HEAVY.lock().await;
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool);
  let marker = "smoke_truncate_marker";
  let sql = format!(
    "SELECT number AS {marker} FROM numbers(1000000000000) WHERE number < 300000 OR sipHash64(number) = 0 \
     SETTINGS max_threads = 1"
  );
  let summary = tokio::time::timeout(
    Duration::from_secs(60),
    connection.execute_streaming(&sql, StreamOptions::limited(10, 64 << 20, 5), &mut |_| Ok(())),
  )
  .await
  .expect("the first megabyte arrives well within a minute")
  .expect("truncated rows");
  match summary {
    QueryExecutionSummary::Rows { row_count, truncated, truncation_reason, .. } => {
      assert_eq!(row_count, 10);
      assert!(truncated);
      assert_eq!(truncation_reason, Some(QueryTruncationReason::RowLimit));
    }
    QueryExecutionSummary::Affected { .. } => panic!("rows expected"),
  }
  let running = still_running(&pool, marker).await;
  stop_marked(&pool, marker).await;
  assert_eq!(running, 0, "只算不出的那一段必须被停下");
  // 会话没被锁着
  assert_eq!(rows_of(run(&mut connection, "SELECT 1 AS one").await)[0]["one"], json!(1));
}

/// 超时之后服务端那条被 KILL；同一个会话的下一条不撞「会话锁着」。
/// 这几条停不下来的查询都限一个线程：不限的话它们各自占满所有核，并行跑的别的用例
/// （DESCRIBE 要在几秒内回来）会被挤得超时（试过，cu 负载高的时候时红时绿）
#[tokio::test]
async fn clickhouse_timeout_kills_the_query_and_the_session_stays_usable() {
  let _heavy = HEAVY.lock().await;
  let Some(pool) = pool().await else { return };
  let sessions = QuerySessionState::default();
  let marker = "smoke_timeout_marker";
  let options = |sql: &'static str, timeout: Duration| StreamingQueryOptions {
    session_id: "smoke-timeout",
    pool_key: "clickhouse-smoke",
    pool: PoolRef::ClickHouse(&pool),
    sql,
    autocommit: true,
    explain_plan: false,
    row_limit: 100,
    byte_limit: 1 << 20,
    batch_size: 100,
    timeout_duration: timeout,
  };
  let started = Instant::now();
  let error = sessions
    .execute_streaming(
      options(
        "SELECT sum(sipHash64(number)) AS smoke_timeout_marker FROM numbers(1000000000000) \
         SETTINGS max_threads = 1",
        Duration::from_millis(1500),
      ),
      &mut |_| Ok(()),
    )
    .await
    .expect_err("times out");
  assert_eq!(error.code.as_deref(), Some(QUERY_TIMEOUT_CODE));
  assert!(started.elapsed() < Duration::from_secs(5));

  let mut rows = Vec::new();
  sessions
    .execute_streaming(options("SELECT 2 AS two", Duration::from_secs(10)), &mut |batch| {
      rows.extend(batch.rows);
      Ok(())
    })
    .await
    .expect("the same session runs the next statement");
  assert_eq!(rows[0]["two"], json!(2));
  let running = still_running(&pool, marker).await;
  stop_marked(&pool, marker).await;
  assert_eq!(running, 0);
}

/// `SET` 与临时表只属于这个会话
#[tokio::test]
async fn clickhouse_sessions_keep_settings_and_temporary_tables() {
  let Some(pool) = pool().await else { return };
  let mut first = session(&pool);
  let mut second = session(&pool);
  run(&mut first, "SET max_threads = 3").await;
  run(&mut first, "CREATE TEMPORARY TABLE smoke_session_tmp (a UInt8)").await;
  run(&mut first, "INSERT INTO smoke_session_tmp VALUES (1), (2)").await;
  let rows = rows_of(
    run(
      &mut first,
      "SELECT getSetting('max_threads') AS t, (SELECT count() FROM smoke_session_tmp) AS c",
    )
    .await,
  );
  assert_eq!(rows[0]["t"], json!(3));
  assert_eq!(rows[0]["c"], json!(2));
  let other = second.execute("SELECT count() FROM smoke_session_tmp", 10).await;
  assert!(other.is_err(), "别的会话看不见这张临时表");
}

/// 没有结果集的语句：写入行数来自服务端的摘要
#[tokio::test]
async fn clickhouse_non_queries_report_written_rows() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool);
  run(&mut connection, "DROP TABLE IF EXISTS smoke_written SYNC").await;
  let created =
    run(&mut connection, "CREATE TABLE smoke_written (a UInt8) ENGINE = MergeTree ORDER BY a")
      .await;
  assert!(matches!(created, QueryExecutionResult::Affected { rows_affected: 0 }));
  let inserted = run(&mut connection, "INSERT INTO smoke_written VALUES (1), (2), (3)").await;
  assert!(matches!(inserted, QueryExecutionResult::Affected { rows_affected: 3 }), "{inserted:?}");
  // 空结果仍然是结果集（有表头），不是「影响 0 行」
  let empty = run(&mut connection, "SELECT a FROM smoke_written WHERE a > 10").await;
  assert!(
    matches!(empty, QueryExecutionResult::Rows { ref rows, .. } if rows.is_empty()),
    "{empty:?}"
  );
  // 语句自己写了 FORMAT：原样一行一格
  let raw = rows_of(
    run(&mut connection, "SELECT a FROM smoke_written ORDER BY a FORMAT JSONEachRow").await,
  );
  assert_eq!(raw[0]["result"], json!("{\"a\":1}"));
  run(&mut connection, "DROP TABLE smoke_written SYNC").await;
}

#[tokio::test]
async fn clickhouse_describes_columns_without_running_the_query() {
  let _heavy = HEAVY.lock().await;
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool);
  let started = Instant::now();
  let columns = connection
    .describe_columns(
      "SELECT sum(sipHash64(number)) AS total, 'x' AS label FROM numbers(1000000000000) -- 注释",
    )
    .await
    .expect("describe");
  // 真算一万亿行要几个小时；20 秒而不是更紧，是因为 cu 负载高时一次往返也会拖到好几秒
  assert!(started.elapsed() < Duration::from_secs(20), "DESCRIBE 不该真的去算");
  let shape: Vec<(&str, &str, &str)> = columns
    .iter()
    .map(|column| {
      (column.name.as_str(), column.database_type.as_str(), column.logical_type.as_str())
    })
    .collect();
  assert_eq!(shape, [("total", "UInt64", "integer"), ("label", "String", "text")]);
  assert!(connection
    .describe_columns("INSERT INTO t VALUES (1)")
    .await
    .expect("non-query")
    .is_empty());
}

#[tokio::test]
async fn clickhouse_catalog_queries_describe_the_fixture() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool);
  for sql in [
    "DROP VIEW IF EXISTS smoke_catalog_mv SYNC",
    "DROP VIEW IF EXISTS smoke_catalog_view SYNC",
    "DROP DICTIONARY IF EXISTS smoke_catalog_dict SYNC",
    "DROP TABLE IF EXISTS smoke_catalog_totals SYNC",
    "DROP TABLE IF EXISTS smoke_catalog_events SYNC",
    "CREATE TABLE smoke_catalog_events (
       id UInt64,
       ts DateTime,
       name LowCardinality(String),
       v Nullable(Float64) DEFAULT 1.5 COMMENT 'val',
       doubled UInt64 MATERIALIZED id * 2 CODEC(ZSTD(1)),
       INDEX idx_name name TYPE bloom_filter GRANULARITY 4
     ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (id, toDate(ts))",
    "CREATE VIEW smoke_catalog_view AS SELECT id FROM smoke_catalog_events",
    "CREATE TABLE smoke_catalog_totals (name String, n UInt64) ENGINE = SummingMergeTree ORDER BY name",
    "CREATE MATERIALIZED VIEW smoke_catalog_mv TO smoke_catalog_totals AS SELECT name, count() AS n FROM smoke_catalog_events GROUP BY name",
    "CREATE DICTIONARY smoke_catalog_dict (name String, n UInt64) PRIMARY KEY name
       SOURCE(CLICKHOUSE(TABLE 'smoke_catalog_totals')) LIFETIME(0) LAYOUT(COMPLEX_KEY_HASHED())",
    "INSERT INTO smoke_catalog_events (id, ts, name) SELECT number, toDateTime('2024-01-01') + number * 60, toString(number % 7) FROM numbers(50000)",
  ] {
    run(&mut connection, sql).await;
  }

  let objects = pool
    .select(object_catalog_queries(&DatabaseType::ClickHouse).expect("objects").objects, &[])
    .await
    .expect("objects");
  let kind_of = |name: &str| {
    objects
      .iter()
      .find(|row| row["object_schema"] == json!(DATABASE) && row["object_name"] == json!(name))
      .map(|row| row["object_kind"].as_str().unwrap_or("").to_string())
  };
  assert_eq!(kind_of("smoke_catalog_events").as_deref(), Some("table"));
  assert_eq!(kind_of("smoke_catalog_view").as_deref(), Some("view"));
  assert_eq!(kind_of("smoke_catalog_mv").as_deref(), Some("materialized-view"));
  assert_eq!(kind_of("smoke_catalog_dict").as_deref(), Some("dictionary"));
  assert!(objects.iter().all(|row| row["object_schema"] != json!("system")), "系统库不进树");

  let queries = schema_metadata_queries(&DatabaseType::ClickHouse).expect("schema");
  let params = [json!("smoke_catalog_events"), JsonValue::Null];
  let columns = pool.select(queries.columns, &params).await.expect("columns");
  let column =
    |name: &str| columns.iter().find(|row| row["column_name"] == json!(name)).expect(name).clone();
  assert_eq!(columns.len(), 5);
  assert_eq!(column("id")["is_primary_key"], json!(true));
  assert_eq!(column("id")["primary_key_ordinal"], json!(1));
  assert_eq!(column("ts")["is_primary_key"], json!(true), "toDate(ts) 用到了它");
  assert_eq!(column("v")["is_nullable"], json!(true));
  assert_eq!(column("v")["column_default"], json!("1.5"));
  assert_eq!(column("v")["comment"], json!("val"));
  assert_eq!(column("name")["is_nullable"], json!(false));
  assert_eq!(column("doubled")["is_generated"], json!(true));
  assert_eq!(column("doubled")["column_extra"], json!("MATERIALIZED id * 2 CODEC(ZSTD(1))"));
  assert_eq!(column("doubled")["column_default"], JsonValue::Null);

  let indexes = pool.select(queries.indexes, &params).await.expect("indexes");
  let summary: Vec<(String, String, bool, bool)> = indexes
    .iter()
    .map(|row| {
      (
        row["index_name"].as_str().unwrap_or("").to_string(),
        row["column_name"].as_str().unwrap_or("").to_string(),
        row["is_primary"].as_bool().unwrap_or(false),
        row["is_unique"].as_bool().unwrap_or(true),
      )
    })
    .collect();
  assert_eq!(
    summary,
    [
      ("PRIMARY KEY".to_string(), "id".to_string(), true, false),
      ("PRIMARY KEY".to_string(), "toDate(ts)".to_string(), true, false),
      ("idx_name".to_string(), "name".to_string(), false, false),
    ]
  );
  assert_eq!(indexes[2]["method"], json!("bloom_filter GRANULARITY 4"));

  assert!(pool.select(queries.foreign_keys, &params).await.expect("fks").is_empty());
  assert!(pool.select(queries.triggers, &params).await.expect("triggers").is_empty());
  let Some(DdlQuery::Bound { sql }) = queries.ddl else { panic!("bound ddl") };
  let ddl = pool.select(sql, &params).await.expect("ddl");
  let text = ddl[0]["sql"].as_str().expect("ddl text");
  assert!(text.starts_with("CREATE TABLE dataomni_smoke.smoke_catalog_events\n("), "{text}");
  assert!(text.contains("ORDER BY (id, toDate(ts))"), "{text}");

  let completion = pool
    .select(completion_catalog_query(&DatabaseType::ClickHouse).expect("completion").relations, &[])
    .await
    .expect("completion");
  let events: Vec<&str> = completion
    .iter()
    .filter(|row| row["relation_name"] == json!("smoke_catalog_events"))
    .filter_map(|row| row["column_name"].as_str())
    .collect();
  assert_eq!(events, ["id", "ts", "name", "v", "doubled"], "按表内顺序");
  assert!(completion.iter().any(|row| row["relation_name"] == json!("smoke_catalog_view")
    && row["relation_kind"] == json!("view")));

  let er = er_diagram_queries(&DatabaseType::ClickHouse).expect("er");
  let er_columns = pool.select(er.columns, &[]).await.expect("er columns");
  assert!(er_columns.iter().any(|row| row["table_name"] == json!("smoke_catalog_events")));
  assert!(
    er_columns.iter().all(|row| row["table_name"] != json!("smoke_catalog_view")),
    "视图不进 ER 图"
  );
  assert!(pool.select(er.foreign_keys, &[]).await.expect("er fks").is_empty());

  let target = rows_of(
    run(&mut connection, session_target_query(&DatabaseType::ClickHouse).expect("target").sql)
      .await,
  );
  assert_eq!(target[0]["database_name"], json!(DATABASE));
  assert_eq!(target[0]["read_only"], json!(false));

  // 执行计划：读表那一步说出主键把 granule 筛到了多少
  let statement = explain_statement(
    &DatabaseType::ClickHouse,
    "SELECT count() FROM smoke_catalog_events WHERE id BETWEEN 100 AND 200",
    false,
  )
  .expect("explain statement");
  let plan_rows = rows_of(run(&mut connection, &statement).await);
  let plan = parse_plan(&DatabaseType::ClickHouse, &plan_rows, false).expect("plan");
  fn find<'a>(
    node: &'a dataomni_lib::services::PlanNode,
    operation: &str,
  ) -> Option<&'a dataomni_lib::services::PlanNode> {
    if node.operation == operation {
      return Some(node);
    }
    node.children.iter().find_map(|child| find(child, operation))
  }
  let read = plan.roots.iter().find_map(|root| find(root, "ReadFromMergeTree")).expect("read step");
  assert_eq!(read.target.as_deref(), Some("dataomni_smoke.smoke_catalog_events"));
  let primary = read
    .detail
    .iter()
    .find(|detail| {
      detail.key == "PrimaryKey (id, toDate(ts))" || detail.key.starts_with("PrimaryKey")
    })
    .expect("primary key detail");
  assert!(primary.value.contains("granules"), "{primary:?}");

  for sql in [
    "DROP DICTIONARY smoke_catalog_dict SYNC",
    "DROP VIEW smoke_catalog_mv SYNC",
    "DROP VIEW smoke_catalog_view SYNC",
    "DROP TABLE smoke_catalog_totals SYNC",
    "DROP TABLE smoke_catalog_events SYNC",
  ] {
    run(&mut connection, sql).await;
  }
}

/// `readonly = 1` 的账号改不了任何设置；这里一个都不带，所以它照常能查、能用会话、
/// 超时也停得下自己的查询
#[tokio::test]
async fn clickhouse_read_only_accounts_query_and_kill_their_own_queries() {
  let _heavy = HEAVY.lock().await;
  let Some(pool) = pool().await else { return };
  let Some(mut profile) = profile_from_env() else { return };
  let password = uuid::Uuid::new_v4().simple().to_string();
  pool.select("DROP USER IF EXISTS smoke_reader", &[]).await.expect("drop user");
  pool
    .select(
      &format!("CREATE USER smoke_reader IDENTIFIED BY '{password}' SETTINGS readonly = 1"),
      &[],
    )
    .await
    .expect("create user");
  pool.select(&format!("GRANT SELECT ON {DATABASE}.* TO smoke_reader"), &[]).await.expect("grant");
  pool.select("GRANT SELECT ON system.* TO smoke_reader", &[]).await.expect("grant system");

  profile.username = "smoke_reader".to_string();
  profile.password = "wrong".to_string();
  let refused = clickhouse::connect(ClickHouseTarget::from_profile(&profile, None)).await.err();
  assert!(
    refused.as_deref().is_some_and(|error| error.starts_with(CLICKHOUSE_AUTH_FAILED)),
    "{refused:?}"
  );

  profile.password = password;
  let reader =
    clickhouse::connect(ClickHouseTarget::from_profile(&profile, None)).await.expect("reader");
  let mut connection = session(&reader);
  let target = rows_of(
    run(&mut connection, session_target_query(&DatabaseType::ClickHouse).expect("target").sql)
      .await,
  );
  assert_eq!(target[0]["read_only"], json!(true));
  // 没有建表的权限（497）；有权限也会因为只读被拒（164）
  let write = connection.execute("CREATE TABLE smoke_reader_t (a UInt8) ENGINE = Memory", 10).await;
  let code = write.expect_err("read only").code;
  assert!(matches!(code.as_deref(), Some("497" | "164")), "{code:?}");

  let sessions = QuerySessionState::default();
  let error = sessions
    .execute_streaming(
      StreamingQueryOptions {
        session_id: "smoke-reader",
        pool_key: "clickhouse-reader",
        pool: PoolRef::ClickHouse(&reader),
        sql: "SELECT sum(sipHash64(number)) AS smoke_reader_marker FROM numbers(1000000000000)",
        autocommit: true,
        explain_plan: false,
        row_limit: 10,
        byte_limit: 1 << 20,
        batch_size: 10,
        timeout_duration: Duration::from_millis(1500),
      },
      &mut |_| Ok(()),
    )
    .await
    .expect_err("times out");
  assert_eq!(error.code.as_deref(), Some(QUERY_TIMEOUT_CODE));
  // KILL 是另一个请求，被丢掉的那条在后台停；等它一下
  tokio::time::sleep(Duration::from_millis(1500)).await;
  let running = still_running(&pool, "smoke_reader_marker").await;
  stop_marked(&pool, "smoke_reader_marker").await;
  assert_eq!(running, 0);
  pool.select("DROP USER smoke_reader", &[]).await.expect("drop user");
}

fn write(sql: &str, params: Vec<JsonValue>, expect_rows: Option<u64>) -> WriteStatement {
  WriteStatement { sql: sql.to_string(), params, expect_rows }
}

async fn values_of(pool: &Arc<ClickHousePool>, table: &str) -> Vec<(u64, String)> {
  pool
    .select(&format!("SELECT id, v FROM {table} ORDER BY id, v"), &[])
    .await
    .expect("read back")
    .iter()
    .map(|row| (row["id"].as_u64().unwrap_or(0), row["v"].as_str().unwrap_or("").to_string()))
    .collect()
}

/// 表格的一项改动：前端展开成「数一遍 → 执行 → 核对」，这里逐条核对。
/// 新增、改、删三种都走一遍，外加三种对不上：一模一样的两行、读完之后别处改了、写完核对不上
#[tokio::test]
async fn clickhouse_grid_writes_count_before_and_verify_after() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool);
  for sql in [
    "DROP TABLE IF EXISTS smoke_grid SYNC",
    "CREATE TABLE smoke_grid (id UInt64, v String) ENGINE = MergeTree ORDER BY id",
    "INSERT INTO smoke_grid VALUES (1, 'a'), (2, 'b'), (2, 'b')",
  ] {
    run(&mut connection, sql).await;
  }
  let batch = |statements: Vec<WriteStatement>| {
    let pool = Arc::clone(&pool);
    async move { execute_write_batch(PoolRef::ClickHouse(&pool), &statements).await }
  };

  // 新增：服务端报的写入行数就是核对
  let inserted = batch(vec![write(
    "INSERT INTO smoke_grid (id, v) VALUES ({p1:UInt64}, {p2:String})",
    vec![json!(3), json!("c")],
    Some(1),
  )])
  .await
  .expect("insert");
  assert_eq!(inserted, [1]);

  // 改：执行前恰好一行，改完新值至少一行
  let row = "id = {p1:UInt64} AND v = {p2:String}";
  batch(vec![
    write(
      &format!("SELECT count() FROM smoke_grid WHERE {row}"),
      vec![json!(1), json!("a")],
      Some(1),
    ),
    write(
      &format!("ALTER TABLE smoke_grid UPDATE v = {{p3:String}} WHERE {row}"),
      vec![json!(1), json!("a"), json!("A")],
      None,
    ),
    write(
      &format!("SELECT toUInt64(count() >= 1) FROM smoke_grid WHERE {row}"),
      vec![json!(1), json!("A")],
      Some(1),
    ),
  ])
  .await
  .expect("update");

  // 删：执行前恰好一行，删完零行
  batch(vec![
    write(
      &format!("SELECT count() FROM smoke_grid WHERE {row}"),
      vec![json!(3), json!("c")],
      Some(1),
    ),
    write(&format!("DELETE FROM smoke_grid WHERE {row}"), vec![json!(3), json!("c")], None),
    write(
      &format!("SELECT count() FROM smoke_grid WHERE {row}"),
      vec![json!(3), json!("c")],
      Some(0),
    ),
  ])
  .await
  .expect("delete");
  assert_eq!(
    values_of(&pool, "smoke_grid").await,
    [(1, "A".into()), (2, "b".into()), (2, "b".into())]
  );

  // 一模一样的两行：分不出改哪一行，一条都不执行
  let error = batch(vec![
    write(
      &format!("SELECT count() FROM smoke_grid WHERE {row}"),
      vec![json!(2), json!("b")],
      Some(1),
    ),
    write(&format!("DELETE FROM smoke_grid WHERE {row}"), vec![json!(2), json!("b")], None),
  ])
  .await
  .expect_err("ambiguous");
  assert_eq!(error.statement_index, 0);
  assert_eq!(error.error.message, format!("{CLICKHOUSE_ROW_AMBIGUOUS}: 2"));

  // 读完之后别处改了：数到零行，和别家「没有恰好影响一行」同一个码
  let error = batch(vec![
    write(
      &format!("SELECT count() FROM smoke_grid WHERE {row}"),
      vec![json!(1), json!("a")],
      Some(1),
    ),
    write(&format!("DELETE FROM smoke_grid WHERE {row}"), vec![json!(1), json!("a")], None),
  ])
  .await
  .expect_err("stale");
  assert_eq!(error.error.code.as_deref(), Some(ROW_COUNT_MISMATCH_CODE));
  assert_eq!(values_of(&pool, "smoke_grid").await.len(), 3, "什么都没删");

  // 改键列：服务端拒绝（420），没写过，不说「已经执行」
  let error = batch(vec![
    write(
      &format!("SELECT count() FROM smoke_grid WHERE {row}"),
      vec![json!(1), json!("A")],
      Some(1),
    ),
    write(
      &format!("ALTER TABLE smoke_grid UPDATE id = {{p3:UInt64}} WHERE {row}"),
      vec![json!(1), json!("A"), json!(9)],
      None,
    ),
  ])
  .await
  .expect_err("key column");
  assert_eq!((error.statement_index, error.error.code.as_deref()), (1, Some("420")));

  // 写完核对对不上：已经生效，撤不回来，如实说
  let error = batch(vec![
    write(
      &format!("SELECT count() FROM smoke_grid WHERE {row}"),
      vec![json!(1), json!("A")],
      Some(1),
    ),
    write(
      &format!("ALTER TABLE smoke_grid UPDATE v = {{p3:String}} WHERE {row}"),
      vec![json!(1), json!("A"), json!("Z")],
      None,
    ),
    write(
      &format!("SELECT count() FROM smoke_grid WHERE {row}"),
      vec![json!(1), json!("Z")],
      Some(5),
    ),
  ])
  .await
  .expect_err("unverified");
  assert_eq!(error.statement_index, 2);
  assert_eq!(error.error.message, format!("{CLICKHOUSE_WRITE_UNVERIFIED}: 5 · 1"));
  assert_eq!(values_of(&pool, "smoke_grid").await[0], (1, "Z".into()), "确实已经改了");
  run(&mut connection, "DROP TABLE smoke_grid SYNC").await;
}

/// 参数原样到达服务端：字符串里的换行、制表符、反斜杠、`\N` 字样不被当成转义，
/// Array 的字面量照界面上显示的写法传。写进去、按它定位一行、读回来，三处都要对
#[tokio::test]
async fn clickhouse_parameters_carry_strings_byte_for_byte() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool);
  for sql in [
    "DROP TABLE IF EXISTS smoke_params SYNC",
    "CREATE TABLE smoke_params (id UInt64, v String, a Array(String)) ENGINE = MergeTree ORDER BY id",
  ] {
    run(&mut connection, sql).await;
  }
  let text = "tab\tnl\nbs\\ \\N \\b quote' 中文";
  let array = "['x\\'y','a\\nb']";
  let inserted = execute_write_batch(
    PoolRef::ClickHouse(&pool),
    &[write(
      "INSERT INTO smoke_params (id, v, a) VALUES ({p1:UInt64}, {p2:String}, {p3:Array(String)})",
      vec![json!(1), json!(text), json!(array)],
      Some(1),
    )],
  )
  .await
  .expect("insert");
  assert_eq!(inserted, [1]);
  let rows = pool
    .select(
      "SELECT v, a, length(a) AS n, a[1] AS first FROM smoke_params WHERE v = {p1:String}",
      &[json!(text)],
    )
    .await
    .expect("read back");
  assert_eq!(rows.len(), 1, "按原值定位得到这一行");
  assert_eq!(rows[0]["v"], json!(text));
  assert_eq!(rows[0]["a"], json!(array));
  assert_eq!((rows[0]["n"].clone(), rows[0]["first"].clone()), (json!(2), json!("x'y")));
  run(&mut connection, "DROP TABLE smoke_params SYNC").await;
}

/// 导出走会话连接：先 DESCRIBE 拿表头（不执行），再流式写完全部行。
/// 值的写法与另外几家一致：大整数、定点小数按原文，NULL 写成空，二进制写 `0x…`
#[tokio::test]
async fn clickhouse_exports_stream_to_a_file_and_refuse_non_queries() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool);
  for sql in [
    "DROP TABLE IF EXISTS smoke_export SYNC",
    "CREATE TABLE smoke_export (
       id UInt64,
       big UInt64,
       cents Decimal(10, 2),
       note Nullable(String),
       raw String,
       doubled UInt64 MATERIALIZED id * 2
     ) ENGINE = MergeTree ORDER BY id",
    "INSERT INTO smoke_export (id, big, cents, note, raw) VALUES
       (1, 18446744073709551615, 10.5, '甲,乙', unhex('ff00')),
       (2, 7, 3, NULL, 'x')",
  ] {
    run(&mut connection, sql).await;
  }
  let dir = std::env::temp_dir().join(format!("dataomni-clickhouse-export-{}", std::process::id()));
  std::fs::create_dir_all(&dir).expect("temp dir");
  let target = dir.join("out.csv");
  let options = || dataomni_lib::services::ExportOptions {
    format: dataomni_lib::services::ExportFormat::Csv,
    delimiter: ",".to_string(),
    include_header: true,
    null_text: String::new(),
    byte_order_mark: false,
    sql_table: String::new(),
    sql_dialect: None,
    sql_computed_columns: Vec::new(),
    sql_identity_columns: Vec::new(),
  };
  let export = |sql: &'static str| {
    let pool = Arc::clone(&pool);
    let target = target.clone();
    async move {
      dataomni_lib::services::export_query(
        PoolRef::ClickHouse(&pool),
        sql,
        &target,
        options(),
        &mut |_| {},
        &mut || false,
      )
      .await
    }
  };

  // 表数据页导出时点名的那种投影：MATERIALIZED 列要写出来才有值
  let summary =
    export("SELECT `id`, `big`, `cents`, `note`, `raw`, `doubled` FROM smoke_export ORDER BY id")
      .await
      .expect("export");
  assert_eq!(summary.rows_written, 2);
  assert_eq!(
    std::fs::read_to_string(&target).expect("read back"),
    "id,big,cents,note,raw,doubled\n1,18446744073709551615,10.50,\"甲,乙\",0xff00,2\n2,7,3.00,,x,4"
  );

  let summary = export("SELECT number FROM numbers(100000)").await.expect("stream");
  assert_eq!(summary.rows_written, 100000);

  let error = export("ALTER TABLE smoke_export DELETE WHERE 1").await.expect_err("refused");
  assert_eq!(error.message, dataomni_lib::services::query_executor::NON_QUERY_MESSAGE);
  let left = pool.select("SELECT count() AS n FROM smoke_export", &[]).await.expect("count");
  assert_eq!(left[0]["n"], json!(2), "拒绝导出时语句一次都没发出去");

  let error = export("SELECT * FROM smoke_no_such_table").await.expect_err("bad sql");
  assert_eq!(error.code.as_deref(), Some("60"), "{error:?}");
  std::fs::remove_dir_all(&dir).ok();
  run(&mut connection, "DROP TABLE smoke_export SYNC").await;
}

/// 经 SSH 隧道：和 Elasticsearch 同一段 `http_endpoint`，地址是 IP 时直接改写成本地端口，
/// 是域名时经 `resolve` 落到本地端口、证书仍按原名校验。两种各连一次。
///
/// 另要 `DATAOMNI_SSH_TUNNEL_HOST` / `_USER` / `_KEY`（同 `ssh_tunnel_smoke.rs`）和
/// `DATAOMNI_CLICKHOUSE_TUNNEL_PORT`：从跳板机看过去 ClickHouse 在 127.0.0.1 的哪个端口。
/// 那个地址在**本机**也要直连不到——本机要是正好开着一条转发到同一个端口（跑别的用例时
/// 手工开的那种），代码没把地址改指本地端口也照样连得上，这条就成了假绿（反向验证时撞上过）。
/// 所以每种写法先断言直连不到，主连接串用别的本地端口转发
#[tokio::test]
async fn clickhouse_connects_through_an_ssh_tunnel() {
  use dataomni_lib::models::{SshAuthMethod, SshTunnelConfig};
  use dataomni_lib::services::ssh_tunnel;
  let Some(base) = profile_from_env() else { return };
  let variable = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
  let (Some(host), Some(user), Some(key), Some(port)) = (
    variable("DATAOMNI_SSH_TUNNEL_HOST"),
    variable("DATAOMNI_SSH_TUNNEL_USER"),
    variable("DATAOMNI_SSH_TUNNEL_KEY"),
    variable("DATAOMNI_CLICKHOUSE_TUNNEL_PORT"),
  ) else {
    return;
  };
  let port: u16 = port.parse().expect("tunnel port");
  #[allow(deprecated)]
  let known_hosts = std::env::home_dir().expect("home").join(".ssh").join("known_hosts");
  // 域名选一个本机解析不出来的：写 `localhost` 的话，没有 `resolve` 也照样落到 127.0.0.1，
  // 证明不了它（反向验证时撞上过）。转发目标另写 127.0.0.1——「从跳板机看过去不是同一个
  // 地址」正是这种填法
  for (remote_host, forward_to) in
    [("127.0.0.1", None), ("clickhouse.dataomni.invalid", Some("127.0.0.1"))]
  {
    let mut target = base.clone();
    target.host = remote_host.to_string();
    target.port = port;
    target.database = None;
    let direct = tokio::time::timeout(
      Duration::from_secs(10),
      clickhouse::connect(ClickHouseTarget::from_profile(&target, None)),
    )
    .await;
    assert!(
      !matches!(direct, Ok(Ok(_))),
      "{remote_host}:{port} 在本机直连得上（开着一条转发？），这条证明不了隧道"
    );
    let tunnel = SshTunnelConfig {
      host: host.clone(),
      port: 22,
      username: user.clone(),
      private_key_path: key.clone(),
      auth: SshAuthMethod::PrivateKey,
      secret: String::new(),
      secret_ref: None,
      remote_host: forward_to.map(str::to_string),
      remote_port: forward_to.map(|_| port),
    };
    target.ssh_tunnel = Some(tunnel.clone());
    let opened = ssh_tunnel::open(&target, &tunnel, &known_hosts).await.expect("tunnel");
    let pool =
      clickhouse::connect(ClickHouseTarget::from_profile(&target, Some(opened.local_port)))
        .await
        .unwrap_or_else(|error| panic!("{remote_host}: {error}"));
    let rows = pool.select("SELECT 1 AS one", &[]).await.expect("select through the tunnel");
    assert_eq!(rows[0]["one"], json!(1), "{remote_host}");
  }
  // 直连同一个地址（跳板机的公网地址）是连不上的：否则上面那两次证明不了隧道
  let mut direct = base.clone();
  direct.host = host.clone();
  direct.port = port;
  let refused = tokio::time::timeout(
    Duration::from_secs(20),
    clickhouse::connect(ClickHouseTarget::from_profile(&direct, None)),
  )
  .await;
  assert!(!matches!(refused, Ok(Ok(_))), "{host}:{port} 直连得上，这条证明不了隧道");
}
