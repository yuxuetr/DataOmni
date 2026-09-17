use serde::Serialize;
use serde_json::{Map, Value as JsonValue};
use sqlx::{
  mysql::{MySqlRow, MySqlValueRef},
  postgres::{PgRow, PgValueRef},
  sqlite::{SqliteRow, SqliteValueRef},
  Column, Executor, MySql, MySqlConnection, PgConnection, Pool, Postgres, Row, Sqlite,
  SqliteConnection, TypeInfo, Value, ValueRef,
};
use std::future::Future;
use tauri_plugin_sql::DbPool;
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time};
use tokio::time::{timeout, Duration};

pub const QUERY_TIMEOUT_CODE: &str = "QUERY_TIMEOUT";

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryExecutionResult {
  Rows { columns: Vec<String>, rows: Vec<Map<String, JsonValue>> },
  Affected { rows_affected: u64 },
}

pub async fn execute_query(pool: &DbPool, sql: &str) -> Result<QueryExecutionResult, String> {
  match pool {
    DbPool::Sqlite(pool) => execute_sqlite(pool, sql).await,
    DbPool::MySql(pool) => execute_mysql(pool, sql).await,
    DbPool::Postgres(pool) => execute_postgres(pool, sql).await,
  }
}

pub enum SessionConnection {
  Sqlite(sqlx::pool::PoolConnection<Sqlite>),
  MySql(sqlx::pool::PoolConnection<MySql>),
  Postgres(sqlx::pool::PoolConnection<Postgres>),
}

impl SessionConnection {
  pub async fn acquire(pool: &DbPool) -> Result<Self, String> {
    match pool {
      DbPool::Sqlite(pool) => {
        pool.acquire().await.map(Self::Sqlite).map_err(|error| error.to_string())
      }
      DbPool::MySql(pool) => {
        pool.acquire().await.map(Self::MySql).map_err(|error| error.to_string())
      }
      DbPool::Postgres(pool) => {
        pool.acquire().await.map(Self::Postgres).map_err(|error| error.to_string())
      }
    }
  }

  pub async fn execute(&mut self, sql: &str) -> Result<QueryExecutionResult, String> {
    match self {
      Self::Sqlite(connection) => execute_sqlite_connection(connection, sql).await,
      Self::MySql(connection) => execute_mysql_connection(connection, sql).await,
      Self::Postgres(connection) => execute_postgres_connection(connection, sql).await,
    }
  }
}

pub async fn execute_query_with_timeout(
  pool: &DbPool,
  sql: &str,
  timeout_duration: Duration,
) -> Result<QueryExecutionResult, String> {
  with_timeout(execute_query(pool, sql), timeout_duration).await
}

async fn with_timeout<F, T>(future: F, timeout_duration: Duration) -> Result<T, String>
where
  F: Future<Output = Result<T, String>>,
{
  timeout(timeout_duration, future).await.map_err(|_| {
    format!("{QUERY_TIMEOUT_CODE}: 查询执行超过 {} 毫秒", timeout_duration.as_millis())
  })?
}

async fn execute_sqlite(pool: &Pool<Sqlite>, sql: &str) -> Result<QueryExecutionResult, String> {
  let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
  execute_sqlite_connection(&mut connection, sql).await
}

async fn execute_sqlite_connection(
  connection: &mut SqliteConnection,
  sql: &str,
) -> Result<QueryExecutionResult, String> {
  if is_transaction_control_statement(sql) {
    let result = (&mut *connection).execute(sql).await.map_err(|error| error.to_string())?;
    return Ok(QueryExecutionResult::Affected { rows_affected: result.rows_affected() });
  }

  let columns = (&mut *connection)
    .describe(sql)
    .await
    .map_err(|error| error.to_string())?
    .columns()
    .iter()
    .map(|column| column.name().to_string())
    .collect::<Vec<_>>();

  if columns.is_empty() {
    let result = (&mut *connection).execute(sql).await.map_err(|error| error.to_string())?;
    return Ok(QueryExecutionResult::Affected { rows_affected: result.rows_affected() });
  }

  let rows = (&mut *connection).fetch_all(sql).await.map_err(|error| error.to_string())?;
  let rows = rows.iter().map(decode_sqlite_row).collect::<Result<Vec<_>, _>>()?;
  Ok(QueryExecutionResult::Rows { columns, rows })
}

async fn execute_mysql(pool: &Pool<MySql>, sql: &str) -> Result<QueryExecutionResult, String> {
  let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
  execute_mysql_connection(&mut connection, sql).await
}

async fn execute_mysql_connection(
  connection: &mut MySqlConnection,
  sql: &str,
) -> Result<QueryExecutionResult, String> {
  if is_transaction_control_statement(sql) {
    let result = (&mut *connection).execute(sql).await.map_err(|error| error.to_string())?;
    return Ok(QueryExecutionResult::Affected { rows_affected: result.rows_affected() });
  }

  let columns = (&mut *connection)
    .describe(sql)
    .await
    .map_err(|error| error.to_string())?
    .columns()
    .iter()
    .map(|column| column.name().to_string())
    .collect::<Vec<_>>();

  if columns.is_empty() {
    let result = (&mut *connection).execute(sql).await.map_err(|error| error.to_string())?;
    return Ok(QueryExecutionResult::Affected { rows_affected: result.rows_affected() });
  }

  let rows = (&mut *connection).fetch_all(sql).await.map_err(|error| error.to_string())?;
  let rows = rows.iter().map(decode_mysql_row).collect::<Result<Vec<_>, _>>()?;
  Ok(QueryExecutionResult::Rows { columns, rows })
}

async fn execute_postgres(
  pool: &Pool<Postgres>,
  sql: &str,
) -> Result<QueryExecutionResult, String> {
  let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
  execute_postgres_connection(&mut connection, sql).await
}

async fn execute_postgres_connection(
  connection: &mut PgConnection,
  sql: &str,
) -> Result<QueryExecutionResult, String> {
  if is_transaction_control_statement(sql) {
    let result = (&mut *connection).execute(sql).await.map_err(|error| error.to_string())?;
    return Ok(QueryExecutionResult::Affected { rows_affected: result.rows_affected() });
  }

  let columns = (&mut *connection)
    .describe(sql)
    .await
    .map_err(|error| error.to_string())?
    .columns()
    .iter()
    .map(|column| column.name().to_string())
    .collect::<Vec<_>>();

  if columns.is_empty() {
    let result = (&mut *connection).execute(sql).await.map_err(|error| error.to_string())?;
    return Ok(QueryExecutionResult::Affected { rows_affected: result.rows_affected() });
  }

  let rows = (&mut *connection).fetch_all(sql).await.map_err(|error| error.to_string())?;
  let rows = rows.iter().map(decode_postgres_row).collect::<Result<Vec<_>, _>>()?;
  Ok(QueryExecutionResult::Rows { columns, rows })
}

fn is_transaction_control_statement(sql: &str) -> bool {
  let normalized = sql.trim().trim_end_matches(';').trim().to_ascii_uppercase();
  [
    "BEGIN",
    "START TRANSACTION",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "RELEASE SAVEPOINT",
    "SET TRANSACTION",
  ]
  .iter()
  .any(|keyword| normalized == *keyword || normalized.starts_with(&format!("{keyword} ")))
}

fn decode_sqlite_row(row: &SqliteRow) -> Result<Map<String, JsonValue>, String> {
  let mut values = Map::new();
  for (index, column) in row.columns().iter().enumerate() {
    let value = row.try_get_raw(index).map_err(|error| error.to_string())?;
    values.insert(column.name().to_string(), decode_sqlite(value)?);
  }
  Ok(values)
}

fn decode_mysql_row(row: &MySqlRow) -> Result<Map<String, JsonValue>, String> {
  let mut values = Map::new();
  for (index, column) in row.columns().iter().enumerate() {
    let value = row.try_get_raw(index).map_err(|error| error.to_string())?;
    values.insert(column.name().to_string(), decode_mysql(value)?);
  }
  Ok(values)
}

fn decode_postgres_row(row: &PgRow) -> Result<Map<String, JsonValue>, String> {
  let mut values = Map::new();
  for (index, column) in row.columns().iter().enumerate() {
    let value = row.try_get_raw(index).map_err(|error| error.to_string())?;
    values.insert(column.name().to_string(), decode_postgres(value)?);
  }
  Ok(values)
}

fn decode_sqlite(value: SqliteValueRef<'_>) -> Result<JsonValue, String> {
  if value.is_null() {
    return Ok(JsonValue::Null);
  }

  match value.type_info().name() {
    "TEXT" => json_value(ValueRef::to_owned(&value).try_decode::<String>()),
    "INTEGER" | "NUMERIC" => json_value(ValueRef::to_owned(&value).try_decode::<i64>()),
    "REAL" => json_value(ValueRef::to_owned(&value).try_decode::<f64>()),
    "BOOLEAN" => json_value(ValueRef::to_owned(&value).try_decode::<bool>()),
    "DATE" => display_value(ValueRef::to_owned(&value).try_decode::<Date>()),
    "TIME" => display_value(ValueRef::to_owned(&value).try_decode::<Time>()),
    "DATETIME" => display_value(ValueRef::to_owned(&value).try_decode::<PrimitiveDateTime>()),
    "BLOB" => json_value(ValueRef::to_owned(&value).try_decode::<Vec<u8>>()),
    "NULL" => Ok(JsonValue::Null),
    type_name => Err(format!("不支持的 SQLite 数据类型: {type_name}")),
  }
}

fn decode_mysql(value: MySqlValueRef<'_>) -> Result<JsonValue, String> {
  if value.is_null() {
    return Ok(JsonValue::Null);
  }

  let type_info = value.type_info();
  let type_name = type_info.name();
  match type_name {
    "JSON" => json_value(ValueRef::to_owned(&value).try_decode::<JsonValue>()),
    "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "INT UNSIGNED" | "MEDIUMINT UNSIGNED"
    | "BIGINT UNSIGNED" | "YEAR" => json_value(ValueRef::to_owned(&value).try_decode::<u64>()),
    "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" => {
      json_value(ValueRef::to_owned(&value).try_decode::<String>())
    }
    "TINYINT" | "SMALLINT" | "INT" | "MEDIUMINT" | "BIGINT" => {
      json_value(ValueRef::to_owned(&value).try_decode::<i64>())
    }
    "FLOAT" => json_value(ValueRef::to_owned(&value).try_decode::<f32>()),
    "DOUBLE" => json_value(ValueRef::to_owned(&value).try_decode::<f64>()),
    "BOOLEAN" => json_value(ValueRef::to_owned(&value).try_decode::<bool>()),
    "DATE" => display_value(ValueRef::to_owned(&value).try_decode::<Date>()),
    "TIME" => display_value(ValueRef::to_owned(&value).try_decode::<Time>()),
    "DATETIME" => display_value(ValueRef::to_owned(&value).try_decode::<PrimitiveDateTime>()),
    "TIMESTAMP" => display_value(ValueRef::to_owned(&value).try_decode::<OffsetDateTime>()),
    "TINYBLOB" | "MEDIUMBLOB" | "BLOB" | "LONGBLOB" => {
      json_value(ValueRef::to_owned(&value).try_decode::<Vec<u8>>())
    }
    "NULL" => Ok(JsonValue::Null),
    _ => Err(format!("不支持的 MySQL 数据类型: {type_name}")),
  }
}

fn decode_postgres(value: PgValueRef<'_>) -> Result<JsonValue, String> {
  if value.is_null() {
    return Ok(JsonValue::Null);
  }

  let type_info = value.type_info();
  let type_name = type_info.name();
  match type_name {
    "INT2" => json_value(ValueRef::to_owned(&value).try_decode::<i16>()),
    "INT4" => json_value(ValueRef::to_owned(&value).try_decode::<i32>()),
    "JSON" | "JSONB" => json_value(ValueRef::to_owned(&value).try_decode::<JsonValue>()),
    "CHAR" | "VARCHAR" | "TEXT" | "NAME" | "UUID" => {
      json_value(ValueRef::to_owned(&value).try_decode::<String>())
    }
    "INT8" => json_value(ValueRef::to_owned(&value).try_decode::<i64>()),
    "FLOAT4" => json_value(ValueRef::to_owned(&value).try_decode::<f32>()),
    "FLOAT8" => json_value(ValueRef::to_owned(&value).try_decode::<f64>()),
    "BOOL" => json_value(ValueRef::to_owned(&value).try_decode::<bool>()),
    "DATE" => display_value(ValueRef::to_owned(&value).try_decode::<Date>()),
    "TIME" => display_value(ValueRef::to_owned(&value).try_decode::<Time>()),
    "TIMESTAMP" => display_value(ValueRef::to_owned(&value).try_decode::<PrimitiveDateTime>()),
    "TIMESTAMPTZ" => display_value(ValueRef::to_owned(&value).try_decode::<OffsetDateTime>()),
    "BYTEA" => json_value(ValueRef::to_owned(&value).try_decode::<Vec<u8>>()),
    "VOID" => Ok(JsonValue::Null),
    _ => Err(format!("不支持的 PostgreSQL 数据类型: {type_name}")),
  }
}

fn json_value<T, E>(value: Result<T, E>) -> Result<JsonValue, String>
where
  T: Serialize,
  E: std::fmt::Display,
{
  let decoded = value.map_err(|error| error.to_string())?;
  serde_json::to_value(decoded).map_err(|error| error.to_string())
}

fn display_value<T, E>(value: Result<T, E>) -> Result<JsonValue, String>
where
  T: std::fmt::Display,
  E: std::fmt::Display,
{
  value.map(|value| JsonValue::String(value.to_string())).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;
  use sqlx::sqlite::SqlitePoolOptions;
  use std::future::pending;

  #[test]
  fn recognizes_transaction_control_statements_without_matching_prefixes() {
    for sql in [
      "BEGIN",
      "begin transaction;",
      "START TRANSACTION",
      "COMMIT WORK",
      "ROLLBACK TO SAVEPOINT before_update",
      "SAVEPOINT before_update",
      "RELEASE SAVEPOINT before_update",
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
    ] {
      assert!(is_transaction_control_statement(sql), "expected transaction SQL: {sql}");
    }

    assert!(!is_transaction_control_statement("SELECT 'BEGIN'"));
    assert!(!is_transaction_control_statement("BEGINNING"));
  }

  #[tokio::test]
  async fn uses_driver_metadata_for_empty_result_sets() {
    let pool = SqlitePoolOptions::new()
      .max_connections(1)
      .connect("sqlite::memory:")
      .await
      .expect("connect to SQLite");
    let result = execute_query(&DbPool::Sqlite(pool), "SELECT 1 AS value WHERE 1 = 0")
      .await
      .expect("execute empty query");

    match result {
      QueryExecutionResult::Rows { columns, rows } => {
        assert_eq!(columns, vec!["value"]);
        assert!(rows.is_empty());
      }
      QueryExecutionResult::Affected { .. } => panic!("expected a row result"),
    }
  }

  #[tokio::test]
  async fn distinguishes_affected_rows_from_returning_rows() {
    let pool = SqlitePoolOptions::new()
      .max_connections(1)
      .connect("sqlite::memory:")
      .await
      .expect("connect to SQLite");
    sqlx::query("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
      .execute(&pool)
      .await
      .expect("create table");
    let pool = DbPool::Sqlite(pool);

    let affected =
      execute_query(&pool, "INSERT INTO items (name) VALUES ('first')").await.expect("insert row");
    assert!(matches!(affected, QueryExecutionResult::Affected { rows_affected: 1 }));

    let returned =
      execute_query(&pool, "INSERT INTO items (name) VALUES ('second') RETURNING id, name")
        .await
        .expect("insert returning row");
    match returned {
      QueryExecutionResult::Rows { columns, rows } => {
        assert_eq!(columns, vec!["id", "name"]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], "second");
      }
      QueryExecutionResult::Affected { .. } => panic!("expected returned rows"),
    }
  }

  #[tokio::test]
  async fn reports_timeout_with_a_stable_error_code() {
    let error = with_timeout(
      async {
        pending::<()>().await;
        Ok::<(), String>(())
      },
      Duration::from_millis(1),
    )
    .await;

    assert_eq!(
      error.expect_err("pending query should time out"),
      "QUERY_TIMEOUT: 查询执行超过 1 毫秒"
    );
  }
}
