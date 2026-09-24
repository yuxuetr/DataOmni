//! Oracle 的真库用例。
//!
//! 默认静默跳过；要跑就在 shell 里设
//! `DATAOMNI_ORACLE_TEST_URL=oracle://user:password@host:port/service`
//! （**不要写进任何文件**），`DATAOMNI_ORACLE_CLIENT_DIR` 指向一份 Instant Client
//! （`scripts/fetch-oracle-client.sh` 取下来的那个目录），并设
//! `DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS=1` 让缺了连接串的时候报错而不是跳过。

use dataomni_lib::models::ConnectionProfile;
use dataomni_lib::services::oracle::{self, OraclePool, OracleTarget};
use dataomni_lib::services::{
  PoolRef, QueryExecutionResult, QueryRow, QuerySessionState, QueryTruncationReason,
  SessionConnection, StreamOptions, StreamingQueryOptions, QUERY_TIMEOUT_CODE,
};
use serde_json::{json, Value as JsonValue};
use std::sync::Arc;
use std::time::{Duration, Instant};

const URL_ENV: &str = "DATAOMNI_ORACLE_TEST_URL";
const REQUIRE_ENV: &str = "DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS";

/// `oracle://user:password@host:port/service` → 一份连接配置。口令里可能有 `@`，从右边切
fn profile_from_env() -> Option<ConnectionProfile> {
  let url = match std::env::var(URL_ENV) {
    Ok(url) if !url.is_empty() => url,
    _ if std::env::var(REQUIRE_ENV).as_deref() == Ok("1") => {
      panic!("{URL_ENV} must be set when {REQUIRE_ENV}=1")
    }
    _ => return None,
  };
  let rest = url.strip_prefix("oracle://").expect("oracle:// URL");
  let (credentials, address) = rest.rsplit_once('@').expect("user:password@host");
  let (username, password) = credentials.split_once(':').expect("user:password");
  let (host_port, service) = address.split_once('/').expect("host:port/service");
  let (host, port) = host_port.rsplit_once(':').expect("host:port");
  let profile = json!({
    "name": "oracle-smoke",
    "db_type": "oracle",
    "host": host,
    "port": port.parse::<u16>().expect("port"),
    "database": service,
    "username": username,
    "password": password,
    "ssl": false,
    "tls_mode": "disabled",
    "options": {},
    "tags": []
  });
  Some(serde_json::from_value(profile).expect("profile"))
}

async fn pool() -> Option<Arc<OraclePool>> {
  let profile = profile_from_env()?;
  let target = OracleTarget::from_profile(&profile);
  let connection = oracle::connect(&target).await.expect("connect to Oracle");
  Some(OraclePool::new(target, connection))
}

async fn session(pool: &Arc<OraclePool>) -> SessionConnection {
  SessionConnection::acquire(PoolRef::Oracle(pool)).await.expect("session connection")
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

async fn run_all(pool: &Arc<OraclePool>, statements: &[&str]) {
  let mut connection = session(pool).await;
  for statement in statements {
    connection
      .execute(statement, 10)
      .await
      .unwrap_or_else(|error| panic!("{statement}: {error:?}"));
  }
}

/// 建表前先删：`DROP TABLE` 一张不存在的表是 ORA-00942，吞掉
async fn drop_quietly(pool: &Arc<OraclePool>, table: &str) {
  let mut connection = session(pool).await;
  let _ = connection.execute(&format!("DROP TABLE {table} PURGE"), 1).await;
}

#[tokio::test]
async fn oracle_decodes_values_the_way_the_other_dialects_do() {
  let Some(pool) = pool().await else { return };
  drop_quietly(&pool, "dataomni_types").await;
  run_all(
    &pool,
    &[
      "CREATE TABLE dataomni_types (id NUMBER(10) PRIMARY KEY, n10_2 NUMBER(10,2), n NUMBER, \
        big NUMBER(38), bd BINARY_DOUBLE, v VARCHAR2(20), nv NVARCHAR2(20), d DATE, \
        ts TIMESTAMP(6), tstz TIMESTAMP(3) WITH TIME ZONE, c CLOB, b BLOB, r RAW(8), flag BOOLEAN)",
      "INSERT INTO dataomni_types VALUES (1, 10.50, 0.5, 12345678901234567890123456789012345678, \
        1.5, '中文', N'汉字', DATE '2026-09-20', TIMESTAMP '2026-09-20 07:04:05.123456', \
        TIMESTAMP '2026-09-20 07:04:05.123 +08:00', 'clob text', HEXTORAW('DEADBEEF'), \
        HEXTORAW('0102'), TRUE)",
      "INSERT INTO dataomni_types (id, n10_2) VALUES (2, 10)",
    ],
  )
  .await;

  let mut connection = session(&pool).await;
  let rows = rows_of(
    connection.execute("SELECT * FROM dataomni_types ORDER BY id", 10).await.expect("select"),
  );
  let row = &rows[0];
  // Oracle 把未加引号的标识符折成大写，结果列名也是
  assert_eq!(row["ID"], json!(1));
  assert_eq!((kind(&row["N10_2"]), text(&row["N10_2"]).as_str()), ("decimal", "10.50"));
  assert_eq!(text(&rows[1]["N10_2"]), "10.00", "按声明的标度补齐");
  assert_eq!(text(&row["N"]), "0.5", "Oracle 写成 .5，要补前导零");
  assert_eq!(
    (kind(&row["BIG"]), text(&row["BIG"]).as_str()),
    ("bigint", "12345678901234567890123456789012345678")
  );
  assert_eq!(row["BD"], json!(1.5));
  assert_eq!(text(&row["V"]), "中文");
  assert_eq!(text(&row["NV"]), "汉字");
  assert_eq!((kind(&row["D"]), text(&row["D"]).as_str()), ("datetime", "2026-09-20 00:00:00"));
  assert_eq!(text(&row["TS"]), "2026-09-20 07:04:05.123456");
  assert_eq!(text(&row["TSTZ"]), "2026-09-20 07:04:05.123 +08:00");
  assert_eq!(text(&row["C"]), "clob text");
  assert_eq!((kind(&row["B"]), text(&row["B"]).as_str()), ("binary", "deadbeef"));
  assert_eq!(text(&row["R"]), "0102");
  assert_eq!(row["FLAG"], json!(true));
  assert_eq!(rows[1]["V"], JsonValue::Null);
}

#[tokio::test]
async fn oracle_errors_carry_the_ora_code_and_position_and_the_session_survives() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool).await;

  let error =
    connection.execute("SELECT * FROM no_such_table", 10).await.expect_err("missing table");
  assert_eq!(error.code.as_deref(), Some("ORA-00942"), "{error:?}");
  // 偏移从 0 起，错误面板的位置从 1 起：no_such_table 的 n 在第 15 个字符
  assert_eq!(error.details.as_ref().and_then(|details| details.position), Some(15));

  // 编辑器给每条语句补了分号：SQL 语句要去掉，PL/SQL 块要留着
  let rows =
    rows_of(connection.execute("SELECT 'alive' AS s FROM dual;", 10).await.expect("alive"));
  assert_eq!(rows[0]["S"], json!("alive"));
  connection.execute("BEGIN NULL; END;", 10).await.expect("plsql keeps its semicolon");
}

#[tokio::test]
async fn oracle_truncates_at_the_row_limit_and_the_session_stays_usable() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool).await;
  let mut rows = Vec::new();
  let summary = connection
    .execute_streaming(
      "SELECT level AS n FROM dual CONNECT BY level <= 5000",
      StreamOptions::limited(100, 16 * 1024 * 1024, 40),
      &mut |batch| {
        rows.extend(batch.rows);
        Ok(())
      },
    )
    .await
    .expect("stream");
  assert_eq!(rows.len(), 100);
  match summary {
    dataomni_lib::services::QueryExecutionSummary::Rows { truncation_reason, .. } => {
      assert_eq!(truncation_reason, Some(QueryTruncationReason::RowLimit))
    }
    other => panic!("expected rows: {other:?}"),
  }
  let again = rows_of(connection.execute("SELECT 1 AS one FROM dual", 10).await.expect("again"));
  // 常量表达式的类型是不带精度的 NUMBER：和 PostgreSQL 的 NUMERIC 一样按小数传
  assert_eq!(text(&again[0]["ONE"]), "1");
}

/// 超时要让服务端真的停下：丢掉 future 时发 break。
#[tokio::test]
async fn oracle_timeout_breaks_the_statement_on_the_server() {
  let Some(pool) = pool().await else { return };
  let sessions = QuerySessionState::default();
  let heavy = "SELECT /* dataomni-timeout */ COUNT(*) FROM \
    (SELECT level FROM dual CONNECT BY level <= 3000) a, \
    (SELECT level FROM dual CONNECT BY level <= 3000) b, \
    (SELECT level FROM dual CONNECT BY level <= 300) c";
  let options = |sql, timeout| StreamingQueryOptions {
    session_id: "oracle-timeout",
    pool_key: "oracle://smoke",
    pool: PoolRef::Oracle(&pool),
    sql,
    autocommit: true,
    explain_plan: false,
    row_limit: 10,
    byte_limit: 16 * 1024 * 1024,
    batch_size: 10,
    timeout_duration: timeout,
  };

  let started = Instant::now();
  let error = sessions
    .execute_streaming(options(heavy, Duration::from_millis(1500)), &mut |_| Ok(()))
    .await
    .expect_err("times out");
  assert_eq!(error.code.as_deref(), Some(QUERY_TIMEOUT_CODE));
  assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());

  // 服务端那边：那条语句不该还在跑
  tokio::time::sleep(Duration::from_secs(2)).await;
  let running = pool
    .select(
      "SELECT COUNT(*) AS n FROM v$session s JOIN v$sql q ON q.sql_id = s.sql_id \
       WHERE s.status = 'ACTIVE' AND q.sql_text LIKE '%dataomni-timeout%' \
       AND q.sql_text NOT LIKE '%v$session%'",
      &[],
    )
    .await
    // 测试用户要能读数据字典：`GRANT SELECT ANY DICTIONARY TO <user>`。
    // 读不了就红，而不是悄悄跳过这一项——这一项正是这条用例要证明的
    .expect("read v$session (GRANT SELECT ANY DICTIONARY to the test user)");
  assert_eq!(running[0]["N"].to_string().trim_matches('"'), "0", "被放弃的语句还在服务端跑");

  let mut rows = Vec::new();
  sessions
    .execute_streaming(options("SELECT 1 AS ok FROM dual", Duration::from_secs(20)), &mut |batch| {
      rows.extend(batch.rows);
      Ok(())
    })
    .await
    .expect("session usable after timeout");
  assert_eq!(text(&rows[0]["OK"]), "1");
}

#[tokio::test]
async fn oracle_catalog_selects_bind_by_position() {
  let Some(pool) = pool().await else { return };
  let rows = pool
    .select("SELECT :1 AS a, :2 AS b, :3 AS c FROM dual", &[json!("x"), json!(42), JsonValue::Null])
    .await
    .expect("select");
  assert_eq!(rows[0]["A"], json!("x"));
  assert_eq!(rows[0]["B"], json!(42));
  assert_eq!(rows[0]["C"], JsonValue::Null);
}

// ---------------------------------------------------------------------------
// 目录查询。夹具的陷阱和另外几家那一组相同：复合外键的列在表里的次序与键内次序
// 相反；外加 Oracle 自己的：自增列、虚拟列、函数索引（隐藏列名 SYS_NC…$）、
// NOT NULL 的系统检查约束（不该列出来）、包。
// ---------------------------------------------------------------------------

async fn meta_fixture(pool: &Arc<OraclePool>) {
  for object in [
    "DROP VIEW om_v_child",
    "DROP TABLE om_child PURGE",
    "DROP TABLE om_parent PURGE",
    "DROP PROCEDURE om_touch",
    "DROP FUNCTION om_double",
    "DROP PACKAGE om_pkg",
    "DROP SEQUENCE om_seq",
  ] {
    let mut connection = session(pool).await;
    let _ = connection.execute(object, 1).await;
  }
  run_all(
    pool,
    &[
      "CREATE TABLE om_parent (x NUMBER(10) NOT NULL, y NUMBER(10) NOT NULL, \
        label VARCHAR2(32 CHAR) NOT NULL, score NUMBER(10,2) DEFAULT 0, \
        CONSTRAINT om_pk_parent PRIMARY KEY (x, y), CONSTRAINT om_uq_parent UNIQUE (label))",
      "CREATE TABLE om_child (id NUMBER GENERATED ALWAYS AS IDENTITY CONSTRAINT om_pk_child PRIMARY KEY, \
        ref_b NUMBER(10) NOT NULL, ref_a NUMBER(10) NOT NULL, note CLOB, \
        total NUMBER GENERATED ALWAYS AS (ref_a + ref_b) VIRTUAL, \
        CONSTRAINT om_fk_child FOREIGN KEY (ref_a, ref_b) REFERENCES om_parent (x, y) ON DELETE CASCADE, \
        CONSTRAINT om_ck_child CHECK (ref_a >= 0))",
      "CREATE INDEX om_ix_child_lower ON om_child (LOWER(TO_CHAR(ref_a)))",
      "COMMENT ON COLUMN om_parent.label IS '标签'",
      "CREATE OR REPLACE TRIGGER om_trg BEFORE INSERT OR UPDATE ON om_child FOR EACH ROW BEGIN NULL; END;",
      "CREATE VIEW om_v_child AS SELECT id, ref_a FROM om_child",
      "CREATE OR REPLACE PROCEDURE om_touch AS BEGIN NULL; END;",
      "CREATE OR REPLACE FUNCTION om_double (n NUMBER) RETURN NUMBER AS BEGIN RETURN n * 2; END;",
      "CREATE OR REPLACE PACKAGE om_pkg AS PROCEDURE ping; END om_pkg;",
      "CREATE SEQUENCE om_seq START WITH 5 INCREMENT BY 3",
    ],
  )
  .await;
}

fn find<'a>(rows: &'a [QueryRow], column: &str, value: &str) -> Vec<&'a QueryRow> {
  rows.iter().filter(|row| row[column] == json!(value)).collect()
}

#[tokio::test]
async fn oracle_catalog_queries_describe_the_fixture() {
  use dataomni_lib::models::DatabaseType;
  use dataomni_lib::services::{
    completion_catalog_query, er_diagram_queries, object_catalog_queries, schema_metadata_queries,
    session_target_query, DdlQuery,
  };
  let Some(pool) = pool().await else { return };
  meta_fixture(&pool).await;
  let queries = schema_metadata_queries(&DatabaseType::Oracle).expect("Oracle catalog");
  let params = |table: &str| vec![json!(table), JsonValue::Null];

  let columns = pool.select(queries.columns, &params("OM_CHILD")).await.expect("columns");
  let names: Vec<String> = columns.iter().map(|row| text(&row["column_name"])).collect();
  assert_eq!(names, ["ID", "REF_B", "REF_A", "NOTE", "TOTAL"], "函数索引的隐藏列不该出现");
  let by_name = |name: &str| find(&columns, "column_name", name)[0].clone();
  assert_eq!(by_name("ID")["is_generated"], json!(1), "自增列");
  assert_eq!(by_name("TOTAL")["is_generated"], json!(1), "虚拟列");
  assert_eq!(by_name("REF_A")["is_generated"], json!(0));
  assert_eq!(by_name("ID")["is_primary_key"], json!(1));
  assert_eq!(by_name("REF_B")["is_nullable"], json!(0));
  assert_eq!(by_name("NOTE")["is_nullable"], json!(1));
  assert_eq!(text(&by_name("REF_A")["data_type"]), "NUMBER(10)");
  assert_eq!(text(&by_name("ID")["data_type"]), "NUMBER");

  let parent = pool.select(queries.columns, &params("OM_PARENT")).await.expect("parent columns");
  let label = find(&parent, "column_name", "LABEL")[0];
  assert_eq!(text(&label["data_type"]), "VARCHAR2(32 CHAR)");
  assert_eq!(text(&label["comment"]), "标签");
  let score = find(&parent, "column_name", "SCORE")[0];
  assert_eq!(text(&score["data_type"]), "NUMBER(10,2)");
  assert_eq!(text(&score["column_default"]).trim(), "0");
  let keys: Vec<(String, JsonValue)> = parent
    .iter()
    .filter(|row| row["is_primary_key"] == json!(1))
    .map(|row| (text(&row["column_name"]), row["primary_key_ordinal"].clone()))
    .collect();
  assert_eq!(keys, [("X".to_string(), json!(1)), ("Y".to_string(), json!(2))]);

  let indexes = pool.select(queries.indexes, &params("OM_CHILD")).await.expect("indexes");
  let expression = find(&indexes, "index_name", "OM_IX_CHILD_LOWER");
  assert_eq!(expression.len(), 1);
  assert_eq!(expression[0]["column_name"], JsonValue::Null, "表达式列显示为「表达式」");
  assert_eq!(find(&indexes, "index_name", "OM_PK_CHILD")[0]["is_primary"], json!(1));

  let foreign_keys = pool.select(queries.foreign_keys, &params("OM_CHILD")).await.expect("fks");
  let pairs: Vec<(String, String)> = foreign_keys
    .iter()
    .map(|row| (text(&row["column_name"]), text(&row["referenced_column"])))
    .collect();
  assert_eq!(pairs, [("REF_A".into(), "X".into()), ("REF_B".into(), "Y".into())], "按键内次序");
  assert_eq!(text(&foreign_keys[0]["on_delete"]), "CASCADE");

  let checks = pool
    .select(queries.check_constraints.expect("checks"), &params("OM_CHILD"))
    .await
    .expect("checks");
  let check_names: Vec<String> = checks.iter().map(|row| text(&row["constraint_name"])).collect();
  assert_eq!(check_names, ["OM_CK_CHILD"], "NOT NULL 的系统约束不列");

  let Some(DdlQuery::Bound { sql: ddl }) = queries.ddl else { panic!("bound DDL") };
  let ddl_rows = pool.select(ddl, &params("OM_PARENT")).await.expect("ddl");
  assert!(text(&ddl_rows[0]["sql"]).contains("CREATE TABLE"), "{:?}", ddl_rows[0]);
  let view_ddl = pool.select(ddl, &params("OM_V_CHILD")).await.expect("view ddl");
  assert!(text(&view_ddl[0]["sql"]).contains("VIEW"), "{:?}", view_ddl[0]);

  let triggers = pool.select(queries.triggers, &params("OM_CHILD")).await.expect("triggers");
  assert_eq!(text(&triggers[0]["trigger_name"]), "OM_TRG");
  assert!(text(&triggers[0]["event"]).contains("INSERT"));
  assert!(text(&triggers[0]["definition"]).contains("TRIGGER"));

  let objects = object_catalog_queries(&DatabaseType::Oracle).expect("objects");
  let listed = pool.select(objects.objects, &[]).await.expect("object list");
  let kind_of =
    |name: &str| find(&listed, "object_name", name).first().map(|row| text(&row["object_kind"]));
  assert_eq!(kind_of("OM_CHILD").as_deref(), Some("table"));
  assert_eq!(kind_of("OM_V_CHILD").as_deref(), Some("view"));
  assert_eq!(kind_of("OM_TOUCH").as_deref(), Some("procedure"));
  assert_eq!(kind_of("OM_DOUBLE").as_deref(), Some("function"));
  assert_eq!(kind_of("OM_PKG").as_deref(), Some("procedure"), "包归在过程一组");
  assert_eq!(kind_of("OM_SEQ").as_deref(), Some("sequence"));
  assert!(find(&listed, "object_schema", "SYS").is_empty(), "系统 schema 不列");
  let id = text(&find(&listed, "object_name", "OM_DOUBLE")[0]["object_id"]);
  let routine = pool.select(objects.routine_definition, &[json!(id)]).await.expect("routine");
  assert!(text(&routine[0]["definition"]).contains("RETURN n * 2"));
  let sequence_id = text(&find(&listed, "object_name", "OM_SEQ")[0]["object_id"]);
  let sequence = pool
    .select(objects.sequence_properties.expect("sequences"), &[json!(sequence_id)])
    .await
    .expect("sequence");
  assert_eq!(text(&sequence[0]["increment_by"]), "3");

  let er = er_diagram_queries(&DatabaseType::Oracle).expect("er");
  let er_columns = pool.select(er.columns, &[]).await.expect("er columns");
  assert!(!find(&er_columns, "table_name", "OM_CHILD").is_empty());
  let er_keys = pool.select(er.foreign_keys, &[]).await.expect("er fks");
  assert_eq!(find(&er_keys, "constraint_name", "OM_FK_CHILD").len(), 2);

  let completion = completion_catalog_query(&DatabaseType::Oracle).expect("completion");
  let relations = pool.select(completion.relations, &[]).await.expect("relations");
  assert!(find(&relations, "relation_name", "OM_V_CHILD")
    .iter()
    .all(|row| text(&row["relation_kind"]) == "view"));

  let target = session_target_query(&DatabaseType::Oracle).expect("target");
  let target_rows = pool.select(target.sql, &[]).await.expect("target");
  assert_eq!(text(&target_rows[0]["schema_name"]), "DATAOMNI");
  assert_eq!(target_rows[0]["read_only"], json!(0));
}

/// 结构页一次发五段目录查询，全部回来才显示。量一下每段多久——`DBMS_METADATA`
/// 在小内存的 Oracle Free 上慢得出奇，要知道慢的是哪一段
#[tokio::test]
#[ignore = "只量时间，不做断言：DATAOMNI_ORACLE_TEST_URL=... cargo test --test oracle_smoke timing -- --ignored --nocapture"]
async fn oracle_structure_page_query_timings() {
  use dataomni_lib::models::DatabaseType;
  use dataomni_lib::services::{schema_metadata_queries, DdlQuery};
  let Some(pool) = pool().await else { return };
  let queries = schema_metadata_queries(&DatabaseType::Oracle).expect("catalog");
  let Some(DdlQuery::Bound { sql: ddl }) = queries.ddl else { panic!("ddl") };
  let params = vec![json!("OM_PARENT"), JsonValue::Null];
  for round in 1..=2 {
    let started = Instant::now();
    let timed = |label: &'static str, sql: &'static str| {
      let pool = Arc::clone(&pool);
      let params = params.clone();
      async move {
        let t = Instant::now();
        let result = pool.select(sql, &params).await;
        (label, t.elapsed(), result.is_ok())
      }
    };
    let results = futures_util::future::join_all([
      timed("columns", queries.columns),
      timed("indexes", queries.indexes),
      timed("foreign_keys", queries.foreign_keys),
      timed("checks", queries.check_constraints.expect("checks")),
      timed("ddl", ddl),
      timed("triggers", queries.triggers),
    ])
    .await;
    println!("round {round}: total {:?}", started.elapsed());
    for (label, took, ok) in results {
      println!("  {label:<13} {took:?} ok={ok}");
    }
  }
}

// ---------------------------------------------------------------------------
// 第二阶段：网格的写入批次、会话事务
// ---------------------------------------------------------------------------

async fn write_fixture(pool: &Arc<OraclePool>) {
  drop_quietly(pool, "om_write").await;
  run_all(
    pool,
    &[
      "CREATE TABLE om_write (id NUMBER(10) PRIMARY KEY, name VARCHAR2(20) NOT NULL, at DATE, note VARCHAR2(20))",
      "INSERT INTO om_write (id, name) VALUES (1, '甲')",
      "INSERT INTO om_write (id, name) VALUES (2, '乙')",
    ],
  )
  .await;
}

fn write(
  sql: &str,
  params: Vec<JsonValue>,
  expect_rows: Option<u64>,
) -> dataomni_lib::services::WriteStatement {
  dataomni_lib::services::WriteStatement { sql: sql.to_string(), params, expect_rows }
}

async fn names(pool: &Arc<OraclePool>) -> Vec<String> {
  pool
    .select("SELECT name FROM om_write ORDER BY id", &[])
    .await
    .expect("read back")
    .iter()
    .map(|row| text(&row["NAME"]))
    .collect()
}

#[tokio::test]
async fn oracle_write_batches_bind_text_dates_and_roll_back_as_a_whole() {
  use dataomni_lib::services::{execute_write_batch, ROW_COUNT_MISMATCH_CODE};
  let Some(pool) = pool().await else { return };
  write_fixture(&pool).await;

  // 日期以结果里的写法绑成文本：默认的 NLS_DATE_FORMAT 是 DD-MON-RR，这一条会 ORA-01861
  let affected = execute_write_batch(
    PoolRef::Oracle(&pool),
    &[
      write(
        r#"UPDATE "DATAOMNI"."OM_WRITE" SET "NAME" = :1, "AT" = :2 WHERE "ID" = 1 AND "NAME" = :3;"#,
        vec![json!("丙"), json!("2026-09-21 08:30:00"), json!("甲")],
        Some(1),
      ),
      write(
        r#"INSERT INTO "DATAOMNI"."OM_WRITE" ("ID", "NAME") VALUES (:1, :2)"#,
        vec![json!(3), json!("丁")],
        None,
      ),
    ],
  )
  .await
  .expect("batch commits");
  assert_eq!(affected, vec![1, 1]);
  assert_eq!(names(&pool).await, ["丙", "乙", "丁"]);
  let at = pool.select("SELECT at FROM om_write WHERE id = 1", &[]).await.expect("date");
  assert_eq!(text(&at[0]["AT"]), "2026-09-21 08:30:00");

  // 第二条违反 NOT NULL：第一条的 DELETE 也不能留下
  let error = execute_write_batch(
    PoolRef::Oracle(&pool),
    &[
      write(r#"DELETE FROM "OM_WRITE" WHERE "ID" = 3"#, vec![], Some(1)),
      write(r#"UPDATE "OM_WRITE" SET "NAME" = NULL WHERE "ID" = 2"#, vec![], Some(1)),
    ],
  )
  .await
  .expect_err("second statement fails");
  assert_eq!(error.statement_index, 1);
  assert_eq!(error.error.code.as_deref(), Some("ORA-01407"), "{:?}", error.error);
  assert_eq!(names(&pool).await, ["丙", "乙", "丁"], "第一条的 DELETE 必须回滚");

  // 那一行已经被别人改掉：零行匹配，整批回滚
  let error = execute_write_batch(
    PoolRef::Oracle(&pool),
    &[
      write(r#"DELETE FROM "OM_WRITE" WHERE "ID" = 3"#, vec![], Some(1)),
      write(
        r#"UPDATE "OM_WRITE" SET "NOTE" = 'x' WHERE "ID" = 1 AND "NAME" = :1"#,
        vec![json!("甲")],
        Some(1),
      ),
    ],
  )
  .await
  .expect_err("stale row");
  assert_eq!(error.error.code.as_deref(), Some(ROW_COUNT_MISMATCH_CODE));
  assert_eq!(names(&pool).await, ["丙", "乙", "丁"]);

  // 用过的连接回到池子里，上面不能开着事务
  let open = pool
    .select("SELECT NVL(DBMS_TRANSACTION.LOCAL_TRANSACTION_ID, 'none') AS t FROM dual", &[])
    .await
    .expect("transaction id");
  assert_eq!(text(&open[0]["T"]), "none");
}

fn session_options<'a>(
  pool: &'a Arc<OraclePool>,
  session_id: &'a str,
  sql: &'a str,
  autocommit: bool,
) -> StreamingQueryOptions<'a> {
  StreamingQueryOptions {
    session_id,
    pool_key: "oracle://smoke",
    pool: PoolRef::Oracle(pool),
    sql,
    autocommit,
    explain_plan: false,
    row_limit: 100,
    byte_limit: 16 * 1024 * 1024,
    batch_size: 100,
    timeout_duration: Duration::from_secs(30),
  }
}

async fn run_in(
  sessions: &QuerySessionState,
  pool: &Arc<OraclePool>,
  session_id: &str,
  sql: &str,
  autocommit: bool,
) {
  sessions
    .execute_streaming(session_options(pool, session_id, sql, autocommit), &mut |_| Ok(()))
    .await
    .unwrap_or_else(|error| panic!("{sql}: {error:?}"));
}

#[tokio::test]
async fn oracle_session_transactions_follow_the_server_and_the_autocommit_switch() {
  use dataomni_lib::services::TransactionStatus;
  let Some(pool) = pool().await else { return };
  write_fixture(&pool).await;
  let sessions = QuerySessionState::default();
  let id = "oracle-transaction";

  // 自动提交开着：写入各自提交，事务栏是空的
  run_in(&sessions, &pool, id, "UPDATE om_write SET note = 'a' WHERE id = 1", true).await;
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Idle);

  // 关掉：同一条写入留在事务里，回滚之后就没了
  run_in(&sessions, &pool, id, "UPDATE om_write SET note = 'b' WHERE id = 1", false).await;
  let begun = sessions.transaction(id).await;
  assert_eq!(begun.status, TransactionStatus::Active);
  run_in(&sessions, &pool, id, "UPDATE om_write SET note = 'c' WHERE id = 2", false).await;
  assert_eq!(
    sessions.transaction(id).await.started_at,
    begun.started_at,
    "同一个事务，开始时间不变"
  );
  run_in(&sessions, &pool, id, "ROLLBACK", true).await;
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Idle);
  let notes = pool.select("SELECT note FROM om_write ORDER BY id", &[]).await.expect("notes");
  assert_eq!(
    (text(&notes[0]["NOTE"]), notes[1]["NOTE"].clone()),
    ("a".to_string(), JsonValue::Null)
  );

  // 按了「开始事务」之后自动提交还开着：不该替用户把他的事务一条条提交掉
  run_in(&sessions, &pool, id, "SET TRANSACTION READ WRITE", true).await;
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Active);
  run_in(&sessions, &pool, id, "UPDATE om_write SET note = 'd' WHERE id = 1", true).await;
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Active);
  run_in(&sessions, &pool, id, "ROLLBACK", true).await;
  let note = pool.select("SELECT note FROM om_write WHERE id = 1", &[]).await.expect("note");
  assert_eq!(text(&note[0]["NOTE"]), "a", "那条 UPDATE 应当随回滚撤掉");

  // DDL 会隐式提交：状态要跟着回到空闲
  run_in(&sessions, &pool, id, "UPDATE om_write SET note = 'e' WHERE id = 1", false).await;
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Active);
  run_in(&sessions, &pool, id, "CREATE TABLE om_tx_ddl (id NUMBER)", false).await;
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Idle);
  run_in(&sessions, &pool, id, "DROP TABLE om_tx_ddl PURGE", true).await;
}

// ---------------------------------------------------------------------------
// 第三阶段：执行计划、整表导出、CSV 导入、改结构
// ---------------------------------------------------------------------------

async fn explain_in(
  sessions: &QuerySessionState,
  pool: &Arc<OraclePool>,
  session_id: &str,
  sql: &str,
  autocommit: bool,
) -> Result<dataomni_lib::services::QueryPlan, dataomni_lib::services::QueryError> {
  use dataomni_lib::models::DatabaseType;
  let statement = dataomni_lib::services::explain_statement(&DatabaseType::Oracle, sql, false)?;
  let mut rows = Vec::new();
  let mut options = session_options(pool, session_id, &statement, autocommit);
  options.explain_plan = true;
  sessions
    .execute_streaming(options, &mut |batch| {
      rows.extend(batch.rows);
      Ok(())
    })
    .await?;
  // 取一份真计划给 explain.rs 的单测当夹具：只写第一次（用例里第一条是分组加排序那条）
  if let Some(path) = std::env::var_os("DATAOMNI_WRITE_ORACLE_PLAN_FIXTURE")
    .filter(|path| !std::path::Path::new(path).exists())
  {
    std::fs::write(path, serde_json::to_string_pretty(&rows).expect("rows")).expect("fixture");
  }
  dataomni_lib::services::parse_plan(&DatabaseType::Oracle, &rows, false)
}

#[tokio::test]
async fn oracle_explain_reads_the_plan_without_running_it_or_leaving_a_transaction() {
  use dataomni_lib::services::TransactionStatus;
  let Some(pool) = pool().await else { return };
  write_fixture(&pool).await;
  let sessions = QuerySessionState::default();
  let id = "oracle-explain";

  let plan = explain_in(
    &sessions,
    &pool,
    id,
    "SELECT name, COUNT(*) FROM om_write WHERE id > 1 GROUP BY name ORDER BY 1;",
    true,
  )
  .await
  .expect("plan");
  assert_eq!(plan.roots.len(), 1);
  let root = &plan.roots[0];
  assert_eq!(root.operation, "SELECT STATEMENT");
  let scan = root.children.iter().flat_map(|child| child.children.iter()).next().expect("scan");
  assert!(scan.operation.starts_with("TABLE ACCESS"), "{}", scan.operation);
  assert_eq!(scan.target.as_deref(), Some("DATAOMNI.OM_WRITE"));
  assert!(
    scan.detail.iter().any(|d| d.key == "Filter" && d.value.contains("ID")),
    "{:?}",
    scan.detail
  );
  assert!(root.cost.is_some() && root.estimated_rows.is_some());
  assert!(plan.raw.contains("Plan hash value"), "{}", plan.raw);
  // 写 PLAN_TABLE 本身开了一个事务：取完计划之后不能留着
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Idle);

  // 解释一条 DELETE 不会删任何东西
  explain_in(&sessions, &pool, id, "DELETE FROM om_write", true).await.expect("dml plan");
  assert_eq!(names(&pool).await.len(), 2);

  // 用户自己开着的事务：改动留着、事务还在
  run_in(&sessions, &pool, id, "UPDATE om_write SET note = 'kept' WHERE id = 1", false).await;
  let begun = sessions.transaction(id).await;
  explain_in(&sessions, &pool, id, "SELECT * FROM om_write", false).await.expect("plan in tx");
  assert_eq!(sessions.transaction(id).await.started_at, begun.started_at);
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Active);
  let note = sessions
    .execute_streaming(
      session_options(&pool, id, "SELECT note FROM om_write WHERE id = 1", false),
      &mut |batch| {
        assert_eq!(text(&batch.rows[0]["NOTE"]), "kept", "用户的改动被计划那一步撤掉了");
        Ok(())
      },
    )
    .await;
  note.expect("read own change");
  run_in(&sessions, &pool, id, "ROLLBACK", true).await;

  // 语法错误的位置指向用户写的那条，不是包了一层之后的
  let error =
    explain_in(&sessions, &pool, id, "SELECT FROM om_write", true).await.expect_err("syntax error");
  assert_eq!(error.code.as_deref(), Some("ORA-00936"));
  assert_eq!(error.details.and_then(|details| details.position), Some(8));
}

fn export_options() -> dataomni_lib::services::ExportOptions {
  dataomni_lib::services::ExportOptions {
    format: dataomni_lib::services::ExportFormat::Csv,
    delimiter: ",".to_string(),
    include_header: true,
    null_text: String::new(),
    byte_order_mark: false,
  }
}

/// 整表导出：表头在取任何一行之前就位；不返回结果集的语句一行都不执行；写错的
/// 语句报它自己的错。同名的列（连接里两边都有 ID）表头与行用的是同一份编号
#[tokio::test]
async fn oracle_exports_stream_to_a_file_and_refuse_non_queries_before_running_them() {
  let Some(pool) = pool().await else { return };
  write_fixture(&pool).await;
  let dir = std::env::temp_dir().join(format!("dataomni-oracle-export-{}", std::process::id()));
  std::fs::create_dir_all(&dir).expect("temp dir");
  let target = dir.join("out.csv");
  let export = |sql: &'static str| {
    let pool = Arc::clone(&pool);
    let target = target.clone();
    async move {
      dataomni_lib::services::export_query(
        PoolRef::Oracle(&pool),
        sql,
        &target,
        export_options(),
        &mut |_| {},
        &mut || false,
      )
      .await
    }
  };

  let summary = export(
    "SELECT a.id, a.name, b.id, a.id * 1.5 AS half FROM om_write a JOIN om_write b ON b.id = a.id ORDER BY a.id;",
  )
  .await
  .expect("export");
  assert_eq!(summary.rows_written, 2);
  let contents = std::fs::read_to_string(&target).expect("read back");
  assert_eq!(contents, "ID,NAME,ID 2,HALF\n1,甲,1,1.5\n2,乙,2,3");

  let error = export("DELETE FROM om_write").await.expect_err("refused");
  assert_eq!(error.message, dataomni_lib::services::query_executor::NON_QUERY_MESSAGE);
  assert_eq!(names(&pool).await, ["甲", "乙"], "拒绝之前不能已经删了");

  let error = export("SELECT * FROM no_such_table").await.expect_err("bad sql");
  assert_eq!(error.code.as_deref(), Some("ORA-00942"), "{error:?}");
  std::fs::remove_dir_all(&dir).ok();
}

/// 和 SQL Server 那份同一个文件：转换失败（ORA-01722 / 01843）、主键冲突、太长、非空。
/// Oracle 的这几种都只终止那一条语句，事务留着
const IMPORT_CSV: &str = "id,n,at,name
1,10,2024-01-01,a
2,abc,2024-01-02,b
3,30,2024-13-45,c
1,40,,d
5,50,,toolong
6,,,f
7,70,2024-02-02 08:30:00,g
";

async fn import_fixture(pool: &Arc<OraclePool>) {
  drop_quietly(pool, "om_import").await;
  run_all(
    pool,
    &["CREATE TABLE om_import (id NUMBER(10) PRIMARY KEY, n NUMBER(10) NOT NULL, at DATE, name VARCHAR2(5))"],
  )
  .await;
}

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
    schema: Some("DATAOMNI".into()),
    table: "OM_IMPORT".into(),
    csv: dataomni_lib::services::CsvOptions {
      delimiter: ",".into(),
      has_header: true,
      null_text: String::new(),
    },
    columns: vec![
      column(0, "ID", "NUMBER(10)"),
      column(1, "N", "NUMBER(10)"),
      column(2, "AT", "DATE"),
      column(3, "NAME", "VARCHAR2(5)"),
    ],
    batch_size: 3,
    strategy,
    on_error,
  }
}

async fn run_import(
  pool: &Arc<OraclePool>,
  request: &dataomni_lib::services::ImportRequest,
) -> dataomni_lib::services::ImportSummary {
  dataomni_lib::services::import_csv(
    PoolRef::Oracle(pool),
    request,
    &mut |_| {},
    &mut || false,
    &mut || false,
  )
  .await
  .expect("import runs")
}

async fn imported(pool: &Arc<OraclePool>) -> Vec<(String, String)> {
  pool
    .select(
      "SELECT id, NVL(TO_CHAR(at, 'YYYY-MM-DD HH24:MI:SS'), '-') AS at FROM om_import ORDER BY id",
      &[],
    )
    .await
    .expect("read back")
    .iter()
    .map(|row| (text(&row["ID"]), text(&row["AT"])))
    .collect()
}

#[tokio::test]
async fn oracle_import_binds_whole_batches_and_finds_the_bad_rows() {
  use dataomni_lib::services::{ErrorPolicy, TransactionStrategy};
  let Some(pool) = pool().await else { return };
  let path =
    std::env::temp_dir().join(format!("dataomni-oracle-import-{}.csv", std::process::id()));
  std::fs::write(&path, IMPORT_CSV).expect("write csv");

  for strategy in [TransactionStrategy::SingleTransaction, TransactionStrategy::PerBatch] {
    import_fixture(&pool).await;
    let summary = run_import(&pool, &import_request(&path, ErrorPolicy::Skip, strategy)).await;
    assert!(!summary.rolled_back, "{summary:?}");
    assert_eq!((summary.rows_read, summary.rows_inserted, summary.rows_failed), (7, 2, 5));
    // 文本按会话的 NLS 格式转成 DATE：只有日期的、带时分秒的都认
    assert_eq!(
      imported(&pool).await,
      [
        ("1".to_string(), "2024-01-01 00:00:00".to_string()),
        ("7".to_string(), "2024-02-02 08:30:00".to_string())
      ],
      "{strategy:?}"
    );
    let by_line = |line: u64| {
      summary.errors.iter().find(|error| error.line == line).map(|error| error.message.clone())
    };
    for (line, code) in
      [(3, "ORA-01722"), (4, "ORA-01843"), (5, "ORA-00001"), (6, "ORA-12899"), (7, "ORA-01400")]
    {
      assert!(by_line(line).is_some_and(|m| m.contains(code)), "{line}: {:?}", by_line(line));
    }
  }
  std::fs::remove_file(&path).ok();
}

#[tokio::test]
async fn oracle_import_aborts_on_the_first_bad_row_and_leaves_nothing_behind() {
  use dataomni_lib::services::{ErrorPolicy, TransactionStrategy};
  let Some(pool) = pool().await else { return };
  import_fixture(&pool).await;
  let path =
    std::env::temp_dir().join(format!("dataomni-oracle-import-abort-{}.csv", std::process::id()));
  std::fs::write(&path, IMPORT_CSV).expect("write csv");

  let summary = run_import(
    &pool,
    &import_request(&path, ErrorPolicy::Abort, TransactionStrategy::SingleTransaction),
  )
  .await;
  assert!(summary.rolled_back);
  assert_eq!(summary.rows_inserted, 0);
  assert_eq!(summary.errors.len(), 1);
  assert_eq!(summary.errors[0].line, 3, "{:?}", summary.errors);
  // 数组 DML 出错时坏行前面那几行已经写进去了，要靠保存点和最后的回滚撤掉
  assert!(imported(&pool).await.is_empty());
  std::fs::remove_file(&path).ok();
}

#[path = "support/ddl_corpus.rs"]
mod ddl_corpus;

async fn oracle_catalog_columns(pool: &Arc<OraclePool>, table: &str) -> Vec<ddl_corpus::Column> {
  use dataomni_lib::models::DatabaseType;
  use dataomni_lib::services::schema_metadata_queries;
  let queries = schema_metadata_queries(&DatabaseType::Oracle).expect("Oracle catalog");
  let flag = |value: &JsonValue| value == &json!(1) || value == &json!(true);
  pool
    .select(queries.columns, &[json!(table), JsonValue::Null])
    .await
    .expect("read column catalog")
    .iter()
    .map(|row| {
      let generated = flag(&row["is_generated"]);
      let default_value = row["column_default"].as_str().map(str::to_string);
      ddl_corpus::Column {
        name: text(&row["column_name"]),
        data_type: text(&row["data_type"]),
        nullable: flag(&row["is_nullable"]),
        primary_key_ordinal: row["primary_key_ordinal"].as_i64(),
        // 自增列的默认值是它背后那个序列的 nextval，序列名每次建表都不一样
        // （`"DATAOMNI"."ISEQ$$_73461".nextval`），语料里写不出来，只比「有没有」
        default_value: match default_value {
          Some(value) if generated && value.contains("ISEQ$$_") => Some("<identity>".to_string()),
          other => other,
        },
        generated,
        collation: row["collation"].as_str().map(str::to_string),
        comment: row["comment"].as_str().map(str::to_string),
        extra: row["column_extra"].as_str().map(str::to_string),
      }
    })
    .collect()
}

/// 改结构语料的 Oracle 用例：语句走界面上同一条路（`execute_write_batch`），跑完再读
/// 列目录核对。Oracle 的 DDL 每条自己提交，这里验的是每条都跑得通、跑完的表对
#[tokio::test]
async fn oracle_runs_the_generated_ddl_from_the_shared_corpus() {
  use dataomni_lib::services::execute_write_batch;
  let Some(pool) = pool().await else { return };
  let cases = ddl_corpus::load("oracle");
  assert!(!cases.is_empty(), "语料里要有 Oracle 的用例");
  for case in cases {
    run_all(&pool, &case.fixture.iter().map(String::as_str).collect::<Vec<_>>()).await;
    if !case.origin.is_empty() {
      let origin = oracle_catalog_columns(&pool, &case.table).await;
      assert_eq!(origin, case.origin, "{}: 语料里的 origin 和数据库给的对不上", case.name);
    }
    let statements: Vec<_> =
      case.statements.iter().map(|sql| write(sql, Vec::new(), None)).collect();
    execute_write_batch(PoolRef::Oracle(&pool), &statements).await.unwrap_or_else(|error| {
      panic!(
        "{}: 生成的语句跑不了（第 {} 条）\n{:?}",
        case.name, error.statement_index, error.error
      )
    });
    run_all(&pool, &case.insert.iter().map(String::as_str).collect::<Vec<_>>()).await;
    let after = oracle_catalog_columns(&pool, &case.final_table).await;
    assert_eq!(after, case.after, "{}: 跑完之后的表和语料说的不一样", case.name);
    run_all(&pool, &case.cleanup.iter().map(String::as_str).collect::<Vec<_>>()).await;
  }
}

/// 对象级结构操作语料的 Oracle 用例：语句走界面上同一条路（`execute_write_batch`）
#[path = "support/object_ddl_corpus.rs"]
mod object_ddl_corpus;

#[tokio::test]
async fn oracle_runs_the_object_ddl_corpus() {
  use dataomni_lib::services::execute_write_batch;
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool).await;
  let user = rows_of(connection.execute("SELECT USER FROM DUAL", 1).await.expect("USER"));
  let user = user[0].values().next().map(text).unwrap_or_default();
  drop(connection);
  for case in object_ddl_corpus::load("oracle") {
    if let Some(written) = &case.schema {
      assert_eq!(written, &user, "{}: 语料写死的 schema", case.name);
    }
    run_all(&pool, &case.fixture.iter().map(String::as_str).collect::<Vec<_>>()).await;
    execute_write_batch(PoolRef::Oracle(&pool), &[write(&case.statement, Vec::new(), None)])
      .await
      .unwrap_or_else(|error| panic!("{}: 生成的语句跑不了\n{:?}", case.name, error.error));
    let mut connection = session(&pool).await;
    let rows = rows_of(connection.execute(&case.check, 1).await.expect("核对查询"));
    let found = rows[0].values().next().map(text).and_then(|value| value.parse::<i64>().ok());
    assert_eq!(found, Some(case.expect), "{}: 跑完之后的结果和语料说的不一样", case.name);
    drop(connection);
    run_all(&pool, &case.cleanup.iter().map(String::as_str).collect::<Vec<_>>()).await;
  }
}
