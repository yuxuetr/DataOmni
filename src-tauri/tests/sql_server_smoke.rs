//! SQL Server 的真库用例。
//!
//! 和 `database_smoke.rs` 一样默认静默跳过；要跑就在 shell 里设
//! `DATAOMNI_SQLSERVER_TEST_URL=sqlserver://user:password@host:port/database`
//! （**不要写进任何文件**），并设 `DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS=1`
//! 让缺了连接串的时候报错而不是跳过。
//!
//! 要带 `-- --test-threads=1`：用例共用 `dataomni_import`、`dataomni_write` 这些表名，
//! 并行跑会互相撞上「There is already an object named …」。
//!
//! 单独一个文件而不是塞进 `database_smoke.rs`：那边全是 sqlx 的池子与插件的
//! `DbPool`，这边是后端自己持有的连接，两边的夹具没有一行能共用。

use dataomni_lib::models::ConnectionProfile;
use dataomni_lib::models::DatabaseType;
use dataomni_lib::services::{completion_catalog_query, er_diagram_queries, session_target_query};
use dataomni_lib::services::{execute_write_batch, ROW_COUNT_MISMATCH_CODE};
use dataomni_lib::services::{
  object_catalog_queries, schema_metadata_queries, sql_server, DdlQuery, PoolRef,
  QueryExecutionResult, QueryExecutionSummary, QueryRow, QuerySessionState, QueryTruncationReason,
  SessionConnection, SqlServerPool, SqlServerTarget, StreamOptions, StreamingQueryOptions,
  TransactionStatus, WriteStatement, QUERY_TIMEOUT_CODE,
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
  Some(SqlServerPool::new(target, client).await.expect("prepare pool"))
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

/// `datetime` 存的是离 1900-01-01 的天数，更早的是负数；而它的下限是 1753 年，
/// `1753-01-01` 还是常见的「最小日期」占位值。tiberius 把天数转成无符号再乘，
/// 这一格读不出来，整条查询（表数据页、导出）跟着报驱动错误
#[tokio::test]
async fn sql_server_reads_datetime_before_1900() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool).await;
  let rows = rows_of(
    connection
      .execute(
        "SELECT CAST('1753-01-01' AS datetime) AS floor_value,
           CAST('1899-12-31 23:59:59.997' AS datetime) AS eve,
           CAST('9999-12-31 23:59:59.997' AS datetime) AS ceiling_value",
        10,
      )
      .await
      .expect("read datetime before 1900"),
  );
  for (column, expected) in [
    ("floor_value", "1753-01-01 00:00:00"),
    ("eve", "1899-12-31 23:59:59.997"),
    ("ceiling_value", "9999-12-31 23:59:59.997"),
  ] {
    assert_eq!(text(&rows[0][column]), expected, "{column}");
  }
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
           CAST('2026-09-20 07:04:05.003' AS datetime) AS dt_tick,
           CAST('2026-09-20' AS date) AS d,
           CAST('07:04:05' AS time(0)) AS t,
           CAST('2026-09-20 07:04:05 +08:00' AS datetimeoffset(0)) AS dto,
           CAST('2026-09-20 07:04:05.1234567' AS datetime2(7)) AS dt2_full,
           CAST('07:04:05.1234567' AS time(7)) AS t_full,
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
    // 1/300 秒的刻度按毫秒写：`.003333` 写回 datetime 列会转换失败（241）
    ("dt_tick", "datetime", "2026-09-20 07:04:05.003"),
    ("d", "date", "2026-09-20"),
    ("t", "time", "07:04:05"),
    ("dto", "datetime", "2026-09-20 07:04:05 +08:00"),
    // 精确到 100 纳秒，第七位不能丢
    ("dt2_full", "datetime", "2026-09-20 07:04:05.1234567"),
    ("t_full", "time", "07:04:05.1234567"),
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

/// real 是单精度：直接转 f64 的话 0.1 成了 0.10000000149011612，SSMS 写的是 0.1
#[tokio::test]
async fn sql_server_reals_read_as_ssms_writes_them() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool).await;
  let rows = rows_of(
    connection
      .execute(
        "SELECT CAST(0.1 AS real) AS narrow, CAST(-3.4e38 AS real) AS low,
           CAST(1.17549435e-38 AS real) AS tiny, CAST(0.1 AS float) AS wide",
        100,
      )
      .await
      .expect("read reals"),
  );
  assert_eq!(rows[0]["narrow"], json!(0.1));
  assert_eq!(rows[0]["low"], json!(-3.4e38));
  assert_eq!(rows[0]["tiny"], json!(1.1754944e-38));
  assert_eq!(rows[0]["wide"], json!(0.1));
}

/// tiberius 把 money 解成 f64：大额的末几位不对，拿它当守卫比，那一行永远改不了。
/// 表数据页转成 decimal(19,4) 再取（`tableProjection`），这里用的是它生成的那条投影
#[tokio::test]
async fn sql_server_large_money_reads_exactly_through_the_table_projection() {
  let Some(pool) = pool().await else { return };
  run_all(
    &pool,
    &[
      "IF OBJECT_ID('dbo.om_money') IS NOT NULL DROP TABLE dbo.om_money",
      "CREATE TABLE dbo.om_money (id int PRIMARY KEY, m money, note nvarchar(20))",
      "INSERT INTO dbo.om_money (id, m) VALUES (1, 922337203685477.5807), (2, -922337203685477.5808),
       (3, 123456789012345.6789)",
    ],
  )
  .await;
  let mut connection = session(&pool).await;
  let driver = rows_of(
    connection.execute("SELECT * FROM dbo.om_money ORDER BY id", 100).await.expect("select *"),
  );
  let projected = rows_of(
    connection
      .execute(
        "SELECT [id], CAST([m] AS decimal(19,4)) AS [m], [note] FROM dbo.om_money ORDER BY [id]",
        100,
      )
      .await
      .expect("projection"),
  );
  assert_eq!(text(&projected[0]["m"]), "922337203685477.5807");
  assert_eq!(text(&projected[1]["m"]), "-922337203685477.5808");
  assert_eq!(text(&projected[2]["m"]), "123456789012345.6789");
  assert_ne!(text(&driver[2]["m"]), "123456789012345.6789", "驱动若已改成精确读，投影可以去掉");

  // 最大值那一行读成的 f64 已经超出 money 的范围，写回去报的是溢出（8115）；这里用范围内的那一行
  let guarded = |value: &JsonValue| {
    vec![write(
      "UPDATE [dbo].[om_money] SET [note] = N'x' WHERE [id] = 3 AND [m] = @P1",
      vec![json!(text(value))],
      Some(1),
    )]
  };
  let error = execute_write_batch(PoolRef::SqlServer(&pool), &guarded(&driver[2]["m"]))
    .await
    .expect_err("驱动读出的值比不上");
  assert_eq!(error.error.code.as_deref(), Some(ROW_COUNT_MISMATCH_CODE));
  execute_write_batch(PoolRef::SqlServer(&pool), &guarded(&projected[2]["m"]))
    .await
    .expect("投影读出的值比得上");
  run_all(&pool, &["DROP TABLE dbo.om_money"]).await;
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

  // USE 换的是会话连接的库，对象树与表数据还在原来的库上读——和 MySQL 一样拒绝
  let refused = connection.execute("USE master", 10).await.expect_err("USE is refused");
  assert_eq!(refused.message, dataomni_lib::services::USE_STATEMENT_REFUSED);

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

/// 一条语句返回几个结果集（`EXEC` 一个过程、`sp_help`）：只显示第一个，**而且要说还有几个**——
/// 之前后面的读掉就没了，界面上看不出少了东西。空的结果集也算一个
#[tokio::test]
async fn sql_server_counts_the_result_sets_it_does_not_show() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool).await;
  let mut rows = Vec::new();
  let summary = connection
    .execute_streaming(
      "SELECT 1 AS a; SELECT 2 AS b WHERE 1 = 0; SELECT 3 AS c",
      StreamOptions::limited(100, 16 * 1024 * 1024, 10),
      &mut |batch| {
        rows.extend(batch.rows);
        Ok(())
      },
    )
    .await
    .expect("stream");
  let QueryExecutionSummary::Rows { columns, omitted_result_sets, .. } = summary else {
    panic!("expected rows");
  };
  assert_eq!(columns, vec!["a".to_string()]);
  assert_eq!(rows.len(), 1);
  assert_eq!(omitted_result_sets, 2);
  let single = connection
    .execute_streaming(
      "SELECT 7 AS n",
      StreamOptions::limited(100, 16 * 1024 * 1024, 10),
      &mut |_| Ok(()),
    )
    .await
    .expect("single");
  let QueryExecutionSummary::Rows { omitted_result_sets, .. } = single else {
    panic!("expected rows");
  };
  assert_eq!(omitted_result_sets, 0);
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
    explain_plan: false,
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

/// 执行多久只由界面上的超时设置管：tiberius 0.13 起驱动自己默认每个往返最多等 30 秒，
/// 不关掉的话设了一分钟超时的语句到第 30 秒就报 TimedOut。
#[tokio::test]
async fn sql_server_statements_may_run_past_the_drivers_own_default_timeout() {
  let Some(pool) = pool().await else { return };
  let sessions = QuerySessionState::default();
  let mut rows = Vec::new();
  sessions
    .execute_streaming(
      StreamingQueryOptions {
        session_id: "sql-server-long",
        pool_key: "sqlserver://smoke-long",
        pool: PoolRef::SqlServer(&pool),
        sql: "WAITFOR DELAY '00:00:32'; SELECT 1 AS late",
        autocommit: true,
        explain_plan: false,
        row_limit: 10,
        byte_limit: 16 * 1024 * 1024,
        batch_size: 10,
        timeout_duration: Duration::from_secs(60),
      },
      &mut |batch| {
        rows.extend(batch.rows);
        Ok(())
      },
    )
    .await
    .expect("runs to the end within the app's own timeout");
  assert_eq!(rows[0]["late"], json!(1));
}

/// NVARCHAR 不检查 UTF-16 是否成对：`LEFT` 截在 emoji 的代理对中间，存下来的就是半个。
/// 驱动默认严格解码，一个这样的值整条查询报「invalid UTF-16 sequence」，同一张表、同一份结果
/// 别的行也看不到。解不出的部分换成 U+FFFD，与 SQLite 存了非 UTF-8 字节时一样。
#[tokio::test]
async fn sql_server_reads_a_half_surrogate_pair_as_a_replacement_character() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool).await;
  let rows = rows_of(
    connection
      .execute("SELECT LEFT(N'😀x', 1) + N'!' AS cut, N'fine' AS good", 10)
      .await
      .expect("a half surrogate pair does not fail the whole result"),
  );
  assert_eq!((&rows[0]["cut"], &rows[0]["good"]), (&json!("\u{fffd}!"), &json!("fine")));
  let catalog = pool.select("SELECT LEFT(N'😀x', 1) AS cut", &[]).await.expect("catalog path");
  assert_eq!(catalog[0]["cut"], json!("\u{fffd}"));
}

/// 图表的伪列（`$node_id`、`$edge_id`、`$from_id`、`$to_id`）在列元数据里带着一个 TDS 没有
/// 定义的标志位，tiberius 0.12 遇到不认识的位整个结果报「column metadata: invalid flags」——
/// 节点表与边表 `SELECT *` 都读不出来。0.13 起忽略不认识的位。
#[tokio::test]
async fn sql_server_reads_graph_pseudo_columns() {
  let Some(pool) = pool().await else { return };
  let drop =
    ["DROP TABLE IF EXISTS dbo.smoke_graph_edge", "DROP TABLE IF EXISTS dbo.smoke_graph_node"];
  run_all(&pool, &drop).await;
  run_all(
    &pool,
    &[
      "CREATE TABLE dbo.smoke_graph_node (id int PRIMARY KEY) AS NODE",
      "CREATE TABLE dbo.smoke_graph_edge AS EDGE",
      "INSERT INTO dbo.smoke_graph_node (id) VALUES (1), (2)",
      "INSERT INTO dbo.smoke_graph_edge VALUES ((SELECT $node_id FROM dbo.smoke_graph_node WHERE id = 1), \
       (SELECT $node_id FROM dbo.smoke_graph_node WHERE id = 2))",
    ],
  )
  .await;
  let nodes = pool.select("SELECT * FROM dbo.smoke_graph_node ORDER BY id", &[]).await;
  let edges = pool.select("SELECT $from_id AS from_id FROM dbo.smoke_graph_edge", &[]).await;
  run_all(&pool, &drop).await;
  let nodes = nodes.expect("read node table");
  let node_id =
    nodes[0].iter().find(|(name, _)| name.starts_with("$node_id")).map(|(_, value)| text(value));
  assert!(
    node_id.as_deref().is_some_and(|id| id.contains("\"id\":0")),
    "伪列的值是服务端拼的 JSON: {:?}",
    nodes[0]
  );
  assert!(text(&edges.expect("read edge table")[0]["from_id"]).contains("smoke_graph_node"));
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

/// 系统版本表的时间段列（`GENERATED ALWAYS AS ROW START / END`）由服务端写，显式给值是
/// 13536——和 identity 一样不能由调用方赋值，算作 `is_generated`。不算的话它们 NOT NULL
/// 又没有默认值，新增行时被当成必填项，导出的 INSERT 也带着它们、每一行都执行不回去。
#[tokio::test]
async fn sql_server_period_columns_count_as_generated() {
  let Some(pool) = pool().await else { return };
  let drop = [
    "IF OBJECT_ID(N'dbo.smoke_temporal') IS NOT NULL ALTER TABLE dbo.smoke_temporal SET (SYSTEM_VERSIONING = OFF)",
    "DROP TABLE IF EXISTS dbo.smoke_temporal",
    "DROP TABLE IF EXISTS dbo.smoke_temporal_history",
  ];
  run_all(&pool, &drop).await;
  run_all(
    &pool,
    &["CREATE TABLE dbo.smoke_temporal (id int PRIMARY KEY, \
       vf datetime2 GENERATED ALWAYS AS ROW START NOT NULL, \
       vt datetime2 GENERATED ALWAYS AS ROW END HIDDEN NOT NULL, \
       PERIOD FOR SYSTEM_TIME (vf, vt)) \
       WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.smoke_temporal_history))"],
  )
  .await;
  let queries = schema_metadata_queries(&DatabaseType::SqlServer).expect("supported");
  let columns =
    pool.select(queries.columns, &[json!("smoke_temporal"), json!("dbo")]).await.expect("columns");
  let generated: Vec<(String, JsonValue, JsonValue, JsonValue)> = columns
    .iter()
    .map(|row| {
      (
        text(&row["column_name"]),
        row["is_generated"].clone(),
        row["identity_generation"].clone(),
        row["column_extra"].clone(),
      )
    })
    .collect();
  run_all(&pool, &drop).await;
  // HIDDEN 的列 `SELECT *` 不展开，取表数据时要点名（`tableProjection`）
  assert_eq!(
    generated,
    [
      ("id".to_string(), json!(false), JsonValue::Null, JsonValue::Null),
      ("vf".to_string(), json!(true), JsonValue::Null, JsonValue::Null),
      ("vt".to_string(), json!(true), JsonValue::Null, json!("HIDDEN")),
    ]
  );
}

/// 图表（`AS NODE` / `AS EDGE`）的内部列（`graph_id_…`、`from_id_…` 这几列）`is_hidden`，
/// 点名取它报 13908「Cannot access internal graph column」——不排掉的话按 HIDDEN 点名取表数据，
/// 节点表与边表的数据页整个打不开。`$node_id` / `$edge_id` 由服务端写，算 `is_generated`；
/// `$from_id` / `$to_id` 是新增边时要给的，不算。
#[tokio::test]
async fn sql_server_graph_tables_hide_their_internal_columns() {
  let Some(pool) = pool().await else { return };
  let drop = ["DROP TABLE IF EXISTS dbo.smoke_likes", "DROP TABLE IF EXISTS dbo.smoke_person"];
  run_all(&pool, &drop).await;
  run_all(
    &pool,
    &[
      "CREATE TABLE dbo.smoke_person (id int PRIMARY KEY, name nvarchar(20)) AS NODE",
      "CREATE TABLE dbo.smoke_likes (rating int) AS EDGE",
      "INSERT INTO dbo.smoke_person (id, name) VALUES (1, N'a'), (2, N'b')",
      "INSERT INTO dbo.smoke_likes VALUES ((SELECT $node_id FROM dbo.smoke_person WHERE id = 1), \
       (SELECT $node_id FROM dbo.smoke_person WHERE id = 2), 5)",
    ],
  )
  .await;
  let queries = schema_metadata_queries(&DatabaseType::SqlServer).expect("supported");
  let mut seen: Vec<(String, String)> = Vec::new();
  for table in ["smoke_person", "smoke_likes"] {
    let columns =
      pool.select(queries.columns, &[json!(table), json!("dbo")]).await.expect("columns");
    let projection = columns
      .iter()
      .map(|row| format!("[{}]", text(&row["column_name"]).replace(']', "]]")))
      .collect::<Vec<_>>()
      .join(", ");
    // 数据页点名取的就是这些列
    let read = pool.select(&format!("SELECT {projection} FROM dbo.{table}"), &[]).await;
    seen.push((
      table.to_string(),
      read.map(|rows| format!("{} rows", rows.len())).unwrap_or_else(|error| format!("{error:?}")),
    ));
    for row in &columns {
      // 列名带一段随机的十六进制后缀，只比前两段
      let name = text(&row["column_name"]);
      let prefix = name.split('_').take(2).collect::<Vec<_>>().join("_");
      seen.push((prefix, row["is_generated"].to_string()));
    }
  }
  run_all(&pool, &drop).await;
  let expected = [
    ("smoke_person", "2 rows"),
    ("$node_id", "true"),
    ("id", "false"),
    ("name", "false"),
    ("smoke_likes", "1 rows"),
    ("$edge_id", "true"),
    ("$from_id", "false"),
    ("$to_id", "false"),
    ("rating", "false"),
  ]
  .map(|(label, value)| (label.to_string(), value.to_string()));
  assert_eq!(seen, expected);
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
  assert_eq!(
    (&by_name("id")["identity_generation"], &by_name("total")["identity_generation"]),
    (&json!("ALWAYS"), &JsonValue::Null)
  );
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

/// 会话选项要和 SSMS 一样开着 `QUOTED_IDENTIFIER` 与 ANSI 那几项：表上有过滤
/// 索引、计算列索引或索引视图时，这几项不对 SQL Server 直接拒绝写入（1934）。
/// sqlcmd 默认就是关着的——建这份夹具时实际撞上过。
#[tokio::test]
async fn sql_server_sessions_use_the_options_that_filtered_indexes_require() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool).await;
  let rows = rows_of(
    connection
      .execute(
        "SELECT
           CAST(SESSIONPROPERTY('QUOTED_IDENTIFIER') AS int) AS quoted_identifier,
           CAST(SESSIONPROPERTY('ANSI_NULLS') AS int) AS ansi_nulls,
           CAST(SESSIONPROPERTY('ANSI_PADDING') AS int) AS ansi_padding,
           CAST(SESSIONPROPERTY('ANSI_WARNINGS') AS int) AS ansi_warnings,
           CAST(SESSIONPROPERTY('CONCAT_NULL_YIELDS_NULL') AS int) AS concat_null_yields_null",
        10,
      )
      .await
      .expect("session options"),
  );
  for option in
    ["quoted_identifier", "ansi_nulls", "ansi_padding", "ansi_warnings", "concat_null_yields_null"]
  {
    assert_eq!(rows[0][option], json!(1), "{option} 没开");
  }
}

/// `sql_variant` 与 CLR 类型（hierarchyid、geography）：tiberius 0.12 读它们的列元数据时是
/// `todo!()`，整条查询 panic（接住之后报驱动失败）；0.13 起照底层类型解出来。
#[tokio::test]
async fn sql_server_reads_sql_variant_and_clr_columns() {
  let Some(pool) = pool().await else { return };
  let mut connection = session(&pool).await;
  let rows = rows_of(
    connection
      .execute(
        "SELECT SERVERPROPERTY('Edition') AS edition, CAST(7 AS sql_variant) AS i, \
         CAST(1.5 AS sql_variant) AS d, CAST(N'中' AS sql_variant) AS s, CAST(NULL AS sql_variant) AS n, \
         hierarchyid::Parse('/1/') AS h, geography::Point(1, 2, 4326) AS g",
        10,
      )
      .await
      .expect("sql_variant and CLR columns are readable"),
  );
  let row = &rows[0];
  assert!(text(&row["edition"]).contains("Developer"), "{row:?}");
  assert_eq!(
    [&row["i"], &row["d"], &row["s"], &row["n"]],
    [&json!(7), &json!({ "type": "decimal", "value": "1.5" }), &json!("中"), &JsonValue::Null]
  );
  // CLR 类型给的是它的二进制形态，与 SSMS 直接查出来的相同（hierarchyid `/1/` 是 0x58）
  assert_eq!(row["h"], json!({ "type": "binary", "value": "58" }));
  assert_eq!(row["g"]["type"], json!("binary"));
  // 目录查询那条路一样
  let catalog =
    pool.select("SELECT SERVERPROPERTY('Edition') AS edition", &[]).await.expect("catalog path");
  assert!(text(&catalog[0]["edition"]).contains("Developer"), "{catalog:?}");
}

// ---------------------------------------------------------------------------
// 第三阶段：网格的写入批次、会话事务、锁等待
// ---------------------------------------------------------------------------

/// 带一个每次更新都往审计表插三行的触发器。驱动报的 DONE 计数会是 1 和 3，
/// 「必须恰好改一行」按那个核对，这张表一行都改不了。
async fn write_fixture(pool: &Arc<SqlServerPool>) {
  run_all(
    pool,
    &[
      "IF OBJECT_ID('dbo.dataomni_write_audit') IS NOT NULL DROP TABLE dbo.dataomni_write_audit",
      "IF OBJECT_ID('dbo.dataomni_write') IS NOT NULL DROP TABLE dbo.dataomni_write",
      "CREATE TABLE dbo.dataomni_write (id int PRIMARY KEY, name nvarchar(20) NOT NULL, note nvarchar(20) NULL)",
      "CREATE TABLE dbo.dataomni_write_audit (id int IDENTITY PRIMARY KEY, note nvarchar(20))",
      "CREATE TRIGGER dbo.dataomni_write_trg ON dbo.dataomni_write AFTER UPDATE AS
       BEGIN INSERT INTO dbo.dataomni_write_audit (note) VALUES ('a'), ('b'), ('c') END",
      "INSERT INTO dbo.dataomni_write (id, name) VALUES (1, N'甲'), (2, N'乙')",
    ],
  )
  .await;
}

fn write(sql: &str, params: Vec<JsonValue>, expect_rows: Option<u64>) -> WriteStatement {
  WriteStatement { sql: sql.to_string(), params, expect_rows }
}

async fn names(pool: &Arc<SqlServerPool>) -> Vec<String> {
  pool
    .select("SELECT name FROM dbo.dataomni_write ORDER BY id", &[])
    .await
    .expect("read back")
    .iter()
    .map(|row| text(&row["name"]))
    .collect()
}

#[tokio::test]
async fn sql_server_write_batches_count_only_their_own_rows_and_roll_back_as_a_whole() {
  let Some(pool) = pool().await else { return };
  write_fixture(&pool).await;

  // 触发器插的三行不算：核对的是这条 UPDATE 自己改了几行
  let affected = execute_write_batch(
    PoolRef::SqlServer(&pool),
    &[
      write(
        "UPDATE [dbo].[dataomni_write] SET [name] = @P1 WHERE [id] = 1 AND [name] = @P2",
        vec![json!("丙"), json!("甲")],
        Some(1),
      ),
      write(
        "INSERT INTO [dbo].[dataomni_write] ([id], [name], [note]) VALUES (@P1, @P2, NULL)",
        vec![json!(3), json!("丁")],
        None,
      ),
    ],
  )
  .await
  .expect("batch commits");
  assert_eq!(affected, vec![1, 1]);
  assert_eq!(names(&pool).await, ["丙", "乙", "丁"]);

  // 第二条违反 NOT NULL：第一条也不能留下
  let error = execute_write_batch(
    PoolRef::SqlServer(&pool),
    &[
      write("DELETE FROM [dbo].[dataomni_write] WHERE [id] = 3", vec![], Some(1)),
      write("UPDATE [dbo].[dataomni_write] SET [name] = NULL WHERE [id] = 2", vec![], Some(1)),
    ],
  )
  .await
  .expect_err("second statement fails");
  assert_eq!(error.statement_index, 1);
  assert_eq!(error.error.code.as_deref(), Some("515"), "{:?}", error.error);
  assert_eq!(names(&pool).await, ["丙", "乙", "丁"], "第一条的 DELETE 必须回滚");

  // 那一行已经被别人改掉：零行匹配，整批回滚
  let error = execute_write_batch(
    PoolRef::SqlServer(&pool),
    &[
      write("DELETE FROM [dbo].[dataomni_write] WHERE [id] = 3", vec![], Some(1)),
      write(
        "UPDATE [dbo].[dataomni_write] SET [note] = N'x' WHERE [id] = 1 AND [name] = @P1",
        vec![json!("甲")],
        Some(1),
      ),
    ],
  )
  .await
  .expect_err("stale row");
  assert_eq!(error.statement_index, 1);
  assert_eq!(error.error.code.as_deref(), Some(ROW_COUNT_MISMATCH_CODE));
  assert_eq!(names(&pool).await, ["丙", "乙", "丁"]);

  // 用过的连接回到池子里，上面不能还开着事务——否则后面的目录查询都在
  // 一个没人会提交的事务里读
  let open = pool.select("SELECT CAST(@@TRANCOUNT AS int) AS n", &[]).await.expect("trancount");
  assert_eq!(open[0]["n"], json!(0));
}

fn session_options<'a>(
  pool: &'a Arc<SqlServerPool>,
  session_id: &'a str,
  sql: &'a str,
  autocommit: bool,
) -> StreamingQueryOptions<'a> {
  StreamingQueryOptions {
    session_id,
    pool_key: "sqlserver://smoke",
    pool: PoolRef::SqlServer(pool),
    sql,
    autocommit,
    explain_plan: false,
    row_limit: 100,
    byte_limit: 16 * 1024 * 1024,
    batch_size: 100,
    timeout_duration: Duration::from_secs(20),
  }
}

async fn run_in(
  sessions: &QuerySessionState,
  pool: &Arc<SqlServerPool>,
  session_id: &str,
  sql: &str,
  autocommit: bool,
) -> Result<QueryExecutionSummary, dataomni_lib::services::QueryError> {
  sessions
    .execute_streaming(session_options(pool, session_id, sql, autocommit), &mut |_| Ok(()))
    .await
}

/// 事务状态是服务端说的，不是从语句推的。
#[tokio::test]
async fn sql_server_session_transaction_state_follows_the_server() {
  let Some(pool) = pool().await else { return };
  write_fixture(&pool).await;
  let sessions = QuerySessionState::default();
  let id = "sql-server-transaction";

  run_in(&sessions, &pool, id, "BEGIN TRANSACTION", true).await.expect("begin");
  let begun = sessions.transaction(id).await;
  assert_eq!(begun.status, TransactionStatus::Active);
  assert!(begun.started_at.is_some());

  // 嵌套一层再提交一层：@@TRANCOUNT 还是 1，事务还开着，开始时间不变
  run_in(&sessions, &pool, id, "BEGIN TRAN", true).await.expect("nested begin");
  run_in(&sessions, &pool, id, "COMMIT", true).await.expect("inner commit");
  assert_eq!(sessions.transaction(id).await, begun);

  // 类型转换错误把整个事务回滚掉了，语句本身只是一条 SELECT。按语句推的
  // 状态会停在「事务中」
  run_in(&sessions, &pool, id, "UPDATE dbo.dataomni_write SET note = N'x' WHERE id = 1", true)
    .await
    .expect("update");
  run_in(&sessions, &pool, id, "SELECT CAST('abc' AS int)", true).await.expect_err("245");
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Idle);
  let notes =
    pool.select("SELECT note FROM dbo.dataomni_write WHERE id = 1", &[]).await.expect("n");
  assert_eq!(notes[0]["note"], JsonValue::Null, "服务端确实回滚了");

  // 关掉自动提交：`BEGIN TRY` 不是开事务，里面那条 DELETE 要被放进事务
  run_in(
    &sessions,
    &pool,
    id,
    "BEGIN TRY DELETE FROM dbo.dataomni_write WHERE id = 2 END TRY BEGIN CATCH END CATCH",
    false,
  )
  .await
  .expect("delete in try");
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Active);
  run_in(&sessions, &pool, id, "ROLLBACK", false).await.expect("rollback");
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Idle);
  assert_eq!(names(&pool).await, ["甲", "乙"], "那条 DELETE 该被回滚掉");

  // 事务里超时：连接被关掉，服务端回滚，状态也得回到空闲
  run_in(&sessions, &pool, id, "BEGIN TRANSACTION", true).await.expect("begin again");
  let error = sessions
    .execute_streaming(
      StreamingQueryOptions {
        timeout_duration: Duration::from_millis(300),
        ..session_options(&pool, id, "WAITFOR DELAY '00:00:10'", true)
      },
      &mut |_| Ok(()),
    )
    .await
    .expect_err("times out");
  assert_eq!(error.code.as_deref(), Some(QUERY_TIMEOUT_CODE));
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Idle);
}

/// 事务开着时会话被服务端结束（DBA `KILL`、故障转移、网络断开）：状态栏要回到
/// 无事务，下一条语句换一条连接照常跑，而不是一直报连接已断
#[tokio::test]
async fn sql_server_session_recovers_after_the_server_kills_it_mid_transaction() {
  let Some(pool) = pool().await else { return };
  write_fixture(&pool).await;
  let sessions = QuerySessionState::default();
  let id = "sql-server-killed";

  run_in(&sessions, &pool, id, "BEGIN TRANSACTION", true).await.expect("begin");
  run_in(&sessions, &pool, id, "UPDATE dbo.dataomni_write SET note = N'x' WHERE id = 1", true)
    .await
    .expect("update");
  let mut spid = String::new();
  sessions
    .execute_streaming(session_options(&pool, id, "SELECT @@SPID AS spid", true), &mut |batch| {
      spid = batch.rows[0].get("spid").map(text).unwrap_or_default();
      Ok(())
    })
    .await
    .expect("spid");
  run_all(&pool, &[&format!("KILL {spid}")]).await;

  let error = run_in(&sessions, &pool, id, "SELECT 1 AS one", true).await.expect_err("killed");
  assert_eq!(
    sessions.transaction(id).await.status,
    TransactionStatus::Idle,
    "连接没了，事务也就没了：{error:?}"
  );
  run_in(&sessions, &pool, id, "SELECT 1 AS one", true).await.expect("下一条换一条连接照常跑");
  let notes =
    pool.select("SELECT note FROM dbo.dataomni_write WHERE id = 1", &[]).await.expect("n");
  assert_eq!(notes[0]["note"], JsonValue::Null, "服务端回滚了事务");
  sessions.release(id).await;
}

/// SQL Server 的读已提交是加锁读：编辑器里开着一个改过这张表的事务时，表数据页
/// 的查询会一直等。等满了要报出来，而不是让界面停在「加载中」。
#[tokio::test]
async fn sql_server_catalog_reads_give_up_on_a_lock_instead_of_hanging() {
  let Some(pool) = pool().await else { return };
  write_fixture(&pool).await;
  let sessions = QuerySessionState::default();
  let id = "sql-server-lock-holder";

  run_in(&sessions, &pool, id, "BEGIN TRANSACTION", true).await.expect("begin");
  run_in(&sessions, &pool, id, "UPDATE dbo.dataomni_write SET note = N'held' WHERE id = 1", true)
    .await
    .expect("update");

  let started = Instant::now();
  let error = pool
    .select("SELECT * FROM dbo.dataomni_write ORDER BY id", &[])
    .await
    .expect_err("blocked read gives up");
  assert_eq!(error.code.as_deref(), Some("1222"), "{error:?}");
  assert!(started.elapsed() < Duration::from_secs(15), "{:?}", started.elapsed());

  run_in(&sessions, &pool, id, "ROLLBACK", true).await.expect("rollback");
  assert_eq!(names(&pool).await, ["甲", "乙"], "锁放开之后照常能读");
}

// ---------------------------------------------------------------------------
// 第四阶段
// ---------------------------------------------------------------------------

/// 执行计划：`SET SHOWPLAN_XML` 包住语句，只编译不执行。关键在「之后」：
/// 没关掉的话这条会话上后面每一条语句都只返回计划，而且看上去是成功的。
#[tokio::test]
async fn sql_server_plans_are_estimated_and_leave_the_session_as_it_was() {
  let Some(pool) = pool().await else { return };
  write_fixture(&pool).await;
  let sessions = QuerySessionState::default();
  let id = "sql-server-plan";

  run_in(&sessions, &pool, id, "BEGIN TRANSACTION", true).await.expect("begin");
  let sql = "DELETE FROM dbo.dataomni_write WHERE id = 1";
  let statement = dataomni_lib::services::explain_statement(&DatabaseType::SqlServer, sql, false)
    .expect("statement");
  let mut rows = Vec::new();
  sessions
    .execute_streaming(
      StreamingQueryOptions { explain_plan: true, ..session_options(&pool, id, &statement, true) },
      &mut |batch| {
        rows.extend(batch.rows);
        Ok(())
      },
    )
    .await
    .expect("plan");
  let plan =
    dataomni_lib::services::parse_plan(&DatabaseType::SqlServer, &rows, false).expect("parse plan");
  let root = &plan.roots[0];
  assert!(root.operation.contains("Delete"), "{root:?}");
  fn targets(node: &dataomni_lib::services::PlanNode, out: &mut Vec<String>) {
    out.extend(node.target.clone());
    node.children.iter().for_each(|child| targets(child, out));
  }
  let mut seen = Vec::new();
  targets(root, &mut seen);
  assert!(seen.iter().any(|target| target == "dbo.dataomni_write"), "{seen:?}");

  // 只编译没执行：那一行还在
  assert_eq!(names(&pool).await, ["甲", "乙"]);
  // SHOWPLAN 关掉了：普通语句拿回的是它自己的结果，不是一份计划
  let mut rows = Vec::new();
  sessions
    .execute_streaming(session_options(&pool, id, "SELECT 1 AS ok", true), &mut |batch| {
      rows.extend(batch.rows);
      Ok(())
    })
    .await
    .expect("plain select");
  assert_eq!(rows[0]["ok"], json!(1));
  // 事务还开着，还是原来那一个
  assert_eq!(sessions.transaction(id).await.status, TransactionStatus::Active);
  run_in(&sessions, &pool, id, "ROLLBACK", true).await.expect("rollback");
}

fn export_options() -> dataomni_lib::services::ExportOptions {
  dataomni_lib::services::ExportOptions {
    format: dataomni_lib::services::ExportFormat::Csv,
    delimiter: ",".to_string(),
    include_header: true,
    null_text: String::new(),
    byte_order_mark: false,
    sql_table: String::new(),
    sql_dialect: None,
    sql_computed_columns: Vec::new(),
    sql_identity_columns: Vec::new(),
    sql_sequence_columns: Vec::new(),
  }
}

/// 整表导出：列名在执行之前从 `sys.dm_exec_describe_first_result_set` 取；
/// 不返回结果集的语句一行都不执行；写错的语句报它自己的错，不是「不返回结果集」。
#[tokio::test]
async fn sql_server_exports_stream_to_a_file_and_refuse_non_queries_before_running_them() {
  let Some(pool) = pool().await else { return };
  write_fixture(&pool).await;
  let dir = std::env::temp_dir().join(format!("dataomni-mssql-export-{}", std::process::id()));
  std::fs::create_dir_all(&dir).expect("temp dir");
  let target = dir.join("out.csv");
  let export = |sql: &'static str| {
    let pool = Arc::clone(&pool);
    let target = target.clone();
    async move {
      dataomni_lib::services::export_query(
        PoolRef::SqlServer(&pool),
        sql,
        &target,
        export_options(),
        &mut |_| {},
        &mut || false,
      )
      .await
    }
  };

  let summary =
    export("SELECT id, name, note, CAST(1 AS int) + id FROM dbo.dataomni_write ORDER BY id")
      .await
      .expect("export");
  assert_eq!(summary.rows_written, 2);
  let contents = std::fs::read_to_string(&target).expect("read back");
  assert_eq!(contents, "id,name,note,(No column name)\n1,甲,,2\n2,乙,,3");

  let error = export("DELETE FROM dbo.dataomni_write").await.expect_err("refused");
  assert_eq!(error.message, dataomni_lib::services::query_executor::NON_QUERY_MESSAGE);
  assert_eq!(names(&pool).await, ["甲", "乙"], "拒绝之前不能已经删了");

  let error = export("SELECT * FROM dbo.no_such_table").await.expect_err("bad sql");
  assert_eq!(error.code.as_deref(), Some("208"), "{error:?}");
  std::fs::remove_dir_all(&dir).ok();
}

/// 导出把二进制写成 `0x…`，导回来是这几个字节；不像十六进制的文本存它自己的字节。
/// 绑进来的是 nvarchar，SQL Server 不肯隐式转成 varbinary，得由语句明说怎么转
#[tokio::test]
async fn sql_server_import_reads_exported_hex_into_varbinary() {
  let Some(pool) = pool().await else { return };
  run_all(
    &pool,
    &[
      "IF OBJECT_ID('dbo.dataomni_import_bin') IS NOT NULL DROP TABLE dbo.dataomni_import_bin",
      "CREATE TABLE dbo.dataomni_import_bin (id int PRIMARY KEY, data varbinary(max) NULL, fixed binary(5) NULL)",
    ],
  )
  .await;
  let path = std::env::temp_dir().join(format!("dataomni-mssql-bin-{}.csv", std::process::id()));
  std::fs::write(&path, "id,data,fixed\n1,0xdeadbeef00,0xdeadbeef00\n2,abc,abc\n3,0x,0x\n")
    .expect("write csv");
  let mut request = import_request(&path, dataomni_lib::services::ErrorPolicy::Abort);
  request.table = "dataomni_import_bin".into();
  request.columns = vec![
    dataomni_lib::services::csv_import::ImportColumn {
      source: 0,
      target: "id".into(),
      target_type: "int".into(),
    },
    dataomni_lib::services::csv_import::ImportColumn {
      source: 1,
      target: "data".into(),
      target_type: "varbinary(max)".into(),
    },
    dataomni_lib::services::csv_import::ImportColumn {
      source: 2,
      target: "fixed".into(),
      target_type: "binary(5)".into(),
    },
  ];
  let summary = run_import(&pool, &request).await;
  std::fs::remove_file(&path).ok();
  assert_eq!(summary.rows_failed, 0, "{:?}", summary.errors);
  let stored: Vec<(JsonValue, JsonValue)> = pool
    .select(
      "SELECT CONVERT(varchar(max), data, 2) AS d, CONVERT(varchar(max), fixed, 2) AS f \
       FROM dbo.dataomni_import_bin ORDER BY id",
      &[],
    )
    .await
    .expect("read back")
    .iter()
    .map(|row| (row["d"].clone(), row["f"].clone()))
    .collect();
  // binary(5) 定长：短的值在右边补零
  assert_eq!(
    stored,
    [
      (json!("DEADBEEF00"), json!("DEADBEEF00")),
      (json!("616263"), json!("6162630000")),
      (json!(""), json!("0000000000")),
    ]
  );
  run_all(&pool, &["DROP TABLE dbo.dataomni_import_bin"]).await;
}

async fn import_fixture(pool: &Arc<SqlServerPool>) {
  run_all(
    pool,
    &[
      "IF OBJECT_ID('dbo.dataomni_import') IS NOT NULL DROP TABLE dbo.dataomni_import",
      "CREATE TABLE dbo.dataomni_import (id int PRIMARY KEY, n int NOT NULL, at date NULL, name nvarchar(5) NULL)",
    ],
  )
  .await;
}

/// 两类错误混在一个文件里：类型转换（245 / 241，服务端会把整个事务回滚）与
/// 只终止语句的那几种（主键冲突、截断、非空）。
const IMPORT_CSV: &str = "id,n,at,name
1,10,2024-01-01,a
2,abc,2024-01-02,b
3,30,2024-13-45,c
1,40,,d
5,50,,toolong
6,,,f
7,70,2024-02-02,g
";

fn import_request(
  path: &std::path::Path,
  on_error: dataomni_lib::services::ErrorPolicy,
) -> dataomni_lib::services::ImportRequest {
  let column =
    |source, target: &str, target_type: &str| dataomni_lib::services::csv_import::ImportColumn {
      source,
      target: target.to_string(),
      target_type: target_type.to_string(),
    };
  dataomni_lib::services::ImportRequest {
    path: path.to_string_lossy().to_string(),
    schema: Some("dbo".into()),
    table: "dataomni_import".into(),
    csv: dataomni_lib::services::CsvOptions {
      delimiter: ",".into(),
      has_header: true,
      null_text: String::new(),
    },
    columns: vec![
      column(0, "id", "int"),
      column(1, "n", "int"),
      column(2, "at", "date"),
      column(3, "name", "nvarchar(5)"),
    ],
    batch_size: 3,
    strategy: dataomni_lib::services::TransactionStrategy::SingleTransaction,
    on_error,
  }
}

async fn run_import(
  pool: &Arc<SqlServerPool>,
  request: &dataomni_lib::services::ImportRequest,
) -> dataomni_lib::services::ImportSummary {
  dataomni_lib::services::import_csv(
    PoolRef::SqlServer(pool),
    request,
    &mut |_| {},
    &mut || false,
    &mut || false,
  )
  .await
  .expect("import runs")
}

async fn imported_ids(pool: &Arc<SqlServerPool>) -> Vec<i64> {
  pool
    .select("SELECT id FROM dbo.dataomni_import ORDER BY id", &[])
    .await
    .expect("read back")
    .iter()
    .filter_map(|row| row["id"].as_i64())
    .collect()
}

#[tokio::test]
async fn sql_server_import_skips_bad_rows_without_losing_the_transaction() {
  let Some(pool) = pool().await else { return };
  import_fixture(&pool).await;
  let path = std::env::temp_dir().join(format!("dataomni-mssql-import-{}.csv", std::process::id()));
  std::fs::write(&path, IMPORT_CSV).expect("write csv");

  let summary =
    run_import(&pool, &import_request(&path, dataomni_lib::services::ErrorPolicy::Skip)).await;
  assert!(!summary.rolled_back, "{summary:?}");
  assert_eq!(summary.rows_read, 7);
  assert_eq!(summary.rows_inserted, 2, "{summary:?}");
  assert_eq!(summary.rows_failed, 5);
  // 单事务：要是 245 把事务带走了，1 号那行也不会在
  assert_eq!(imported_ids(&pool).await, [1, 7]);

  let by_line = |line: u64| {
    summary.errors.iter().find(|error| error.line == line).map(|error| error.message.clone())
  };
  let conversion = dataomni_lib::services::csv_import::CSV_VALUE_NOT_CONVERTIBLE;
  assert!(
    by_line(3).is_some_and(|m| m.starts_with(conversion) && m.contains("abc")),
    "{:?}",
    by_line(3)
  );
  assert!(by_line(4).is_some_and(|m| m.starts_with(conversion) && m.contains("2024-13-45")));
  assert!(by_line(5).is_some_and(|m| m.contains("PRIMARY KEY")), "{:?}", by_line(5));
  assert!(by_line(6).is_some_and(|m| m.contains("truncated")), "{:?}", by_line(6));
  assert!(by_line(7).is_some_and(|m| m.contains("NULL")), "{:?}", by_line(7));
  std::fs::remove_file(&path).ok();
}

#[tokio::test]
async fn sql_server_import_aborts_on_the_first_bad_row_and_leaves_nothing_behind() {
  let Some(pool) = pool().await else { return };
  import_fixture(&pool).await;
  let path =
    std::env::temp_dir().join(format!("dataomni-mssql-import-abort-{}.csv", std::process::id()));
  std::fs::write(&path, IMPORT_CSV).expect("write csv");

  let summary =
    run_import(&pool, &import_request(&path, dataomni_lib::services::ErrorPolicy::Abort)).await;
  assert!(summary.rolled_back);
  assert_eq!(summary.rows_inserted, 0);
  assert_eq!(summary.errors.len(), 1);
  assert_eq!(summary.errors[0].line, 3, "{:?}", summary.errors);
  assert!(imported_ids(&pool).await.is_empty());
  std::fs::remove_file(&path).ok();
}

#[path = "support/ddl_corpus.rs"]
mod ddl_corpus;

async fn sql_server_catalog_columns(
  pool: &Arc<SqlServerPool>,
  table: &str,
) -> Vec<ddl_corpus::Column> {
  let queries = schema_metadata_queries(&DatabaseType::SqlServer).expect("SQL Server catalog");
  pool
    .select(queries.columns, &[json!(table), json!("dbo")])
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

/// 改结构语料的 SQL Server 用例：语句走的是界面上同一条路——`execute_write_batch`，
/// 一个事务，每条语句后面拼着 `@@ROWCOUNT`——跑完再读列目录核对。
#[tokio::test]
async fn sql_server_runs_the_generated_ddl_from_the_shared_corpus() {
  let Some(pool) = pool().await else { return };
  // 没写 COLLATE 的列拿的是库的默认排序规则。语料照默认安装写，换成这台
  // 服务端的默认值再比——换的是期望，不是数据库给的结果
  let default_collation = pool
    .select("SELECT CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128)) AS c", &[])
    .await
    .expect("default collation")[0]["c"]
    .as_str()
    .unwrap_or_default()
    .to_string();
  let expected = |columns: &[ddl_corpus::Column]| -> Vec<ddl_corpus::Column> {
    columns
      .iter()
      .cloned()
      .map(|mut column| {
        if column.collation.as_deref() == Some("SQL_Latin1_General_CP1_CI_AS") {
          column.collation = Some(default_collation.clone());
        }
        column
      })
      .collect()
  };

  let cases = ddl_corpus::load("sqlserver");
  assert!(!cases.is_empty(), "语料里要有 SQL Server 的用例");
  for case in cases {
    run_all(&pool, &case.fixture.iter().map(String::as_str).collect::<Vec<_>>()).await;
    if !case.origin.is_empty() {
      let origin = sql_server_catalog_columns(&pool, &case.table).await;
      assert_eq!(
        origin,
        expected(&case.origin),
        "{}: 语料里的 origin 和数据库给的对不上",
        case.name
      );
    }

    let statements: Vec<WriteStatement> =
      case.statements.iter().map(|sql| write(sql, Vec::new(), None)).collect();
    execute_write_batch(PoolRef::SqlServer(&pool), &statements).await.unwrap_or_else(|error| {
      panic!(
        "{}: 生成的语句跑不了（第 {} 条）\n{:?}",
        case.name, error.statement_index, error.error
      )
    });
    run_all(&pool, &case.insert.iter().map(String::as_str).collect::<Vec<_>>()).await;

    let after = sql_server_catalog_columns(&pool, &case.final_table).await;
    assert_eq!(after, expected(&case.after), "{}: 跑完之后的表和语料说的不一样", case.name);
    run_all(&pool, &case.cleanup.iter().map(String::as_str).collect::<Vec<_>>()).await;
  }
}

/// 对象级结构操作语料的 SQL Server 用例：语句走界面上同一条路（`execute_write_batch`）
#[path = "support/object_ddl_corpus.rs"]
mod object_ddl_corpus;

#[tokio::test]
async fn sql_server_runs_the_object_ddl_corpus() {
  let Some(pool) = pool().await else { return };
  let schema = pool.select("SELECT SCHEMA_NAME() AS s", &[]).await.expect("default schema")[0]["s"]
    .as_str()
    .unwrap_or_default()
    .to_string();
  for case in object_ddl_corpus::load("sqlserver") {
    if let Some(written) = &case.schema {
      assert_eq!(written, &schema, "{}: 语料写死的 schema", case.name);
    }
    run_all(&pool, &case.fixture.iter().map(String::as_str).collect::<Vec<_>>()).await;
    execute_write_batch(PoolRef::SqlServer(&pool), &[write(&case.statement, Vec::new(), None)])
      .await
      .unwrap_or_else(|error| panic!("{}: 生成的语句跑不了\n{:?}", case.name, error.error));
    let rows = pool.select(&case.check, &[]).await.expect("核对查询");
    let found = rows[0].values().next().and_then(JsonValue::as_i64);
    assert_eq!(found, Some(case.expect), "{}: 跑完之后的结果和语料说的不一样", case.name);
    run_all(&pool, &case.cleanup.iter().map(String::as_str).collect::<Vec<_>>()).await;
  }
}
