//! SQL Server 的真库用例。
//!
//! 和 `database_smoke.rs` 一样默认静默跳过；要跑就在 shell 里设
//! `DATAOMNI_SQLSERVER_TEST_URL=sqlserver://user:password@host:port/database`
//! （**不要写进任何文件**），并设 `DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS=1`
//! 让缺了连接串的时候报错而不是跳过。
//!
//! 单独一个文件而不是塞进 `database_smoke.rs`：那边全是 sqlx 的池子与插件的
//! `DbPool`，这边是后端自己持有的连接，两边的夹具没有一行能共用。

use dataomni_lib::models::ConnectionProfile;
use dataomni_lib::models::DatabaseType;
use dataomni_lib::services::{completion_catalog_query, er_diagram_queries, session_target_query};
use dataomni_lib::services::{
  object_catalog_queries, schema_metadata_queries, sql_server, DdlQuery, PoolRef,
  QueryExecutionResult, QueryExecutionSummary, QueryRow, QuerySessionState, QueryTruncationReason,
  SessionConnection, SqlServerPool, SqlServerTarget, StreamOptions, StreamingQueryOptions,
  QUERY_TIMEOUT_CODE,
};
use serde_json::{json, Value as JsonValue};
use std::sync::Arc;
use std::time::{Duration, Instant};

const URL_ENV: &str = "DATAOMNI_SQLSERVER_TEST_URL";
const REQUIRE_ENV: &str = "DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS";

/// `sqlserver://user:password@host:port/database` → 一份连接配置。
/// 口令里可能有 `@`，所以从右边切。
fn profile_from_env() -> Option<ConnectionProfile> {
  let url = match std::env::var(URL_ENV) {
    Ok(url) if !url.is_empty() => url,
    _ if std::env::var(REQUIRE_ENV).as_deref() == Ok("1") => {
      panic!("{URL_ENV} must be set when {REQUIRE_ENV}=1")
    }
    _ => return None,
  };
  let rest = url.strip_prefix("sqlserver://").expect("sqlserver:// URL");
  let (credentials, address) = rest.rsplit_once('@').expect("user:password@host");
  let (username, password) = credentials.split_once(':').expect("user:password");
  let (host_port, database) = address.split_once('/').expect("host:port/database");
  let (host, port) = host_port.rsplit_once(':').expect("host:port");
  let profile = json!({
    "name": "sql-server-smoke",
    "db_type": "sqlserver",
    "host": host,
    "port": port.parse::<u16>().expect("port"),
    "database": database,
    "username": username,
    "password": password,
    "ssl": true,
    "tls_mode": "preferred",
    "options": {},
    "tags": []
  });
  Some(serde_json::from_value(profile).expect("profile"))
}

async fn pool() -> Option<Arc<SqlServerPool>> {
  let profile = profile_from_env()?;
  let target = SqlServerTarget::from_profile(&profile);
  let client = sql_server::connect(&target).await.expect("connect to SQL Server");
  Some(SqlServerPool::new(target, client))
}

async fn session(pool: &Arc<SqlServerPool>) -> SessionConnection {
  SessionConnection::acquire(PoolRef::SqlServer(pool)).await.expect("session connection")
}

fn rows_of(result: QueryExecutionResult) -> Vec<QueryRow> {
  match result {
    QueryExecutionResult::Rows { rows, .. } => rows,
    QueryExecutionResult::Affected { rows_affected } => {
      panic!("expected rows, got {rows_affected} affected")
    }
  }
}

fn affected_of(result: QueryExecutionResult) -> u64 {
  match result {
    QueryExecutionResult::Affected { rows_affected } => rows_affected,
    QueryExecutionResult::Rows { .. } => panic!("expected an affected-rows result"),
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

#[tokio::test]
async fn sql_server_decodes_values_the_way_the_other_dialects_do() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool).await;
  let rows = rows_of(
    connection
      .execute(
        "SELECT
           CAST(42 AS int) AS i,
           CAST(9223372036854775807 AS bigint) AS big,
           CAST(10.50 AS decimal(10,2)) AS cents,
           CAST(-1.5 AS decimal(5,1)) AS negative,
           CAST(-0.5 AS decimal(5,1)) AS negative_fraction,
           CAST(42 AS decimal(10,0)) AS whole,
           N'中文' AS s,
           CAST('2026-09-20 07:04:05.25' AS datetime2(2)) AS dt2,
           CAST('2026-09-20 07:04:05' AS datetime) AS dt,
           CAST('2026-09-20' AS date) AS d,
           CAST('07:04:05' AS time(0)) AS t,
           CAST('2026-09-20 07:04:05 +08:00' AS datetimeoffset(0)) AS dto,
           CAST(1 AS bit) AS flag,
           CAST('6F9619FF-8B86-D011-B42D-00C04FC964FF' AS uniqueidentifier) AS g,
           CAST(0x00FF10 AS varbinary(8)) AS bin,
           CAST(1.5 AS money) AS m,
           CAST(NULL AS int) AS nothing,
           1 + 1,
           2 + 2",
        100,
      )
      .await
      .expect("decode common types"),
  );
  let row = &rows[0];
  assert_eq!(row["i"], json!(42));
  assert_eq!((kind(&row["big"]), text(&row["big"]).as_str()), ("bigint", "9223372036854775807"));
  for (column, expected) in [
    ("cents", "10.50"),
    // tiberius 自己的 Display 在这三个上都是错的：`-1.-5`、`0.5`、`42.0`
    ("negative", "-1.5"),
    ("negative_fraction", "-0.5"),
    ("whole", "42"),
    ("m", "1.5000"),
  ] {
    assert_eq!(
      (kind(&row[column]), text(&row[column]).as_str()),
      ("decimal", expected),
      "{column}"
    );
  }
  assert_eq!(row["s"], json!("中文"));
  for (column, value_type, expected) in [
    ("dt2", "datetime", "2026-09-20 07:04:05.25"),
    ("dt", "datetime", "2026-09-20 07:04:05"),
    ("d", "date", "2026-09-20"),
    ("t", "time", "07:04:05"),
    ("dto", "datetime", "2026-09-20 07:04:05 +08:00"),
    ("g", "text", "6F9619FF-8B86-D011-B42D-00C04FC964FF"),
    ("bin", "binary", "00ff10"),
  ] {
    assert_eq!(
      (kind(&row[column]), text(&row[column]).as_str()),
      (value_type, expected),
      "{column}"
    );
  }
  assert_eq!(row["flag"], json!(true));
  assert_eq!(row["nothing"], JsonValue::Null);
  // 两个没名字的列都在，没有互相覆盖
  assert_eq!(row["(No column name)"], json!(2));
  assert_eq!(row["(No column name) 2"], json!(4));
}

#[tokio::test]
async fn sql_server_reports_affected_rows_and_runs_batches_that_must_stand_alone() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool).await;
  // 用例开头清掉上一次失败留下的表：测试库是共享的
  connection
    .execute(
      "IF OBJECT_ID('dbo.dataomni_smoke_rows') IS NOT NULL DROP TABLE dbo.dataomni_smoke_rows",
      10,
    )
    .await
    .expect("drop leftover");
  connection
    .execute(
      "IF OBJECT_ID('dbo.dataomni_smoke_proc') IS NOT NULL DROP PROCEDURE dbo.dataomni_smoke_proc",
      10,
    )
    .await
    .expect("drop leftover procedure");

  assert_eq!(
    affected_of(
      connection
        .execute("CREATE TABLE dbo.dataomni_smoke_rows (id int PRIMARY KEY, v nvarchar(10))", 10)
        .await
        .expect("create")
    ),
    0
  );
  assert_eq!(
    affected_of(
      connection
        .execute("INSERT INTO dbo.dataomni_smoke_rows VALUES (1, N'a'), (2, N'b'), (3, N'c')", 10)
        .await
        .expect("insert")
    ),
    3
  );
  assert_eq!(
    affected_of(
      connection
        .execute("UPDATE dbo.dataomni_smoke_rows SET v = N'z' WHERE id >= 2", 10)
        .await
        .expect("update")
    ),
    2
  );

  // 取影响行数的那一句必须另发一批：拼进同一批的话，它会被存成过程体的一部分
  connection
    .execute("CREATE PROCEDURE dbo.dataomni_smoke_proc AS SELECT COUNT(*) AS n FROM dbo.dataomni_smoke_rows", 10)
    .await
    .expect("create procedure");
  let definition = rows_of(
    connection
      .execute("SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.dataomni_smoke_proc')) AS body", 10)
      .await
      .expect("read procedure body"),
  );
  let body = text(&definition[0]["body"]);
  assert!(!body.contains("@@ROWCOUNT"), "过程体里混进了补上去的语句: {body}");
  let called = rows_of(connection.execute("EXEC dbo.dataomni_smoke_proc", 10).await.expect("call"));
  assert_eq!(called[0]["n"], json!(3));

  connection.execute("DROP PROCEDURE dbo.dataomni_smoke_proc", 10).await.expect("cleanup");
  connection.execute("DROP TABLE dbo.dataomni_smoke_rows", 10).await.expect("cleanup");
}

#[tokio::test]
async fn sql_server_errors_carry_the_error_number_and_point_at_the_line() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool).await;
  let missing = connection
    .execute("SELECT 1\nFROM dataomni_no_such_table", 10)
    .await
    .expect_err("missing table");
  assert_eq!(missing.code.as_deref(), Some("208"), "{missing:?}");
  assert!(missing.message.contains("dataomni_no_such_table"), "{missing:?}");
  // 找不到对象时 SQL Server 报的是**语句开头**那一行，不是对象名那一行
  assert_eq!(missing.position(), Some(1), "{missing:?}");

  // 语法错误报的是出错的那一行：跳过去正好落在第二行开头。报错的原文也必须
  // 只说用户写的东西——此前在语句后面补过一句行数查询，这里报的是「';' 附近」
  let syntax =
    connection.execute("SELECT name\nFROM sys.objects WHERE", 10).await.expect_err("syntax error");
  assert_eq!(syntax.code.as_deref(), Some("102"), "{syntax:?}");
  assert_eq!(syntax.position(), Some(13), "{syntax:?}");
  assert!(syntax.message.contains("WHERE"), "{syntax:?}");

  // 出过错的连接照样能用
  let rows = rows_of(connection.execute("SELECT 1 AS ok", 10).await.expect("still usable"));
  assert_eq!(rows[0]["ok"], json!(1));
}

#[tokio::test]
async fn sql_server_truncates_at_the_row_limit_and_the_connection_stays_usable() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool).await;
  let mut rows = Vec::new();
  let summary = connection
    .execute_streaming(
      "SELECT TOP 50 o.object_id FROM sys.all_objects o",
      StreamOptions::limited(3, 16 * 1024 * 1024, 2),
      &mut |batch| {
        rows.extend(batch.rows);
        Ok(())
      },
    )
    .await
    .expect("stream");
  let QueryExecutionSummary::Rows { row_count, truncated, truncation_reason, .. } = summary else {
    panic!("expected rows");
  };
  assert_eq!((row_count, rows.len()), (3, 3));
  assert!(truncated);
  assert_eq!(truncation_reason, Some(QueryTruncationReason::RowLimit));
  // 截断之后剩下的行要读完，否则这条连接上的下一条语句拿到的是上一条的残余
  let next = rows_of(connection.execute("SELECT 7 AS n", 10).await.expect("next statement"));
  assert_eq!(next[0]["n"], json!(7));
}

/// 超时之后：会话马上能用，**服务端的那条语句也停了**。
///
/// 后一半是要紧的：tiberius 不发 attention 包，只放弃 future 的话那条
/// `WAITFOR` 会在服务端一直跑到底，同一连接上的下一条要排在它后面。
#[tokio::test]
async fn sql_server_timeout_closes_the_connection_so_the_server_stops_the_statement() {
  let Some(pool) = pool().await else { return };
  let sessions = QuerySessionState::default();
  let options = |sql, timeout| StreamingQueryOptions {
    session_id: "sql-server-timeout",
    pool_key: "sqlserver://smoke",
    pool: PoolRef::SqlServer(&pool),
    sql,
    autocommit: true,
    assume_rows: false,
    row_limit: 10,
    byte_limit: 16 * 1024 * 1024,
    batch_size: 10,
    timeout_duration: timeout,
  };

  let error = sessions
    .execute_streaming(
      options("WAITFOR DELAY '00:00:20'; SELECT 1 AS late", Duration::from_millis(500)),
      &mut |_| Ok(()),
    )
    .await
    .expect_err("times out");
  assert_eq!(error.code.as_deref(), Some(QUERY_TIMEOUT_CODE));

  let started = Instant::now();
  let mut rows = Vec::new();
  sessions
    .execute_streaming(options("SELECT 1 AS ok", Duration::from_secs(10)), &mut |batch| {
      rows.extend(batch.rows);
      Ok(())
    })
    .await
    .expect("session usable after timeout");
  assert_eq!(rows[0]["ok"], json!(1));
  assert!(
    started.elapsed() < Duration::from_secs(5),
    "下一条排在被放弃的那条后面: {:?}",
    started.elapsed()
  );

  // 服务端那边：不该还有一条 WAITFOR 在跑
  tokio::time::sleep(Duration::from_millis(500)).await;
  let waiting = pool
    .select(
      "SELECT COUNT(*) AS n FROM sys.dm_exec_requests r
       CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
       WHERE r.wait_type = 'WAITFOR' AND t.text LIKE '%SELECT 1 AS late%'",
      &[],
    )
    .await
    .expect("inspect requests");
  assert_eq!(waiting[0]["n"], json!(0), "被放弃的语句还在服务端跑");
}

// ---------------------------------------------------------------------------
// 目录查询。夹具的陷阱和 MySQL / PostgreSQL 那一组相同：复合外键的列在表里
// 声明的次序和键内次序相反（ref_b 在 ref_a 前面）；复合主键与复合唯一键的
// 列序；外加 SQL Server 特有的 identity、计算列、带过滤条件的索引、同时挂在
// 两种事件上的触发器。
// ---------------------------------------------------------------------------

const META_SCHEMA: &str = "dataomni_meta";

async fn run_all(pool: &Arc<SqlServerPool>, statements: &[&str]) {
  let mut connection = session(pool).await;
  for statement in statements {
    connection
      .execute(statement, 10)
      .await
      .unwrap_or_else(|error| panic!("{statement}: {error:?}"));
  }
}

async fn meta_fixture(pool: &Arc<SqlServerPool>) {
  run_all(
    pool,
    &[
      "IF OBJECT_ID('dataomni_meta.v_child') IS NOT NULL DROP VIEW dataomni_meta.v_child",
      "IF OBJECT_ID('dataomni_meta.p_child') IS NOT NULL DROP PROCEDURE dataomni_meta.p_child",
      "IF OBJECT_ID('dataomni_meta.f_one') IS NOT NULL DROP FUNCTION dataomni_meta.f_one",
      "IF OBJECT_ID('dataomni_meta.child') IS NOT NULL DROP TABLE dataomni_meta.child",
      "IF OBJECT_ID('dataomni_meta.parent') IS NOT NULL DROP TABLE dataomni_meta.parent",
      "IF OBJECT_ID('dataomni_meta.s_seq') IS NOT NULL DROP SEQUENCE dataomni_meta.s_seq",
      "IF SCHEMA_ID('dataomni_meta') IS NULL EXEC('CREATE SCHEMA dataomni_meta')",
      "CREATE TABLE dataomni_meta.parent (
         x int NOT NULL,
         y int NOT NULL,
         label nvarchar(32) NOT NULL,
         score decimal(10,2) NULL DEFAULT 0,
         CONSTRAINT pk_parent PRIMARY KEY (x, y),
         CONSTRAINT uq_parent UNIQUE (label, score)
       )",
      "CREATE TABLE dataomni_meta.child (
         id int IDENTITY(1,1) NOT NULL CONSTRAINT pk_child PRIMARY KEY,
         ref_b int NOT NULL,
         ref_a int NOT NULL,
         note varchar(max) NULL,
         created datetime2(3) NOT NULL DEFAULT SYSDATETIME(),
         total AS (ref_a + ref_b),
         CONSTRAINT fk_child_parent FOREIGN KEY (ref_a, ref_b)
           REFERENCES dataomni_meta.parent (x, y) ON DELETE CASCADE,
         CONSTRAINT ck_child_ref CHECK (ref_a > 0)
       )",
      "CREATE INDEX ix_child_big ON dataomni_meta.child (ref_a) INCLUDE (note) WHERE ref_a > 10",
      "CREATE TRIGGER dataomni_meta.tr_child ON dataomni_meta.child AFTER INSERT, UPDATE AS SET NOCOUNT ON",
      "CREATE VIEW dataomni_meta.v_child AS SELECT id, ref_a FROM dataomni_meta.child",
      "CREATE PROCEDURE dataomni_meta.p_child AS SELECT 1 AS one",
      "CREATE FUNCTION dataomni_meta.f_one() RETURNS int AS BEGIN RETURN 1 END",
      "CREATE SEQUENCE dataomni_meta.s_seq START WITH 5 INCREMENT BY 2",
    ],
  )
  .await;
}

fn find<'a>(rows: &'a [QueryRow], column: &str, value: &str) -> Vec<&'a QueryRow> {
  rows.iter().filter(|row| text(&row[column]) == value).collect()
}

/// 这一条把所有目录查询一次跑完：它们共用一个夹具，而建夹具本身要十几条 DDL。
#[tokio::test]
async fn sql_server_catalog_queries_describe_the_fixture() {
  let Some(pool) = pool().await else { return };
  meta_fixture(&pool).await;
  let queries = schema_metadata_queries(&DatabaseType::SqlServer).expect("supported");
  let params = |table: &str| [json!(table), json!(META_SCHEMA)];

  // 列
  let columns = pool.select(queries.columns, &params("child")).await.expect("columns");
  let names: Vec<String> = columns.iter().map(|row| text(&row["column_name"])).collect();
  assert_eq!(names, ["id", "ref_b", "ref_a", "note", "created", "total"]);
  let by_name =
    |name: &str| columns.iter().find(|row| text(&row["column_name"]) == name).expect(name);
  assert_eq!(text(&by_name("id")["data_type"]), "int");
  assert_eq!(text(&by_name("note")["data_type"]), "varchar(max)");
  assert_eq!(text(&by_name("created")["data_type"]), "datetime2(3)");
  assert_eq!(by_name("id")["is_primary_key"], json!(true));
  assert_eq!(by_name("id")["primary_key_ordinal"], json!(1));
  // identity 与计算列都由数据库产生；有默认值的普通列不是
  assert_eq!(by_name("id")["is_generated"], json!(true));
  assert_eq!(by_name("total")["is_generated"], json!(true));
  assert_eq!(by_name("created")["is_generated"], json!(false));
  assert!(text(&by_name("created")["column_default"]).to_lowercase().contains("sysdatetime"));
  assert_eq!(by_name("note")["is_nullable"], json!(true));
  assert_eq!(by_name("ref_a")["is_nullable"], json!(false));

  let parent = pool.select(queries.columns, &params("parent")).await.expect("parent columns");
  let parent_type = |name: &str| {
    parent.iter().find(|row| text(&row["column_name"]) == name).map(|row| text(&row["data_type"]))
  };
  assert_eq!(parent_type("label").as_deref(), Some("nvarchar(32)"));
  assert_eq!(parent_type("score").as_deref(), Some("decimal(10,2)"));
  let pk: Vec<(String, JsonValue)> = parent
    .iter()
    .filter(|row| row["is_primary_key"] == json!(true))
    .map(|row| (text(&row["column_name"]), row["primary_key_ordinal"].clone()))
    .collect();
  assert_eq!(pk, [("x".to_string(), json!(1)), ("y".to_string(), json!(2))]);

  // 索引
  let indexes = pool.select(queries.indexes, &params("parent")).await.expect("indexes");
  let columns_of = |rows: &[QueryRow], index: &str| -> Vec<String> {
    find(rows, "index_name", index).iter().map(|row| text(&row["column_name"])).collect()
  };
  assert_eq!(columns_of(&indexes, "pk_parent"), ["x", "y"]);
  assert_eq!(columns_of(&indexes, "uq_parent"), ["label", "score"]);
  let unique = find(&indexes, "index_name", "uq_parent")[0];
  assert_eq!(
    (unique["is_unique"].clone(), unique["is_primary"].clone()),
    (json!(true), json!(false))
  );
  let child_indexes = pool.select(queries.indexes, &params("child")).await.expect("child indexes");
  // INCLUDE 的列不是键的一部分
  assert_eq!(columns_of(&child_indexes, "ix_child_big"), ["ref_a"]);
  assert_eq!(find(&child_indexes, "index_name", "ix_child_big")[0]["is_partial"], json!(true));
  assert_eq!(find(&child_indexes, "index_name", "pk_child")[0]["is_valid"], json!(true));

  // 外键：按键内次序配对，不是按列在表里的次序
  let foreign_keys = pool.select(queries.foreign_keys, &params("child")).await.expect("fks");
  let pairs: Vec<(String, String)> = foreign_keys
    .iter()
    .map(|row| (text(&row["column_name"]), text(&row["referenced_column"])))
    .collect();
  assert_eq!(pairs, [("ref_a".into(), "x".into()), ("ref_b".into(), "y".into())]);
  assert_eq!(text(&foreign_keys[0]["on_delete"]), "CASCADE");
  assert_eq!(text(&foreign_keys[0]["on_update"]), "NO ACTION");
  assert_eq!(text(&foreign_keys[0]["referenced_schema"]), META_SCHEMA);

  // 检查约束、触发器
  let checks = pool
    .select(queries.check_constraints.expect("checks"), &params("child"))
    .await
    .expect("checks");
  assert_eq!(text(&checks[0]["constraint_name"]), "ck_child_ref");
  assert!(text(&checks[0]["expression"]).contains("ref_a"));
  let triggers = pool.select(queries.triggers, &params("child")).await.expect("triggers");
  assert_eq!(text(&triggers[0]["timing"]), "AFTER");
  let event = text(&triggers[0]["event"]);
  assert!(event.contains("INSERT") && event.contains("UPDATE"), "{event}");

  // 定义：视图有，表没有
  let Some(DdlQuery::Bound { sql: ddl }) = queries.ddl else { panic!("bound ddl") };
  let view = pool.select(ddl, &params("v_child")).await.expect("view ddl");
  assert!(text(&view[0]["sql"]).trim_start().to_uppercase().starts_with("CREATE VIEW"));
  assert!(pool.select(ddl, &params("child")).await.expect("table ddl").is_empty());

  // 对象目录
  let catalog = object_catalog_queries(&DatabaseType::SqlServer).expect("objects");
  let objects = pool.select(catalog.objects, &[]).await.expect("objects");
  let kind_of = |name: &str| {
    objects
      .iter()
      .find(|row| text(&row["object_schema"]) == META_SCHEMA && text(&row["object_name"]) == name)
      .map(|row| text(&row["object_kind"]))
  };
  for (name, expected) in [
    ("child", "table"),
    ("v_child", "view"),
    ("p_child", "procedure"),
    ("f_one", "function"),
    ("s_seq", "sequence"),
  ] {
    assert_eq!(kind_of(name).as_deref(), Some(expected), "{name}");
  }
  let id_of = |name: &str| {
    objects
      .iter()
      .find(|row| text(&row["object_schema"]) == META_SCHEMA && text(&row["object_name"]) == name)
      .map(|row| text(&row["object_id"]))
      .expect(name)
  };
  // 前端对非 PostgreSQL 的方言绑两个参数，第二个是库名
  let routine = pool
    .select(catalog.routine_definition, &[json!(id_of("p_child")), json!("dataomni_test")])
    .await
    .expect("routine definition");
  assert!(text(&routine[0]["definition"]).contains("SELECT 1 AS one"));
  let sequence = pool
    .select(catalog.sequence_properties.expect("sequences"), &[json!(id_of("s_seq"))])
    .await
    .expect("sequence");
  assert_eq!(
    (text(&sequence[0]["start_value"]), text(&sequence[0]["increment_by"])),
    ("5".into(), "2".into())
  );

  // ER 图、补全、会话位置
  let er = er_diagram_queries(&DatabaseType::SqlServer).expect("er");
  let er_columns = pool.select(er.columns, &[]).await.expect("er columns");
  assert!(er_columns
    .iter()
    .any(|row| text(&row["table_name"]) == "child" && text(&row["column_name"]) == "total"));
  assert!(
    !er_columns.iter().any(|row| text(&row["table_name"]) == "v_child"),
    "ER 图只画表，视图没有外键"
  );
  let er_keys = pool.select(er.foreign_keys, &[]).await.expect("er fks");
  assert_eq!(find(&er_keys, "constraint_name", "fk_child_parent").len(), 2);
  let completion = completion_catalog_query(&DatabaseType::SqlServer).expect("completion");
  let relations = pool.select(completion.relations, &[]).await.expect("relations");
  assert!(relations
    .iter()
    .any(|row| text(&row["relation_name"]) == "v_child" && text(&row["relation_kind"]) == "view"));
  let target = session_target_query(&DatabaseType::SqlServer).expect("target");
  let where_am_i = pool.select(target.sql, &[]).await.expect("session target");
  assert_eq!(text(&where_am_i[0]["schema_name"]), "dbo");
  assert_eq!(where_am_i[0]["read_only"], json!(false));
}
