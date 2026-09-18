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
    execute_query_with_limits(&DbPool::Sqlite(pool), "SELECT 'too large' AS value", 100, 1)
      .await
      .expect("limit SQLite result bytes"),
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
    QueryExecutionResult::Rows { columns, rows, .. } => {
      assert_eq!(columns, vec![column]);
      assert!(rows.is_empty());
    }
    QueryExecutionResult::Affected { .. } => panic!("expected a row result"),
  }
}

fn assert_single_row_result(result: QueryExecutionResult, column: &str, value: &str) {
  match result {
    QueryExecutionResult::Rows { columns, rows, .. } => {
      assert_eq!(columns, vec![column]);
      assert_eq!(rows.len(), 1);
      assert_eq!(rows[0][column], value);
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
