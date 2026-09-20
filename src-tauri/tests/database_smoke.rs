use dataomni_lib::services::{
  execute_query, execute_query_with_limit, execute_query_with_limits, execute_query_with_timeout,
  QueryExecutionResult, QueryExecutionSummary, QuerySessionState, QueryTruncationReason,
  StreamingQueryOptions, QUERY_TIMEOUT_CODE,
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
  assert_tagged_values(
    precise,
    &[
      ("large_integer", "bigint", "9007199254740993"),
      ("decimal_value", "decimal", "12345678901234567890.12345678"),
      ("binary_value", "binary", "00ff10"),
      ("json_value", "json", "{\"enabled\":true}"),
    ],
  );

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

fn assert_query_times_out(result: Result<QueryExecutionResult, String>) {
  let error = result.expect_err("query should exceed its timeout");
  assert!(error.starts_with(QUERY_TIMEOUT_CODE), "unexpected timeout error: {error}");
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
    vec![
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
      match dialect {
        "mysql" => format!("CREATE INDEX ix_meta_child_expr_{suffix} ON {child} ((score + 1))"),
        _ => format!("CREATE INDEX ix_meta_child_expr_{suffix} ON {child} ((lower(label)))"),
      },
    ]
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
  let indexes: Vec<(String, String, i32, bool, bool)> = index_rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("index_name"),
        row.get::<String, _>("column_name"),
        row.get::<i32, _>("ordinal"),
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
  // PostgreSQL 会把 varchar 归一成 text，所以原文是 `lower(label::text)`
  assert!(
    expression_column.as_deref().is_some_and(|text| text.starts_with("lower(label")),
    "表达式索引要给出表达式原文；join pg_attribute 的写法会让这一列整个消失: {indexes:?}"
  );

  let fk_rows = sqlx::query(queries.foreign_keys)
    .bind(&fixture.child)
    .bind(Option::<String>::None)
    .fetch_all(&pool)
    .await
    .expect("run PostgreSQL foreign key query");
  let pairs: Vec<(i32, String, String, String)> = fk_rows
    .iter()
    .map(|row| {
      (
        row.get::<i32, _>("ordinal"),
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
  for statement in fixture.ddl("mysql") {
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
  let indexes: Vec<(String, String, u32, i64, i64)> = index_rows
    .iter()
    .map(|row| {
      (
        row.get::<String, _>("index_name"),
        row.get::<String, _>("column_name"),
        row.get::<u32, _>("ordinal"),
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
    expression_column.as_deref().is_some_and(|text| text.contains("score")),
    "函数索引的 COLUMN_NAME 是 NULL，必须回退到 EXPRESSION，否则这一列是空的: {indexes:?}"
  );

  let fk_rows = sqlx::query(queries.foreign_keys)
    .bind(&fixture.child)
    .bind(Option::<String>::None)
    .fetch_all(&pool)
    .await
    .expect("run MySQL foreign key query");
  let pairs: Vec<(u32, String, String, String)> = fk_rows
    .iter()
    .map(|row| {
      (
        row.get::<u32, _>("ordinal"),
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
  assert_eq!(checks.len(), 1, "只应列出这张表的那一条 CHECK: {checks:?}");
  assert_eq!(checks[0].0, format!("ck_meta_child_{}", fixture.suffix));
  assert!(checks[0].1.contains("score"), "约束表达式应含列名: {:?}", checks[0].1);

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
  for statement in fixture.ddl("mysql") {
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
  assert!(ddl.contains(&format!("ck_meta_child_{}", fixture.suffix)), "应含检查约束: {ddl}");
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
  let rows = sqlx::query(queries.triggers)
    .bind(&fixture.child)
    .bind(Option::<String>::None)
    .fetch_all(&pool)
    .await
    .expect("run trigger query");

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
  for statement in fixture.ddl("mysql") {
    sqlx::query(&statement).execute(&pool).await.expect("prepare MySQL fixture");
  }
  sqlx::query(&format!("CREATE VIEW {view} AS SELECT id, label FROM {}", fixture.child))
    .execute(&pool)
    .await
    .expect("create view");
  // MySQL 的 CREATE TRIGGER 不支持预处理协议（错误 1295），只能走文本协议
  sqlx::raw_sql(&format!(
    "CREATE TRIGGER {trigger} BEFORE INSERT ON {} FOR EACH ROW SET NEW.score = 1",
    fixture.child
  ))
  .execute(&pool)
  .await
  .expect("create trigger");

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
