//! DuckDB 的真库用例。
//!
//! 和另外几家不同，这些用例**每次都跑**：DuckDB 是编进来的，库就是临时目录里的
//! 一个文件，不需要服务器、不需要连接串。每条用例用自己的文件，互不干扰。

use dataomni_lib::services::duckdb::{self, DuckDbPool};
use dataomni_lib::services::{
  PoolRef, QueryError, QueryExecutionResult, QueryExecutionSummary, QueryRow, QuerySessionState,
  QueryTruncationReason, SessionConnection, StreamOptions, StreamingQueryOptions,
  TransactionStatus, QUERY_TIMEOUT_CODE,
};
use serde_json::{json, Value as JsonValue};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 这条用例自己的库文件。先删掉上一次留下的（连同 WAL）
fn database_file(name: &str) -> PathBuf {
  let path =
    std::env::temp_dir().join(format!("dataomni-duckdb-{name}-{}.duckdb", std::process::id()));
  let _ = std::fs::remove_file(&path);
  let _ = std::fs::remove_file(path.with_extension("duckdb.wal"));
  path
}

async fn pool(name: &str) -> Arc<DuckDbPool> {
  let path = database_file(name);
  duckdb::open(&path.to_string_lossy()).await.expect("open DuckDB file")
}

async fn session(pool: &Arc<DuckDbPool>) -> SessionConnection {
  SessionConnection::acquire(PoolRef::DuckDb(pool)).await.expect("session connection")
}

fn rows_of(result: QueryExecutionResult) -> Vec<QueryRow> {
  match result {
    QueryExecutionResult::Rows { rows, .. } => rows,
    QueryExecutionResult::Affected { rows_affected } => {
      panic!("expected rows, got {rows_affected} affected")
    }
  }
}

/// 带类型标签的值的文本；裸值原样
fn text(value: &JsonValue) -> String {
  match value {
    JsonValue::Object(map) => {
      map.get("value").and_then(JsonValue::as_str).unwrap_or("").to_string()
    }
    JsonValue::String(text) => text.clone(),
    other => other.to_string(),
  }
}

fn kind(value: &JsonValue) -> &str {
  value.get("type").and_then(JsonValue::as_str).unwrap_or("")
}

async fn run_all(pool: &Arc<DuckDbPool>, statements: &[&str]) {
  let mut connection = session(pool).await;
  for statement in statements {
    connection
      .execute(statement, 10)
      .await
      .unwrap_or_else(|error| panic!("{statement}: {error:?}"));
  }
}

#[tokio::test]
async fn duckdb_decodes_values_the_way_the_other_dialects_do() {
  let pool = pool("types").await;
  let mut connection = session(&pool).await;
  let rows = rows_of(
    connection
      .execute(
        "SELECT 1::TINYINT AS tiny, 9007199254740993::BIGINT AS big, \
          170141183460469231731687303715884105727::HUGEINT AS huge, 10.50::DECIMAL(10,2) AS money, \
          1.5::DOUBLE AS dbl, 'nan'::DOUBLE AS nan, DATE '2026-09-26' AS d, \
          TIME '07:04:05.120' AS t, TIMESTAMP '2026-09-26 07:04:05.123456' AS ts, \
          TIMESTAMPTZ '2026-09-26 07:04:05+08' AS tstz, INTERVAL '1 year 2 days 03:04:05' AS iv, \
          '\\xAA\\x01'::BLOB AS b, '中文' AS s, true AS flag, NULL::INTEGER AS nothing, \
          [1, 2, NULL] AS list, {'a': 1, 'b': 'x'} AS st, MAP {'k': 1} AS m, \
          'ok'::ENUM('ok', 'no') AS e, '00000000-0000-0000-0000-000000000001'::UUID AS u, \
          '{\"a\":1}'::JSON AS j, BITSTRING '0101' AS bits, 'infinity'::DATE AS forever, \
          0.1::FLOAT AS narrow, [0.1::FLOAT] AS narrow_list",
        10,
      )
      .await
      .expect("select"),
  );
  let row = &rows[0];
  assert_eq!(row["tiny"], json!(1));
  assert_eq!((kind(&row["big"]), text(&row["big"]).as_str()), ("bigint", "9007199254740993"));
  assert_eq!(text(&row["huge"]), "170141183460469231731687303715884105727");
  assert_eq!((kind(&row["money"]), text(&row["money"]).as_str()), ("decimal", "10.50"));
  assert_eq!(row["dbl"], json!(1.5));
  assert_eq!(row["nan"], json!("NaN"));
  assert_eq!((kind(&row["d"]), text(&row["d"]).as_str()), ("date", "2026-09-26"));
  assert_eq!(text(&row["t"]), "07:04:05.12");
  assert_eq!(text(&row["ts"]), "2026-09-26 07:04:05.123456");
  assert_eq!(text(&row["tstz"]), "2026-09-25 23:04:05+00", "不编 ICU，带时区的按 UTC 显示");
  assert_eq!(text(&row["iv"]), "1 year 2 days 03:04:05");
  assert_eq!((kind(&row["b"]), text(&row["b"]).as_str()), ("binary", "aa01"));
  assert_eq!(row["s"], json!("中文"));
  assert_eq!(row["flag"], json!(true));
  assert_eq!(row["nothing"], JsonValue::Null);
  assert_eq!((kind(&row["list"]), text(&row["list"]).as_str()), ("json", "[1,2,null]"));
  assert_eq!(text(&row["st"]), r#"{"a":1,"b":"x"}"#);
  assert_eq!(row["m"], json!("{k=1}"), "MAP 按 DuckDB 的写法：填回去转得回列的类型");
  assert_eq!(row["e"], json!("ok"));
  assert_eq!(row["u"], json!("00000000-0000-0000-0000-000000000001"));
  assert_eq!(row["j"], json!(r#"{"a":1}"#));
  assert_eq!(row["bits"], json!("0101"));
  assert_eq!(text(&row["forever"]), "infinity");
  // 单精度照 DuckDB 自己的写法，不是放宽成 f64 之后的 0.10000000149011612
  assert_eq!(row["narrow"], json!(0.1));
  assert_eq!(text(&row["narrow_list"]), "[0.1]");
}

#[tokio::test]
async fn duckdb_errors_carry_the_category_and_position_and_the_session_survives() {
  let pool = pool("errors").await;
  let mut connection = session(&pool).await;

  let error =
    connection.execute("SELECT * FROM no_such_table", 10).await.expect_err("missing table");
  assert_eq!(error.code.as_deref(), Some("Catalog Error"), "{error:?}");
  assert_eq!(error.details.as_ref().and_then(|details| details.position), Some(15));

  let error = connection
    .execute("SELECT 1,\n  2,\n  nosuch\nFROM range(1)", 10)
    .await
    .expect_err("missing column");
  assert_eq!(error.code.as_deref(), Some("Binder Error"));
  assert_eq!(error.details.as_ref().and_then(|details| details.position), Some(18), "第三行的 n");

  // 编辑器给每条语句补了分号
  let rows = rows_of(connection.execute("SELECT 'alive' AS s;", 10).await.expect("alive"));
  assert_eq!(rows[0]["s"], json!("alive"));
}

#[tokio::test]
async fn duckdb_streams_and_stops_at_the_row_limit_without_computing_the_rest() {
  let pool = pool("limit").await;
  let mut connection = session(&pool).await;
  let mut rows = Vec::new();
  let started = Instant::now();
  // 十亿行：客户端物化的话这一条要跑很久、吃掉几个 GB
  let summary = connection
    .execute_streaming(
      "SELECT i, i * 2 AS d FROM range(1000000000) t(i)",
      StreamOptions::limited(100, 16 * 1024 * 1024, 40),
      &mut |batch| {
        rows.extend(batch.rows);
        Ok(())
      },
    )
    .await
    .expect("stream");
  assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
  assert_eq!(rows.len(), 100);
  match summary {
    QueryExecutionSummary::Rows { truncation_reason, .. } => {
      assert_eq!(truncation_reason, Some(QueryTruncationReason::RowLimit))
    }
    other => panic!("expected rows: {other:?}"),
  }
  let again = rows_of(connection.execute("SELECT 1 AS one", 10).await.expect("again"));
  assert_eq!(again[0]["one"], json!(1));
}

#[tokio::test]
async fn duckdb_tells_statements_that_change_things_from_queries() {
  let pool = pool("kinds").await;
  let mut connection = session(&pool).await;
  let affected = |result: QueryExecutionResult| match result {
    QueryExecutionResult::Affected { rows_affected } => rows_affected,
    QueryExecutionResult::Rows { columns, .. } => panic!("expected affected, got rows {columns:?}"),
  };
  assert_eq!(affected(connection.execute("CREATE TABLE t (x INTEGER)", 10).await.expect("ddl")), 0);
  assert_eq!(
    affected(connection.execute("INSERT INTO t VALUES (1), (2)", 10).await.expect("insert")),
    2
  );
  assert_eq!(affected(connection.execute("UPDATE t SET x = x + 1", 10).await.expect("update")), 2);
  assert_eq!(affected(connection.execute("SET threads = 2", 10).await.expect("set")), 0);
  // 带 RETURNING 的是查询；SHOW、DESCRIBE、省掉 SELECT 的 FROM 也是
  let returned = rows_of(
    connection.execute("INSERT INTO t VALUES (9) RETURNING x", 10).await.expect("returning"),
  );
  assert_eq!(returned[0]["x"], json!(9));
  assert_eq!(
    rows_of(connection.execute("SHOW TABLES", 10).await.expect("show"))[0]["name"],
    json!("t")
  );
  assert_eq!(rows_of(connection.execute("FROM t ORDER BY x", 10).await.expect("from")).len(), 3);
  assert_eq!(
    affected(connection.execute("DELETE FROM t WHERE x > 2", 10).await.expect("delete")),
    2
  );
}

/// 超时要让那条语句真的停下，而且会话还是那条连接：事务、`SET` 都还在
#[tokio::test]
async fn duckdb_timeout_interrupts_the_statement_and_keeps_the_session() {
  let pool = pool("timeout").await;
  let sessions = QuerySessionState::default();
  let options = |sql, timeout| StreamingQueryOptions {
    session_id: "duckdb-timeout",
    pool_key: "duckdb:smoke",
    pool: PoolRef::DuckDb(&pool),
    sql,
    autocommit: true,
    explain_plan: false,
    row_limit: 10,
    byte_limit: 16 * 1024 * 1024,
    batch_size: 10,
    timeout_duration: timeout,
  };
  let run = |sql: &'static str| {
    let sessions = &sessions;
    let options = &options;
    async move {
      let mut rows = Vec::new();
      sessions
        .execute_streaming(options(sql, Duration::from_secs(20)), &mut |batch| {
          rows.extend(batch.rows);
          Ok(())
        })
        .await
        .unwrap_or_else(|error| panic!("{sql}: {error:?}"));
      rows
    }
  };

  run("SET VARIABLE marker = 'still here'").await;
  let started = Instant::now();
  let error = sessions
    .execute_streaming(
      options(
        "SELECT count(*) FROM range(1000000000) a(x) WHERE x % 7 = 3",
        Duration::from_millis(800),
      ),
      &mut |_| Ok(()),
    )
    .await
    .expect_err("times out");
  assert_eq!(error.code.as_deref(), Some(QUERY_TIMEOUT_CODE));

  // 被打断的那条要让出连接：下一条不该等它把十亿行数完
  // 设上限而不是干等：不打断的话它会一直等下去，用例卡住而不是变红
  let rows =
    tokio::time::timeout(Duration::from_secs(5), run("SELECT getvariable('marker') AS marker"))
      .await
      .unwrap_or_else(|_| panic!("被打断的那条没有让出连接（{:?}）", started.elapsed()));
  assert_eq!(rows[0]["marker"], json!("still here"), "还是同一条连接");
}

async fn run_in(
  sessions: &QuerySessionState,
  pool: &Arc<DuckDbPool>,
  session_id: &str,
  sql: &str,
  autocommit: bool,
) -> Result<(), QueryError> {
  let options = StreamingQueryOptions {
    session_id,
    pool_key: "duckdb:smoke",
    pool: PoolRef::DuckDb(pool),
    sql,
    autocommit,
    explain_plan: false,
    row_limit: 100,
    byte_limit: 16 * 1024 * 1024,
    batch_size: 100,
    timeout_duration: Duration::from_secs(20),
  };
  sessions.execute_streaming(options, &mut |_| Ok(())).await.map(|_| ())
}

/// 事务语义和 PostgreSQL 一样：一条出错，整个事务废了，只能回滚
#[tokio::test]
async fn duckdb_session_transactions_abort_on_error_like_postgres() {
  let pool = pool("transactions").await;
  run_all(
    &pool,
    &["CREATE TABLE w (id INTEGER PRIMARY KEY, note VARCHAR)", "INSERT INTO w VALUES (1, 'a')"],
  )
  .await;
  let sessions = QuerySessionState::default();
  let id = "duckdb-transaction";
  let run = |sql, autocommit| run_in(&sessions, &pool, id, sql, autocommit);

  run("UPDATE w SET note = 'b' WHERE id = 1", false).await.expect("update in a transaction");
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Active);
  run("INSERT INTO w VALUES (1, 'dup')", false).await.expect_err("duplicate key");
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Failed);
  let error = run("SELECT 1", false).await.expect_err("aborted transaction");
  assert!(error.message.contains("ROLLBACK"), "{error:?}");
  run("ROLLBACK", true).await.expect("rollback");
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Idle);

  let notes = pool.select("SELECT note FROM w", &[]).await.expect("notes");
  assert_eq!(notes[0]["note"], json!("a"), "回滚把那条 UPDATE 也撤掉了");

  // DDL 在事务里，能回滚
  run("DROP TABLE w", false).await.expect("drop in a transaction");
  run("ROLLBACK", true).await.expect("rollback drop");
  assert_eq!(
    pool.select("SELECT count(*) AS n FROM w", &[]).await.expect("still there")[0]["n"],
    json!(1)
  );
}

#[tokio::test]
async fn duckdb_write_batches_check_row_counts_and_roll_back_as_a_whole() {
  use dataomni_lib::services::{WriteStatement, ROW_COUNT_MISMATCH_CODE};
  let pool = pool("writes").await;
  run_all(
    &pool,
    &[
      "CREATE TABLE w (id INTEGER PRIMARY KEY, note VARCHAR)",
      "INSERT INTO w VALUES (1, 'a'), (2, 'b')",
    ],
  )
  .await;
  let write = |sql: &str, params: Vec<JsonValue>, expect_rows: Option<u64>| {
    serde_json::from_value::<WriteStatement>(
      json!({ "sql": sql, "params": params, "expectRows": expect_rows }),
    )
    .expect("statement")
  };

  let affected = pool
    .write_batch(&[
      write("UPDATE w SET note = $1 WHERE id = $2", vec![json!("x"), json!(1)], Some(1)),
      write("DELETE FROM w WHERE id = $1", vec![json!(2)], Some(1)),
    ])
    .await
    .expect("batch");
  assert_eq!(affected, vec![1, 1]);

  // 第二条对不上行数：第一条也要撤掉
  let error = pool
    .write_batch(&[
      write("UPDATE w SET note = $1 WHERE id = $2", vec![json!("y"), json!(1)], Some(1)),
      write("DELETE FROM w WHERE id = $1", vec![json!(99)], Some(1)),
    ])
    .await
    .expect_err("row count mismatch");
  assert_eq!(error.statement_index, 1);
  assert_eq!(error.error.code.as_deref(), Some(ROW_COUNT_MISMATCH_CODE));
  let notes = pool.select("SELECT id, note FROM w ORDER BY id", &[]).await.expect("notes");
  assert_eq!(notes.len(), 1);
  assert_eq!(notes[0]["note"], json!("x"));
}

/// 表格里改一格，值以文本绑定（界面给的就是显示出来的那串字），由 DuckDB 转成列的
/// 类型；并发守卫拿原值去比，同样是文本。每种类型都要能原样转回去——转不回去的话
/// 那一格改不了，或者每次提交都报「没有恰好影响一行」
#[tokio::test]
async fn duckdb_writes_bind_displayed_text_into_every_column_type() {
  use dataomni_lib::services::WriteStatement;
  let pool = pool("casts").await;
  run_all(
    &pool,
    &[
      "CREATE TABLE t (id INTEGER PRIMARY KEY, i INTEGER, d DECIMAL(10,2), ts TIMESTAMP, \
        tz TIMESTAMPTZ, dt DATE, tm TIME, b BOOLEAN, u UUID, e ENUM('ok', 'no'), l INTEGER[], \
        st STRUCT(a INTEGER, b VARCHAR), m MAP(VARCHAR, INTEGER), j JSON, h HUGEINT, iv INTERVAL, \
        bl BLOB, un UNION(n INTEGER, t VARCHAR))",
      "INSERT INTO t (id) VALUES (1)",
    ],
  )
  .await;
  let mut connection = session(&pool).await;
  // 二进制走表达式（`binaryLiteral`）：`from_hex` 存进去的是那两个字节，不是那串字
  connection.execute("UPDATE t SET bl = from_hex('aa01') WHERE id = 1", 1).await.expect("blob");
  let blob = rows_of(
    connection.execute("SELECT bl, octet_length(bl) AS n FROM t", 1).await.expect("blob back"),
  );
  assert_eq!((text(&blob[0]["bl"]), blob[0]["n"].clone()), ("aa01".to_string(), json!(2)));
  for (column, value) in [
    ("i", json!("42")),
    ("d", json!("10.50")),
    ("ts", json!("2026-09-26 07:04:05.123456")),
    ("tz", json!("2026-09-25 23:04:05+00")),
    ("dt", json!("2026-09-26")),
    ("tm", json!("07:04:05.12")),
    ("b", json!(true)),
    ("u", json!("00000000-0000-0000-0000-000000000001")),
    ("e", json!("ok")),
    ("l", json!("[1,2,null]")),
    ("st", json!(r#"{"a":1,"b":"x"}"#)),
    ("m", json!("{k=1}")),
    ("j", json!(r#"{"a":1}"#)),
    ("h", json!("170141183460469231731687303715884105727")),
    ("iv", json!("1 year 2 days 03:04:05")),
    // 显示成 JSON 的 `"hi"` 填回去，库里存的就是带引号的那五个字
    ("un", json!("hi")),
  ] {
    let write = |sql: String, params: Vec<JsonValue>| {
      serde_json::from_value::<WriteStatement>(
        json!({ "sql": sql, "params": params, "expectRows": 1 }),
      )
      .expect("statement")
    };
    pool
      .write_batch(&[write(
        format!("UPDATE t SET {column} = ? WHERE id = ?"),
        vec![value.clone(), json!(1)],
      )])
      .await
      .unwrap_or_else(|error| panic!("{column} = {value}: {:?}", error.error));
    // 读回来显示的那串字，要能再原样比中
    let shown =
      rows_of(connection.execute(&format!("SELECT {column} FROM t"), 1).await.expect("read back"));
    let shown = match &shown[0][column] {
      JsonValue::Bool(flag) => json!(flag),
      other => json!(text(other)),
    };
    pool
      .write_batch(&[write(
        format!("UPDATE t SET id = 1 WHERE id = ? AND {column} = ?"),
        vec![json!(1), shown.clone()],
      )])
      .await
      .unwrap_or_else(|error| panic!("{column} 显示成 {shown} 比不中: {:?}", error.error));
  }
}

// ---------------------------------------------------------------------------
// 目录查询。夹具里放的是会咬人的那几样：复合主键、复合外键、表达式索引、带空格与
// 关键字的名字、计算列、带注释的列、视图、序列、宏（含表宏）。
// ---------------------------------------------------------------------------

const FIXTURE: &[&str] = &[
  "CREATE SCHEMA sales",
  "CREATE TYPE mood AS ENUM ('ok', 'sad')",
  "CREATE SEQUENCE seq_id START 10 INCREMENT BY 3",
  "CREATE TABLE sales.parent (a INTEGER, b VARCHAR, PRIMARY KEY (a, b))",
  "CREATE TABLE sales.child (id INTEGER PRIMARY KEY DEFAULT nextval('seq_id'), \
    pa INTEGER NOT NULL, pb VARCHAR, email VARCHAR UNIQUE, \
    price DECIMAL(10,2) DEFAULT 0 CHECK (price >= 0), m mood, \
    twice INTEGER GENERATED ALWAYS AS (pa * 2) VIRTUAL, note VARCHAR, \
    FOREIGN KEY (pa, pb) REFERENCES sales.parent (a, b))",
  "COMMENT ON COLUMN sales.child.note IS '备注'",
  "CREATE INDEX child_note ON sales.child (note, pa)",
  "CREATE UNIQUE INDEX child_expr ON sales.child ((lower(email)))",
  "CREATE TABLE sales.\"odd name\" (\"my col\" INTEGER, \"x y\" INTEGER GENERATED ALWAYS AS (\"my col\" + 1), \"select\" VARCHAR)",
  "CREATE INDEX odd_idx ON sales.\"odd name\" (\"my col\", \"select\")",
  "CREATE VIEW sales.v AS SELECT id, price FROM sales.child",
  "CREATE MACRO add1(x) AS x + 1",
  "CREATE MACRO tbl(n) AS TABLE SELECT * FROM range(n)",
];

fn find<'a>(rows: &'a [QueryRow], column: &str, value: &str) -> Vec<&'a QueryRow> {
  rows.iter().filter(|row| text(&row[column]) == value).collect()
}

#[tokio::test]
async fn duckdb_catalog_queries_describe_the_fixture() {
  use dataomni_lib::models::DatabaseType;
  use dataomni_lib::services::{
    completion_catalog_query, er_diagram_queries, object_catalog_queries, schema_metadata_queries,
    session_target_query, DdlQuery,
  };
  let pool = pool("catalog").await;
  run_all(&pool, FIXTURE).await;
  let queries = schema_metadata_queries(&DatabaseType::DuckDB).expect("DuckDB catalog");
  let params = |table: &str| vec![json!(table), json!("sales")];

  let columns = pool.select(queries.columns, &params("child")).await.expect("columns");
  let names: Vec<String> = columns.iter().map(|row| text(&row["column_name"])).collect();
  assert_eq!(names, ["id", "pa", "pb", "email", "price", "m", "twice", "note"]);
  let by_name = |name: &str| find(&columns, "column_name", name)[0].clone();
  assert_eq!(by_name("id")["is_primary_key"], json!(true));
  assert_eq!(by_name("id")["primary_key_ordinal"], json!(1));
  assert_eq!(text(&by_name("id")["column_default"]), "nextval('seq_id')");
  assert_eq!(by_name("twice")["is_generated"], json!(true), "计算列");
  assert_eq!(by_name("twice")["column_default"], JsonValue::Null, "计算列的表达式不是默认值");
  assert_eq!(by_name("pa")["is_generated"], json!(false));
  assert_eq!(by_name("pa")["is_nullable"], json!(false));
  assert_eq!(text(&by_name("price")["data_type"]), "DECIMAL(10,2)");
  assert_eq!(text(&by_name("m")["data_type"]), "ENUM('ok', 'sad')");
  assert_eq!(text(&by_name("note")["comment"]), "备注");

  let odd = pool.select(queries.columns, &params("odd name")).await.expect("odd columns");
  let generated: Vec<(String, JsonValue)> =
    odd.iter().map(|row| (text(&row["column_name"]), row["is_generated"].clone())).collect();
  assert_eq!(
    generated,
    [("my col".into(), json!(false)), ("x y".into(), json!(true)), ("select".into(), json!(false))],
    "带空格、带引号的列名也认得出计算列"
  );
  // DuckDB 的名字带不带引号都不分大小写：编辑器里写 `FROM Sales.CHILD` 也是这张表
  let shouting =
    pool.select(queries.columns, &[json!("CHILD"), json!("Sales")]).await.expect("upper");
  assert_eq!(shouting.len(), 8, "大写的名字也该查到同一张表");
  // 不给 schema 就是当前 schema（main），sales 里的表查不到
  assert!(pool
    .select(queries.columns, &[json!("child"), JsonValue::Null])
    .await
    .expect("main")
    .is_empty());

  let parent = pool.select(queries.columns, &params("parent")).await.expect("parent columns");
  let keys: Vec<(String, JsonValue)> = parent
    .iter()
    .map(|row| (text(&row["column_name"]), row["primary_key_ordinal"].clone()))
    .collect();
  assert_eq!(keys, [("a".to_string(), json!(1)), ("b".to_string(), json!(2))]);

  let indexes = pool.select(queries.indexes, &params("child")).await.expect("indexes");
  let pairs: Vec<(String, String, JsonValue)> = indexes
    .iter()
    .map(|row| (text(&row["index_name"]), text(&row["column_name"]), row["is_unique"].clone()))
    .collect();
  assert_eq!(
    pairs,
    [
      ("child_email_key".into(), "email".into(), json!(true)),
      ("child_expr".into(), "(lower(email))".into(), json!(true)),
      ("child_id_pkey".into(), "id".into(), json!(true)),
      ("child_note".into(), "note".into(), json!(false)),
      ("child_note".into(), "pa".into(), json!(false)),
    ]
  );
  assert_eq!(find(&indexes, "index_name", "child_id_pkey")[0]["is_primary"], json!(true));
  let odd_index = pool.select(queries.indexes, &params("odd name")).await.expect("odd index");
  let odd_columns: Vec<String> = odd_index.iter().map(|row| text(&row["column_name"])).collect();
  assert_eq!(odd_columns, ["my col", "select"], "带引号的名字去掉两层引号");

  let foreign_keys = pool.select(queries.foreign_keys, &params("child")).await.expect("fks");
  let pairs: Vec<(String, String, String)> = foreign_keys
    .iter()
    .map(|row| {
      (text(&row["column_name"]), text(&row["referenced_table"]), text(&row["referenced_column"]))
    })
    .collect();
  assert_eq!(
    pairs,
    [("pa".into(), "parent".into(), "a".into()), ("pb".into(), "parent".into(), "b".into())]
  );
  assert_eq!(text(&foreign_keys[0]["referenced_schema"]), "sales");

  let checks = pool
    .select(queries.check_constraints.expect("checks"), &params("child"))
    .await
    .expect("checks");
  assert_eq!(checks.len(), 1);
  assert_eq!(text(&checks[0]["expression"]), "(price >= 0)");

  let Some(DdlQuery::Bound { sql: ddl }) = queries.ddl else {
    panic!("DuckDB 的定义走绑定参数")
  };
  let ddl_rows = pool.select(ddl, &params("child")).await.expect("ddl");
  let statements: Vec<String> = ddl_rows.iter().map(|row| text(&row["sql"])).collect();
  assert!(statements[0].starts_with("CREATE TABLE sales.child("), "{statements:?}");
  assert_eq!(statements.len(), 3, "建表之后是两条 CREATE INDEX: {statements:?}");
  let view = pool.select(ddl, &params("v")).await.expect("view ddl");
  assert!(text(&view[0]["sql"]).starts_with("CREATE VIEW sales.v AS"));
  assert!(pool.select(queries.triggers, &params("child")).await.expect("triggers").is_empty());

  let objects = object_catalog_queries(&DatabaseType::DuckDB).expect("objects");
  let listed = pool.select(objects.objects, &[]).await.expect("object list");
  let kind_of =
    |name: &str| find(&listed, "object_name", name).first().map(|row| text(&row["object_kind"]));
  assert_eq!(kind_of("child").as_deref(), Some("table"));
  assert_eq!(kind_of("odd name").as_deref(), Some("table"));
  assert_eq!(kind_of("v").as_deref(), Some("view"));
  assert_eq!(kind_of("seq_id").as_deref(), Some("sequence"));
  assert_eq!(kind_of("add1").as_deref(), Some("function"));
  assert_eq!(kind_of("tbl").as_deref(), Some("function"));
  assert!(find(&listed, "object_schema", "information_schema").is_empty(), "系统 schema 不列");
  let routine =
    pool.select(objects.routine_definition, &[json!("main.tbl")]).await.expect("routine");
  assert_eq!(
    text(&routine[0]["definition"]),
    "CREATE MACRO main.tbl(n) AS TABLE SELECT * FROM \"range\"(n)"
  );
  let sequence = pool
    .select(objects.sequence_properties.expect("sequences"), &[json!("main.seq_id")])
    .await
    .expect("sequence");
  assert_eq!(
    (text(&sequence[0]["start_value"]), text(&sequence[0]["increment_by"])),
    ("10".into(), "3".into())
  );

  let er = er_diagram_queries(&DatabaseType::DuckDB).expect("er");
  let er_columns = pool.select(er.columns, &[]).await.expect("er columns");
  assert!(!find(&er_columns, "table_name", "child").is_empty());
  assert!(find(&er_columns, "table_name", "v").is_empty(), "ER 图不画视图");
  let er_keys = pool.select(er.foreign_keys, &[]).await.expect("er fks");
  assert_eq!(er_keys.len(), 2);

  let completion = completion_catalog_query(&DatabaseType::DuckDB).expect("completion");
  let relations = pool.select(completion.relations, &[]).await.expect("relations");
  assert_eq!(text(&find(&relations, "relation_name", "v")[0]["relation_kind"]), "view");
  assert_eq!(text(&find(&relations, "relation_name", "child")[0]["relation_kind"]), "table");

  let target = session_target_query(&DatabaseType::DuckDB).expect("target");
  let where_am_i = pool.select(target.sql, &[]).await.expect("target");
  assert_eq!(text(&where_am_i[0]["schema_name"]), "main");
  assert_eq!(where_am_i[0]["read_only"], json!(false));
}

#[tokio::test]
async fn duckdb_explain_reads_the_json_plan() {
  use dataomni_lib::models::DatabaseType;
  use dataomni_lib::services::{explain_statement, parse_plan};
  let pool = pool("explain").await;
  run_all(&pool, FIXTURE).await;
  let statement = explain_statement(
    &DatabaseType::DuckDB,
    "SELECT c.id FROM sales.child c JOIN sales.parent p ON p.a = c.pa ORDER BY c.id LIMIT 5",
    false,
  )
  .expect("statement");
  let mut connection = session(&pool).await;
  let mut rows = Vec::new();
  connection
    .execute_streaming(
      &statement,
      StreamOptions::limited(100, 16 * 1024 * 1024, 100).for_explain(),
      &mut |batch| {
        rows.extend(batch.rows);
        Ok(())
      },
    )
    .await
    .expect("explain");
  let plan = parse_plan(&DatabaseType::DuckDB, &rows, false).expect("plan");
  assert_eq!(plan.roots[0].operation, "TOP_N");
  assert!(!plan.roots[0].children.is_empty());
}

// ---------------------------------------------------------------------------
// 第三阶段：CSV 导入、整表导出
// ---------------------------------------------------------------------------

/// 与 Oracle、SQL Server 那份同一组坏行：转不成整数、不存在的日期、主键冲突、太长、
/// 非空。DuckDB 的 VARCHAR(5) 不查长度，太长那一格靠检查约束
const IMPORT_CSV: &str = "id,n,at,name
1,10,2024-01-01,a
2,abc,2024-01-02,b
3,30,2024-13-45,c
1,40,,d
5,50,,toolong
6,,,f
7,70,2024-02-02 08:30:00,g
";

fn import_request(
  path: &std::path::Path,
  on_error: dataomni_lib::services::ErrorPolicy,
  strategy: dataomni_lib::services::TransactionStrategy,
) -> dataomni_lib::services::ImportRequest {
  let column =
    |source, target: &str, target_type: &str| dataomni_lib::services::csv_import::ImportColumn {
      source,
      target: target.to_string(),
      target_type: target_type.to_string(),
    };
  dataomni_lib::services::ImportRequest {
    path: path.to_string_lossy().to_string(),
    schema: Some("main".into()),
    table: "im".into(),
    csv: dataomni_lib::services::CsvOptions {
      delimiter: ",".into(),
      has_header: true,
      null_text: String::new(),
    },
    columns: vec![
      column(0, "id", "INTEGER"),
      column(1, "n", "INTEGER"),
      column(2, "at", "TIMESTAMP"),
      column(3, "name", "VARCHAR"),
    ],
    batch_size: 3,
    strategy,
    on_error,
  }
}

async fn import_into_fresh_table(
  name: &str,
  on_error: dataomni_lib::services::ErrorPolicy,
  strategy: dataomni_lib::services::TransactionStrategy,
) -> (Arc<DuckDbPool>, Result<dataomni_lib::services::ImportSummary, QueryError>) {
  let pool = pool(name).await;
  run_all(
    &pool,
    &["CREATE TABLE im (id INTEGER PRIMARY KEY, n INTEGER NOT NULL, \"at\" TIMESTAMP, \
       name VARCHAR CHECK (length(name) <= 5))"],
  )
  .await;
  let path =
    std::env::temp_dir().join(format!("dataomni-duckdb-{name}-{}.csv", std::process::id()));
  std::fs::write(&path, IMPORT_CSV).expect("write csv");
  let summary = dataomni_lib::services::import_csv(
    PoolRef::DuckDb(&pool),
    &import_request(&path, on_error, strategy),
    &mut |_| {},
    &mut || false,
    &mut || false,
  )
  .await;
  std::fs::remove_file(&path).ok();
  (pool, summary)
}

async fn imported_ids(pool: &Arc<DuckDbPool>) -> Vec<JsonValue> {
  pool
    .select("SELECT id FROM im ORDER BY id", &[])
    .await
    .expect("read back")
    .iter()
    .map(|row| row["id"].clone())
    .collect()
}

/// DuckDB 没有保存点、一条出错整个事务就废了：分批时整批撤掉再逐行重放，好行留下
#[tokio::test]
async fn duckdb_import_per_batch_skips_the_bad_rows_without_savepoints() {
  use dataomni_lib::services::{ErrorPolicy, TransactionStrategy};
  let (pool, summary) =
    import_into_fresh_table("import-skip", ErrorPolicy::Skip, TransactionStrategy::PerBatch).await;
  let summary = summary.expect("import runs");
  assert!(!summary.rolled_back, "{summary:?}");
  assert_eq!((summary.rows_read, summary.rows_inserted, summary.rows_failed), (7, 2, 5));
  assert_eq!(imported_ids(&pool).await, [json!(1), json!(7)]);
  let by_line = |line: u64| {
    summary.errors.iter().find(|error| error.line == line).map(|error| error.message.clone())
  };
  for (line, fragment) in [
    (3, "Could not convert string 'abc'"),
    (4, "timestamp field value out of range"),
    (5, "violates primary key constraint"),
    (6, "CHECK constraint failed"),
    (7, "NOT NULL constraint failed"),
  ] {
    assert!(by_line(line).is_some_and(|m| m.contains(fragment)), "{line}: {:?}", by_line(line));
  }
}

/// 单事务里跳过坏行要靠保存点：开始之前就拒绝，一行都不写
#[tokio::test]
async fn duckdb_import_refuses_to_skip_rows_inside_one_transaction() {
  use dataomni_lib::services::{ErrorPolicy, TransactionStrategy};
  let (pool, summary) = import_into_fresh_table(
    "import-single-skip",
    ErrorPolicy::Skip,
    TransactionStrategy::SingleTransaction,
  )
  .await;
  let error = summary.expect_err("refused");
  assert_eq!(error.message, dataomni_lib::services::csv_import::CSV_SKIP_NEEDS_SAVEPOINTS);
  assert!(imported_ids(&pool).await.is_empty());
}

/// 出错即停：两种策略都一行不留，坏行是第 3 行（表头是第 1 行）
#[tokio::test]
async fn duckdb_import_aborts_on_the_first_bad_row_and_names_it() {
  use dataomni_lib::services::{ErrorPolicy, TransactionStrategy};
  for strategy in [TransactionStrategy::SingleTransaction, TransactionStrategy::PerBatch] {
    let (pool, summary) =
      import_into_fresh_table(&format!("import-abort-{strategy:?}"), ErrorPolicy::Abort, strategy)
        .await;
    let summary = summary.expect("import runs");
    assert_eq!(summary.rows_inserted, 0, "{strategy:?}: {summary:?}");
    assert_eq!(summary.errors.len(), 1, "{strategy:?}: {:?}", summary.errors);
    assert_eq!(summary.errors[0].line, 3, "{strategy:?}: {:?}", summary.errors);
    assert!(imported_ids(&pool).await.is_empty(), "{strategy:?}: 第一批里的好行也不该留下");
  }
}

/// 导出把 BLOB 写成 `0x…`，导回来是这几个字节；不像十六进制的文本存它自己的字节
#[tokio::test]
async fn duckdb_import_reads_exported_hex_into_blob() {
  use dataomni_lib::services::{ErrorPolicy, TransactionStrategy};
  let pool = pool("import-blob").await;
  run_all(&pool, &["CREATE TABLE im (id INTEGER, data BLOB)"]).await;
  let path = std::env::temp_dir().join(format!("dataomni-duckdb-blob-{}.csv", std::process::id()));
  std::fs::write(&path, "id,data\n1,0xdeadbeef00\n2,abc\n3,0x\n").expect("write csv");
  let mut request =
    import_request(&path, ErrorPolicy::Abort, TransactionStrategy::SingleTransaction);
  request.columns.truncate(1);
  request.columns.push(dataomni_lib::services::csv_import::ImportColumn {
    source: 1,
    target: "data".into(),
    target_type: "BLOB".into(),
  });
  let summary = dataomni_lib::services::import_csv(
    PoolRef::DuckDb(&pool),
    &request,
    &mut |_| {},
    &mut || false,
    &mut || false,
  )
  .await
  .expect("import runs");
  std::fs::remove_file(&path).ok();
  assert_eq!(summary.rows_failed, 0, "{:?}", summary.errors);
  let stored: Vec<JsonValue> = pool
    .select("SELECT hex(data) AS h FROM im ORDER BY id", &[])
    .await
    .expect("read back")
    .iter()
    .map(|row| row["h"].clone())
    .collect();
  assert_eq!(stored, [json!("DEADBEEF00"), json!("616263"), json!("")]);
}

/// 整表导出：表头在取任何一行之前就位；不返回结果集的语句一行都不执行
#[tokio::test]
async fn duckdb_exports_stream_to_a_file_and_refuse_non_queries_before_running_them() {
  let pool = pool("export").await;
  run_all(
    &pool,
    &["CREATE TABLE w (id INTEGER, name VARCHAR)", "INSERT INTO w VALUES (1, '甲'), (2, '乙')"],
  )
  .await;
  let dir = std::env::temp_dir().join(format!("dataomni-duckdb-export-{}", std::process::id()));
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
  };
  let export = |sql: &'static str| {
    let pool = Arc::clone(&pool);
    let target = target.clone();
    async move {
      dataomni_lib::services::export_query(
        PoolRef::DuckDb(&pool),
        sql,
        &target,
        options(),
        &mut |_| {},
        &mut || false,
      )
      .await
    }
  };

  let summary = export(
    "SELECT a.id, a.name, b.id, a.id * 1.5 AS half FROM w a JOIN w b ON b.id = a.id ORDER BY a.id;",
  )
  .await
  .expect("export");
  assert_eq!(summary.rows_written, 2);
  assert_eq!(
    std::fs::read_to_string(&target).expect("read back"),
    "id,name,id 2,half\n1,甲,1,1.5\n2,乙,2,3.0"
  );

  let error = export("DELETE FROM w").await.expect_err("refused");
  assert_eq!(error.message, dataomni_lib::services::query_executor::NON_QUERY_MESSAGE);
  assert_eq!(
    pool.select("SELECT count(*) AS n FROM w", &[]).await.expect("count")[0]["n"],
    json!(2)
  );

  let error = export("SELECT * FROM no_such_table").await.expect_err("bad sql");
  assert_eq!(error.code.as_deref(), Some("Catalog Error"), "{error:?}");
  std::fs::remove_dir_all(&dir).ok();
}

// ---------------------------------------------------------------------------
// 改结构与建表、对象级结构操作：跑前端生成的那几条语句（共用语料），跑完读目录核对
// ---------------------------------------------------------------------------

#[path = "support/ddl_corpus.rs"]
mod ddl_corpus;

#[path = "support/object_ddl_corpus.rs"]
mod object_ddl_corpus;

async fn duckdb_catalog_columns(pool: &Arc<DuckDbPool>, table: &str) -> Vec<ddl_corpus::Column> {
  use dataomni_lib::models::DatabaseType;
  use dataomni_lib::services::schema_metadata_queries;
  let queries = schema_metadata_queries(&DatabaseType::DuckDB).expect("DuckDB catalog");
  pool
    .select(queries.columns, &[json!(table), JsonValue::Null])
    .await
    .expect("read column catalog")
    .iter()
    .map(|row| ddl_corpus::Column {
      name: text(&row["column_name"]),
      data_type: text(&row["data_type"]),
      nullable: row["is_nullable"] == json!(true),
      primary_key_ordinal: row["primary_key_ordinal"].as_i64(),
      default_value: row["column_default"].as_str().map(str::to_string),
      generated: row["is_generated"] == json!(true),
      collation: row["collation"].as_str().map(str::to_string),
      comment: row["comment"].as_str().map(str::to_string),
      extra: row["column_extra"].as_str().map(str::to_string),
    })
    .collect()
}

fn statement(sql: &str) -> dataomni_lib::services::WriteStatement {
  serde_json::from_value(json!({ "sql": sql, "params": [] })).expect("statement")
}

/// 语句走界面上同一条路（`execute_write_batch`，一个事务）：DuckDB 的 DDL 在事务里，
/// 一次改结构的几条语句要么全生效、要么全不生效
#[tokio::test]
async fn duckdb_runs_the_generated_ddl_from_the_shared_corpus() {
  use dataomni_lib::services::execute_write_batch;
  let pool = pool("ddl-corpus").await;
  let cases = ddl_corpus::load("duckdb");
  assert!(!cases.is_empty(), "语料里要有 DuckDB 的用例");
  for case in cases {
    run_all(&pool, &case.fixture.iter().map(String::as_str).collect::<Vec<_>>()).await;
    if !case.origin.is_empty() {
      let origin = duckdb_catalog_columns(&pool, &case.table).await;
      assert_eq!(origin, case.origin, "{}: 语料里的 origin 和数据库给的对不上", case.name);
    }
    let statements: Vec<_> = case.statements.iter().map(|sql| statement(sql)).collect();
    execute_write_batch(PoolRef::DuckDb(&pool), &statements).await.unwrap_or_else(|error| {
      panic!(
        "{}: 生成的语句跑不了（第 {} 条）\n{:?}",
        case.name, error.statement_index, error.error
      )
    });
    run_all(&pool, &case.insert.iter().map(String::as_str).collect::<Vec<_>>()).await;
    let after = duckdb_catalog_columns(&pool, &case.final_table).await;
    assert_eq!(after, case.after, "{}: 跑完之后的表和语料说的不一样", case.name);
    run_all(&pool, &case.cleanup.iter().map(String::as_str).collect::<Vec<_>>()).await;
  }
}

#[tokio::test]
async fn duckdb_runs_the_object_ddl_corpus() {
  use dataomni_lib::services::execute_write_batch;
  let pool = pool("object-ddl-corpus").await;
  let cases = object_ddl_corpus::load("duckdb");
  assert!(!cases.is_empty(), "语料里要有 DuckDB 的用例");
  let current = pool.select("SELECT current_schema() AS s", &[]).await.expect("current schema");
  let current = text(&current[0]["s"]);
  for case in cases {
    if let Some(written) = &case.schema {
      assert_eq!(written, &current, "{}: 语料写死的 schema", case.name);
    }
    run_all(&pool, &case.fixture.iter().map(String::as_str).collect::<Vec<_>>()).await;
    execute_write_batch(PoolRef::DuckDb(&pool), &[statement(&case.statement)])
      .await
      .unwrap_or_else(|error| panic!("{}: 生成的语句跑不了\n{:?}", case.name, error.error));
    let found = pool.select(&case.check, &[]).await.expect("核对查询");
    let found = found[0].values().next().and_then(JsonValue::as_i64);
    assert_eq!(found, Some(case.expect), "{}: 跑完之后的结果和语料说的不一样", case.name);
    run_all(&pool, &case.cleanup.iter().map(String::as_str).collect::<Vec<_>>()).await;
  }
}
