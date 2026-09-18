use futures_util::TryStreamExt;
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
pub const DEFAULT_QUERY_ROW_LIMIT: usize = 1_000;
pub const DEFAULT_QUERY_BATCH_SIZE: usize = 250;
pub const DEFAULT_QUERY_BYTE_LIMIT: usize = 16 * 1024 * 1024;

pub type QueryRow = Map<String, JsonValue>;

#[derive(Debug, Clone, Serialize)]
pub struct QueryResultBatch {
  pub index: usize,
  pub offset: usize,
  pub rows: Vec<QueryRow>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryTruncationReason {
  RowLimit,
  ByteLimit,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryExecutionSummary {
  Rows {
    columns: Vec<String>,
    row_count: usize,
    batch_count: usize,
    truncated: bool,
    truncation_reason: Option<QueryTruncationReason>,
    row_limit: usize,
    byte_limit: usize,
    bytes_read: usize,
  },
  Affected {
    rows_affected: u64,
  },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryExecutionResult {
  Rows {
    columns: Vec<String>,
    rows: Vec<Map<String, JsonValue>>,
    truncated: bool,
    truncation_reason: Option<QueryTruncationReason>,
    row_limit: usize,
    byte_limit: usize,
    bytes_read: usize,
  },
  Affected {
    rows_affected: u64,
  },
}

pub async fn execute_query(pool: &DbPool, sql: &str) -> Result<QueryExecutionResult, String> {
  execute_query_with_limit(pool, sql, DEFAULT_QUERY_ROW_LIMIT).await
}

pub async fn execute_query_with_limit(
  pool: &DbPool,
  sql: &str,
  row_limit: usize,
) -> Result<QueryExecutionResult, String> {
  execute_query_with_limits(pool, sql, row_limit, DEFAULT_QUERY_BYTE_LIMIT).await
}

pub async fn execute_query_with_limits(
  pool: &DbPool,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, String> {
  match pool {
    DbPool::Sqlite(pool) => execute_sqlite(pool, sql, row_limit, byte_limit).await,
    DbPool::MySql(pool) => execute_mysql(pool, sql, row_limit, byte_limit).await,
    DbPool::Postgres(pool) => execute_postgres(pool, sql, row_limit, byte_limit).await,
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

  pub async fn execute(
    &mut self,
    sql: &str,
    row_limit: usize,
  ) -> Result<QueryExecutionResult, String> {
    match self {
      Self::Sqlite(connection) => execute_sqlite_connection(connection, sql, row_limit).await,
      Self::MySql(connection) => execute_mysql_connection(connection, sql, row_limit).await,
      Self::Postgres(connection) => execute_postgres_connection(connection, sql, row_limit).await,
    }
  }

  pub async fn execute_streaming(
    &mut self,
    sql: &str,
    row_limit: usize,
    byte_limit: usize,
    batch_size: usize,
    sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), String> + Send),
  ) -> Result<QueryExecutionSummary, String> {
    match self {
      Self::Sqlite(connection) => {
        execute_sqlite_connection_streaming(
          connection, sql, row_limit, byte_limit, batch_size, sink,
        )
        .await
      }
      Self::MySql(connection) => {
        execute_mysql_connection_streaming(connection, sql, row_limit, byte_limit, batch_size, sink)
          .await
      }
      Self::Postgres(connection) => {
        execute_postgres_connection_streaming(
          connection, sql, row_limit, byte_limit, batch_size, sink,
        )
        .await
      }
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

async fn execute_sqlite(
  pool: &Pool<Sqlite>,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, String> {
  let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
  execute_sqlite_connection_with_limits(&mut connection, sql, row_limit, byte_limit).await
}

async fn execute_sqlite_connection(
  connection: &mut SqliteConnection,
  sql: &str,
  row_limit: usize,
) -> Result<QueryExecutionResult, String> {
  execute_sqlite_connection_with_limits(connection, sql, row_limit, DEFAULT_QUERY_BYTE_LIMIT).await
}

async fn execute_sqlite_connection_with_limits(
  connection: &mut SqliteConnection,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, String> {
  let mut rows = Vec::new();
  let summary = execute_sqlite_connection_streaming(
    connection,
    sql,
    row_limit,
    byte_limit,
    row_limit.max(1),
    &mut |batch| {
      rows.extend(batch.rows);
      Ok(())
    },
  )
  .await?;
  summary_with_rows(summary, rows)
}

async fn execute_sqlite_connection_streaming(
  connection: &mut SqliteConnection,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
  batch_size: usize,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), String> + Send),
) -> Result<QueryExecutionSummary, String> {
  if is_transaction_control_statement(sql) {
    let result = (&mut *connection).execute(sql).await.map_err(|error| error.to_string())?;
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
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
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
  }

  let mut stream = (&mut *connection).fetch(sql);
  let mut rows = Vec::with_capacity(batch_size);
  let mut row_count = 0;
  let mut batch_count = 0;
  let mut bytes_read: usize = 0;
  let mut truncation_reason = None;
  while row_count < row_limit {
    let Some(row) = stream.try_next().await.map_err(|error| error.to_string())? else {
      break;
    };
    let row = decode_sqlite_row(&row)?;
    let row_bytes = serialized_row_size(&row)?;
    if bytes_read.saturating_add(row_bytes) > byte_limit {
      truncation_reason = Some(QueryTruncationReason::ByteLimit);
      break;
    }
    bytes_read += row_bytes;
    rows.push(row);
    row_count += 1;
    flush_full_batch(&mut rows, batch_size, &mut batch_count, row_count, sink)?;
  }
  if truncation_reason.is_none()
    && row_count == row_limit
    && stream.try_next().await.map_err(|error| error.to_string())?.is_some()
  {
    truncation_reason = Some(QueryTruncationReason::RowLimit);
  }
  flush_remaining_batch(&mut rows, &mut batch_count, row_count, sink)?;
  Ok(QueryExecutionSummary::Rows {
    columns,
    row_count,
    batch_count,
    truncated: truncation_reason.is_some(),
    truncation_reason,
    row_limit,
    byte_limit,
    bytes_read,
  })
}

async fn execute_mysql(
  pool: &Pool<MySql>,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, String> {
  let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
  execute_mysql_connection_with_limits(&mut connection, sql, row_limit, byte_limit).await
}

async fn execute_mysql_connection(
  connection: &mut MySqlConnection,
  sql: &str,
  row_limit: usize,
) -> Result<QueryExecutionResult, String> {
  execute_mysql_connection_with_limits(connection, sql, row_limit, DEFAULT_QUERY_BYTE_LIMIT).await
}

async fn execute_mysql_connection_with_limits(
  connection: &mut MySqlConnection,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, String> {
  let mut rows = Vec::new();
  let summary = execute_mysql_connection_streaming(
    connection,
    sql,
    row_limit,
    byte_limit,
    row_limit.max(1),
    &mut |batch| {
      rows.extend(batch.rows);
      Ok(())
    },
  )
  .await?;
  summary_with_rows(summary, rows)
}

async fn execute_mysql_connection_streaming(
  connection: &mut MySqlConnection,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
  batch_size: usize,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), String> + Send),
) -> Result<QueryExecutionSummary, String> {
  if is_transaction_control_statement(sql) {
    let result = (&mut *connection).execute(sql).await.map_err(|error| error.to_string())?;
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
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
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
  }

  let mut stream = (&mut *connection).fetch(sql);
  let mut rows = Vec::with_capacity(batch_size);
  let mut row_count = 0;
  let mut batch_count = 0;
  let mut bytes_read: usize = 0;
  let mut truncation_reason = None;
  while row_count < row_limit {
    let Some(row) = stream.try_next().await.map_err(|error| error.to_string())? else {
      break;
    };
    let row = decode_mysql_row(&row)?;
    let row_bytes = serialized_row_size(&row)?;
    if bytes_read.saturating_add(row_bytes) > byte_limit {
      truncation_reason = Some(QueryTruncationReason::ByteLimit);
      break;
    }
    bytes_read += row_bytes;
    rows.push(row);
    row_count += 1;
    flush_full_batch(&mut rows, batch_size, &mut batch_count, row_count, sink)?;
  }
  if truncation_reason.is_none()
    && row_count == row_limit
    && stream.try_next().await.map_err(|error| error.to_string())?.is_some()
  {
    truncation_reason = Some(QueryTruncationReason::RowLimit);
  }
  flush_remaining_batch(&mut rows, &mut batch_count, row_count, sink)?;
  Ok(QueryExecutionSummary::Rows {
    columns,
    row_count,
    batch_count,
    truncated: truncation_reason.is_some(),
    truncation_reason,
    row_limit,
    byte_limit,
    bytes_read,
  })
}

async fn execute_postgres(
  pool: &Pool<Postgres>,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, String> {
  let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
  execute_postgres_connection_with_limits(&mut connection, sql, row_limit, byte_limit).await
}

async fn execute_postgres_connection(
  connection: &mut PgConnection,
  sql: &str,
  row_limit: usize,
) -> Result<QueryExecutionResult, String> {
  execute_postgres_connection_with_limits(connection, sql, row_limit, DEFAULT_QUERY_BYTE_LIMIT)
    .await
}

async fn execute_postgres_connection_with_limits(
  connection: &mut PgConnection,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, String> {
  let mut rows = Vec::new();
  let summary = execute_postgres_connection_streaming(
    connection,
    sql,
    row_limit,
    byte_limit,
    row_limit.max(1),
    &mut |batch| {
      rows.extend(batch.rows);
      Ok(())
    },
  )
  .await?;
  summary_with_rows(summary, rows)
}

async fn execute_postgres_connection_streaming(
  connection: &mut PgConnection,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
  batch_size: usize,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), String> + Send),
) -> Result<QueryExecutionSummary, String> {
  if is_transaction_control_statement(sql) {
    let result = (&mut *connection).execute(sql).await.map_err(|error| error.to_string())?;
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
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
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
  }

  let mut stream = (&mut *connection).fetch(sql);
  let mut rows = Vec::with_capacity(batch_size);
  let mut row_count = 0;
  let mut batch_count = 0;
  let mut bytes_read: usize = 0;
  let mut truncation_reason = None;
  while row_count < row_limit {
    let Some(row) = stream.try_next().await.map_err(|error| error.to_string())? else {
      break;
    };
    let row = decode_postgres_row(&row)?;
    let row_bytes = serialized_row_size(&row)?;
    if bytes_read.saturating_add(row_bytes) > byte_limit {
      truncation_reason = Some(QueryTruncationReason::ByteLimit);
      break;
    }
    bytes_read += row_bytes;
    rows.push(row);
    row_count += 1;
    flush_full_batch(&mut rows, batch_size, &mut batch_count, row_count, sink)?;
  }
  if truncation_reason.is_none()
    && row_count == row_limit
    && stream.try_next().await.map_err(|error| error.to_string())?.is_some()
  {
    truncation_reason = Some(QueryTruncationReason::RowLimit);
  }
  flush_remaining_batch(&mut rows, &mut batch_count, row_count, sink)?;
  Ok(QueryExecutionSummary::Rows {
    columns,
    row_count,
    batch_count,
    truncated: truncation_reason.is_some(),
    truncation_reason,
    row_limit,
    byte_limit,
    bytes_read,
  })
}

fn flush_full_batch(
  rows: &mut Vec<QueryRow>,
  batch_size: usize,
  batch_count: &mut usize,
  row_count: usize,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), String> + Send),
) -> Result<(), String> {
  if rows.len() < batch_size.max(1) {
    return Ok(());
  }
  send_batch(rows, batch_count, row_count, sink)
}

fn flush_remaining_batch(
  rows: &mut Vec<QueryRow>,
  batch_count: &mut usize,
  row_count: usize,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), String> + Send),
) -> Result<(), String> {
  if rows.is_empty() {
    return Ok(());
  }
  send_batch(rows, batch_count, row_count, sink)
}

fn send_batch(
  rows: &mut Vec<QueryRow>,
  batch_count: &mut usize,
  row_count: usize,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), String> + Send),
) -> Result<(), String> {
  let batch_rows = std::mem::take(rows);
  let offset = row_count - batch_rows.len();
  sink(QueryResultBatch { index: *batch_count, offset, rows: batch_rows })?;
  *batch_count += 1;
  Ok(())
}

fn serialized_row_size(row: &QueryRow) -> Result<usize, String> {
  serde_json::to_vec(row).map(|bytes| bytes.len()).map_err(|error| error.to_string())
}

fn summary_with_rows(
  summary: QueryExecutionSummary,
  rows: Vec<QueryRow>,
) -> Result<QueryExecutionResult, String> {
  match summary {
    QueryExecutionSummary::Rows {
      columns,
      truncated,
      truncation_reason,
      row_limit,
      byte_limit,
      bytes_read,
      ..
    } => Ok(QueryExecutionResult::Rows {
      columns,
      rows,
      truncated,
      truncation_reason,
      row_limit,
      byte_limit,
      bytes_read,
    }),
    QueryExecutionSummary::Affected { rows_affected } => {
      Ok(QueryExecutionResult::Affected { rows_affected })
    }
  }
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
      QueryExecutionResult::Rows { columns, rows, truncated, row_limit, .. } => {
        assert_eq!(columns, vec!["value"]);
        assert!(rows.is_empty());
        assert!(!truncated);
        assert_eq!(row_limit, DEFAULT_QUERY_ROW_LIMIT);
      }
      QueryExecutionResult::Affected { .. } => panic!("expected a row result"),
    }
  }

  #[tokio::test]
  async fn stops_fetching_after_the_configured_row_limit() {
    let pool = SqlitePoolOptions::new()
      .max_connections(1)
      .connect("sqlite::memory:")
      .await
      .expect("connect to SQLite");
    let result = execute_query_with_limit(
      &DbPool::Sqlite(pool),
      "SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3",
      2,
    )
    .await
    .expect("execute limited query");

    match result {
      QueryExecutionResult::Rows { rows, truncated, row_limit, .. } => {
        assert_eq!(rows.len(), 2);
        assert!(truncated);
        assert_eq!(row_limit, 2);
      }
      QueryExecutionResult::Affected { .. } => panic!("expected a row result"),
    }
  }

  #[tokio::test]
  async fn streams_ordered_result_batches() {
    let pool = SqlitePoolOptions::new()
      .max_connections(1)
      .connect("sqlite::memory:")
      .await
      .expect("connect to SQLite");
    let mut connection = pool.acquire().await.expect("acquire SQLite connection");
    let mut batches = Vec::new();
    let summary = execute_sqlite_connection_streaming(
      &mut connection,
      "SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5",
      5,
      DEFAULT_QUERY_BYTE_LIMIT,
      2,
      &mut |batch| {
        batches.push(batch);
        Ok(())
      },
    )
    .await
    .expect("stream rows");

    match summary {
      QueryExecutionSummary::Rows { row_count, batch_count, truncated, .. } => {
        assert_eq!(row_count, 5);
        assert_eq!(batch_count, 3);
        assert!(!truncated);
      }
      QueryExecutionSummary::Affected { .. } => panic!("expected rows"),
    }
    assert_eq!(batches.iter().map(|batch| batch.offset).collect::<Vec<_>>(), vec![0, 2, 4]);
    assert_eq!(batches.iter().map(|batch| batch.rows.len()).collect::<Vec<_>>(), vec![2, 2, 1]);
  }

  #[tokio::test]
  async fn stops_streaming_before_exceeding_the_byte_budget() {
    let pool = SqlitePoolOptions::new()
      .max_connections(1)
      .connect("sqlite::memory:")
      .await
      .expect("connect to SQLite");
    let mut connection = pool.acquire().await.expect("acquire SQLite connection");
    let mut batches = Vec::new();
    let summary = execute_sqlite_connection_streaming(
      &mut connection,
      "SELECT 'a value larger than the budget' AS value",
      100,
      1,
      10,
      &mut |batch| {
        batches.push(batch);
        Ok(())
      },
    )
    .await
    .expect("enforce byte budget");

    match summary {
      QueryExecutionSummary::Rows {
        row_count, truncated, truncation_reason, bytes_read, ..
      } => {
        assert_eq!(row_count, 0);
        assert!(truncated);
        assert_eq!(truncation_reason, Some(QueryTruncationReason::ByteLimit));
        assert_eq!(bytes_read, 0);
      }
      QueryExecutionSummary::Affected { .. } => panic!("expected rows"),
    }
    assert!(batches.is_empty());
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
      QueryExecutionResult::Rows { columns, rows, .. } => {
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
