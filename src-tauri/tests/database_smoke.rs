use dataomni_lib::services::{
  execute_query, execute_query_with_limit, execute_query_with_limits, execute_query_with_timeout,
  QueryExecutionResult, QueryExecutionSummary, QuerySessionState, QueryTruncationReason,
  StreamingQueryOptions, QUERY_TIMEOUT_CODE,
};
use sqlx::{mysql::MySqlPoolOptions, postgres::PgPoolOptions, sqlite::SqlitePoolOptions};
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
