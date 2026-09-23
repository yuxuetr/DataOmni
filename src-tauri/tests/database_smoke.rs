use dataomni_lib::services::{
  execute_query, execute_query_with_limit, execute_query_with_limits, execute_query_with_timeout,
  export_query, ExportFormat, ExportOptions, ExportSummary, QueryError, QueryExecutionResult,
  QueryExecutionSummary, QuerySessionState, QueryTruncationReason, StreamingQueryOptions,
  NON_QUERY_MESSAGE, QUERY_TIMEOUT_CODE,
};
use sqlx::{
  mysql::MySqlPoolOptions, postgres::PgPoolOptions, sqlite::SqlitePoolOptions, Column, Row,
  TypeInfo,
};
use std::time::Duration;
use tauri_plugin_sql::DbPool;

const REQUIRE_NETWORK_DATABASES_ENV: &str = "DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS";
const MYSQL_URL_ENV: &str = "DATAOMNI_MYSQL_TEST_URL";
const POSTGRES_URL_ENV: &str = "DATAOMNI_POSTGRES_TEST_URL";

#[tokio::test]
async fn sqlite_supports_basic_read_write() {
  let pool = SqlitePoolOptions::new()
    .max_connections(1)
    .connect("sqlite::memory:")
    .await
    .expect("connect to in-memory SQLite");

  sqlx::query("CREATE TABLE smoke_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
    .execute(&pool)
    .await
    .expect("create SQLite smoke table");
  sqlx::query("INSERT INTO smoke_test (value) VALUES (?)")
    .bind("ready")
    .execute(&pool)
    .await
    .expect("insert SQLite smoke row");

  let value: String = sqlx::query_scalar("SELECT value FROM smoke_test WHERE id = 1")
    .fetch_one(&pool)
    .await
    .expect("read SQLite smoke row");

  assert_eq!(value, "ready");

  let result =
    execute_query(&DbPool::Sqlite(pool.clone()), "SELECT value FROM smoke_test WHERE id = -1")
      .await
      .expect("describe empty SQLite result");
  assert_empty_row_result(result, "value");

  assert_truncated_result(
    execute_query_with_limit(
      &DbPool::Sqlite(pool.clone()),
      "SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3",
      2,
    )
    .await
    .expect("limit SQLite result"),
    2,
  );
  assert_byte_limited_result(
    execute_query_with_limits(&DbPool::Sqlite(pool.clone()), "SELECT 'too large' AS value", 100, 1)
      .await
      .expect("limit SQLite result bytes"),
  );
  let precise = execute_query(
    &DbPool::Sqlite(pool),
    "SELECT 9007199254740993 AS large_integer, X'00ff10' AS binary_value",
  )
  .await
  .expect("read precise SQLite values");
  assert_tagged_values(
    precise,
    &[("large_integer", "bigint", "9007199254740993"), ("binary_value", "binary", "00ff10")],
  );
}

#[tokio::test]
async fn postgres_supports_basic_read_write() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool = PgPoolOptions::new()
    .max_connections(1)
    .connect(&url)
    .await
    .expect("connect to PostgreSQL smoke database");

  sqlx::query("CREATE TEMP TABLE smoke_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
    .execute(&pool)
    .await
    .expect("create PostgreSQL smoke table");
  sqlx::query("INSERT INTO smoke_test (id, value) VALUES ($1, $2)")
    .bind(1_i32)
    .bind("ready")
    .execute(&pool)
    .await
    .expect("insert PostgreSQL smoke row");

  let value: String = sqlx::query_scalar("SELECT value FROM smoke_test WHERE id = $1")
    .bind(1_i32)
    .fetch_one(&pool)
    .await
    .expect("read PostgreSQL smoke row");

  assert_eq!(value, "ready");

  let result = execute_query(
    &DbPool::Postgres(pool.clone()),
    "UPDATE smoke_test SET value = 'updated' WHERE id = 1 RETURNING value",
  )
  .await
  .expect("execute PostgreSQL returning query");
  assert_single_row_result(result, "value", "updated");

  assert_query_times_out(
    execute_query_with_timeout(
      &DbPool::Postgres(pool.clone()),
      "SELECT pg_sleep(1)",
      Duration::from_millis(20),
    )
    .await,
  );
  assert_truncated_result(
    execute_query_with_limit(
      &DbPool::Postgres(pool.clone()),
      "SELECT value FROM generate_series(1, 3) AS value",
      2,
    )
    .await
    .expect("limit PostgreSQL result"),
    2,
  );
  assert_byte_limited_result(
    execute_query_with_limits(
      &DbPool::Postgres(pool.clone()),
      "SELECT 'too large'::text AS value",
      100,
      1,
    )
    .await
    .expect("limit PostgreSQL result bytes"),
  );
  let precise = execute_query(
    &DbPool::Postgres(pool.clone()),
    "SELECT 9007199254740993::BIGINT AS large_integer, 12345678901234567890.12345678::NUMERIC AS decimal_value, '2026-09-18 10:00:00+08'::TIMESTAMPTZ AS zoned_time, decode('00ff10', 'hex') AS binary_value, '{\"enabled\":true}'::JSONB AS json_value",
  )
  .await
  .expect("read precise PostgreSQL values");
  assert_tagged_values(
    precise,
    &[
      ("large_integer", "bigint", "9007199254740993"),
      ("decimal_value", "decimal", "12345678901234567890.12345678"),
      ("zoned_time", "datetime", "2026-09-18T02:00:00+00:00"),
      ("binary_value", "binary", "00ff10"),
      ("json_value", "json", "{\"enabled\":true}"),
    ],
  );

  assert_transaction_binding(
    &QuerySessionState::default(),
    "postgres-session",
    &url,
    &DbPool::Postgres(pool),
    "CREATE TEMP TABLE transaction_binding_test (value TEXT NOT NULL)",
    "INSERT INTO transaction_binding_test (value) VALUES ('pending')",
  )
  .await;
}

#[tokio::test]
async fn mysql_supports_basic_read_write() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool = MySqlPoolOptions::new()
    .max_connections(1)
    .connect(&url)
    .await
    .expect("connect to MySQL smoke database");

  sqlx::query("CREATE TEMPORARY TABLE smoke_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
    .execute(&pool)
    .await
    .expect("create MySQL smoke table");
  sqlx::query("INSERT INTO smoke_test (id, value) VALUES (?, ?)")
    .bind(1_i32)
    .bind("ready")
    .execute(&pool)
    .await
    .expect("insert MySQL smoke row");

  let value: String = sqlx::query_scalar("SELECT value FROM smoke_test WHERE id = ?")
    .bind(1_i32)
    .fetch_one(&pool)
    .await
    .expect("read MySQL smoke row");

  assert_eq!(value, "ready");

  let result =
    execute_query(&DbPool::MySql(pool.clone()), "SELECT value FROM smoke_test WHERE id = -1")
      .await
      .expect("describe empty MySQL result");
  assert_empty_row_result(result, "value");

  assert_query_times_out(
    execute_query_with_timeout(
      &DbPool::MySql(pool.clone()),
      "SELECT SLEEP(1)",
      Duration::from_millis(20),
    )
    .await,
  );
  assert_truncated_result(
    execute_query_with_limit(
      &DbPool::MySql(pool.clone()),
      "SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3",
      2,
    )
    .await
    .expect("limit MySQL result"),
    2,
  );
  assert_byte_limited_result(
    execute_query_with_limits(&DbPool::MySql(pool.clone()), "SELECT 'too large' AS value", 100, 1)
      .await
      .expect("limit MySQL result bytes"),
  );
  let precise = execute_query(
    &DbPool::MySql(pool.clone()),
    "SELECT CAST(9007199254740993 AS UNSIGNED) AS large_integer, CAST(12345678901234567890.12345678 AS DECIMAL(30,8)) AS decimal_value, X'00ff10' AS binary_value, JSON_OBJECT('enabled', TRUE) AS json_value",
  )
  .await
  .expect("read precise MySQL values");
  let mut expected = vec![
    ("large_integer", "bigint", "9007199254740993"),
    ("decimal_value", "decimal", "12345678901234567890.12345678"),
    ("binary_value", "binary", "00ff10"),
  ];
  // MariaDB 的 JSON 是 LONGTEXT 的别名，线协议上就是一段文本，驱动认不出
  // 它是 JSON。界面照文本显示和编辑，不会丢字——只是没有 JSON 专用编辑器
  if mysql_flavor(&pool).await == MysqlFlavor::MariaDb {
    let QueryExecutionResult::Rows { rows, .. } = &precise else {
      panic!("expected a row result");
    };
    assert_eq!(rows[0]["json_value"], "{\"enabled\": true}");
  } else {
    expected.push(("json_value", "json", "{\"enabled\":true}"));
  }
  assert_tagged_values(precise, &expected);

  assert_transaction_binding(
    &QuerySessionState::default(),
    "mysql-session",
    &url,
    &DbPool::MySql(pool),
    "CREATE TEMPORARY TABLE transaction_binding_test (value TEXT NOT NULL)",
    "INSERT INTO transaction_binding_test (value) VALUES ('pending')",
  )
  .await;
}

async fn assert_transaction_binding(
  sessions: &QuerySessionState,
  session_id: &str,
  pool_key: &str,
  pool: &DbPool,
  create_table_sql: &str,
  insert_sql: &str,
) {
  let timeout = Duration::from_secs(5);
  sessions
    .execute(session_id, pool_key, pool, create_table_sql, 100, timeout)
    .await
    .expect("create session-local temporary table");
  sessions
    .execute(session_id, pool_key, pool, "BEGIN", 100, timeout)
    .await
    .expect("begin transaction");
  sessions
    .execute(session_id, pool_key, pool, insert_sql, 100, timeout)
    .await
    .expect("insert inside transaction");

  let result = sessions
    .execute(session_id, pool_key, pool, "SELECT value FROM transaction_binding_test", 100, timeout)
    .await
    .expect("read inside transaction");
  assert_single_row_result(result, "value", "pending");

  sessions
    .execute(session_id, pool_key, pool, "ROLLBACK", 100, timeout)
    .await
    .expect("rollback transaction");
  let result = sessions
    .execute(session_id, pool_key, pool, "SELECT value FROM transaction_binding_test", 100, timeout)
    .await
    .expect("read after rollback");
  assert_empty_row_result(result, "value");

  let mut batches = Vec::new();
  let summary = sessions
    .execute_streaming(
      StreamingQueryOptions {
        session_id,
        pool_key,
        pool,
        sql: "SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5",
        autocommit: true,
        assume_rows: false,
        row_limit: 5,
        byte_limit: 16 * 1024 * 1024,
        batch_size: 2,
        timeout_duration: timeout,
      },
      &mut |batch| {
        batches.push(batch);
        Ok(())
      },
    )
    .await
    .expect("stream result batches");
  match summary {
    QueryExecutionSummary::Rows { row_count, batch_count, truncated, .. } => {
      assert_eq!(row_count, 5);
      assert_eq!(batch_count, 3);
      assert!(!truncated);
    }
    QueryExecutionSummary::Affected { .. } => panic!("expected row summary"),
  }
  assert_eq!(batches.iter().map(|batch| batch.offset).collect::<Vec<_>>(), vec![0, 2, 4]);

  assert!(sessions.release(session_id).await);
}

fn assert_empty_row_result(result: QueryExecutionResult, column: &str) {
  match result {
    QueryExecutionResult::Rows { columns, column_metadata, rows, .. } => {
      assert_eq!(columns, vec![column]);
      assert!(rows.is_empty());
      assert_eq!(column_metadata.len(), 1);
      assert_eq!(column_metadata[0].name, column);
      assert_eq!(column_metadata[0].ordinal, 0);
      assert!(!column_metadata[0].database_type.is_empty());
      assert_eq!(column_metadata[0].logical_type, "text");
      assert_eq!(column_metadata[0].nullable, Some(false));
    }
    QueryExecutionResult::Affected { .. } => panic!("expected a row result"),
  }
}

fn assert_single_row_result(result: QueryExecutionResult, column: &str, value: &str) {
  match result {
    QueryExecutionResult::Rows { columns, column_metadata, rows, .. } => {
      assert_eq!(columns, vec![column]);
      assert_eq!(rows.len(), 1);
      assert_eq!(rows[0][column], value);
      assert_eq!(column_metadata.len(), columns.len());
      assert_eq!(column_metadata[0].name, column);
      assert!(!column_metadata[0].database_type.is_empty());
    }
    QueryExecutionResult::Affected { .. } => panic!("expected a row result"),
  }
}

fn assert_query_times_out(result: Result<QueryExecutionResult, QueryError>) {
  let error = result.expect_err("query should exceed its timeout");
  // 按 code 判断而不是按消息前缀：消息是要翻译的，按前缀匹配等于把
  // 「这是超时」的判断绑在某一种语言上
  assert_eq!(error.code.as_deref(), Some(QUERY_TIMEOUT_CODE), "unexpected timeout error: {error}");
}

fn assert_truncated_result(result: QueryExecutionResult, expected_limit: usize) {
  match result {
    QueryExecutionResult::Rows { rows, truncated, row_limit, .. } => {
      assert_eq!(rows.len(), expected_limit);
      assert!(truncated);
      assert_eq!(row_limit, expected_limit);
    }
    QueryExecutionResult::Affected { .. } => panic!("expected a row result"),
  }
}

fn assert_byte_limited_result(result: QueryExecutionResult) {
  match result {
    QueryExecutionResult::Rows { rows, truncated, truncation_reason, bytes_read, .. } => {
      assert!(rows.is_empty());
      assert!(truncated);
      assert_eq!(truncation_reason, Some(QueryTruncationReason::ByteLimit));
      assert_eq!(bytes_read, 0);
    }
    QueryExecutionResult::Affected { .. } => panic!("expected a row result"),
  }
}

fn assert_tagged_values(result: QueryExecutionResult, expected: &[(&str, &str, &str)]) {
  let QueryExecutionResult::Rows { rows, .. } = result else {
    panic!("expected a row result");
  };
  assert_eq!(rows.len(), 1);
  for (column, value_type, value) in expected {
    assert_eq!(rows[0][*column]["type"], *value_type);
    assert_eq!(rows[0][*column]["value"], *value);
  }
}

fn network_database_url(variable: &str) -> Option<String> {
  match std::env::var(variable) {
    Ok(url) if !url.is_empty() => Some(url),
    _ if network_databases_required() => {
      panic!("{variable} must be set when {REQUIRE_NETWORK_DATABASES_ENV}=1")
    }
    _ => {
      eprintln!("skipping network database smoke test because {variable} is not set");
      None
    }
  }
}

fn network_databases_required() -> bool {
  std::env::var(REQUIRE_NETWORK_DATABASES_ENV).as_deref() == Ok("1")
}

/// MySQL 常用类型 + 已知坑点的解码覆盖。
///
/// 这些类型此前只在用户实际点开某张表时才暴露问题（`unsupported datatype: BINARY`），
/// 这里把它们固定成一道门。
#[tokio::test]
async fn mysql_decodes_common_column_types() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool = MySqlPoolOptions::new()
    .max_connections(1)
    .connect(&url)
    .await
    .expect("connect to MySQL smoke database");

  sqlx::query(
    "CREATE TEMPORARY TABLE type_coverage (
       col_tinyint TINYINT,
       col_int INT,
       col_bigint BIGINT,
       col_bigint_unsigned BIGINT UNSIGNED,
       col_decimal DECIMAL(20, 4),
       col_float FLOAT,
       col_double DOUBLE,
       col_bit BIT(8),
       col_char CHAR(8),
       col_varchar VARCHAR(32),
       col_text TEXT,
       col_enum ENUM('a', 'b'),
       col_set SET('x', 'y'),
       col_binary BINARY(4),
       col_varbinary VARBINARY(16),
       col_blob BLOB,
       col_date DATE,
       col_time TIME,
       col_datetime DATETIME,
       col_timestamp TIMESTAMP NULL,
       col_year YEAR,
       col_json JSON
     )",
  )
  .execute(&pool)
  .await
  .expect("create MySQL type coverage table");

  sqlx::query(
    "INSERT INTO type_coverage VALUES (
       -1, 2147483647, 9223372036854775807, 18446744073709551615,
       12345678901234.5678, 1.5, 2.5, b'10101010',
       'chr', 'varchar', 'text', 'a', 'x,y',
       0x00FF1020, 0x0102, 0x03,
       '2026-09-20', '12:34:56', '2026-09-20 12:34:56', '2026-09-20 12:34:56',
       2026, '{\"k\": 1}'
     )",
  )
  .execute(&pool)
  .await
  .expect("insert MySQL type coverage row");

  let result = execute_query(&DbPool::MySql(pool.clone()), "SELECT * FROM type_coverage")
    .await
    .expect("decode every MySQL column type");

  // 精度是重点：DECIMAL 与 BIGINT UNSIGNED 都超出 JavaScript Number 的安全范围
  assert_tagged_values(
    result,
    &[
      ("col_bigint", "bigint", "9223372036854775807"),
      ("col_bigint_unsigned", "bigint", "18446744073709551615"),
      ("col_decimal", "decimal", "12345678901234.5678"),
      ("col_binary", "binary", "00ff1020"),
      ("col_date", "date", "2026-09-20"),
    ],
  );
}

/// PostgreSQL 常用类型 + 已知坑点的解码覆盖。
///
/// 未覆盖 `BIT` 与 `INET` / `CIDR`：sqlx 要分别开启 `bit-vec` 与 `ipnetwork`
/// feature 才能解码，而这两种类型在应用 schema 中少见，为它们引入依赖不划算。
/// 真碰上时解码器会报出明确的「不支持的 PostgreSQL 数据类型: BIT」，届时再加。
#[tokio::test]
async fn postgres_decodes_common_column_types() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool = PgPoolOptions::new()
    .max_connections(1)
    .connect(&url)
    .await
    .expect("connect to PostgreSQL smoke database");

  sqlx::query(
    "CREATE TEMP TABLE type_coverage (
       col_smallint SMALLINT,
       col_int INTEGER,
       col_bigint BIGINT,
       col_numeric NUMERIC(20, 4),
       col_real REAL,
       col_double DOUBLE PRECISION,
       col_bool BOOLEAN,
       col_char CHAR(8),
       col_varchar VARCHAR(32),
       col_text TEXT,
       col_uuid UUID,
       col_bytea BYTEA,
       col_date DATE,
       col_time TIME,
       col_timestamp TIMESTAMP,
       col_timestamptz TIMESTAMPTZ,
       col_interval INTERVAL,
       col_json JSON,
       col_jsonb JSONB,
       col_text_array TEXT[],
       col_int_array INTEGER[],
       col_bit_placeholder BOOLEAN
     )",
  )
  .execute(&pool)
  .await
  .expect("create PostgreSQL type coverage table");

  sqlx::query(
    "INSERT INTO type_coverage VALUES (
       -1, 2147483647, 9223372036854775807,
       12345678901234.5678, 1.5, 2.5, true,
       'chr', 'varchar', 'text',
       '00000000-0000-0000-0000-000000000001',
       '\\x00ff1020'::bytea,
       '2026-09-20', '12:34:56', '2026-09-20 12:34:56', '2026-09-20 12:34:56+00',
       '1 day', '{\"k\": 1}', '{\"k\": 1}',
       ARRAY['a', 'b'], ARRAY[1, 2],
       false
     )",
  )
  .execute(&pool)
  .await
  .expect("insert PostgreSQL type coverage row");

  let result = execute_query(&DbPool::Postgres(pool.clone()), "SELECT * FROM type_coverage")
    .await
    .expect("decode every PostgreSQL column type");

  assert_tagged_values(
    result,
    &[
      ("col_bigint", "bigint", "9223372036854775807"),
      ("col_numeric", "decimal", "12345678901234.5678"),
      ("col_bytea", "binary", "00ff1020"),
      ("col_date", "date", "2026-09-20"),
    ],
  );
}

// ---------------------------------------------------------------------------
// 结构浏览：索引、外键、检查约束
//
// 这几段目录查询最容易「看起来能跑、其实是错的」。造型上刻意设了两个陷阱：
//   1. 复合外键 (ref_a, ref_b) → (x, y)，而 ref_b 在表里声明在 ref_a 之前。
//      按列序而不是按键序配对，会得到 ref_b→x、ref_a→y —— 错位之后结果
//      看上去完全正常。
//   2. 复合主键 (x, y) 与复合唯一键 (label, score)，验证列顺序不被打乱。
// ---------------------------------------------------------------------------

/// 每个测试用自己的一套表名与约束名。
///
/// 共用一套名字时，`cargo test` 的并行执行会让一个测试的 DROP 打掉另一个
/// 正在用的表——单独跑绿、一起跑红，而失败信息指向的是查询本身。
/// MySQL 的约束名还是 schema 级唯一的，表名带后缀还不够。
struct MetaFixture {
  suffix: &'static str,
  parent: String,
  child: String,
}

impl MetaFixture {
  fn new(suffix: &'static str) -> Self {
    Self {
      suffix,
      parent: format!("dataomni_meta_parent_{suffix}"),
      child: format!("dataomni_meta_child_{suffix}"),
    }
  }

  fn ddl(&self, dialect: &str) -> Vec<String> {
    let Self { suffix, parent, child } = self;
    let text_type = "VARCHAR(32)";
    let mut statements = vec![
      format!("DROP TABLE IF EXISTS {child}"),
      format!("DROP TABLE IF EXISTS {parent}"),
      format!("CREATE TABLE {parent} (x INT NOT NULL, y INT NOT NULL, PRIMARY KEY (x, y))"),
      format!(
        "CREATE TABLE {child} (
           id INT NOT NULL,
           ref_b INT NOT NULL,
           ref_a INT NOT NULL,
           label {text_type},
           score INT,
           PRIMARY KEY (id),
           CONSTRAINT uq_meta_child_{suffix} UNIQUE (label, score),
           CONSTRAINT ck_meta_child_{suffix} CHECK (score >= 0),
           CONSTRAINT fk_meta_child_{suffix} FOREIGN KEY (ref_a, ref_b)
             REFERENCES {parent} (x, y) ON DELETE CASCADE ON UPDATE RESTRICT
         )"
      ),
      format!("CREATE INDEX ix_meta_child_label_{suffix} ON {child} (label)"),
      // 表达式索引：三种方言各有各的坑。PostgreSQL 的 indkey 在这一位是 0，
      // join pg_attribute 会让整列消失；MySQL 的 COLUMN_NAME 为 NULL、表达式在
      // EXPRESSION 里；SQLite 的 pragma_index_info.name 为 NULL。
      // 不放进夹具，这三处处理就全是猜的。
    ];
    match dialect {
      "mysql" => statements
        .push(format!("CREATE INDEX ix_meta_child_expr_{suffix} ON {child} ((score + 1))")),
      // MariaDB 没有函数索引（要先建虚拟列再索引它，那就是普通索引了），
      // 这一种它根本建不出来，也就不会在它的目录里出现
      "mariadb" => {}
      _ => statements
        .push(format!("CREATE INDEX ix_meta_child_expr_{suffix} ON {child} ((lower(label)))")),
    }
    statements
  }
}

#[tokio::test]
async fn postgres_reports_indexes_foreign_keys_and_checks() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");

  let fixture = MetaFixture::new("pg");
  for statement in fixture.ddl("postgres") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare PostgreSQL metadata fixture");
  }

  let queries = dataomni_lib::services::schema_metadata_queries(
    &dataomni_lib::models::DatabaseType::PostgreSQL,
  )
  .expect("PostgreSQL is supported");

  let index_rows = sqlx::query(queries.indexes)
    .bind(&fixture.child)
    .bind(Option::<String>::None)
    .fetch_all(&pool)
    .await
    .expect("run PostgreSQL index query");
  let indexes: Vec<(String, String, i64, bool, bool)> = index_rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("index_name"),
        row.get::<String, _>("column_name"),
        pg_int(row, "ordinal").expect("ordinal is never NULL"),
        row.get::<bool, _>("is_unique"),
        row.get::<bool, _>("is_primary"),
      )
    })
    .collect();

  assert!(
    indexes.contains(&(format!("{}_pkey", fixture.child), "id".into(), 1, true, true)),
    "主键索引应被标为 unique + primary: {indexes:?}"
  );
  assert_eq!(
    indexes
      .iter()
      .filter(|(name, ..)| name == &format!("uq_meta_child_{}", fixture.suffix))
      .map(|(_, column, ordinal, unique, _)| (column.as_str(), *ordinal, *unique))
      .collect::<Vec<_>>(),
    vec![("label", 1, true), ("score", 2, true)],
    "复合唯一键的列顺序必须是建表时的顺序: {indexes:?}"
  );
  assert!(
    indexes.contains(&(
      format!("ix_meta_child_label_{}", fixture.suffix),
      "label".into(),
      1,
      false,
      false
    )),
    "普通索引应被标为非 unique: {indexes:?}"
  );
  let expression_column = indexes
    .iter()
    .find(|(name, ..)| name == &format!("ix_meta_child_expr_{}", fixture.suffix))
    .map(|(_, column, ..)| column.clone());
  // PostgreSQL 会把 varchar 归一成 text，所以原文是 `lower(label::text)`；
  // CockroachDB 外面多一层括号：`(lower(label))`
  assert!(
    expression_column
      .as_deref()
      .is_some_and(|text| text.trim_start_matches('(').starts_with("lower(label")),
    "表达式索引要给出表达式原文；join pg_attribute 的写法会让这一列整个消失: {indexes:?}"
  );

  let fk_rows = sqlx::query(queries.foreign_keys)
    .bind(&fixture.child)
    .bind(Option::<String>::None)
    .fetch_all(&pool)
    .await
    .expect("run PostgreSQL foreign key query");
  let pairs: Vec<(i64, String, String, String)> = fk_rows
    .iter()
    .map(|row| {
      (
        pg_int(row, "ordinal").expect("ordinal is never NULL"),
        row.get::<String, _>("column_name"),
        row.get::<String, _>("referenced_table"),
        row.get::<String, _>("referenced_column"),
      )
    })
    .collect();
  assert_eq!(
    pairs,
    vec![
      (1, "ref_a".into(), fixture.parent.clone(), "x".into()),
      (2, "ref_b".into(), fixture.parent.clone(), "y".into()),
    ],
    "复合外键必须按键序配对，不是按列在表里的声明顺序"
  );
  assert_eq!(fk_rows[0].get::<Option<String>, _>("on_delete").as_deref(), Some("CASCADE"));
  assert_eq!(fk_rows[0].get::<Option<String>, _>("on_update").as_deref(), Some("RESTRICT"));

  let check_sql = queries.check_constraints.expect("PostgreSQL has a check constraint catalog");
  let check_rows = sqlx::query(check_sql)
    .bind(&fixture.child)
    .bind(Option::<String>::None)
    .fetch_all(&pool)
    .await
    .expect("run PostgreSQL check constraint query");
  let checks: Vec<(String, String)> = check_rows
    .iter()
    .map(|row| (row.get::<String, _>("constraint_name"), row.get::<String, _>("expression")))
    .collect();
  assert_eq!(checks.len(), 1, "只应列出建表时写的那一条 CHECK；NOT NULL 不该混进来: {checks:?}");
  assert_eq!(checks[0].0, format!("ck_meta_child_{}", fixture.suffix));
  assert!(checks[0].1.contains("score"), "约束表达式应含列名: {:?}", checks[0].1);

  for table in [&fixture.child, &fixture.parent] {
    sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
  }
}

#[tokio::test]
async fn mysql_reports_indexes_foreign_keys_and_checks() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");

  let fixture = MetaFixture::new("my");
  for statement in fixture.ddl(mysql_flavor(&pool).await.fixture_dialect()) {
    sqlx::query(&statement).execute(&pool).await.expect("prepare MySQL metadata fixture");
  }

  let queries =
    dataomni_lib::services::schema_metadata_queries(&dataomni_lib::models::DatabaseType::MySQL)
      .expect("MySQL is supported");

  let index_rows = sqlx::query(queries.indexes)
    .bind(&fixture.child)
    .bind(Option::<String>::None)
    .fetch_all(&pool)
    .await
    .expect("run MySQL index query");
  let indexes: Vec<(String, String, i64, i64, i64)> = index_rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("index_name"),
        row.get::<String, _>("column_name"),
        mysql_ordinal(row, "ordinal").expect("ordinal is never NULL"),
        row.get::<i64, _>("is_unique"),
        row.get::<i64, _>("is_primary"),
      )
    })
    .collect();

  assert!(
    indexes.contains(&("PRIMARY".into(), "id".into(), 1, 1, 1)),
    "MySQL 主键索引名是 PRIMARY，应同时标 unique 与 primary: {indexes:?}"
  );
  assert_eq!(
    indexes
      .iter()
      .filter(|(name, ..)| name == &format!("uq_meta_child_{}", fixture.suffix))
      .map(|(_, column, ordinal, unique, _)| (column.as_str(), *ordinal, *unique))
      .collect::<Vec<_>>(),
    vec![("label", 1, 1), ("score", 2, 1)],
    "复合唯一键的列顺序必须是建表时的顺序: {indexes:?}"
  );
  assert!(
    indexes.contains(&(format!("ix_meta_child_label_{}", fixture.suffix), "label".into(), 1, 0, 0)),
    "普通索引应被标为非 unique: {indexes:?}"
  );
  let expression_column = indexes
    .iter()
    .find(|(name, ..)| name == &format!("ix_meta_child_expr_{}", fixture.suffix))
    .map(|(_, column, ..)| column.clone());
  assert!(
    mysql_flavor(&pool).await == MysqlFlavor::MariaDb
      || expression_column.as_deref().is_some_and(|text| text.contains("score")),
    "函数索引的 COLUMN_NAME 是 NULL，必须回退到 EXPRESSION，否则这一列是空的: {indexes:?}"
  );

  let fk_rows = sqlx::query(queries.foreign_keys)
    .bind(&fixture.child)
    .bind(Option::<String>::None)
    .fetch_all(&pool)
    .await
    .expect("run MySQL foreign key query");
  let pairs: Vec<(i64, String, String, String)> = fk_rows
    .iter()
    .map(|row| {
      (
        mysql_ordinal(row, "ordinal").expect("ordinal is never NULL"),
        row.get::<String, _>("column_name"),
        row.get::<String, _>("referenced_table"),
        row.get::<String, _>("referenced_column"),
      )
    })
    .collect();
  assert_eq!(
    pairs,
    vec![
      (1, "ref_a".into(), fixture.parent.clone(), "x".into()),
      (2, "ref_b".into(), fixture.parent.clone(), "y".into()),
    ],
    "复合外键必须按键序配对，不是按列在表里的声明顺序"
  );
  assert_eq!(fk_rows[0].get::<Option<String>, _>("on_delete").as_deref(), Some("CASCADE"));
  assert_eq!(fk_rows[0].get::<Option<String>, _>("on_update").as_deref(), Some("RESTRICT"));

  let check_sql = queries.check_constraints.expect("MySQL 8 has a check constraint catalog");
  let check_rows = sqlx::query(check_sql)
    .bind(&fixture.child)
    .bind(Option::<String>::None)
    .fetch_all(&pool)
    .await
    .expect("run MySQL check constraint query");
  let checks: Vec<(String, String)> = check_rows
    .iter()
    .map(|row| (row.get::<String, _>("constraint_name"), row.get::<String, _>("expression")))
    .collect();
  // TiDB 上这一段恒为空，两层原因：默认不启用检查约束（建表时解析了就丢）；
  // 打开之后 `TABLE_CONSTRAINTS` 也不列 CHECK，与 `CHECK_CONSTRAINTS` 接不上
  // （在 TiDB 8.5 上打开开关验过）。结构页因此不显示——已知缺口，钉在这里，
  // 哪天 TiDB 补上了这条会红
  if mysql_flavor(&pool).await == MysqlFlavor::TiDb {
    assert!(checks.is_empty(), "TiDB 的检查约束目录接上了，回来重估: {checks:?}");
  } else {
    assert_eq!(checks.len(), 1, "只应列出这张表的那一条 CHECK: {checks:?}");
    assert_eq!(checks[0].0, format!("ck_meta_child_{}", fixture.suffix));
    assert!(checks[0].1.contains("score"), "约束表达式应含列名: {:?}", checks[0].1);
  }

  for table in [&fixture.child, &fixture.parent] {
    sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
  }
}

#[tokio::test]
async fn sqlite_reports_indexes_and_foreign_keys() {
  let pool = SqlitePoolOptions::new()
    .max_connections(1)
    .connect("sqlite::memory:")
    .await
    .expect("connect to in-memory SQLite");

  let fixture = MetaFixture::new("lite");
  for statement in fixture.ddl("sqlite") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare SQLite metadata fixture");
  }

  let queries =
    dataomni_lib::services::schema_metadata_queries(&dataomni_lib::models::DatabaseType::SQLite)
      .expect("SQLite is supported");

  let index_rows = sqlx::query(queries.indexes)
    .bind(&fixture.child)
    .fetch_all(&pool)
    .await
    .expect("run SQLite index query");
  let indexes: Vec<(String, String, i64, i64, i64)> = index_rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("index_name"),
        row.get::<String, _>("column_name"),
        row.get::<i64, _>("ordinal"),
        row.get::<i64, _>("is_unique"),
        row.get::<i64, _>("is_primary"),
      )
    })
    .collect();

  // SQLite 给约束建的索引是自动命名的，编号按约束出现的顺序：_1 是主键，
  // _2 是 UNIQUE。`id INT`（不是 `INTEGER`）不是 rowid 别名，所以主键也有索引。
  assert!(
    indexes.contains(&(format!("sqlite_autoindex_{}_1", fixture.child), "id".into(), 1, 1, 1)),
    "主键索引应被标为 unique + primary: {indexes:?}"
  );
  assert_eq!(
    indexes
      .iter()
      .filter(|(name, ..)| *name == format!("sqlite_autoindex_{}_2", fixture.child))
      .map(|(_, column, ordinal, unique, primary)| (column.as_str(), *ordinal, *unique, *primary))
      .collect::<Vec<_>>(),
    vec![("label", 1, 1, 0), ("score", 2, 1, 0)],
    "复合唯一键的列顺序必须是建表时的顺序，且不该被当成主键: {indexes:?}"
  );
  assert!(
    indexes.contains(&(format!("ix_meta_child_label_{}", fixture.suffix), "label".into(), 1, 0, 0)),
    "普通索引应被标为非 unique: {indexes:?}"
  );
  // SQLite 对表达式索引不给列名，也不给表达式原文（pragma_index_info 返回
  // NULL）。这里把这个事实钉住：前端据此把空列名显示成「(表达式)」，
  // 而不是渲染成一个空白格。
  assert_eq!(
    indexes
      .iter()
      .find(|(name, ..)| name == &format!("ix_meta_child_expr_{}", fixture.suffix))
      .map(|(_, column, ..)| column.as_str()),
    Some(""),
    "SQLite 表达式索引的列名应为空；若哪天变了，前端的占位显示要跟着改: {indexes:?}"
  );

  let fk_rows = sqlx::query(queries.foreign_keys)
    .bind(&fixture.child)
    .fetch_all(&pool)
    .await
    .expect("run SQLite foreign key query");
  let pairs: Vec<(String, i64, String, String, String)> = fk_rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("constraint_name"),
        row.get::<i64, _>("ordinal"),
        row.get::<String, _>("column_name"),
        row.get::<String, _>("referenced_table"),
        row.get::<String, _>("referenced_column"),
      )
    })
    .collect();
  assert_eq!(
    pairs,
    vec![
      ("fk_0".into(), 1, "ref_a".into(), fixture.parent.clone(), "x".into()),
      ("fk_0".into(), 2, "ref_b".into(), fixture.parent.clone(), "y".into()),
    ],
    "SQLite 外键无名，用 fk_<id> 合成；复合外键必须按键序配对"
  );
}

#[tokio::test]
async fn mysql_returns_the_authoritative_create_table_statement() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");

  let fixture = MetaFixture::new("myddl");
  for statement in fixture.ddl(mysql_flavor(&pool).await.fixture_dialect()) {
    sqlx::query(&statement).execute(&pool).await.expect("prepare MySQL metadata fixture");
  }

  let queries =
    dataomni_lib::services::schema_metadata_queries(&dataomni_lib::models::DatabaseType::MySQL)
      .expect("MySQL is supported");
  let Some(dataomni_lib::services::DdlQuery::Interpolated { sql }) = queries.ddl else {
    panic!("MySQL 的建表语句只能插值");
  };

  // 与前端同样的做法：表名作为反引号标识符插进去，SHOW 不接受占位符
  let rendered = sql.replace("{table}", &format!("`{}`", fixture.child));
  let row = sqlx::query(&rendered).fetch_one(&pool).await.expect("run SHOW CREATE TABLE");

  // 列名字面就叫 `Create Table`（带空格）；猜成 `create_table` 会取到空值
  // 前端拿到的是按列名索引的 JSON，所以列名本身就是契约的一部分：
  // 它字面就叫 `Create Table`（带空格），猜成 `create_table` 会取到空值。
  // 类型是 VARCHAR，不是 BLOB——plugin-sql 的解码器能处理。
  assert_eq!(
    row.columns().iter().map(|column| column.name()).collect::<Vec<_>>(),
    vec!["Table", "Create Table"]
  );
  assert_eq!(row.columns()[1].type_info().name(), "VARCHAR");

  // 按序号取值：sqlx 对 SHOW 语句不建列名索引，`row.get("Create Table")` 会报
  // ColumnNotFound，尽管 row.columns() 明明给出了这个名字。
  let ddl: String = row.get(1);
  assert!(ddl.starts_with("CREATE TABLE"), "应是建表语句原文: {ddl}");
  assert!(ddl.contains(&format!("fk_meta_child_{}", fixture.suffix)), "应含外键定义: {ddl}");
  // TiDB 默认不启用检查约束：建表时解析了就丢，表里本来就没有它
  if mysql_flavor(&pool).await != MysqlFlavor::TiDb {
    assert!(ddl.contains(&format!("ck_meta_child_{}", fixture.suffix)), "应含检查约束: {ddl}");
  }
  assert!(ddl.contains(&format!("ix_meta_child_label_{}", fixture.suffix)), "应含显式索引: {ddl}");

  for table in [&fixture.child, &fixture.parent] {
    sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
  }
}

#[tokio::test]
async fn sqlite_returns_create_table_together_with_its_indexes() {
  let pool = SqlitePoolOptions::new()
    .max_connections(1)
    .connect("sqlite::memory:")
    .await
    .expect("connect to in-memory SQLite");

  let fixture = MetaFixture::new("liteddl");
  for statement in fixture.ddl("sqlite") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare SQLite metadata fixture");
  }

  let queries =
    dataomni_lib::services::schema_metadata_queries(&dataomni_lib::models::DatabaseType::SQLite)
      .expect("SQLite is supported");
  let Some(dataomni_lib::services::DdlQuery::Bound { sql }) = queries.ddl else {
    panic!("SQLite 的建表语句走绑定参数");
  };

  let rows =
    sqlx::query(sql).bind(&fixture.child).fetch_all(&pool).await.expect("run sqlite_master");
  let statements: Vec<String> = rows.iter().map(|row| row.get::<String, _>("sql")).collect();

  assert!(statements[0].starts_with("CREATE TABLE"), "建表语句要排在最前: {statements:?}");
  // 只给 CREATE TABLE 的话，照着重建出来的表会少掉所有显式索引
  assert!(
    statements.iter().any(|sql| sql.contains(&format!("ix_meta_child_label_{}", fixture.suffix))),
    "显式索引也要一并给出: {statements:?}"
  );
  // 自动建的约束索引 sql 为 NULL，已经含在 CREATE TABLE 里，不该重复出现
  assert!(
    !statements.iter().any(|sql| sql.contains("sqlite_autoindex")),
    "自动索引不该出现: {statements:?}"
  );
}

// ---------------------------------------------------------------------------
// 目录查询的参数：前端发出去的那一组，真库答不答应
// ---------------------------------------------------------------------------

/// 收集一个方言里全部走绑定参数的目录查询，连同它们在界面上的名字。
fn bound_catalog_queries(
  queries: &dataomni_lib::services::SchemaMetadataQueries,
) -> Vec<(&'static str, &'static str)> {
  let mut bound = vec![
    ("columns", queries.columns),
    ("indexes", queries.indexes),
    ("foreign_keys", queries.foreign_keys),
    ("triggers", queries.triggers),
  ];
  if let Some(sql) = queries.check_constraints {
    bound.push(("check_constraints", sql));
  }
  // 插值那一种不绑参数，表名已经作为标识符拼进语句了
  if let Some(dataomni_lib::services::DdlQuery::Bound { sql }) = queries.ddl {
    bound.push(("ddl", sql));
  }
  bound
}

/// 前端只拿 `parameter_count` 造一组参数，发给上面每一段。
///
/// 单测数的是占位符个数；这条证明真库确实答应。它红过一次：`ddl` 那一段
/// 此前照 SQLite 的形状只绑了表名，而 PostgreSQL 的视图定义要两个——
/// 真库的回答是 `bind message supplies 1 parameters, but prepared statement
/// requires 2`，而这几段查询在前端是同一个 `Promise.all`，于是 PostgreSQL 上
/// 整个「结构」页的索引、外键、触发器一条都显示不出来。
#[tokio::test]
async fn postgres_accepts_the_parameters_the_ui_actually_sends() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");

  let fixture = MetaFixture::new("pgparams");
  for statement in fixture.ddl("postgres") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare PostgreSQL fixture");
  }

  let queries = dataomni_lib::services::schema_metadata_queries(
    &dataomni_lib::models::DatabaseType::PostgreSQL,
  )
  .expect("supported");

  let cockroach = is_cockroach(&pool).await;
  for (name, sql) in bound_catalog_queries(&queries) {
    let mut query = sqlx::query(sql).bind(&fixture.child);
    for _ in 1..queries.parameter_count {
      query = query.bind(Option::<String>::None);
    }
    match query.fetch_all(&pool).await {
      Err(error) if cockroach && name == "triggers" => {
        assert_cockroach_refuses_the_trigger_catalog(error)
      }
      Err(error) => panic!("PostgreSQL 的 {name} 不接受界面发的参数: {error}"),
      Ok(_) => {
        assert!(!(cockroach && name == "triggers"), "CockroachDB 的触发器目录能跑了，回来重估")
      }
    }
  }
}

#[tokio::test]
async fn mysql_accepts_the_parameters_the_ui_actually_sends() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");

  let fixture = MetaFixture::new("myparams");
  for statement in fixture.ddl(mysql_flavor(&pool).await.fixture_dialect()) {
    sqlx::query(&statement).execute(&pool).await.expect("prepare MySQL fixture");
  }

  let queries =
    dataomni_lib::services::schema_metadata_queries(&dataomni_lib::models::DatabaseType::MySQL)
      .expect("supported");

  for (name, sql) in bound_catalog_queries(&queries) {
    let mut query = sqlx::query(sql).bind(&fixture.child);
    for _ in 1..queries.parameter_count {
      query = query.bind(Option::<String>::None);
    }
    query
      .fetch_all(&pool)
      .await
      .unwrap_or_else(|error| panic!("MySQL 的 {name} 不接受界面发的参数: {error}"));
  }
}

// ---------------------------------------------------------------------------
// 目录查询的结果：界面那一侧的解码器认不认
// ---------------------------------------------------------------------------

/// 目录查询在应用里是前端经 `tauri-plugin-sql` 的 `select` 发的，解码用的是
/// **插件自己的**类型表，不是 `query_executor`。上面那些用例拿 sqlx 的
/// `row.get::<T>` 取值，走的是第三套解码——所以「SQL 在真库上跑得通」与
/// 「界面上显示得出来」之间一直隔着一道没人比过的缝。84495ab 就掉在这道缝里：
/// MySQL 的 `information_schema` 标识符列是 VARBINARY，查询本身没错，界面报
/// `unsupported datatype`。
///
/// 这里是 `decode/{mysql,postgres,sqlite}.rs` 里**有专门分支**的类型名。
/// PostgreSQL 那份从 2.4 起对不认识的类型会退回 `try_decode_unchecked::<String>`
/// 硬解，只打一条 warn——那不算认：二进制协议下一个 OID 是四个字节，按
/// 字符串硬解出来的不是它的值。所以门按有分支的算，不按「碰巧没报错」算。
const PLUGIN_SQL_VERSION: &str = "2.4.1";
const PLUGIN_DECODES_MYSQL: &[&str] = &[
  "CHAR",
  "VARCHAR",
  "TINYTEXT",
  "TEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
  "ENUM",
  "FLOAT",
  "DOUBLE",
  "TINYINT",
  "SMALLINT",
  "INT",
  "MEDIUMINT",
  "BIGINT",
  "TINYINT UNSIGNED",
  "SMALLINT UNSIGNED",
  "INT UNSIGNED",
  "MEDIUMINT UNSIGNED",
  "BIGINT UNSIGNED",
  "YEAR",
  "BOOLEAN",
  "DATE",
  "TIME",
  "DATETIME",
  "TIMESTAMP",
  "JSON",
  "MEDIUMBLOB",
  "BLOB",
  "LONGBLOB",
  "NULL",
];
const PLUGIN_DECODES_POSTGRES: &[&str] = &[
  "CHAR",
  "VARCHAR",
  "TEXT",
  "NAME",
  "UUID",
  "FLOAT4",
  "FLOAT8",
  "INT2",
  "INT4",
  "INT8",
  "BOOL",
  "DATE",
  "TIME",
  "TIMESTAMP",
  "TIMESTAMPTZ",
  "JSON",
  "JSONB",
  "BYTEA",
  "NUMERIC",
  "VOID",
];
const PLUGIN_DECODES_SQLITE: &[&str] =
  &["TEXT", "REAL", "INTEGER", "NUMERIC", "BOOLEAN", "DATE", "TIME", "DATETIME", "BLOB", "NULL"];

/// 上面三张表是照着某一个版本的源码抄的。插件一升级，这条先红——
/// 去 `~/.cargo/registry/src/*/tauri-plugin-sql-<新版本>/src/decode/` 重核一遍
/// 再改版本号，而不是只改版本号。
#[test]
fn plugin_decoder_tables_were_read_from_the_locked_version() {
  let lock = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock"))
    .expect("read Cargo.lock");
  let locked = lock
    .split("[[package]]")
    .find(|package| package.contains("name = \"tauri-plugin-sql\""))
    .and_then(|package| package.lines().find_map(|line| line.strip_prefix("version = ")))
    .map(|version| version.trim_matches('"').to_string());
  assert_eq!(
    locked.as_deref(),
    Some(PLUGIN_SQL_VERSION),
    "tauri-plugin-sql 换了版本：先重核它的 decode/*.rs，再更新这里的类型表"
  );
}

/// 界面会发出去的一段目录查询，连同它绑的参数。
struct CatalogRequest {
  name: &'static str,
  sql: String,
  params: Vec<Option<String>>,
}

impl CatalogRequest {
  fn new(name: &'static str, sql: &str, params: Vec<Option<String>>) -> Self {
    Self { name, sql: sql.to_string(), params }
  }
}

/// 界面对一张表、一个视图、整个库发的那几组目录查询。
///
/// 参数的造法照前端：表级的按 `parameter_count` 绑「表名 + schema」
/// （`catalogQueryParams`），库级的把库名重复 `parameter_count` 次。
/// 例程与序列各方言不同，由调用方补。
fn ui_catalog_requests(
  db_type: &dataomni_lib::models::DatabaseType,
  table: &str,
  view: &str,
  schema: Option<&str>,
  database: Option<&str>,
  quote: fn(&str) -> String,
) -> Vec<CatalogRequest> {
  let metadata = dataomni_lib::services::schema_metadata_queries(db_type).expect("supported");
  let scoped = |name: &str| -> Vec<Option<String>> {
    let mut params = vec![Some(name.to_string())];
    if metadata.parameter_count > 1 {
      params.push(schema.map(str::to_string));
    }
    params
  };
  let mut requests = vec![
    CatalogRequest::new("columns", metadata.columns, scoped(table)),
    CatalogRequest::new("indexes", metadata.indexes, scoped(table)),
    CatalogRequest::new("foreign_keys", metadata.foreign_keys, scoped(table)),
    CatalogRequest::new("triggers", metadata.triggers, scoped(table)),
  ];
  if let Some(sql) = metadata.check_constraints {
    requests.push(CatalogRequest::new("check_constraints", sql, scoped(table)));
  }
  // 用视图：PostgreSQL 只对视图给得出定义原文，表上这段本来就是 0 行
  match metadata.ddl {
    Some(dataomni_lib::services::DdlQuery::Bound { sql }) => {
      requests.push(CatalogRequest::new("ddl", sql, scoped(view)));
    }
    Some(dataomni_lib::services::DdlQuery::Interpolated { sql }) => {
      requests.push(CatalogRequest::new("ddl", &sql.replace("{table}", &quote(view)), vec![]));
    }
    None => {}
  }

  let repeated = |count: u8| vec![database.map(str::to_string); usize::from(count)];
  let objects = dataomni_lib::services::object_catalog_queries(db_type).expect("supported");
  requests.push(CatalogRequest::new(
    "objects",
    objects.objects,
    repeated(objects.object_parameter_count),
  ));
  let er = dataomni_lib::services::er_diagram_queries(db_type).expect("supported");
  requests.push(CatalogRequest::new("er_columns", er.columns, repeated(er.parameter_count)));
  requests.push(CatalogRequest::new(
    "er_foreign_keys",
    er.foreign_keys,
    repeated(er.parameter_count),
  ));
  let completion = dataomni_lib::services::completion_catalog_query(db_type).expect("supported");
  requests.push(CatalogRequest::new(
    "completion",
    completion.relations,
    repeated(completion.parameter_count),
  ));
  let target = dataomni_lib::services::session_target_query(db_type).expect("supported");
  requests.push(CatalogRequest::new("session_target", target.sql, vec![]));
  requests
}

/// 一段查询的结果里，插件解不了的列（`列名: 类型名`）。
///
/// 取类型名的方式与插件一致——`ValueRef::type_info().name()`，空值跳过，
/// 因为插件对空值一律先返回 null、不看类型。
fn undecodable_columns<R>(rows: &[R], decodable: &[&str]) -> std::collections::BTreeSet<String>
where
  R: Row,
  usize: sqlx::ColumnIndex<R>,
{
  use sqlx::ValueRef;
  let mut undecodable = std::collections::BTreeSet::new();
  for row in rows {
    for (index, column) in row.columns().iter().enumerate() {
      let Ok(value) = row.try_get_raw(index) else {
        undecodable.insert(format!("{}: <raw value unavailable>", column.name()));
        continue;
      };
      if value.is_null() {
        continue;
      }
      let type_name = value.type_info().name().to_string();
      if !decodable.contains(&type_name.as_str()) {
        undecodable.insert(format!("{}: {type_name}", column.name()));
      }
    }
  }
  undecodable
}

/// 每段都必须真的返回了行：0 行时列类型一个都没被检查，这条门就是空转的。
fn assert_plugin_decodes<R>(dialect: &str, request: &CatalogRequest, rows: &[R], decodable: &[&str])
where
  R: Row,
  usize: sqlx::ColumnIndex<R>,
{
  assert!(
    !rows.is_empty(),
    "{dialect} 的 {} 返回 0 行，列类型没有被检查到——夹具缺了这类对象",
    request.name
  );
  let undecodable = undecodable_columns(rows, decodable);
  assert!(
    undecodable.is_empty(),
    "{dialect} 的 {} 有插件解不了的列，界面上会报 unsupported datatype：{undecodable:?}",
    request.name
  );
}

#[tokio::test]
async fn sqlite_catalog_results_are_decodable_by_the_plugin() {
  let pool = SqlitePoolOptions::new()
    .max_connections(1)
    .connect("sqlite::memory:")
    .await
    .expect("connect to in-memory SQLite");

  let fixture = MetaFixture::new("litedecode");
  let view = format!("{}_v", fixture.child);
  for statement in fixture.ddl("sqlite") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare SQLite fixture");
  }
  for statement in [
    format!("CREATE VIEW {view} AS SELECT id, label FROM {}", fixture.child),
    format!(
      "CREATE TRIGGER {}_trg AFTER INSERT ON {} BEGIN SELECT 1; END",
      fixture.child, fixture.child
    ),
  ] {
    sqlx::query(&statement).execute(&pool).await.expect("prepare SQLite objects");
  }

  let requests = ui_catalog_requests(
    &dataomni_lib::models::DatabaseType::SQLite,
    &fixture.child,
    &view,
    None,
    None,
    |name| format!("\"{name}\""),
  );
  for request in &requests {
    let mut query = sqlx::query(&request.sql);
    for param in &request.params {
      query = query.bind(param.clone());
    }
    let rows = query
      .fetch_all(&pool)
      .await
      .unwrap_or_else(|error| panic!("SQLite 的 {} 跑不通: {error}", request.name));
    assert_plugin_decodes("SQLite", request, &rows, PLUGIN_DECODES_SQLITE);
  }
}

#[tokio::test]
async fn mysql_catalog_results_are_decodable_by_the_plugin() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");

  let fixture = MetaFixture::new("mydecode");
  let view = format!("{}_v", fixture.child);
  let function = format!("{}_fn", fixture.child);
  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  sqlx::raw_sql(&format!("DROP FUNCTION IF EXISTS {function}")).execute(&pool).await.ok();
  for statement in fixture.ddl(mysql_flavor(&pool).await.fixture_dialect()) {
    sqlx::query(&statement).execute(&pool).await.expect("prepare MySQL fixture");
  }
  sqlx::query(&format!("CREATE VIEW {view} AS SELECT id, label FROM {}", fixture.child))
    .execute(&pool)
    .await
    .expect("create view");
  // TiDB 没有触发器与存储函数，建不出来；那两段目录在它上面恒为 0 行，
  // 而 0 行的一段什么类型都没检查，只能不查
  let flavor = mysql_flavor(&pool).await;
  let stored_programs = flavor != MysqlFlavor::TiDb;
  // CREATE TRIGGER / FUNCTION 不收预处理协议（1295），走文本协议
  let program_statements = [
    format!(
      "CREATE TRIGGER {}_trg BEFORE INSERT ON {} FOR EACH ROW SET NEW.score = 1",
      fixture.child, fixture.child
    ),
    format!("CREATE FUNCTION {function}(a INT) RETURNS INT DETERMINISTIC RETURN a + 1"),
  ];
  for statement in program_statements.iter().filter(|_| stored_programs) {
    sqlx::raw_sql(statement).execute(&pool).await.expect("prepare MySQL objects");
  }
  let database: String =
    sqlx::query_scalar("SELECT DATABASE()").fetch_one(&pool).await.expect("current database");

  let mut requests = ui_catalog_requests(
    &dataomni_lib::models::DatabaseType::MySQL,
    &fixture.child,
    &view,
    None,
    Some(&database),
    |name| format!("`{name}`"),
  );
  let objects =
    dataomni_lib::services::object_catalog_queries(&dataomni_lib::models::DatabaseType::MySQL)
      .expect("supported");
  // 与 ObjectDefinitionDialog 一样：例程名加库名
  requests.push(CatalogRequest::new(
    "routine_definition",
    objects.routine_definition,
    vec![Some(function.clone()), Some(database.clone())],
  ));
  if !stored_programs {
    // 检查约束目录在 TiDB 上也恒为空，原因见 `mysql_reports_indexes_foreign_keys_and_checks`
    requests.retain(|request| {
      !["triggers", "routine_definition", "check_constraints"].contains(&request.name)
    });
  }

  for request in &requests {
    let mut query = sqlx::query(&request.sql);
    for param in &request.params {
      query = query.bind(param.clone());
    }
    let rows = query
      .fetch_all(&pool)
      .await
      .unwrap_or_else(|error| panic!("MySQL 的 {} 跑不通: {error}", request.name));
    assert_plugin_decodes("MySQL", request, &rows, PLUGIN_DECODES_MYSQL);
  }

  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  sqlx::raw_sql(&format!("DROP FUNCTION IF EXISTS {function}")).execute(&pool).await.ok();
  for table in [&fixture.child, &fixture.parent] {
    sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
  }
}

#[tokio::test]
async fn postgres_catalog_results_are_decodable_by_the_plugin() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");

  let cockroach = is_cockroach(&pool).await;
  let fixture = MetaFixture::new("pgdecode");
  let view = format!("{}_v", fixture.child);
  let function = format!("{}_fn", fixture.child);
  let sequence = format!("{}_seq", fixture.child);
  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  for statement in fixture.ddl("postgres") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare PostgreSQL fixture");
  }
  for statement in [
    format!("CREATE VIEW {view} AS SELECT id, label FROM {}", fixture.child),
    format!("DROP SEQUENCE IF EXISTS {sequence}"),
    format!("CREATE SEQUENCE {sequence}"),
    format!(
      "CREATE OR REPLACE FUNCTION {function}() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql"
    ),
    format!(
      "CREATE TRIGGER {}_trg BEFORE INSERT ON {} FOR EACH ROW EXECUTE FUNCTION {function}()",
      fixture.child, fixture.child
    ),
  ] {
    sqlx::query(&statement).execute(&pool).await.expect("prepare PostgreSQL objects");
  }
  let sequence_oid: String =
    sqlx::query_scalar(&format!("SELECT '{sequence}'::regclass::oid::text"))
      .fetch_one(&pool)
      .await
      .expect("sequence oid");
  let function_oid: String =
    sqlx::query_scalar(&format!("SELECT '{function}'::regproc::oid::text"))
      .fetch_one(&pool)
      .await
      .expect("function oid");

  let mut requests = ui_catalog_requests(
    &dataomni_lib::models::DatabaseType::PostgreSQL,
    &fixture.child,
    &view,
    Some("public"),
    None,
    |name| format!("\"{name}\""),
  );
  let objects =
    dataomni_lib::services::object_catalog_queries(&dataomni_lib::models::DatabaseType::PostgreSQL)
      .expect("supported");
  // 与 ObjectDefinitionDialog 一样：两段都只绑对象的 oid
  requests.push(CatalogRequest::new(
    "routine_definition",
    objects.routine_definition,
    vec![Some(function_oid)],
  ));
  requests.push(CatalogRequest::new(
    "sequence_properties",
    objects.sequence_properties.expect("PostgreSQL has sequences"),
    vec![Some(sequence_oid)],
  ));

  for request in &requests {
    let mut query = sqlx::query(&request.sql);
    for param in &request.params {
      query = query.bind(param.clone());
    }
    let rows = match query.fetch_all(&pool).await {
      Err(error) if cockroach && request.name == "triggers" => {
        assert_cockroach_refuses_the_trigger_catalog(error);
        continue;
      }
      result => {
        result.unwrap_or_else(|error| panic!("PostgreSQL 的 {} 跑不通: {error}", request.name))
      }
    };
    assert_plugin_decodes("PostgreSQL", request, &rows, PLUGIN_DECODES_POSTGRES);
  }

  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  for table in [&fixture.child, &fixture.parent] {
    sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
  }
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {function}()")).execute(&pool).await.ok();
  sqlx::query(&format!("DROP SEQUENCE IF EXISTS {sequence}")).execute(&pool).await.ok();
}

// ---------------------------------------------------------------------------
// 视图定义与触发器
// ---------------------------------------------------------------------------

#[tokio::test]
async fn postgres_returns_the_view_definition_but_not_a_create_table() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");

  let fixture = MetaFixture::new("pgview");
  let view = format!("{}_v", fixture.child);
  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  for statement in fixture.ddl("postgres") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare PostgreSQL fixture");
  }
  sqlx::query(&format!("CREATE VIEW {view} AS SELECT id, label FROM {}", fixture.child))
    .execute(&pool)
    .await
    .expect("create view");

  let queries = dataomni_lib::services::schema_metadata_queries(
    &dataomni_lib::models::DatabaseType::PostgreSQL,
  )
  .expect("supported");
  let Some(dataomni_lib::services::DdlQuery::Bound { sql }) = queries.ddl else {
    panic!("PostgreSQL 走绑定参数");
  };

  let view_rows = sqlx::query(sql)
    .bind(&view)
    .bind(Option::<String>::None)
    .fetch_all(&pool)
    .await
    .expect("run view definition query");
  assert_eq!(view_rows.len(), 1, "视图应给出定义");
  let definition: String = view_rows[0].get("sql");
  assert!(definition.starts_with("CREATE OR REPLACE VIEW"), "应是可执行的定义: {definition}");
  assert!(definition.contains("SELECT"), "应含视图的 SELECT: {definition}");

  // 同一段 SQL 查一张普通表时必须什么也不给——否则前端会把空结果当成定义显示
  let table_rows = sqlx::query(sql)
    .bind(&fixture.child)
    .bind(Option::<String>::None)
    .fetch_all(&pool)
    .await
    .expect("run view definition query against a table");
  assert!(table_rows.is_empty(), "查表时不该返回任何东西：PostgreSQL 没有权威建表语句");

  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  for table in [&fixture.child, &fixture.parent] {
    sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
  }
}

#[tokio::test]
async fn postgres_lists_user_triggers_without_the_foreign_key_internals() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");

  let fixture = MetaFixture::new("pgtrig");
  let function = format!("{}_fn", fixture.child);
  let trigger = format!("{}_trg", fixture.child);
  for statement in fixture.ddl("postgres") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare PostgreSQL fixture");
  }
  sqlx::query(&format!(
    "CREATE OR REPLACE FUNCTION {function}() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql"
  ))
  .execute(&pool)
  .await
  .expect("create trigger function");
  sqlx::query(&format!(
    "CREATE TRIGGER {trigger} BEFORE INSERT ON {} FOR EACH ROW EXECUTE FUNCTION {function}()",
    fixture.child
  ))
  .execute(&pool)
  .await
  .expect("create trigger");

  let queries = dataomni_lib::services::schema_metadata_queries(
    &dataomni_lib::models::DatabaseType::PostgreSQL,
  )
  .expect("supported");
  let outcome = sqlx::query(queries.triggers)
    .bind(&fixture.child)
    .bind(Option::<String>::None)
    .fetch_all(&pool)
    .await;
  let rows = match outcome {
    Err(error) if is_cockroach(&pool).await => {
      assert_cockroach_refuses_the_trigger_catalog(error);
      Vec::new()
    }
    result => result.expect("run trigger query"),
  };

  if rows.is_empty() && is_cockroach(&pool).await {
    for table in [&fixture.child, &fixture.parent] {
      sqlx::query(&format!("DROP TABLE IF EXISTS {table} CASCADE")).execute(&pool).await.ok();
    }
    sqlx::query(&format!("DROP FUNCTION IF EXISTS {function}()")).execute(&pool).await.ok();
    return;
  }

  let names: Vec<String> = rows.iter().map(|row| row.get::<String, _>("trigger_name")).collect();
  // 这张表带外键，PostgreSQL 会为它建内部触发器；tgisinternal 没排掉的话
  // 这里会多出几条用户看不懂的条目
  assert_eq!(names, vec![trigger.clone()], "只应列出用户写的触发器: {names:?}");
  let definition: String = rows[0].get("definition");
  assert!(definition.starts_with("CREATE TRIGGER"), "应是完整定义原文: {definition}");

  sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger} ON {}", fixture.child))
    .execute(&pool)
    .await
    .ok();
  for table in [&fixture.child, &fixture.parent] {
    sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
  }
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {function}()")).execute(&pool).await.ok();
}

#[tokio::test]
async fn mysql_returns_trigger_components_and_the_create_view_statement() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");

  let fixture = MetaFixture::new("mytrig");
  let view = format!("{}_v", fixture.child);
  let trigger = format!("{}_trg", fixture.child);
  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  for statement in fixture.ddl(mysql_flavor(&pool).await.fixture_dialect()) {
    sqlx::query(&statement).execute(&pool).await.expect("prepare MySQL fixture");
  }
  sqlx::query(&format!("CREATE VIEW {view} AS SELECT id, label FROM {}", fixture.child))
    .execute(&pool)
    .await
    .expect("create view");
  // TiDB 没有触发器：视图那一半照查，触发器那一半只断言目录是空的
  let has_triggers = mysql_flavor(&pool).await != MysqlFlavor::TiDb;
  // MySQL 的 CREATE TRIGGER 不支持预处理协议（错误 1295），只能走文本协议
  if has_triggers {
    sqlx::raw_sql(&format!(
      "CREATE TRIGGER {trigger} BEFORE INSERT ON {} FOR EACH ROW SET NEW.score = 1",
      fixture.child
    ))
    .execute(&pool)
    .await
    .expect("create trigger");
  }

  let queries =
    dataomni_lib::services::schema_metadata_queries(&dataomni_lib::models::DatabaseType::MySQL)
      .expect("supported");

  // SHOW CREATE TABLE 对视图返回的列叫 `Create View`，不是 `Create Table`
  let Some(dataomni_lib::services::DdlQuery::Interpolated { sql }) = queries.ddl else {
    panic!("MySQL 走插值");
  };
  let row = sqlx::query(&sql.replace("{table}", &format!("`{view}`")))
    .fetch_one(&pool)
    .await
    .expect("run SHOW CREATE TABLE on a view");
  assert_eq!(
    row.columns().iter().map(|column| column.name()).collect::<Vec<_>>(),
    vec!["View", "Create View", "character_set_client", "collation_connection"]
  );
  let view_ddl: String = row.get(1);
  assert!(view_ddl.contains("CREATE"), "应是视图定义原文: {view_ddl}");

  let rows = sqlx::query(queries.triggers)
    .bind(&fixture.child)
    .bind(Option::<String>::None)
    .fetch_all(&pool)
    .await
    .expect("run trigger query");
  if !has_triggers {
    assert!(rows.is_empty(), "TiDB 上触发器目录应是空的");
    return;
  }
  assert_eq!(rows.len(), 1);
  assert_eq!(rows[0].get::<String, _>("trigger_name"), trigger);
  // MySQL 只给拆开的组件，没有完整的 CREATE TRIGGER
  assert_eq!(rows[0].get::<String, _>("timing"), "BEFORE");
  assert_eq!(rows[0].get::<String, _>("event"), "INSERT");
  assert!(rows[0].get::<String, _>("definition").contains("NEW.score"));

  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  for table in [&fixture.child, &fixture.parent] {
    sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
  }
}

#[tokio::test]
async fn sqlite_returns_view_and_trigger_definitions() {
  let pool = SqlitePoolOptions::new()
    .max_connections(1)
    .connect("sqlite::memory:")
    .await
    .expect("connect to in-memory SQLite");

  let fixture = MetaFixture::new("liteview");
  let view = format!("{}_v", fixture.child);
  let trigger = format!("{}_trg", fixture.child);
  for statement in fixture.ddl("sqlite") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare SQLite fixture");
  }
  sqlx::query(&format!("CREATE VIEW {view} AS SELECT id, label FROM {}", fixture.child))
    .execute(&pool)
    .await
    .expect("create view");
  sqlx::query(&format!(
    "CREATE TRIGGER {trigger} AFTER INSERT ON {} BEGIN SELECT 1; END",
    fixture.child
  ))
  .execute(&pool)
  .await
  .expect("create trigger");

  let queries =
    dataomni_lib::services::schema_metadata_queries(&dataomni_lib::models::DatabaseType::SQLite)
      .expect("supported");

  let Some(dataomni_lib::services::DdlQuery::Bound { sql }) = queries.ddl else {
    panic!("SQLite 走绑定参数");
  };
  let view_rows = sqlx::query(sql).bind(&view).fetch_all(&pool).await.expect("run sqlite_master");
  let view_ddl: String = view_rows[0].get("sql");
  assert!(view_ddl.starts_with("CREATE VIEW"), "视图定义原文: {view_ddl}");

  let rows = sqlx::query(queries.triggers)
    .bind(&fixture.child)
    .fetch_all(&pool)
    .await
    .expect("run trigger query");
  assert_eq!(rows.len(), 1);
  assert_eq!(rows[0].get::<String, _>("trigger_name"), trigger);
  assert!(rows[0].get::<String, _>("definition").starts_with("CREATE TRIGGER"));
}

// ---------------------------------------------------------------------------
// 库级对象目录：表 / 视图 / 物化视图 / 函数 / 存储过程 / 序列
// ---------------------------------------------------------------------------

#[tokio::test]
async fn postgres_lists_database_objects_and_resolves_overloaded_routines() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");

  let fixture = MetaFixture::new("pgcat");
  let view = format!("{}_v", fixture.child);
  let matview = format!("{}_mv", fixture.child);
  let sequence = format!("{}_seq", fixture.child);
  let routine = format!("{}_fn", fixture.child);

  sqlx::query(&format!("DROP MATERIALIZED VIEW IF EXISTS {matview}")).execute(&pool).await.ok();
  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  sqlx::query(&format!("DROP SEQUENCE IF EXISTS {sequence}")).execute(&pool).await.ok();
  for statement in fixture.ddl("postgres") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare PostgreSQL fixture");
  }
  sqlx::query(&format!("CREATE VIEW {view} AS SELECT id FROM {}", fixture.child))
    .execute(&pool)
    .await
    .expect("create view");
  sqlx::query(&format!("CREATE MATERIALIZED VIEW {matview} AS SELECT id FROM {}", fixture.child))
    .execute(&pool)
    .await
    .expect("create materialized view");
  sqlx::query(&format!("CREATE SEQUENCE {sequence} START 7 INCREMENT 3"))
    .execute(&pool)
    .await
    .expect("create sequence");
  // 两个同名函数，只有参数类型不同——这正是「按名字取定义」会出错的情形
  sqlx::query(&format!(
    "CREATE OR REPLACE FUNCTION {routine}(a int) RETURNS int AS $$ SELECT a + 1 $$ LANGUAGE sql"
  ))
  .execute(&pool)
  .await
  .expect("create function int");
  sqlx::query(&format!("CREATE OR REPLACE FUNCTION {routine}(a text) RETURNS text AS $$ SELECT a || 'x' $$ LANGUAGE sql"))
    .execute(&pool)
    .await
    .expect("create function text");

  let queries =
    dataomni_lib::services::object_catalog_queries(&dataomni_lib::models::DatabaseType::PostgreSQL)
      .expect("supported");
  let rows = sqlx::query(queries.objects).fetch_all(&pool).await.expect("list objects");
  let objects: Vec<(String, String, String)> = rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("object_name"),
        row.get::<String, _>("object_kind"),
        row.get::<String, _>("object_id"),
      )
    })
    .collect();

  let kind_of =
    |name: &str| objects.iter().find(|(n, ..)| n == name).map(|(_, kind, _)| kind.clone());
  assert_eq!(kind_of(&fixture.child).as_deref(), Some("table"));
  assert_eq!(kind_of(&view).as_deref(), Some("view"));
  assert_eq!(kind_of(&matview).as_deref(), Some("materialized-view"));
  assert_eq!(kind_of(&sequence).as_deref(), Some("sequence"));

  // 重载的两个函数必须是两条、显示名带参数签名，否则树里长得一模一样
  let overloads: Vec<&(String, String, String)> =
    objects.iter().filter(|(name, ..)| name.starts_with(&routine)).collect();
  assert_eq!(overloads.len(), 2, "两个重载应各占一条: {overloads:?}");
  // CockroachDB 的签名不带参数名、类型用它自己的拼法：`(int8)` / `(text)`
  let (integer_signature, text_signature) =
    if is_cockroach(&pool).await { ("(int8)", "(text)") } else { ("(a integer)", "(a text)") };
  assert!(
    overloads.iter().any(|(name, ..)| name.ends_with(integer_signature))
      && overloads.iter().any(|(name, ..)| name.ends_with(text_signature)),
    "显示名要带参数签名: {overloads:?}"
  );
  assert_ne!(overloads[0].2, overloads[1].2, "两个重载的 object_id 必须不同");

  // 按 oid 取定义，取到的必须是对应的那一个重载
  for (name, _, id) in &overloads {
    let definition: String = sqlx::query(queries.routine_definition)
      .bind(id)
      .fetch_one(&pool)
      .await
      .expect("run routine definition query")
      .get("definition");
    // CockroachDB 的定义原文用它自己的类型名：`INT8`、`STRING`
    let cockroach = integer_signature == "(int8)";
    let expected = match (name.ends_with(text_signature), cockroach) {
      (true, true) => "STRING",
      (true, false) => "TEXT",
      (false, true) => "INT8",
      (false, false) => "INTEGER",
    };
    assert!(
      definition.to_uppercase().contains(&format!("RETURNS {expected}")),
      "oid {id} 应取到 {name} 的定义，实际: {definition}"
    );
  }

  let sequence_id = objects
    .iter()
    .find(|(name, ..)| name == &sequence)
    .map(|(.., id)| id.clone())
    .expect("sequence listed");
  let sequence_sql = queries.sequence_properties.expect("PostgreSQL has sequences");
  let row = sqlx::query(sequence_sql)
    .bind(&sequence_id)
    .fetch_one(&pool)
    .await
    .expect("run sequence properties query");
  assert_eq!(row.get::<String, _>("start_value"), "7");
  assert_eq!(row.get::<String, _>("increment_by"), "3");

  sqlx::query(&format!("DROP MATERIALIZED VIEW IF EXISTS {matview}")).execute(&pool).await.ok();
  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  sqlx::query(&format!("DROP SEQUENCE IF EXISTS {sequence}")).execute(&pool).await.ok();
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {routine}(int)")).execute(&pool).await.ok();
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {routine}(text)")).execute(&pool).await.ok();
  for table in [&fixture.child, &fixture.parent] {
    sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
  }
}

#[tokio::test]
async fn mysql_lists_tables_views_and_routines() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");

  let fixture = MetaFixture::new("mycat");
  let view = format!("{}_v", fixture.child);
  let routine = format!("{}_fn", fixture.child);
  let procedure = format!("{}_sp", fixture.child);

  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  sqlx::raw_sql(&format!("DROP FUNCTION IF EXISTS {routine}")).execute(&pool).await.ok();
  sqlx::raw_sql(&format!("DROP PROCEDURE IF EXISTS {procedure}")).execute(&pool).await.ok();
  for statement in fixture.ddl(mysql_flavor(&pool).await.fixture_dialect()) {
    sqlx::query(&statement).execute(&pool).await.expect("prepare MySQL fixture");
  }
  sqlx::query(&format!("CREATE VIEW {view} AS SELECT id FROM {}", fixture.child))
    .execute(&pool)
    .await
    .expect("create view");
  // TiDB 没有存储函数与过程：表和视图照查，例程那一半跳过
  let stored_programs = mysql_flavor(&pool).await != MysqlFlavor::TiDb;
  // CREATE FUNCTION / PROCEDURE 不支持预处理协议
  if stored_programs {
    sqlx::raw_sql(&format!(
      "CREATE FUNCTION {routine}(a INT) RETURNS INT DETERMINISTIC RETURN a + 1"
    ))
    .execute(&pool)
    .await
    .expect("create function");
    sqlx::raw_sql(&format!("CREATE PROCEDURE {procedure}() SELECT 1"))
      .execute(&pool)
      .await
      .expect("create procedure");
  }

  let database: String =
    sqlx::query_scalar("SELECT DATABASE()").fetch_one(&pool).await.expect("current database");

  let queries =
    dataomni_lib::services::object_catalog_queries(&dataomni_lib::models::DatabaseType::MySQL)
      .expect("supported");
  let rows = sqlx::query(queries.objects)
    .bind(&database)
    .bind(&database)
    .fetch_all(&pool)
    .await
    .expect("list objects");
  let objects: Vec<(String, String)> = rows
    .iter()
    .map(|row| (row.get::<String, _>("object_name"), row.get::<String, _>("object_kind")))
    .collect();

  let kind_of = |name: &str| objects.iter().find(|(n, _)| n == name).map(|(_, kind)| kind.clone());
  assert_eq!(kind_of(&fixture.child).as_deref(), Some("table"));
  assert_eq!(kind_of(&view).as_deref(), Some("view"));
  if stored_programs {
    assert_eq!(kind_of(&routine).as_deref(), Some("function"));
    assert_eq!(kind_of(&procedure).as_deref(), Some("procedure"));

    let definition: String = sqlx::query(queries.routine_definition)
      .bind(&routine)
      .bind(Option::<String>::None)
      .fetch_one(&pool)
      .await
      .expect("run routine definition query")
      .get("definition");
    assert!(definition.contains("a + 1"), "应给出语句体: {definition}");
  }

  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  sqlx::raw_sql(&format!("DROP FUNCTION IF EXISTS {routine}")).execute(&pool).await.ok();
  sqlx::raw_sql(&format!("DROP PROCEDURE IF EXISTS {procedure}")).execute(&pool).await.ok();
  for table in [&fixture.child, &fixture.parent] {
    sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
  }
}

#[tokio::test]
async fn sqlite_lists_tables_and_views_without_internal_objects() {
  let pool = SqlitePoolOptions::new()
    .max_connections(1)
    .connect("sqlite::memory:")
    .await
    .expect("connect to in-memory SQLite");

  let fixture = MetaFixture::new("litecat");
  let view = format!("{}_v", fixture.child);
  for statement in fixture.ddl("sqlite") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare SQLite fixture");
  }
  sqlx::query(&format!("CREATE VIEW {view} AS SELECT id FROM {}", fixture.child))
    .execute(&pool)
    .await
    .expect("create view");
  // AUTOINCREMENT 会让 SQLite 建一张内部的 sqlite_sequence 表
  sqlx::query("CREATE TABLE auto_t (id INTEGER PRIMARY KEY AUTOINCREMENT)")
    .execute(&pool)
    .await
    .expect("create autoincrement table");

  let queries =
    dataomni_lib::services::object_catalog_queries(&dataomni_lib::models::DatabaseType::SQLite)
      .expect("supported");
  let rows = sqlx::query(queries.objects).fetch_all(&pool).await.expect("list objects");
  let objects: Vec<(String, String)> = rows
    .iter()
    .map(|row| (row.get::<String, _>("object_name"), row.get::<String, _>("object_kind")))
    .collect();

  assert!(objects.contains(&(fixture.child.clone(), "table".into())));
  assert!(objects.contains(&(view.clone(), "view".into())));
  assert!(
    !objects.iter().any(|(name, _)| name.starts_with("sqlite_")),
    "SQLite 内部对象不该出现在树里: {objects:?}"
  );
}

// ---------------------------------------------------------------------------
// 整库 ER 图数据
// ---------------------------------------------------------------------------

#[tokio::test]
async fn postgres_er_diagram_covers_all_tables_and_their_links() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");

  let fixture = MetaFixture::new("pger");
  // 一张与谁都没关系的表：用户明确要求孤立的表也要出现在图里
  let lonely = format!("{}_lonely", fixture.child);
  sqlx::query(&format!("DROP TABLE IF EXISTS {lonely}")).execute(&pool).await.ok();
  for statement in fixture.ddl("postgres") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare PostgreSQL fixture");
  }
  sqlx::query(&format!("CREATE TABLE {lonely} (note VARCHAR(16))"))
    .execute(&pool)
    .await
    .expect("create lonely table");

  let queries =
    dataomni_lib::services::er_diagram_queries(&dataomni_lib::models::DatabaseType::PostgreSQL)
      .expect("supported");

  let column_rows = sqlx::query(queries.columns).fetch_all(&pool).await.expect("list columns");
  let columns: Vec<(String, String, String, bool)> = column_rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("table_name"),
        row.get::<String, _>("column_name"),
        row.get::<String, _>("data_type"),
        row.get::<bool, _>("is_primary_key"),
      )
    })
    .collect();

  // 孤立的表必须在列清单里——图上要画出它，即便一条线也没有
  assert!(
    columns.iter().any(|(table, column, ..)| table == &lonely && column == "note"),
    "没有外键的表也要出现"
  );
  // 类型要带长度：丢掉 (32) 等于丢掉一半信息
  let label = columns
    .iter()
    .find(|(table, column, ..)| table == &fixture.child && column == "label")
    .map(|(.., data_type, _)| data_type.clone());
  assert_eq!(label.as_deref(), Some("character varying(32)"), "类型要带长度");
  assert!(
    columns.iter().any(|(table, column, _, pk)| table == &fixture.child && column == "id" && *pk),
    "主键要标出来: {columns:?}"
  );

  let fk_rows =
    sqlx::query(queries.foreign_keys).fetch_all(&pool).await.expect("list foreign keys");
  let links: Vec<(String, String, String, String)> = fk_rows
    .iter()
    .filter(|row| row.get::<String, _>("table_name") == fixture.child)
    .map(|row| {
      (
        row.get::<String, _>("table_name"),
        row.get::<String, _>("column_name"),
        row.get::<String, _>("referenced_table"),
        row.get::<String, _>("referenced_column"),
      )
    })
    .collect();
  assert_eq!(
    links,
    vec![
      (fixture.child.clone(), "ref_a".into(), fixture.parent.clone(), "x".into()),
      (fixture.child.clone(), "ref_b".into(), fixture.parent.clone(), "y".into()),
    ],
    "复合外键的两条连线必须各自连到对的列上"
  );

  sqlx::query(&format!("DROP TABLE IF EXISTS {lonely}")).execute(&pool).await.ok();
  for table in [&fixture.child, &fixture.parent] {
    sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
  }
}

#[tokio::test]
async fn mysql_er_diagram_reports_column_types_with_length() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");

  let fixture = MetaFixture::new("myer");
  let view = format!("{}_v", fixture.child);
  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  for statement in fixture.ddl(mysql_flavor(&pool).await.fixture_dialect()) {
    sqlx::query(&statement).execute(&pool).await.expect("prepare MySQL fixture");
  }
  sqlx::query(&format!("CREATE VIEW {view} AS SELECT id FROM {}", fixture.child))
    .execute(&pool)
    .await
    .expect("create view");

  let database: String =
    sqlx::query_scalar("SELECT DATABASE()").fetch_one(&pool).await.expect("current database");
  let queries =
    dataomni_lib::services::er_diagram_queries(&dataomni_lib::models::DatabaseType::MySQL)
      .expect("supported");

  let column_rows =
    sqlx::query(queries.columns).bind(&database).fetch_all(&pool).await.expect("list columns");
  let columns: Vec<(String, String, String)> = column_rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("table_name"),
        row.get::<String, _>("column_name"),
        row.get::<String, _>("data_type"),
      )
    })
    .collect();

  assert_eq!(
    columns
      .iter()
      .find(|(table, column, _)| table == &fixture.child && column == "label")
      .map(|(.., data_type)| data_type.as_str()),
    Some("varchar(32)"),
    "DATA_TYPE 只给 varchar；图上要显示的是完整类型"
  );
  // ER 图画的是表之间的外键，视图没有外键，混进来只会多出一堆孤立的框
  assert!(!columns.iter().any(|(table, ..)| table == &view), "视图不该出现在 ER 图里: {columns:?}");

  let fk_rows = sqlx::query(queries.foreign_keys)
    .bind(&database)
    .fetch_all(&pool)
    .await
    .expect("list foreign keys");
  let links: Vec<(String, String)> = fk_rows
    .iter()
    .filter(|row| row.get::<String, _>("table_name") == fixture.child)
    .map(|row| (row.get::<String, _>("column_name"), row.get::<String, _>("referenced_column")))
    .collect();
  assert_eq!(links, vec![("ref_a".into(), "x".into()), ("ref_b".into(), "y".into())]);

  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  for table in [&fixture.child, &fixture.parent] {
    sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
  }
}

#[tokio::test]
async fn sqlite_er_diagram_reads_every_table_in_one_round_trip() {
  let pool = SqlitePoolOptions::new()
    .max_connections(1)
    .connect("sqlite::memory:")
    .await
    .expect("connect to in-memory SQLite");

  let fixture = MetaFixture::new("liteer");
  for statement in fixture.ddl("sqlite") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare SQLite fixture");
  }
  sqlx::query("CREATE TABLE lonely_note (note TEXT)").execute(&pool).await.expect("lonely");

  let queries =
    dataomni_lib::services::er_diagram_queries(&dataomni_lib::models::DatabaseType::SQLite)
      .expect("supported");

  let column_rows = sqlx::query(queries.columns).fetch_all(&pool).await.expect("list columns");
  let columns: Vec<(String, String, i64)> = column_rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("table_name"),
        row.get::<String, _>("column_name"),
        row.get::<i64, _>("is_primary_key"),
      )
    })
    .collect();

  // 一次查完所有表：按表逐个跑 PRAGMA 在几十张表的库上就是几十次往返
  assert!(columns.iter().any(|(table, ..)| table == &fixture.parent));
  assert!(columns.iter().any(|(table, ..)| table == &fixture.child));
  assert!(columns.iter().any(|(table, column, _)| table == "lonely_note" && column == "note"));
  assert!(
    columns.iter().any(|(table, column, pk)| table == &fixture.child && column == "id" && *pk == 1),
    "主键要标出来: {columns:?}"
  );

  let fk_rows =
    sqlx::query(queries.foreign_keys).fetch_all(&pool).await.expect("list foreign keys");
  let links: Vec<(String, String, String)> = fk_rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("column_name"),
        row.get::<String, _>("referenced_table"),
        row.get::<String, _>("referenced_column"),
      )
    })
    .collect();
  assert_eq!(
    links,
    vec![
      ("ref_a".into(), fixture.parent.clone(), "x".into()),
      ("ref_b".into(), fixture.parent.clone(), "y".into()),
    ]
  );
}

#[tokio::test]
async fn postgres_completion_catalog_lists_views_next_to_tables() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");

  let fixture = MetaFixture::new("pgcomp");
  let view = format!("{}_v", fixture.child);
  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  for statement in fixture.ddl("postgres") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare PostgreSQL fixture");
  }
  sqlx::query(&format!("CREATE VIEW {view} AS SELECT id, label FROM {}", fixture.child))
    .execute(&pool)
    .await
    .expect("create view");

  let query = dataomni_lib::services::completion_catalog_query(
    &dataomni_lib::models::DatabaseType::PostgreSQL,
  )
  .expect("supported");
  let rows = sqlx::query(query.relations).fetch_all(&pool).await.expect("list relations");
  let catalog: Vec<(String, String, String, String)> = rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("relation_name"),
        row.get::<String, _>("relation_kind"),
        row.get::<String, _>("column_name"),
        row.get::<String, _>("data_type"),
      )
    })
    .collect();

  // 列必须按表内顺序返回：补全列表照抄这个次序，按字母排会把 id 冲到中间
  let child_columns: Vec<&str> = catalog
    .iter()
    .filter(|(relation, ..)| relation == &fixture.child)
    .map(|(_, _, column, _)| column.as_str())
    .collect();
  assert_eq!(child_columns, vec!["id", "ref_b", "ref_a", "label", "score"], "列要保持表内顺序");

  assert!(
    catalog
      .iter()
      .any(|(relation, kind, column, _)| relation == &view && kind == "view" && column == "label"),
    "视图的列也要能补全，且标成 view: {catalog:?}"
  );
  assert_eq!(
    catalog
      .iter()
      .find(|(relation, _, column, _)| relation == &fixture.child && column == "label")
      .map(|(.., data_type)| data_type.as_str()),
    Some("character varying(32)"),
    "补全项的说明里要看得见长度"
  );

  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  for table in [&fixture.child, &fixture.parent] {
    sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
  }
}

#[tokio::test]
async fn mysql_completion_catalog_lists_views_next_to_tables() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");

  let fixture = MetaFixture::new("mycomp");
  let view = format!("{}_v", fixture.child);
  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  for statement in fixture.ddl(mysql_flavor(&pool).await.fixture_dialect()) {
    sqlx::query(&statement).execute(&pool).await.expect("prepare MySQL fixture");
  }
  sqlx::query(&format!("CREATE VIEW {view} AS SELECT id, label FROM {}", fixture.child))
    .execute(&pool)
    .await
    .expect("create view");

  let database: String =
    sqlx::query_scalar("SELECT DATABASE()").fetch_one(&pool).await.expect("current database");
  let query =
    dataomni_lib::services::completion_catalog_query(&dataomni_lib::models::DatabaseType::MySQL)
      .expect("supported");
  let rows =
    sqlx::query(query.relations).bind(&database).fetch_all(&pool).await.expect("list relations");
  let catalog: Vec<(String, String, String, String)> = rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("relation_name"),
        row.get::<String, _>("relation_kind"),
        row.get::<String, _>("column_name"),
        row.get::<String, _>("data_type"),
      )
    })
    .collect();

  let child_columns: Vec<&str> = catalog
    .iter()
    .filter(|(relation, ..)| relation == &fixture.child)
    .map(|(_, _, column, _)| column.as_str())
    .collect();
  assert_eq!(child_columns, vec!["id", "ref_b", "ref_a", "label", "score"], "列要保持表内顺序");

  assert!(
    catalog
      .iter()
      .any(|(relation, kind, column, _)| relation == &view && kind == "view" && column == "label"),
    "视图的列也要能补全，且标成 view: {catalog:?}"
  );
  assert_eq!(
    catalog
      .iter()
      .find(|(relation, _, column, _)| relation == &fixture.child && column == "label")
      .map(|(.., data_type)| data_type.as_str()),
    Some("varchar(32)"),
    "COLUMN_TYPE 才带长度"
  );

  sqlx::query(&format!("DROP VIEW IF EXISTS {view}")).execute(&pool).await.ok();
  for table in [&fixture.child, &fixture.parent] {
    sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
  }
}

#[tokio::test]
async fn sqlite_completion_catalog_lists_views_next_to_tables() {
  let pool = SqlitePoolOptions::new()
    .max_connections(1)
    .connect("sqlite::memory:")
    .await
    .expect("connect to in-memory SQLite");

  let fixture = MetaFixture::new("litecomp");
  for statement in fixture.ddl("sqlite") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare SQLite fixture");
  }
  let view = format!("{}_v", fixture.child);
  sqlx::query(&format!("CREATE VIEW {view} AS SELECT id, label FROM {}", fixture.child))
    .execute(&pool)
    .await
    .expect("create view");

  let query =
    dataomni_lib::services::completion_catalog_query(&dataomni_lib::models::DatabaseType::SQLite)
      .expect("supported");
  let rows = sqlx::query(query.relations).fetch_all(&pool).await.expect("list relations");
  let catalog: Vec<(String, String, String)> = rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("relation_name"),
        row.get::<String, _>("relation_kind"),
        row.get::<String, _>("column_name"),
      )
    })
    .collect();

  let child_columns: Vec<&str> = catalog
    .iter()
    .filter(|(relation, ..)| relation == &fixture.child)
    .map(|(_, _, column)| column.as_str())
    .collect();
  assert_eq!(child_columns, vec!["id", "ref_b", "ref_a", "label", "score"], "列要保持表内顺序");

  assert!(
    catalog
      .iter()
      .any(|(relation, kind, column)| relation == &view && kind == "view" && column == "label"),
    "pragma_table_info 对视图同样给列: {catalog:?}"
  );
  // sqlite_master 里的内部表不该混进补全
  assert!(
    !catalog.iter().any(|(relation, ..)| relation.starts_with("sqlite_")),
    "内部表要挡住: {catalog:?}"
  );
}

#[tokio::test]
async fn postgres_session_target_reports_the_servers_own_answer() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");

  let query =
    dataomni_lib::services::session_target_query(&dataomni_lib::models::DatabaseType::PostgreSQL)
      .expect("supported");

  let row = sqlx::query(query.sql).fetch_one(&pool).await.expect("read session target");
  assert!(!row.get::<String, _>("database_name").is_empty(), "库名不该是空的");
  assert_eq!(row.get::<Option<String>, _>("schema_name").as_deref(), Some("public"));
  assert!(!row.get::<bool, _>("read_only"), "普通连接不是只读的");

  // 同一条连接上改掉 search_path 之后，这条查询报的是新值——证明它读的是
  // 服务端的实际状态，不是把连接串里的东西原样回显。
  //
  // 应用里**不会**据此做实时刷新：tauri-plugin-sql 用的是 sqlx 默认的连接池
  // （最多 10 条连接），`SET` 只改动其中一条，下一条查询可能落在另一条上。
  // 所以界面上那一栏说的是「新查询默认落在哪」，不是「会话现在在哪」。
  let mut conn = pool.acquire().await.expect("hold one connection");
  let schema = "dataomni_target_probe";
  sqlx::query(&format!("CREATE SCHEMA IF NOT EXISTS {schema}"))
    .execute(&mut *conn)
    .await
    .expect("create probe schema");
  sqlx::query(&format!("SET search_path TO {schema}"))
    .execute(&mut *conn)
    .await
    .expect("move this connection");

  let moved =
    sqlx::query(query.sql).fetch_one(&mut *conn).await.expect("read session target again");
  assert_eq!(
    moved.get::<Option<String>, _>("schema_name").as_deref(),
    Some(schema),
    "读的必须是服务端的实际 schema，不是连接配置的回显"
  );

  sqlx::query("SET search_path TO public").execute(&mut *conn).await.ok();
  sqlx::query(&format!("DROP SCHEMA IF EXISTS {schema}")).execute(&mut *conn).await.ok();
}

#[tokio::test]
async fn mysql_session_target_reports_database_and_read_only() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");

  let query =
    dataomni_lib::services::session_target_query(&dataomni_lib::models::DatabaseType::MySQL)
      .expect("supported");

  let row = sqlx::query(query.sql).fetch_one(&pool).await.expect("read session target");
  assert_eq!(
    row.get::<Option<String>, _>("database_name").as_deref(),
    Some("dataomni_test"),
    "报的应当是服务端选定的库"
  );
  // MySQL 没有独立于库的 schema，这一列恒为 NULL
  assert!(row.get::<Option<String>, _>("schema_name").is_none());
  // 布尔表达式在 MySQL 里是 BIGINT，按整数取
  assert_eq!(row.get::<i64, _>("read_only"), 0, "测试库不是只读副本");
}

#[tokio::test]
async fn mysql_use_is_rejected_by_the_prepared_protocol() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");

  // 这条钉住的是「MySQL 那一栏为什么不会过期」。
  //
  // 两件事叠在一起：(1) `USE` 走不了预处理协议，应用的 `execute_query` 正是
  // 预处理的，所以用户在编辑器里敲 `USE` 得到的是 1295，不是悄悄换了个库；
  // (2) 就算换掉了，MySQL 的 `DATABASE()` 在预处理语句里是**准备时**求值的，
  // 实测 `USE` 之后同一条连接上预处理的 `SELECT DATABASE()` 仍报旧库名，
  // 只有文本协议才报新的。
  //
  // 所以界面上那一栏在 MySQL 下恒等于连上去时选定的库。哪天改回文本协议，
  // 这条会红，提醒回来重估那一栏的说法。
  //
  // MariaDB 与 TiDB 不一样：它们的预处理协议**收** `USE`。这正是下面那条
  // 用例要防的事，这里照实钉住差别——哪天它们也拒了，那道防线就可以重估。
  let outcome = sqlx::query("USE information_schema").execute(&pool).await;
  if mysql_flavor(&pool).await != MysqlFlavor::MySql {
    assert!(outcome.is_ok(), "MariaDB / TiDB 的预处理协议本来收 USE，实际: {outcome:?}");
    return;
  }
  let error = outcome.expect_err("prepared protocol must reject USE");
  assert!(
    error.to_string().contains("1295") || error.to_string().contains("prepared statement"),
    "预期 1295，实际: {error}"
  );
}

/// 用户在编辑器里敲的 `USE` 不能把池子里的连接挪到别的库。
///
/// 对象树、补全、ER 图的目录查询都按 `DATABASE()` 取当前库，而它们和编辑器
/// 共用一个池子。一条被 `USE` 挪走的连接还回池子之后，下一次恰好拿到它的
/// 目录查询就会列出另一个库的表，而界面上的库名还是原来那个——静默地错。
///
/// MySQL 上这件事靠预处理协议拒绝 `USE` 挡住（上一条），MariaDB 上协议不挡，
/// 只能由我们自己挡。池子只放一条连接，保证第二次拿到的就是被挪过的那条。
#[tokio::test]
async fn mysql_use_cannot_move_a_pooled_connection_to_another_database() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");
  let db_pool = DbPool::MySql(pool.clone());

  let error = execute_query(&db_pool, "/* 切库 */ use information_schema")
    .await
    .expect_err("USE must be refused");
  assert!(
    error.message.starts_with(dataomni_lib::services::USE_STATEMENT_REFUSED),
    "应当由我们拒绝，而不是驱动报什么算什么，实际: {}",
    error.message
  );

  let database: Option<String> = sqlx::query_scalar("SELECT CAST(DATABASE() AS CHAR)")
    .fetch_one(&pool)
    .await
    .expect("read current database");
  assert_eq!(database.as_deref(), Some("dataomni_test"), "池子里的连接被挪走了");
}

/// 同一个 URL 可能指向 MySQL、MariaDB 或 TiDB，几家只在少数地方真的不同，
/// 用例在那几处按服务端自报的版本分开断言。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MysqlFlavor {
  MySql,
  MariaDb,
  TiDb,
}

impl MysqlFlavor {
  /// 给 `MetaFixture::ddl` 用的方言名：只有 MariaDB 建不出函数索引
  fn fixture_dialect(self) -> &'static str {
    match self {
      Self::MariaDb => "mariadb",
      Self::MySql | Self::TiDb => "mysql",
    }
  }
}

/// PostgreSQL 协议的那一组：同一个 URL 可能指向 PostgreSQL 或 CockroachDB
async fn is_cockroach(pool: &sqlx::PgPool) -> bool {
  let version: String =
    sqlx::query_scalar("SELECT version()").fetch_one(pool).await.expect("read server version");
  version.contains("CockroachDB")
}

/// 目录里的整数列：PostgreSQL 是 INT4，CockroachDB 的 INT 一律是 INT8。
/// 界面走插件的解码器，两种都认；sqlx 的 `get` 按宽度严格匹配
fn pg_int(row: &sqlx::postgres::PgRow, column: &str) -> Option<i64> {
  row
    .try_get::<Option<i32>, _>(column)
    .map(|value| value.map(i64::from))
    .or_else(|_| row.try_get::<Option<i64>, _>(column))
    .unwrap_or_else(|error| panic!("decode {column}: {error}"))
}

/// CockroachDB 没有 `pg_get_triggerdef()`，而且它的 `pg_trigger` 与
/// `information_schema.triggers` 都是空的——建了触发器也查不到（25.2 上验过），
/// 只有 `SHOW CREATE TRIGGER` 看得见。换一种目录写法只会把「查不到」变成
/// 「没有」，所以触发器那一段在它上面就是报错，由结构页那一段单独显示原因。
/// 钉在这里：哪天它补上了这个函数，这条会红，提醒回来把这段接上。
fn assert_cockroach_refuses_the_trigger_catalog(error: impl std::fmt::Display) {
  let message = error.to_string();
  assert!(message.contains("pg_get_triggerdef"), "应是缺 pg_get_triggerdef，实际: {message}");
}

async fn mysql_flavor(pool: &sqlx::MySqlPool) -> MysqlFlavor {
  let version: String =
    sqlx::query_scalar("SELECT VERSION()").fetch_one(pool).await.expect("read server version");
  if version.contains("MariaDB") {
    MysqlFlavor::MariaDb
  } else if version.contains("TiDB") {
    MysqlFlavor::TiDb
  } else {
    MysqlFlavor::MySql
  }
}

/// 目录里的序号列：MySQL 是 INT UNSIGNED，MariaDB 是 BIGINT。
///
/// 界面走插件的解码器，两种都认；sqlx 的 `get` 按宽度和符号严格匹配，
/// 所以用例这里也得两种都认，否则红的是用例而不是应用。
fn mysql_ordinal(row: &sqlx::mysql::MySqlRow, column: &str) -> Option<i64> {
  row
    .try_get::<Option<u32>, _>(column)
    .map(|ordinal| ordinal.map(i64::from))
    .or_else(|_| row.try_get::<Option<i64>, _>(column))
    .unwrap_or_else(|error| panic!("decode {column}: {error}"))
}

/// MariaDB 与 MySQL 只在**拼写**上不同、意思一样的两处，换成 MySQL 的拼法。
///
/// - 整数类型带显示宽度：`int(11)`、`int(10) unsigned`。MySQL 8.0.19 起不再
///   显示它，MariaDB 照旧；宽度从来不影响取值范围。
/// - 表达式小写带括号：`on update current_timestamp()`。
///
/// 只放这两条。默认值那种「意思也不同」的差别由目录查询自己换形状
/// （见 `mysql_column_defaults_come_back_in_one_shape_on_mysql_and_mariadb`），
/// 不能在用例里抹平——抹平了就看不见界面会拿到什么。
fn mariadb_spelling_as_mysql(mut column: ddl_corpus::Column) -> ddl_corpus::Column {
  column.data_type = strip_integer_display_width(&column.data_type);
  column.extra =
    column.extra.map(|extra| extra.replace("current_timestamp()", "CURRENT_TIMESTAMP"));
  column
}

fn strip_integer_display_width(data_type: &str) -> String {
  let integer_types = ["tinyint(", "smallint(", "mediumint(", "bigint(", "int("];
  let Some(prefix) = integer_types.iter().find(|prefix| data_type.starts_with(**prefix)) else {
    return data_type.to_string();
  };
  let rest = &data_type[prefix.len()..];
  match rest.find(')') {
    Some(close) if rest[..close].chars().all(|c| c.is_ascii_digit()) => {
      format!("{}{}", &prefix[..prefix.len() - 1], &rest[close + 1..])
    }
    _ => data_type.to_string(),
  }
}

#[tokio::test]
async fn sqlite_session_target_reports_query_only() {
  let pool = SqlitePoolOptions::new()
    .max_connections(1)
    .connect("sqlite::memory:")
    .await
    .expect("connect to in-memory SQLite");

  let query =
    dataomni_lib::services::session_target_query(&dataomni_lib::models::DatabaseType::SQLite)
      .expect("supported");

  let row = sqlx::query(query.sql).fetch_one(&pool).await.expect("read session target");
  // SQLite 的「库」就是那个文件，连接配置里的路径已经说明了一切
  assert!(row.get::<Option<String>, _>("database_name").is_none());
  assert!(row.get::<Option<String>, _>("schema_name").is_none());
  assert_eq!(row.get::<i64, _>("read_only"), 0);

  sqlx::query("PRAGMA query_only = 1").execute(&pool).await.expect("turn on query_only");
  let locked = sqlx::query(query.sql).fetch_one(&pool).await.expect("read session target again");
  assert_eq!(locked.get::<i64, _>("read_only"), 1, "query_only 打开后要报出只读");
}

#[tokio::test]
async fn postgres_syntax_error_carries_sqlstate_and_position() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");

  // `form` 是个错别字，PostgreSQL 会指出它在第几个字符上
  let sql = "SELECT 1 form dual";
  let error = execute_query(&DbPool::Postgres(pool.clone()), sql)
    .await
    .expect_err("syntax error should fail");

  assert_eq!(error.code.as_deref(), Some("42601"), "SQLSTATE 要原样带上来");
  // CockroachDB 不给出错位置（没有 POSITION 字段），界面就不标位置，
  // 只显示原话。钉住「没有」：哪天它给了，这条会红，提醒回来验对不对得上
  if is_cockroach(&pool).await {
    assert!(error.position().is_none(), "CockroachDB 开始给位置了，回来验: {error:?}");
    assert!(!error.message.is_empty());
    return;
  }
  let position = error.position().expect("PostgreSQL 会给出错字符位置") as usize;
  // 位置是从 1 开始的字符下标；这条语句里它指向 `dual`
  assert_eq!(&sql[position - 1..position + 3], "dual", "位置必须能对回原文: {error:?}");
  assert!(!error.message.is_empty());
}

#[tokio::test]
async fn postgres_constraint_violation_names_the_constraint_and_table() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");

  let table = "dataomni_err_probe";
  sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
  sqlx::query(&format!(
    "CREATE TABLE {table} (id INT PRIMARY KEY, code TEXT NOT NULL,
       CONSTRAINT uq_{table}_code UNIQUE (code))"
  ))
  .execute(&pool)
  .await
  .expect("create probe table");
  sqlx::query(&format!("INSERT INTO {table} VALUES (1, 'a')"))
    .execute(&pool)
    .await
    .expect("seed probe row");

  let error =
    execute_query(&DbPool::Postgres(pool.clone()), &format!("INSERT INTO {table} VALUES (2, 'a')"))
      .await
      .expect_err("unique violation should fail");

  assert_eq!(error.code.as_deref(), Some("23505"));
  // CockroachDB 给约束名，但不填 TABLE 字段，DETAIL 里的值带引号
  // （`Key (code)=('a')`）。界面少的只是单独标出的表名那一栏
  if is_cockroach(&pool).await {
    assert_eq!(error.constraint(), Some(format!("uq_{table}_code").as_str()));
    assert!(error.table().is_none(), "CockroachDB 开始给表名了，回来重估: {error:?}");
    assert!(error.detail().unwrap_or_default().contains("(code)="), "{error:?}");
    sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
    return;
  }
  assert_eq!(error.constraint(), Some(format!("uq_{table}_code").as_str()));
  assert_eq!(error.table(), Some(table));
  // DETAIL 才说得出是哪个值撞了；以前这一整句都被 to_string() 丢掉了
  assert!(
    error.detail().unwrap_or_default().contains("(code)=(a)"),
    "DETAIL 要带上冲突的值: {error:?}"
  );

  sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
}

#[tokio::test]
async fn mysql_error_carries_its_sqlstate() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");

  let error = execute_query(&DbPool::MySql(pool.clone()), "SELECT 1 FROM dataomni_no_such_table")
    .await
    .expect_err("missing table should fail");

  // MySQL 不给字符位置，只有错误码和消息——界面据此决定不显示「跳到出错位置」
  assert_eq!(error.code.as_deref(), Some("42S02"));
  assert!(error.position().is_none(), "MySQL 没有字符位置，不该凭空造一个");
  assert!(error.message.contains("dataomni_no_such_table"), "消息要带上表名: {error:?}");
}

#[tokio::test]
async fn sqlite_error_carries_its_result_code() {
  let pool = SqlitePoolOptions::new()
    .max_connections(1)
    .connect("sqlite::memory:")
    .await
    .expect("connect to in-memory SQLite");

  let error = execute_query(&DbPool::Sqlite(pool.clone()), "SELECT 1 FROM no_such_table")
    .await
    .expect_err("missing table should fail");

  assert!(error.code.is_some(), "SQLite 的扩展结果码要带上来: {error:?}");
  assert!(error.position().is_none());
  assert!(error.message.contains("no_such_table"));
}

/// 导出要证明的是「一行不少地落进文件」，而这只有拿真库跑才算数：
/// 新的 `describe_columns` 在三种驱动上各有一套实现，SQLite 的单测证明不了
/// MySQL 或 PostgreSQL。行数刻意超过默认 1000 行的结果上限——导出走的是
/// 另一条不设限的路，走错了会在第 1000 行戛然而止。
const EXPORT_ROW_COUNT: usize = 2_500;

#[tokio::test]
async fn postgres_exports_every_row_and_refuses_a_non_query() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool = PgPoolOptions::new()
    .max_connections(2)
    .connect(&url)
    .await
    .expect("connect to PostgreSQL smoke database");

  // 不能用 TEMP TABLE：导出另开一条连接，而临时表是连接私有的。真表就得自己
  // 收拾干净——测试库是共享的，一次断言失败留下的表会一直攒在那里，所以开头
  // 先清掉所有同名前缀的残留，而不是只清这一次要用的那张
  let leftovers: Vec<String> = sqlx::query_scalar(
    "SELECT tablename::text FROM pg_tables WHERE tablename LIKE 'export_smoke\\_%'",
  )
  .fetch_all(&pool)
  .await
  .expect("list leftovers");
  for leftover in leftovers {
    sqlx::query(&format!("DROP TABLE IF EXISTS \"{leftover}\""))
      .execute(&pool)
      .await
      .expect("drop");
  }
  let table = format!("export_smoke_{}", std::process::id());
  sqlx::query(&format!(
    "CREATE TABLE {table} (id BIGINT PRIMARY KEY, label TEXT, blob_value BYTEA, nothing TEXT)"
  ))
  .execute(&pool)
  .await
  .expect("create export table");
  sqlx::query(&format!(
    "INSERT INTO {table} (id, label, blob_value, nothing)
     SELECT i, 'row,' || i, '\\xdeadbeef'::bytea, NULL FROM generate_series(1, {EXPORT_ROW_COUNT}) AS i"
  ))
  .execute(&pool)
  .await
  .expect("seed export table");

  let (contents, summary) = export_to_string(
    &DbPool::Postgres(pool.clone()),
    &format!("SELECT * FROM {table} ORDER BY id"),
  )
  .await;

  assert_eq!(summary.rows_written, EXPORT_ROW_COUNT as u64);
  let lines = contents.lines().collect::<Vec<_>>();
  assert_eq!(lines.len(), EXPORT_ROW_COUNT + 1, "表头一行加上每行数据一行");
  assert_eq!(lines[0], "id,label,blob_value,nothing");
  // 逗号在值里要被引号包起来；bytea 按 0x 十六进制写；NULL 是空字段
  assert_eq!(lines[1], "1,\"row,1\",0xdeadbeef,");
  assert_eq!(
    lines[EXPORT_ROW_COUNT],
    format!("{EXPORT_ROW_COUNT},\"row,{EXPORT_ROW_COUNT}\",0xdeadbeef,")
  );

  // 点「导出」不该让一条 DELETE 真把数据删掉
  let error = export_error(&DbPool::Postgres(pool.clone()), &format!("DELETE FROM {table}")).await;
  // 后端给的是**错误码**，文案由前端按当前语言翻（`utils/backendError.ts`）。
  // 这里断言中文原句的写法在错误码化之后就一直是红的，只是网络用例平时跳过，
  // 没人看见——断言码才是这条路真正要钉住的东西
  assert_eq!(error.message, NON_QUERY_MESSAGE, "点「导出」不该让一条 DELETE 真执行");
  let remaining: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
    .fetch_one(&pool)
    .await
    .expect("count");
  assert_eq!(remaining, EXPORT_ROW_COUNT as i64, "被拒绝的语句一行也不该执行");

  sqlx::query(&format!("DROP TABLE {table}")).execute(&pool).await.expect("drop");
}

#[tokio::test]
async fn mysql_exports_every_row_and_refuses_a_non_query() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool = MySqlPoolOptions::new()
    .max_connections(2)
    .connect(&url)
    .await
    .expect("connect to MySQL smoke database");

  let leftovers: Vec<String> = sqlx::query_scalar(
    // MySQL 8 的 information_schema 列是 VARBINARY，直接取 String 会解码失败
    "SELECT CAST(table_name AS CHAR) FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name LIKE 'export\\_smoke\\_%'",
  )
  .fetch_all(&pool)
  .await
  .expect("list leftovers");
  for leftover in leftovers {
    sqlx::query(&format!("DROP TABLE IF EXISTS `{leftover}`")).execute(&pool).await.expect("drop");
  }
  let table = format!("export_smoke_{}", std::process::id());
  sqlx::query(&format!(
    "CREATE TABLE `{table}` (id BIGINT PRIMARY KEY, label TEXT, blob_value VARBINARY(8), nothing TEXT)"
  ))
  .execute(&pool)
  .await
  .expect("create export table");
  // 不用递归 CTE 造行：MySQL 的 cte_max_recursion_depth 默认就是 1000，
  // 而这条测试要的恰恰是超过 1000 行
  let values = (1..=EXPORT_ROW_COUNT)
    .map(|i| format!("({i}, 'row,{i}', X'deadbeef', NULL)"))
    .collect::<Vec<_>>()
    .join(", ");
  sqlx::query(&format!("INSERT INTO `{table}` (id, label, blob_value, nothing) VALUES {values}"))
    .execute(&pool)
    .await
    .expect("seed export table");

  let (contents, summary) =
    export_to_string(&DbPool::MySql(pool.clone()), &format!("SELECT * FROM `{table}` ORDER BY id"))
      .await;

  assert_eq!(summary.rows_written, EXPORT_ROW_COUNT as u64);
  let lines = contents.lines().collect::<Vec<_>>();
  assert_eq!(lines.len(), EXPORT_ROW_COUNT + 1);
  assert_eq!(lines[0], "id,label,blob_value,nothing");
  assert_eq!(lines[1], "1,\"row,1\",0xdeadbeef,");

  let error = export_error(&DbPool::MySql(pool.clone()), &format!("DELETE FROM `{table}`")).await;
  // 后端给的是**错误码**，文案由前端按当前语言翻（`utils/backendError.ts`）。
  // 这里断言中文原句的写法在错误码化之后就一直是红的，只是网络用例平时跳过，
  // 没人看见——断言码才是这条路真正要钉住的东西
  assert_eq!(error.message, NON_QUERY_MESSAGE, "点「导出」不该让一条 DELETE 真执行");
  let remaining: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM `{table}`"))
    .fetch_one(&pool)
    .await
    .expect("count");
  assert_eq!(remaining, EXPORT_ROW_COUNT as i64, "被拒绝的语句一行也不该执行");

  sqlx::query(&format!("DROP TABLE `{table}`")).execute(&pool).await.expect("drop");
}

fn csv_export_options() -> ExportOptions {
  ExportOptions {
    format: ExportFormat::Csv,
    delimiter: ",".to_string(),
    include_header: true,
    null_text: String::new(),
    byte_order_mark: false,
  }
}

fn export_target(tag: &str) -> std::path::PathBuf {
  let dir = std::env::temp_dir().join(format!("dataomni-smoke-{}-{tag}", std::process::id()));
  std::fs::create_dir_all(&dir).expect("temp dir");
  dir.join("export.csv")
}

async fn export_to_string(pool: &DbPool, sql: &str) -> (String, ExportSummary) {
  let target = export_target("ok");
  let summary = export_query(pool, sql, &target, csv_export_options(), &mut |_| {}, &mut || false)
    .await
    .expect("export");
  let contents = std::fs::read_to_string(&target).expect("read back");
  std::fs::remove_file(&target).ok();
  (contents, summary)
}

async fn export_error(pool: &DbPool, sql: &str) -> QueryError {
  let target = export_target("refused");
  let error = export_query(pool, sql, &target, csv_export_options(), &mut |_| {}, &mut || false)
    .await
    .expect_err("should refuse");
  assert!(!target.exists(), "拒绝时不该留下文件");
  error
}

/// 列目录夹具：把「非空、没有默认值、却不能由用户填」的那几种列摆出来。
///
/// 自增主键在三种方言里的表示各不相同，而它们的共同点正是问题所在——
/// `COLUMN_DEFAULT` 是 NULL、`IS_NULLABLE` 是 NO。只看这两个字段，
/// 一张最普通的表也会被判成「主键必填」，于是一行都插不进去。
fn column_fixture_ddl(dialect: &str, table: &str) -> Vec<String> {
  let drop = format!("DROP TABLE IF EXISTS {table}");
  match dialect {
    "postgres" => vec![
      drop,
      format!(
        "CREATE TABLE {table} (
           id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
           code varchar(32) NOT NULL,
           tags text[],
           amount numeric(10,2) DEFAULT 0,
           w int NOT NULL,
           h int NOT NULL,
           area int GENERATED ALWAYS AS (w * h) STORED
         )"
      ),
    ],
    "mysql" => vec![
      drop,
      format!(
        "CREATE TABLE {table} (
           id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
           code VARCHAR(32) NOT NULL,
           flags INT UNSIGNED,
           amount DECIMAL(10,2) DEFAULT 0,
           w INT NOT NULL,
           h INT NOT NULL,
           area INT GENERATED ALWAYS AS (w * h) STORED
         )"
      ),
    ],
    _ => vec![
      drop,
      format!(
        "CREATE TABLE {table} (
           id INTEGER PRIMARY KEY,
           code VARCHAR(32) NOT NULL,
           amount NUMERIC DEFAULT 0,
           w INT NOT NULL,
           h INT NOT NULL,
           area INT GENERATED ALWAYS AS (w * h) VIRTUAL
         )"
      ),
    ],
  }
}

/// 默认值无论连的是 MySQL 还是 MariaDB，都要按 MySQL 的形状回来。
///
/// 改结构的界面照这个形状把默认值重述回 SQL（`tableDdl.ts` 的
/// `columnDefaultSql`）：不带 `DEFAULT_GENERATED` 的非数字当字符串再引一层。
/// MariaDB 原样给的是 SQL 字面量 `'a'`、「没有默认值」给的是字符串 `NULL`，
/// 不换形状的话，只改一列注释就会把默认值悄悄改掉。
///
/// 每一行都是两家原始表示不同、或容易被换形状的规则误伤的一类。
/// 最后一行尤其要紧：`DEFAULT 'CURRENT_TIMESTAMP'` 是字符串，不是表达式。
#[tokio::test]
async fn mysql_column_defaults_come_back_in_one_shape_on_mysql_and_mariadb() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");
  let flavor = mysql_flavor(&pool).await;
  let table = "dataomni_default_shapes";
  sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.expect("drop");
  sqlx::query(&format!(
    r"CREATE TABLE {table} (
       s_plain VARCHAR(20) DEFAULT 'a',
       s_quote VARCHAR(20) DEFAULT 'it''s',
       s_bslash VARCHAR(20) DEFAULT 'a\\b',
       s_nullword VARCHAR(20) DEFAULT 'NULL',
       s_nullable VARCHAR(20),
       s_notnull VARCHAR(20) NOT NULL,
       s_empty VARCHAR(20) DEFAULT '',
       i_zero INT DEFAULT 0,
       d_neg DECIMAL(5,2) DEFAULT -1.5,
       b_bit BIT(1) DEFAULT b'1',
       ts TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       e_expr VARCHAR(36) DEFAULT (UUID()),
       s_ctsword VARCHAR(30) DEFAULT 'CURRENT_TIMESTAMP'
     )"
  ))
  .execute(&pool)
  .await
  .expect("create default shape fixture");

  let columns =
    mysql_catalog_columns(&pool, column_queries(dataomni_lib::models::DatabaseType::MySQL), table)
      .await;
  let shapes: Vec<(String, Option<String>, bool)> = columns
    .into_iter()
    .map(|column| {
      let generated = column.extra.as_deref().unwrap_or_default().contains("DEFAULT_GENERATED");
      (column.name, column.default_value, generated)
    })
    .collect();
  let literal =
    |name: &str, value: Option<&str>| (name.to_string(), value.map(String::from), false);
  assert_eq!(
    shapes[..10],
    [
      literal("s_plain", Some("a")),
      literal("s_quote", Some("it's")),
      literal("s_bslash", Some(r"a\b")),
      literal("s_nullword", Some("NULL")),
      literal("s_nullable", None),
      literal("s_notnull", None),
      literal("s_empty", Some("")),
      literal("i_zero", Some("0")),
      // TiDB 不补足标度，写的是 `-1.5`；数值列的默认值原样重述，两种写法同一个值
      literal("d_neg", Some(if flavor == MysqlFlavor::TiDb { "-1.5" } else { "-1.50" })),
      literal("b_bit", Some("b'1'")),
    ]
  );
  // 表达式的原文两家写法不同（`CURRENT_TIMESTAMP` / `current_timestamp()`），
  // 都是合法的 SQL；要钉的是它被认成表达式
  for (name, default_value, generated) in &shapes[10..12] {
    assert!(*generated && default_value.is_some(), "{name} 应被认成表达式: {shapes:?}");
  }
  assert_eq!(shapes[12], literal("s_ctsword", Some("CURRENT_TIMESTAMP")));

  sqlx::query(&format!("DROP TABLE {table}")).execute(&pool).await.ok();
}

fn column_queries(db_type: dataomni_lib::models::DatabaseType) -> &'static str {
  dataomni_lib::services::schema_metadata_queries(&db_type).expect("supported").columns
}

#[tokio::test]
async fn postgres_reports_declared_types_and_generated_columns() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");

  let table = "dataomni_columns_pg";
  for statement in column_fixture_ddl("postgres", table) {
    sqlx::query(&statement).execute(&pool).await.expect("prepare PostgreSQL column fixture");
  }

  let rows = sqlx::query(column_queries(dataomni_lib::models::DatabaseType::PostgreSQL))
    .bind(table)
    .bind(Option::<String>::None)
    .fetch_all(&pool)
    .await
    .expect("run PostgreSQL column query");
  let columns: Vec<(String, String, bool, Option<i64>, bool)> = rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("column_name"),
        row.get::<String, _>("data_type"),
        row.get::<bool, _>("is_nullable"),
        pg_int(row, "primary_key_ordinal"),
        row.get::<bool, _>("is_generated"),
      )
    })
    .collect();

  let by_name = |name: &str| {
    columns.iter().find(|(column, ..)| column == name).cloned().unwrap_or_else(|| {
      panic!("{name} 应出现在列目录里: {columns:?}");
    })
  };

  // information_schema 把这三种类型分别报成 integer / character varying / ARRAY，
  // 其中 ARRAY 等于什么都没说——结构页显示的就是这个字段。
  assert_eq!(by_name("code").1, "character varying(32)", "长度不能丢: {columns:?}");
  assert_eq!(by_name("tags").1, "text[]", "数组类型不能报成 ARRAY: {columns:?}");
  assert_eq!(by_name("amount").1, "numeric(10,2)", "精度不能丢: {columns:?}");

  // identity 列没有 column_default 又是非空——没有 is_generated 就插不进行
  assert!(by_name("id").4, "GENERATED ALWAYS AS IDENTITY 必须标成由数据库产生: {columns:?}");
  assert!(by_name("area").4, "计算列必须标成由数据库产生: {columns:?}");
  assert!(!by_name("code").4, "普通非空列不是由数据库产生的: {columns:?}");

  assert_eq!(by_name("id").3, Some(1), "主键次序: {columns:?}");
  assert_eq!(by_name("code").3, None, "非主键列没有键内次序: {columns:?}");
  assert!(!by_name("code").2 && by_name("tags").2, "可空性: {columns:?}");

  sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
}

#[tokio::test]
async fn mysql_reports_declared_types_and_generated_columns() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");

  let table = "dataomni_columns_my";
  for statement in column_fixture_ddl("mysql", table) {
    sqlx::query(&statement).execute(&pool).await.expect("prepare MySQL column fixture");
  }

  let rows = sqlx::query(column_queries(dataomni_lib::models::DatabaseType::MySQL))
    .bind(table)
    .bind(Option::<String>::None)
    .fetch_all(&pool)
    .await
    .expect("run MySQL column query");
  let mariadb = mysql_flavor(&pool).await == MysqlFlavor::MariaDb;
  let columns: Vec<(String, String, i64, Option<i64>, i64)> = rows
    .iter()
    .map(|row| {
      let data_type = row.get::<String, _>("data_type");
      (
        row.get::<String, _>("column_name"),
        if mariadb { strip_integer_display_width(&data_type) } else { data_type },
        row.get::<i64, _>("is_nullable"),
        mysql_ordinal(row, "primary_key_ordinal"),
        row.get::<i64, _>("is_generated"),
      )
    })
    .collect();

  let by_name = |name: &str| {
    columns.iter().find(|(column, ..)| column == name).cloned().unwrap_or_else(|| {
      panic!("{name} 应出现在列目录里: {columns:?}");
    })
  };

  // DATA_TYPE 给的是 varchar / int / decimal，长度、unsigned、精度全丢
  assert_eq!(by_name("code").1, "varchar(32)", "长度不能丢: {columns:?}");
  assert_eq!(by_name("flags").1, "int unsigned", "unsigned 不能丢: {columns:?}");
  assert_eq!(by_name("amount").1, "decimal(10,2)", "精度不能丢: {columns:?}");

  assert_eq!(by_name("id").4, 1, "AUTO_INCREMENT 必须标成由数据库产生: {columns:?}");
  assert_eq!(by_name("area").4, 1, "计算列必须标成由数据库产生: {columns:?}");
  assert_eq!(by_name("code").4, 0, "普通非空列不是由数据库产生的: {columns:?}");

  assert_eq!(by_name("id").3, Some(1), "主键次序: {columns:?}");
  assert_eq!(by_name("code").3, None, "非主键列没有键内次序: {columns:?}");
  assert_eq!((by_name("code").2, by_name("flags").2), (0, 1), "可空性: {columns:?}");

  sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await.ok();
}

#[tokio::test]
async fn sqlite_reports_generated_columns_that_table_info_hides() {
  let pool = SqlitePoolOptions::new()
    .max_connections(1)
    .connect("sqlite::memory:")
    .await
    .expect("connect to in-memory SQLite");

  let table = "dataomni_columns_lite";
  for statement in column_fixture_ddl("sqlite", table) {
    sqlx::query(&statement).execute(&pool).await.expect("prepare SQLite column fixture");
  }

  let rows = sqlx::query(column_queries(dataomni_lib::models::DatabaseType::SQLite))
    .bind(table)
    .fetch_all(&pool)
    .await
    .expect("run SQLite column query");
  let columns: Vec<(String, String, i64, Option<i64>, i64)> = rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("column_name"),
        row.get::<String, _>("data_type"),
        row.get::<i64, _>("is_nullable"),
        row.get::<Option<i64>, _>("primary_key_ordinal"),
        row.get::<i64, _>("is_generated"),
      )
    })
    .collect();

  let by_name = |name: &str| {
    columns.iter().find(|(column, ..)| column == name).cloned().unwrap_or_else(|| {
      panic!("{name} 应出现在列目录里: {columns:?}");
    })
  };

  // pragma_table_info 看不见计算列，而 `SELECT *` 查得出来——结构页会比数据页少一列
  assert_eq!(by_name("area").4, 1, "VIRTUAL 计算列必须出现且标成由数据库产生: {columns:?}");
  assert_eq!(by_name("code").1, "VARCHAR(32)", "SQLite 的声明类型原样带回: {columns:?}");
  assert_eq!(by_name("id").3, Some(1), "主键次序: {columns:?}");
  assert_eq!(by_name("code").2, 0, "NOT NULL 列不可空: {columns:?}");
}

/// 改结构的共用语料：`fixtures/ddl-conformance.json`。
///
/// 前端的 `tableDdl.conformance.test.ts` 照它核对**生成的语句**；这里照它
/// 跑真库，核对两件前端证明不了的事——那串字符是不是合法的 ALTER TABLE，
/// 以及跑完之后表到底变成了什么样。
///
/// `origin` 也在这里被核对：它是前端做 diff 的起点，手写一份假设就等于把
/// 两边的起点分开了。先建表、再用列目录读一遍、逐字段比对。
mod ddl_corpus {
  use serde_json::Value as JsonValue;

  pub struct Case {
    pub name: String,
    pub table: String,
    pub final_table: String,
    pub fixture: Vec<String>,
    pub statements: Vec<String>,
    /// 建表用例跑完之后不写主键值插一行：写错的自增表现不是建表失败，
    /// 而是建出来了但**插不进行**
    pub insert: Vec<String>,
    pub origin: Vec<Column>,
    pub after: Vec<Column>,
    pub cleanup: Vec<String>,
  }

  /// 目录里一列的期望值。`None` 表示这个方言不报告该字段，不参与比对
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub struct Column {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key_ordinal: Option<i64>,
    pub default_value: Option<String>,
    pub generated: bool,
    pub collation: Option<String>,
    pub comment: Option<String>,
    pub extra: Option<String>,
  }

  fn text(value: &JsonValue, key: &str) -> Option<String> {
    value.get(key).and_then(|found| found.as_str()).map(str::to_string)
  }

  fn columns(value: &JsonValue, key: &str) -> Vec<Column> {
    value
      .get(key)
      .and_then(|found| found.as_array())
      .map(|entries| {
        entries
          .iter()
          .map(|entry| Column {
            name: text(entry, "name").unwrap_or_default(),
            data_type: text(entry, "dataType").unwrap_or_default(),
            nullable: entry.get("nullable").and_then(|found| found.as_bool()).unwrap_or(false),
            primary_key_ordinal: entry.get("primaryKeyOrdinal").and_then(|found| found.as_i64()),
            default_value: text(entry, "defaultValue"),
            generated: entry.get("generated").and_then(|found| found.as_bool()).unwrap_or(false),
            collation: text(entry, "collation"),
            comment: text(entry, "comment"),
            extra: text(entry, "extra"),
          })
          .collect()
      })
      .unwrap_or_default()
  }

  fn strings(value: &JsonValue, key: &str) -> Vec<String> {
    value
      .get(key)
      .and_then(|found| found.as_array())
      .map(|entries| {
        entries.iter().filter_map(|entry| entry.as_str().map(str::to_string)).collect()
      })
      .unwrap_or_default()
  }

  pub fn load(dialect: &str) -> Vec<Case> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/ddl-conformance.json");
    let source = std::fs::read_to_string(path).expect("读取改结构语料");
    let parsed: JsonValue = serde_json::from_str(&source).expect("解析改结构语料");
    let cases = parsed.get("cases").and_then(|found| found.as_array()).expect("语料里要有 cases");
    cases
      .iter()
      .filter(|case| text(case, "dialect").as_deref() == Some(dialect))
      .map(|case| Case {
        name: text(case, "name").unwrap_or_default(),
        table: text(case, "table").unwrap_or_default(),
        final_table: text(case, "newTableName").unwrap_or_default(),
        fixture: strings(case, "fixture"),
        statements: strings(case, "statements"),
        insert: strings(case, "insert"),
        origin: columns(case, "origin"),
        after: columns(case, "after"),
        cleanup: strings(case, "cleanup"),
      })
      .collect()
  }
}

/// 三种方言的目录行读法各不相同：PostgreSQL 给真布尔，另两家给 1/0；
/// 键内次序在 MySQL 的 information_schema 里是无符号整数。所以是三个函数，
/// 不是一个带类型参数的宏——宏只会让「哪一家怎么解码」这件事更难看清。
async fn postgres_catalog_columns(
  pool: &sqlx::PgPool,
  sql: &str,
  table: &str,
) -> Vec<ddl_corpus::Column> {
  let rows = sqlx::query(sql)
    .bind(table)
    .bind("public")
    .fetch_all(pool)
    .await
    .expect("run PostgreSQL column catalog");
  rows
    .iter()
    .map(|row| ddl_corpus::Column {
      name: row.get::<String, _>("column_name"),
      data_type: row.get::<String, _>("data_type"),
      nullable: row.get::<bool, _>("is_nullable"),
      primary_key_ordinal: pg_int(row, "primary_key_ordinal"),
      default_value: row.get::<Option<String>, _>("column_default"),
      generated: row.get::<bool, _>("is_generated"),
      collation: row.get::<Option<String>, _>("collation"),
      comment: row.get::<Option<String>, _>("comment"),
      extra: row.get::<Option<String>, _>("column_extra"),
    })
    .collect()
}

async fn mysql_catalog_columns(
  pool: &sqlx::MySqlPool,
  sql: &str,
  table: &str,
) -> Vec<ddl_corpus::Column> {
  let rows = sqlx::query(sql)
    .bind(table)
    .bind(Option::<String>::None)
    .fetch_all(pool)
    .await
    .expect("run MySQL column catalog");
  rows
    .iter()
    .map(|row| ddl_corpus::Column {
      name: row.get::<String, _>("column_name"),
      data_type: row.get::<String, _>("data_type"),
      nullable: row.get::<i64, _>("is_nullable") == 1,
      primary_key_ordinal: mysql_ordinal(row, "primary_key_ordinal"),
      default_value: row.get::<Option<String>, _>("column_default"),
      generated: row.get::<i64, _>("is_generated") == 1,
      collation: row.get::<Option<String>, _>("collation"),
      comment: row.get::<Option<String>, _>("comment"),
      extra: row.get::<Option<String>, _>("column_extra"),
    })
    .collect()
}

async fn sqlite_catalog_columns(
  pool: &sqlx::SqlitePool,
  sql: &str,
  table: &str,
) -> Vec<ddl_corpus::Column> {
  let rows = sqlx::query(sql).bind(table).fetch_all(pool).await.expect("run SQLite column catalog");
  rows
    .iter()
    .map(|row| ddl_corpus::Column {
      name: row.get::<String, _>("column_name"),
      data_type: row.get::<String, _>("data_type"),
      nullable: row.get::<i64, _>("is_nullable") == 1,
      primary_key_ordinal: row.get::<Option<i64>, _>("primary_key_ordinal"),
      default_value: row.get::<Option<String>, _>("column_default"),
      generated: row.get::<i64, _>("is_generated") == 1,
      collation: row.get::<Option<String>, _>("collation"),
      comment: row.get::<Option<String>, _>("comment"),
      extra: row.get::<Option<String>, _>("column_extra"),
    })
    .collect()
}

#[tokio::test]
async fn postgres_runs_the_generated_ddl_from_the_shared_corpus() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");
  let catalog = column_queries(dataomni_lib::models::DatabaseType::PostgreSQL);
  // CockroachDB 的目录处处是自己的拼法：`INT` 是 `bigint`、字符串默认值写成
  // `'a'::STRING`、SERIAL 的默认值照样给出 `nextval(...)`。逐字段比语料只是在比
  // 拼写。在它上面守住真正要紧的三件事：生成的语句跑得通、建出来的表插得进行、
  // 跑完之后列名与顺序和语料一致
  let cockroach = is_cockroach(&pool).await;
  let names = |columns: &[ddl_corpus::Column]| -> Vec<String> {
    columns.iter().map(|column| column.name.clone()).collect()
  };

  for case in ddl_corpus::load("postgresql") {
    for statement in &case.fixture {
      sqlx::query(statement).execute(&pool).await.expect("prepare corpus fixture");
    }

    // 建表用例没有 origin——表还不存在
    if !case.origin.is_empty() {
      let origin = postgres_catalog_columns(&pool, catalog, &case.table).await;
      if cockroach {
        assert_eq!(names(&origin), names(&case.origin), "{}: 夹具建出来的列不对", case.name);
      } else {
        assert_eq!(origin, case.origin, "{}: 语料里的 origin 和数据库给的对不上", case.name);
      }
    }

    for statement in &case.statements {
      sqlx::query(statement)
        .execute(&pool)
        .await
        .unwrap_or_else(|error| panic!("{}: 生成的语句跑不了\n{statement}\n{error}", case.name));
    }

    for statement in &case.insert {
      sqlx::query(statement)
        .execute(&pool)
        .await
        .unwrap_or_else(|error| panic!("{}: 建出来的表插不进行\n{statement}\n{error}", case.name));
    }

    let after = postgres_catalog_columns(&pool, catalog, &case.final_table).await;
    if cockroach {
      assert_eq!(names(&after), names(&case.after), "{}: 跑完之后的列不对", case.name);
    } else {
      assert_eq!(after, case.after, "{}: 跑完之后的表和语料说的不一样", case.name);
    }

    for statement in &case.cleanup {
      sqlx::query(statement).execute(&pool).await.ok();
    }
  }
}

#[tokio::test]
async fn mysql_runs_the_generated_ddl_from_the_shared_corpus() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");
  let catalog = column_queries(dataomni_lib::models::DatabaseType::MySQL);
  let flavor = mysql_flavor(&pool).await;
  let mariadb = flavor == MysqlFlavor::MariaDb;
  // 没写 `COLLATE` 的列拿到的是库的默认排序规则：MySQL 8 是 `utf8mb4_0900_ai_ci`，
  // MariaDB 11.4 是 `utf8mb4_uca1400_ai_ci`，TiDB 是 `utf8mb4_bin`。语料照 MySQL 写，
  // 换成这台服务端的默认值再比——换的是**期望**，不是数据库给的结果；而且只换
  // 语料里那个「默认值」，显式写了 `utf8mb4_bin` 的列不受影响
  let default_collation: String = sqlx::query_scalar(
    "SELECT CAST(DEFAULT_COLLATION_NAME AS CHAR) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = DATABASE()",
  )
  .fetch_one(&pool)
  .await
  .expect("read default collation");
  let expected = |columns: &[ddl_corpus::Column]| -> Vec<ddl_corpus::Column> {
    columns
      .iter()
      .cloned()
      .map(|mut column| {
        if column.collation.as_deref() == Some("utf8mb4_0900_ai_ci") {
          column.collation = Some(default_collation.clone());
        }
        column
      })
      .collect()
  };
  let comparable = |columns: Vec<ddl_corpus::Column>| {
    if mariadb {
      columns.into_iter().map(mariadb_spelling_as_mysql).collect()
    } else {
      columns
    }
  };

  for case in ddl_corpus::load("mysql") {
    for statement in &case.fixture {
      sqlx::query(statement).execute(&pool).await.expect("prepare corpus fixture");
    }

    // 建表用例没有 origin——表还不存在
    if !case.origin.is_empty() {
      let origin = comparable(mysql_catalog_columns(&pool, catalog, &case.table).await);
      assert_eq!(
        origin,
        expected(&case.origin),
        "{}: 语料里的 origin 和数据库给的对不上",
        case.name
      );
    }

    // TiDB 不收「一条 ALTER 里同时改列又改表名」（8200）。生成器为了原子性
    // 恰好会这么写，所以在 TiDB 上改表名加改列会被整条拒绝——已知缺口，
    // 但拒绝是整条的、什么都没改，也把原因说出来了。钉住的就是这个
    let mut refused_by_tidb = false;
    for statement in &case.statements {
      match sqlx::query(statement).execute(&pool).await {
        Ok(_) => {}
        Err(error)
          if flavor == MysqlFlavor::TiDb
            && error.to_string().contains("Unsupported multi schema change") =>
        {
          refused_by_tidb = true;
          break;
        }
        Err(error) => panic!("{}: 生成的语句跑不了\n{statement}\n{error}", case.name),
      }
    }
    if refused_by_tidb {
      let untouched = comparable(mysql_catalog_columns(&pool, catalog, &case.table).await);
      assert_eq!(untouched, expected(&case.origin), "{}: TiDB 拒绝之后表不该有任何变化", case.name);
      for statement in &case.cleanup {
        sqlx::query(statement).execute(&pool).await.ok();
      }
      continue;
    }

    for statement in &case.insert {
      sqlx::query(statement)
        .execute(&pool)
        .await
        .unwrap_or_else(|error| panic!("{}: 建出来的表插不进行\n{statement}\n{error}", case.name));
    }

    let after = comparable(mysql_catalog_columns(&pool, catalog, &case.final_table).await);
    assert_eq!(after, expected(&case.after), "{}: 跑完之后的表和语料说的不一样", case.name);

    for statement in &case.cleanup {
      sqlx::query(statement).execute(&pool).await.ok();
    }
  }
}

#[tokio::test]
async fn sqlite_runs_the_generated_ddl_from_the_shared_corpus() {
  let pool = SqlitePoolOptions::new()
    .max_connections(1)
    .connect("sqlite::memory:")
    .await
    .expect("connect to in-memory SQLite");
  let catalog = column_queries(dataomni_lib::models::DatabaseType::SQLite);

  for case in ddl_corpus::load("sqlite") {
    for statement in &case.fixture {
      sqlx::query(statement).execute(&pool).await.expect("prepare corpus fixture");
    }

    // 建表用例没有 origin——表还不存在
    if !case.origin.is_empty() {
      let origin = sqlite_catalog_columns(&pool, catalog, &case.table).await;
      assert_eq!(origin, case.origin, "{}: 语料里的 origin 和数据库给的对不上", case.name);
    }

    for statement in &case.statements {
      sqlx::query(statement)
        .execute(&pool)
        .await
        .unwrap_or_else(|error| panic!("{}: 生成的语句跑不了\n{statement}\n{error}", case.name));
    }

    for statement in &case.insert {
      sqlx::query(statement)
        .execute(&pool)
        .await
        .unwrap_or_else(|error| panic!("{}: 建出来的表插不进行\n{statement}\n{error}", case.name));
    }

    let after = sqlite_catalog_columns(&pool, catalog, &case.final_table).await;
    assert_eq!(after, case.after, "{}: 跑完之后的表和语料说的不一样", case.name);
  }
}

/// 事务状态是推出来的，而推的前提是「PostgreSQL 在事务里出一次错就废掉整个
/// 事务」这句话为真。这条用例拿真库把那句话钉住：出错之后再跑一条普通语句
/// 必须失败，而 ROLLBACK 必须把事务带回可用。
///
/// MySQL 不是这样——同一段脚本在 MySQL 上出错之后 SELECT 照常能跑。
/// 两家的差别正是 `aborts_transaction_on_error` 存在的理由。
#[tokio::test]
async fn postgres_aborts_the_whole_transaction_after_one_failed_statement() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");
  let sessions = QuerySessionState::default();
  let db_pool = DbPool::Postgres(pool);

  let options = |sql: &'static str| StreamingQueryOptions {
    session_id: "tx-pg",
    pool_key: &url,
    pool: &db_pool,
    sql,
    autocommit: true,
    assume_rows: false,
    row_limit: 100,
    byte_limit: 1 << 20,
    batch_size: 10,
    timeout_duration: Duration::from_secs(10),
  };

  sessions.execute_streaming(options("BEGIN"), &mut |_| Ok(())).await.expect("begin");
  assert_eq!(
    sessions.transaction("tx-pg").await.status,
    dataomni_lib::services::TransactionStatus::Active
  );

  sessions
    .execute_streaming(options("SELECT no_such_column"), &mut |_| Ok(()))
    .await
    .expect_err("这条本来就该失败");
  assert_eq!(
    sessions.transaction("tx-pg").await.status,
    dataomni_lib::services::TransactionStatus::Failed,
    "PostgreSQL 在事务里出一次错就废掉整个事务"
  );

  // 钉住「废掉」是真的：一条最普通的语句也跑不了
  sessions
    .execute_streaming(options("SELECT 1"), &mut |_| Ok(()))
    .await
    .expect_err("事务已废，任何语句都该被拒");

  sessions.execute_streaming(options("ROLLBACK"), &mut |_| Ok(())).await.expect("rollback");
  assert_eq!(
    sessions.transaction("tx-pg").await,
    dataomni_lib::services::TransactionState::default()
  );
  sessions.execute_streaming(options("SELECT 1"), &mut |_| Ok(())).await.expect("回滚之后又能用");

  sessions.release("tx-pg").await;
}

/// 同一段脚本在 MySQL 上：出错之后事务照常可用。把它也标成「已失败」是说假话。
#[tokio::test]
async fn mysql_keeps_the_transaction_usable_after_a_failed_statement() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");
  let sessions = QuerySessionState::default();
  let db_pool = DbPool::MySql(pool);

  let options = |sql: &'static str| StreamingQueryOptions {
    session_id: "tx-my",
    pool_key: &url,
    pool: &db_pool,
    sql,
    autocommit: true,
    assume_rows: false,
    row_limit: 100,
    byte_limit: 1 << 20,
    batch_size: 10,
    timeout_duration: Duration::from_secs(10),
  };

  sessions.execute_streaming(options("BEGIN"), &mut |_| Ok(())).await.expect("begin");
  sessions
    .execute_streaming(options("SELECT no_such_column"), &mut |_| Ok(()))
    .await
    .expect_err("这条本来就该失败");
  assert_eq!(
    sessions.transaction("tx-my").await.status,
    dataomni_lib::services::TransactionStatus::Active,
    "MySQL 的事务在一条语句出错之后照常可用"
  );
  sessions.execute_streaming(options("SELECT 1"), &mut |_| Ok(())).await.expect("照常能跑");

  sessions.execute_streaming(options("ROLLBACK"), &mut |_| Ok(())).await.expect("rollback");
  sessions.release("tx-my").await;
}

/// 执行计划的三个解析器，各自拿真库跑一遍。
///
/// 单测里的那几份 JSON 是**从这些库上抄下来的**，但抄下来的那一刻之后，
/// 数据库的版本、优化器与输出格式还会变。这几条用例保证解析器面对的一直是
/// 真实输出，而不是某一天的快照。
fn plan_operations(node: &dataomni_lib::services::PlanNode, into: &mut Vec<String>) {
  into.push(node.operation.clone());
  for child in &node.children {
    plan_operations(child, into);
  }
}

fn all_operations(plan: &dataomni_lib::services::QueryPlan) -> Vec<String> {
  let mut names = Vec::new();
  for root in &plan.roots {
    plan_operations(root, &mut names);
  }
  names
}

async fn explain_with_session(
  sessions: &QuerySessionState,
  pool: &DbPool,
  pool_key: &str,
  db_type: &dataomni_lib::models::DatabaseType,
  sql: &str,
  analyze: bool,
) -> dataomni_lib::services::QueryPlan {
  let statement =
    dataomni_lib::services::explain_statement(db_type, sql, analyze).expect("explain statement");
  // 和 `explain_query` 命令走同一条路径，包括 assume_rows——MySQL 在预处理
  // `EXPLAIN FORMAT=JSON` 时报告 0 列，不带这个标志就拿不到那一行
  let mut rows = Vec::new();
  sessions
    .execute_streaming(
      StreamingQueryOptions {
        session_id: "plan",
        pool_key,
        pool,
        sql: &statement,
        autocommit: true,
        assume_rows: true,
        row_limit: 10_000,
        byte_limit: 16 * 1024 * 1024,
        batch_size: 200,
        timeout_duration: Duration::from_secs(30),
      },
      &mut |batch| {
        rows.extend(batch.rows);
        Ok(())
      },
    )
    .await
    .unwrap_or_else(|error| panic!("跑不了: {statement}\n{error}"));
  dataomni_lib::services::parse_plan(db_type, &rows, analyze).expect("parse plan")
}

#[tokio::test]
async fn postgres_explain_gives_a_tree_with_real_numbers_when_analyzed() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");
  let cockroach = is_cockroach(&pool).await;
  let db_pool = DbPool::Postgres(pool);
  let sessions = QuerySessionState::default();
  let db_type = dataomni_lib::models::DatabaseType::PostgreSQL;

  for statement in [
    "DROP TABLE IF EXISTS explain_smoke",
    "CREATE TABLE explain_smoke (id int primary key, code text, n int)",
    "INSERT INTO explain_smoke SELECT g, 'c' || g, g % 7 FROM generate_series(1, 300) g",
    "ANALYZE explain_smoke",
  ] {
    sessions
      .execute("plan", &url, &db_pool, statement, 1, Duration::from_secs(30))
      .await
      .expect("prepare fixture");
  }

  let sql = "SELECT code FROM explain_smoke WHERE n > 2 ORDER BY code LIMIT 5";

  // CockroachDB 的 EXPLAIN 没有 JSON 格式，给的是它自己的文本树。当前版本不解析，
  // 要钉的是「报出来」：服务端的原话送到界面上，而不是画一棵空树
  if cockroach {
    let statement =
      dataomni_lib::services::explain_statement(&db_type, sql, false).expect("explain statement");
    let error = sessions
      .execute("plan", &url, &db_pool, &statement, 1, Duration::from_secs(30))
      .await
      .expect_err("CockroachDB rejects FORMAT JSON");
    assert!(error.message.contains("syntax error"), "应是服务端原话: {}", error.message);
    sessions.release("plan").await;
    return;
  }

  let plain = explain_with_session(&sessions, &db_pool, &url, &db_type, sql, false).await;
  let operations = all_operations(&plain);
  assert!(operations.iter().any(|name| name.contains("Scan")), "{operations:?}");
  assert!(
    plain.roots.iter().all(|node| node.actual_rows.is_none()),
    "没 ANALYZE 就不该有实际行数: {:?}",
    plain.roots
  );
  assert!(!plain.raw.trim().is_empty(), "文本那一页要有东西");

  let analyzed = explain_with_session(&sessions, &db_pool, &url, &db_type, sql, true).await;
  assert!(analyzed.execution_ms.is_some(), "ANALYZE 要给出执行耗时: {analyzed:?}");
  let has_actual = {
    let mut found = false;
    let mut stack: Vec<&dataomni_lib::services::PlanNode> = analyzed.roots.iter().collect();
    while let Some(node) = stack.pop() {
      found |= node.actual_rows.is_some();
      stack.extend(node.children.iter());
    }
    found
  };
  assert!(has_actual, "ANALYZE 要给出实际行数: {analyzed:?}");

  sessions
    .execute(
      "plan",
      &url,
      &db_pool,
      "DROP TABLE IF EXISTS explain_smoke",
      1,
      Duration::from_secs(30),
    )
    .await
    .ok();
  sessions.release("plan").await;
}

#[tokio::test]
async fn mysql_explain_nests_the_join_and_names_both_tables() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to MySQL");
  let flavor = mysql_flavor(&pool).await;
  let db_pool = DbPool::MySql(pool);
  let sessions = QuerySessionState::default();
  let db_type = dataomni_lib::models::DatabaseType::MySQL;

  for statement in [
    "DROP TABLE IF EXISTS explain_smoke_child",
    "DROP TABLE IF EXISTS explain_smoke",
    "CREATE TABLE explain_smoke (id INT PRIMARY KEY, code VARCHAR(32), n INT)",
    "CREATE TABLE explain_smoke_child (id INT PRIMARY KEY, parent INT, INDEX(parent))",
    "INSERT INTO explain_smoke VALUES (1,'a',5),(2,'b',1),(3,'c',9)",
    "INSERT INTO explain_smoke_child VALUES (1,1),(2,2),(3,3)",
  ] {
    sessions
      .execute("plan", &url, &db_pool, statement, 1, Duration::from_secs(30))
      .await
      .expect("prepare fixture");
  }

  let query =
    "SELECT p.code FROM explain_smoke p JOIN explain_smoke_child c ON c.parent = p.id WHERE p.n > 2";

  // TiDB 不认 `FORMAT=JSON`，它自己的 `tidb_json` 是另一棵树。当前版本不解析它，
  // 要钉的是「报出来」：服务端的原话一路送到界面上，而不是画一棵空树
  if flavor == MysqlFlavor::TiDb {
    let statement =
      dataomni_lib::services::explain_statement(&db_type, query, false).expect("explain statement");
    let error = sessions
      .execute("plan", &url, &db_pool, &statement, 1, Duration::from_secs(30))
      .await
      .expect_err("TiDB rejects FORMAT=JSON");
    assert!(error.message.contains("not supported"), "应是 TiDB 的原话: {}", error.message);
    sessions.release("plan").await;
    return;
  }

  let plan = explain_with_session(&sessions, &db_pool, &url, &db_type, query, false).await;

  let operations = all_operations(&plan);
  assert!(operations.contains(&"query_block".to_string()), "{operations:?}");

  // 钉住的是**形状**，不只是「两张表在树上某处」。
  // `nested_loop` 的元素是 `{"table": {...}}` 这样的单键包装，外面那层不该
  // 在树上占一行——不拆包，两张表照样都在，只是各自深了一层，而一个只看
  // 「出现过没有」的断言对此一无所知。
  let mut stack: Vec<&dataomni_lib::services::PlanNode> = plan.roots.iter().collect();
  let mut join = None;
  while let Some(node) = stack.pop() {
    if node.operation == "nested_loop" {
      join = Some(node);
      break;
    }
    stack.extend(node.children.iter());
  }
  let join = join.unwrap_or_else(|| panic!("连接那一层该叫 nested_loop: {operations:?}"));
  let mut children: Vec<(&str, &str)> = join
    .children
    .iter()
    .map(|child| (child.operation.as_str(), child.target.as_deref().unwrap_or("")))
    .collect();
  children.sort();
  assert_eq!(
    children,
    vec![("table", "c"), ("table", "p")],
    "nested_loop 的直接子节点就是两张表: {operations:?}"
  );

  for statement in
    ["DROP TABLE IF EXISTS explain_smoke_child", "DROP TABLE IF EXISTS explain_smoke"]
  {
    sessions.execute("plan", &url, &db_pool, statement, 1, Duration::from_secs(30)).await.ok();
  }
  sessions.release("plan").await;
}

#[tokio::test]
async fn sqlite_explain_query_plan_names_the_index_it_will_use() {
  let pool = SqlitePoolOptions::new()
    .max_connections(1)
    .connect("sqlite::memory:")
    .await
    .expect("connect to in-memory SQLite");
  let db_pool = DbPool::Sqlite(pool);
  let sessions = QuerySessionState::default();
  let db_type = dataomni_lib::models::DatabaseType::SQLite;

  for statement in [
    "CREATE TABLE explain_smoke (id INTEGER PRIMARY KEY, code TEXT, n INT)",
    "CREATE INDEX ix_explain_smoke_n ON explain_smoke(n)",
  ] {
    sessions
      .execute("plan", "sqlite::memory:", &db_pool, statement, 1, Duration::from_secs(5))
      .await
      .expect("prepare fixture");
  }

  let plan = explain_with_session(
    &sessions,
    &db_pool,
    "sqlite::memory:",
    &db_type,
    "SELECT code FROM explain_smoke WHERE n = 3",
    false,
  )
  .await;

  let operations = all_operations(&plan);
  assert!(
    operations.iter().any(|name| name.contains("ix_explain_smoke_n")),
    "计划里该点名用了哪个索引: {operations:?}"
  );
  assert!(!plan.analyzed);
}

// ---------------------------------------------------------------------------
// CSV 导入
//
// 单元测试跑在 SQLite 上，而 SQLite 什么都收：文本进 INTEGER 列不报错，
// 一条语句失败之后事务还能接着用。真正要验的两件事只有真库能给：
// PostgreSQL 会拒收类型不符的文本，也会在一条语句报错之后把整个事务废掉。
// ---------------------------------------------------------------------------

fn write_import_csv(name: &str, contents: &str) -> std::path::PathBuf {
  let path = std::env::temp_dir().join(format!("dataomni-import-{name}.csv"));
  std::fs::write(&path, contents).expect("write CSV fixture");
  path
}

fn import_request(
  path: &std::path::Path,
  table: &str,
  columns: Vec<dataomni_lib::services::csv_import::ImportColumn>,
) -> dataomni_lib::services::ImportRequest {
  dataomni_lib::services::ImportRequest {
    path: path.to_string_lossy().to_string(),
    schema: None,
    table: table.to_string(),
    csv: dataomni_lib::services::CsvOptions {
      delimiter: ",".into(),
      has_header: true,
      null_text: String::new(),
    },
    columns,
    batch_size: 2,
    strategy: dataomni_lib::services::TransactionStrategy::SingleTransaction,
    on_error: dataomni_lib::services::ErrorPolicy::Abort,
  }
}

fn import_column(
  source: usize,
  target: &str,
  target_type: &str,
) -> dataomni_lib::services::csv_import::ImportColumn {
  dataomni_lib::services::csv_import::ImportColumn {
    source,
    target: target.to_string(),
    target_type: target_type.to_string(),
  }
}

async fn run_import(
  pool: &DbPool,
  request: &dataomni_lib::services::ImportRequest,
) -> dataomni_lib::services::ImportSummary {
  let mut progress = |_| {};
  let mut cancelled = || false;
  let mut paused = || false;
  dataomni_lib::services::import_csv(pool, request, &mut progress, &mut cancelled, &mut paused)
    .await
    .expect("import runs")
}

/// 文本绑进 integer / date / numeric / boolean 列。
///
/// 这一条是 `$n::text::类型` 存在的全部理由：PostgreSQL 不会替我们转，
/// 少了那层转换，四列里有三列会当场报类型错。
#[tokio::test]
async fn postgres_import_casts_text_into_typed_columns() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(2).connect(&url).await.expect("connect to PostgreSQL");
  let db_pool = DbPool::Postgres(pool.clone());

  sqlx::query("DROP TABLE IF EXISTS import_smoke_typed").execute(&pool).await.expect("drop");
  sqlx::query(
    "CREATE TABLE import_smoke_typed (n int, d date, amount numeric(10,2), ok boolean, tag varchar(8))",
  )
  .execute(&pool)
  .await
  .expect("create");

  let path = write_import_csv(
    "pg-typed",
    "n,d,amount,ok,tag\n1,2026-01-02,12.50,true,a\n2,2026-03-04,0.99,false,b\n",
  );
  let summary = run_import(
    &db_pool,
    &import_request(
      &path,
      "import_smoke_typed",
      vec![
        import_column(0, "n", "integer"),
        import_column(1, "d", "date"),
        import_column(2, "amount", "numeric(10,2)"),
        import_column(3, "ok", "boolean"),
        import_column(4, "tag", "character varying(8)"),
      ],
    ),
  )
  .await;

  assert_eq!(summary.rows_failed, 0, "{:?}", summary.errors);
  assert_eq!(summary.rows_inserted, 2);

  // 只数行数证明不了转换是对的：一串 '2026-01-02' 存进 text 列也是两行
  // `n::int4`：CockroachDB 的 INT 是 INT8，这里要比的是导入的值，不是列宽
  let row = sqlx::query(
    "SELECT n::int4 AS n, d, amount, ok, tag FROM import_smoke_typed ORDER BY n LIMIT 1",
  )
  .fetch_one(&pool)
  .await
  .expect("read back");
  assert_eq!(row.get::<i32, _>("n"), 1);
  assert_eq!(row.get::<chrono::NaiveDate, _>("d").to_string(), "2026-01-02");
  assert!(row.get::<bool, _>("ok"));
  assert_eq!(row.get::<String, _>("tag"), "a");

  sqlx::query("DROP TABLE IF EXISTS import_smoke_typed").execute(&pool).await.expect("cleanup");
}

/// PostgreSQL 在一条语句报错之后会把整个事务废掉，后续语句一律 25P02。
///
/// 所以「跳过错误行」在 PG 上不是「忽略那条错误」那么简单——不退回保存点，
/// 坏行后面的每一行都会跟着失败。这一条盯的就是它。
#[tokio::test]
async fn postgres_keeps_importing_after_a_row_the_server_rejected() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(2).connect(&url).await.expect("connect to PostgreSQL");
  let db_pool = DbPool::Postgres(pool.clone());

  sqlx::query("DROP TABLE IF EXISTS import_smoke_skip").execute(&pool).await.expect("drop");
  sqlx::query("CREATE TABLE import_smoke_skip (n int primary key, tag text)")
    .execute(&pool)
    .await
    .expect("create");

  // 第 3 行的 n 不是数字，第 5 行与第 2 行主键撞车——两种不同的服务端拒收
  let path = write_import_csv("pg-skip", "n,tag\n1,a\nnot-a-number,b\n3,c\n1,d\n5,e\n");
  let mut request = import_request(
    &path,
    "import_smoke_skip",
    vec![import_column(0, "n", "integer"), import_column(1, "tag", "text")],
  );
  request.on_error = dataomni_lib::services::ErrorPolicy::Skip;
  let summary = run_import(&db_pool, &request).await;

  assert_eq!(summary.rows_failed, 2, "{:?}", summary.errors);
  assert_eq!(summary.rows_inserted, 3);
  // 报的是文件里的行号，不是「第几批第几行」
  assert_eq!(summary.errors.iter().map(|error| error.line).collect::<Vec<_>>(), vec![3, 5]);
  assert!(!summary.rolled_back);

  let kept: Vec<i32> = sqlx::query_scalar("SELECT n::int4 FROM import_smoke_skip ORDER BY n")
    .fetch_all(&pool)
    .await
    .expect("read back");
  assert_eq!(kept, vec![1, 3, 5]);

  sqlx::query("DROP TABLE IF EXISTS import_smoke_skip").execute(&pool).await.expect("cleanup");
}

/// 单事务下一行坏掉，整份都不能留下——而 PostgreSQL 的 ROLLBACK 必须发得出去。
#[tokio::test]
async fn postgres_import_leaves_nothing_behind_when_one_row_fails() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool =
    PgPoolOptions::new().max_connections(2).connect(&url).await.expect("connect to PostgreSQL");
  let db_pool = DbPool::Postgres(pool.clone());

  sqlx::query("DROP TABLE IF EXISTS import_smoke_atomic").execute(&pool).await.expect("drop");
  sqlx::query("CREATE TABLE import_smoke_atomic (n int)").execute(&pool).await.expect("create");

  let path = write_import_csv("pg-atomic", "n\n1\n2\nnope\n4\n");
  let summary = run_import(
    &db_pool,
    &import_request(&path, "import_smoke_atomic", vec![import_column(0, "n", "integer")]),
  )
  .await;

  assert!(summary.rolled_back);
  assert_eq!(summary.rows_inserted, 0);
  // 停下来之前也要说清是哪一行：「这一批失败了」帮不上任何忙
  assert_eq!(summary.errors.first().map(|error| error.line), Some(4));

  let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM import_smoke_atomic")
    .fetch_one(&pool)
    .await
    .expect("count");
  assert_eq!(left, 0);

  sqlx::query("DROP TABLE IF EXISTS import_smoke_atomic").execute(&pool).await.expect("cleanup");
}

/// MySQL：分批提交下，坏行前面已经提交的批次留在库里。
#[tokio::test]
async fn mysql_import_commits_batch_by_batch_and_names_the_bad_line() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool =
    MySqlPoolOptions::new().max_connections(2).connect(&url).await.expect("connect to MySQL");
  let db_pool = DbPool::MySql(pool.clone());

  sqlx::query("DROP TABLE IF EXISTS import_smoke_batch").execute(&pool).await.expect("drop");
  sqlx::query("CREATE TABLE import_smoke_batch (n int primary key, tag varchar(16)) ENGINE=InnoDB")
    .execute(&pool)
    .await
    .expect("create");

  // 每批两行：前两行一批先提交，第 4 行与第 1 行主键撞车
  let path = write_import_csv("mysql-batch", "n,tag\n1,a\n2,b\n1,c\n4,d\n");
  let mut request = import_request(
    &path,
    "import_smoke_batch",
    vec![import_column(0, "n", "integer"), import_column(1, "tag", "varchar(16)")],
  );
  request.strategy = dataomni_lib::services::TransactionStrategy::PerBatch;
  request.on_error = dataomni_lib::services::ErrorPolicy::Skip;
  let summary = run_import(&db_pool, &request).await;

  assert_eq!(summary.rows_failed, 1, "{:?}", summary.errors);
  assert_eq!(summary.errors[0].line, 4);
  assert_eq!(summary.rows_inserted, 3);
  assert!(!summary.rolled_back);

  let kept: Vec<i32> = sqlx::query_scalar("SELECT n FROM import_smoke_batch ORDER BY n")
    .fetch_all(&pool)
    .await
    .expect("read back");
  assert_eq!(kept, vec![1, 2, 4]);

  sqlx::query("DROP TABLE IF EXISTS import_smoke_batch").execute(&pool).await.expect("cleanup");
}
