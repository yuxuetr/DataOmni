use chrono::{DateTime, Utc};
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

pub use crate::services::query_error::{QueryError, QUERY_TIMEOUT_CODE};
pub const DEFAULT_QUERY_ROW_LIMIT: usize = 1_000;
pub const DEFAULT_QUERY_BATCH_SIZE: usize = 250;
pub const DEFAULT_QUERY_BYTE_LIMIT: usize = 16 * 1024 * 1024;

pub type QueryRow = Map<String, JsonValue>;

#[derive(Debug, Clone, Serialize)]
pub struct QueryColumnMetadata {
  pub name: String,
  pub ordinal: usize,
  pub database_type: String,
  pub logical_type: String,
  pub nullable: Option<bool>,
}

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
    column_metadata: Vec<QueryColumnMetadata>,
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
    column_metadata: Vec<QueryColumnMetadata>,
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

pub async fn execute_query(pool: &DbPool, sql: &str) -> Result<QueryExecutionResult, QueryError> {
  execute_query_with_limit(pool, sql, DEFAULT_QUERY_ROW_LIMIT).await
}

pub async fn execute_query_with_limit(
  pool: &DbPool,
  sql: &str,
  row_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  execute_query_with_limits(pool, sql, row_limit, DEFAULT_QUERY_BYTE_LIMIT).await
}

pub async fn execute_query_with_limits(
  pool: &DbPool,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
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
  pub async fn acquire(pool: &DbPool) -> Result<Self, QueryError> {
    match pool {
      DbPool::Sqlite(pool) => pool.acquire().await.map(Self::Sqlite).map_err(display_error),
      DbPool::MySql(pool) => pool.acquire().await.map(Self::MySql).map_err(display_error),
      DbPool::Postgres(pool) => pool.acquire().await.map(Self::Postgres).map_err(display_error),
    }
  }

  pub async fn execute(
    &mut self,
    sql: &str,
    row_limit: usize,
  ) -> Result<QueryExecutionResult, QueryError> {
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
    sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
  ) -> Result<QueryExecutionSummary, QueryError> {
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
) -> Result<QueryExecutionResult, QueryError> {
  with_timeout(execute_query(pool, sql), timeout_duration).await
}

async fn with_timeout<F, T>(future: F, timeout_duration: Duration) -> Result<T, QueryError>
where
  F: Future<Output = Result<T, QueryError>>,
{
  timeout(timeout_duration, future).await.map_err(|_| {
    QueryError::with_code(
      QUERY_TIMEOUT_CODE,
      format!("查询执行超过 {} 毫秒", timeout_duration.as_millis()),
    )
  })?
}

async fn execute_sqlite(
  pool: &Pool<Sqlite>,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  let mut connection = pool.acquire().await.map_err(QueryError::from)?;
  execute_sqlite_connection_with_limits(&mut connection, sql, row_limit, byte_limit).await
}

async fn execute_sqlite_connection(
  connection: &mut SqliteConnection,
  sql: &str,
  row_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  execute_sqlite_connection_with_limits(connection, sql, row_limit, DEFAULT_QUERY_BYTE_LIMIT).await
}

async fn execute_sqlite_connection_with_limits(
  connection: &mut SqliteConnection,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
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
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
) -> Result<QueryExecutionSummary, QueryError> {
  if is_transaction_control_statement(sql) {
    let result = (&mut *connection).execute(sql).await.map_err(QueryError::from)?;
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
  }

  let description = (&mut *connection).describe(sql).await.map_err(QueryError::from)?;
  let column_metadata = description
    .columns()
    .iter()
    .enumerate()
    .map(|(ordinal, column)| QueryColumnMetadata {
      name: column.name().to_string(),
      ordinal,
      database_type: column.type_info().name().to_string(),
      logical_type: sqlite_logical_type(column.type_info().name()).to_string(),
      nullable: description.nullable(ordinal),
    })
    .collect::<Vec<_>>();
  let columns = column_metadata.iter().map(|column| column.name.clone()).collect::<Vec<_>>();

  if columns.is_empty() {
    let result = (&mut *connection).execute(sql).await.map_err(QueryError::from)?;
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
  }

  let mut stream = (&mut *connection).fetch(sqlx::query(sql));
  let mut rows = Vec::with_capacity(batch_size);
  let mut row_count = 0;
  let mut batch_count = 0;
  let mut bytes_read: usize = 0;
  let mut truncation_reason = None;
  while row_count < row_limit {
    let Some(row) = stream.try_next().await.map_err(QueryError::from)? else {
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
    && stream.try_next().await.map_err(QueryError::from)?.is_some()
  {
    truncation_reason = Some(QueryTruncationReason::RowLimit);
  }
  flush_remaining_batch(&mut rows, &mut batch_count, row_count, sink)?;
  Ok(QueryExecutionSummary::Rows {
    columns,
    column_metadata,
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
) -> Result<QueryExecutionResult, QueryError> {
  let mut connection = pool.acquire().await.map_err(QueryError::from)?;
  execute_mysql_connection_with_limits(&mut connection, sql, row_limit, byte_limit).await
}

async fn execute_mysql_connection(
  connection: &mut MySqlConnection,
  sql: &str,
  row_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  execute_mysql_connection_with_limits(connection, sql, row_limit, DEFAULT_QUERY_BYTE_LIMIT).await
}

async fn execute_mysql_connection_with_limits(
  connection: &mut MySqlConnection,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
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
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
) -> Result<QueryExecutionSummary, QueryError> {
  if is_transaction_control_statement(sql) {
    let result = (&mut *connection).execute(sql).await.map_err(QueryError::from)?;
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
  }

  let description = (&mut *connection).describe(sql).await.map_err(QueryError::from)?;
  let column_metadata = description
    .columns()
    .iter()
    .enumerate()
    .map(|(ordinal, column)| QueryColumnMetadata {
      name: column.name().to_string(),
      ordinal,
      database_type: column.type_info().name().to_string(),
      logical_type: mysql_logical_type(column.type_info().name()).to_string(),
      nullable: description.nullable(ordinal),
    })
    .collect::<Vec<_>>();
  let columns = column_metadata.iter().map(|column| column.name.clone()).collect::<Vec<_>>();

  if columns.is_empty() {
    let result = (&mut *connection).execute(sql).await.map_err(QueryError::from)?;
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
  }

  let mut stream = (&mut *connection).fetch(sqlx::query(sql));
  let mut rows = Vec::with_capacity(batch_size);
  let mut row_count = 0;
  let mut batch_count = 0;
  let mut bytes_read: usize = 0;
  let mut truncation_reason = None;
  while row_count < row_limit {
    let Some(row) = stream.try_next().await.map_err(QueryError::from)? else {
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
    && stream.try_next().await.map_err(QueryError::from)?.is_some()
  {
    truncation_reason = Some(QueryTruncationReason::RowLimit);
  }
  flush_remaining_batch(&mut rows, &mut batch_count, row_count, sink)?;
  Ok(QueryExecutionSummary::Rows {
    columns,
    column_metadata,
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
) -> Result<QueryExecutionResult, QueryError> {
  let mut connection = pool.acquire().await.map_err(QueryError::from)?;
  execute_postgres_connection_with_limits(&mut connection, sql, row_limit, byte_limit).await
}

async fn execute_postgres_connection(
  connection: &mut PgConnection,
  sql: &str,
  row_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
  execute_postgres_connection_with_limits(connection, sql, row_limit, DEFAULT_QUERY_BYTE_LIMIT)
    .await
}

async fn execute_postgres_connection_with_limits(
  connection: &mut PgConnection,
  sql: &str,
  row_limit: usize,
  byte_limit: usize,
) -> Result<QueryExecutionResult, QueryError> {
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
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
) -> Result<QueryExecutionSummary, QueryError> {
  if is_transaction_control_statement(sql) {
    let result = (&mut *connection).execute(sql).await.map_err(QueryError::from)?;
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
  }

  let description = (&mut *connection).describe(sql).await.map_err(QueryError::from)?;
  let column_metadata = description
    .columns()
    .iter()
    .enumerate()
    .map(|(ordinal, column)| QueryColumnMetadata {
      name: column.name().to_string(),
      ordinal,
      database_type: column.type_info().name().to_string(),
      logical_type: postgres_logical_type(column.type_info().name()).to_string(),
      nullable: description.nullable(ordinal),
    })
    .collect::<Vec<_>>();
  let columns = column_metadata.iter().map(|column| column.name.clone()).collect::<Vec<_>>();

  if columns.is_empty() {
    let result = (&mut *connection).execute(sql).await.map_err(QueryError::from)?;
    return Ok(QueryExecutionSummary::Affected { rows_affected: result.rows_affected() });
  }

  let mut stream = (&mut *connection).fetch(sqlx::query(sql));
  let mut rows = Vec::with_capacity(batch_size);
  let mut row_count = 0;
  let mut batch_count = 0;
  let mut bytes_read: usize = 0;
  let mut truncation_reason = None;
  while row_count < row_limit {
    let Some(row) = stream.try_next().await.map_err(QueryError::from)? else {
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
    && stream.try_next().await.map_err(QueryError::from)?.is_some()
  {
    truncation_reason = Some(QueryTruncationReason::RowLimit);
  }
  flush_remaining_batch(&mut rows, &mut batch_count, row_count, sink)?;
  Ok(QueryExecutionSummary::Rows {
    columns,
    column_metadata,
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
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
) -> Result<(), QueryError> {
  if rows.len() < batch_size.max(1) {
    return Ok(());
  }
  send_batch(rows, batch_count, row_count, sink)
}

fn flush_remaining_batch(
  rows: &mut Vec<QueryRow>,
  batch_count: &mut usize,
  row_count: usize,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
) -> Result<(), QueryError> {
  if rows.is_empty() {
    return Ok(());
  }
  send_batch(rows, batch_count, row_count, sink)
}

fn send_batch(
  rows: &mut Vec<QueryRow>,
  batch_count: &mut usize,
  row_count: usize,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
) -> Result<(), QueryError> {
  let batch_rows = std::mem::take(rows);
  let offset = row_count - batch_rows.len();
  sink(QueryResultBatch { index: *batch_count, offset, rows: batch_rows })?;
  *batch_count += 1;
  Ok(())
}

fn serialized_row_size(row: &QueryRow) -> Result<usize, QueryError> {
  serde_json::to_vec(row).map(|bytes| bytes.len()).map_err(display_error)
}

fn sqlite_logical_type(database_type: &str) -> &'static str {
  match database_type {
    "BOOLEAN" => "boolean",
    "INTEGER" => "integer",
    "REAL" | "NUMERIC" => "decimal",
    "BLOB" => "binary",
    "DATE" => "date",
    "TIME" => "time",
    "DATETIME" => "datetime",
    "TEXT" => "text",
    _ => "unknown",
  }
}

fn mysql_logical_type(database_type: &str) -> &'static str {
  match database_type {
    "BOOLEAN" => "boolean",
    "TINYINT" | "SMALLINT" | "INT" | "MEDIUMINT" | "BIGINT" | "TINYINT UNSIGNED"
    | "SMALLINT UNSIGNED" | "INT UNSIGNED" | "MEDIUMINT UNSIGNED" | "BIGINT UNSIGNED" | "YEAR" => {
      "integer"
    }
    "DECIMAL" | "FLOAT" | "DOUBLE" => "decimal",
    "TINYBLOB" | "MEDIUMBLOB" | "BLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" => "binary",
    "DATE" => "date",
    "TIME" => "time",
    "DATETIME" | "TIMESTAMP" => "datetime",
    "JSON" => "json",
    "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => "text",
    "BIT" => "integer",
    "GEOMETRY" => "binary",
    _ => "unknown",
  }
}

fn postgres_logical_type(database_type: &str) -> &'static str {
  match database_type {
    "BOOL" => "boolean",
    "INT2" | "INT4" | "INT8" => "integer",
    "NUMERIC" | "FLOAT4" | "FLOAT8" => "decimal",
    "BYTEA" => "binary",
    "INTERVAL" => "time",
    "TEXT[]" | "VARCHAR[]" | "NAME[]" | "INT2[]" | "INT4[]" | "INT8[]" => "unknown",
    "DATE" => "date",
    "TIME" | "TIMETZ" => "time",
    "TIMESTAMP" | "TIMESTAMPTZ" => "datetime",
    "JSON" | "JSONB" => "json",
    "CHAR" | "VARCHAR" | "TEXT" | "NAME" | "UUID" => "text",
    _ => "unknown",
  }
}

fn summary_with_rows(
  summary: QueryExecutionSummary,
  rows: Vec<QueryRow>,
) -> Result<QueryExecutionResult, QueryError> {
  match summary {
    QueryExecutionSummary::Rows {
      columns,
      column_metadata,
      truncated,
      truncation_reason,
      row_limit,
      byte_limit,
      bytes_read,
      ..
    } => Ok(QueryExecutionResult::Rows {
      columns,
      column_metadata,
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

fn decode_sqlite_row(row: &SqliteRow) -> Result<Map<String, JsonValue>, QueryError> {
  let mut values = Map::new();
  for (index, column) in row.columns().iter().enumerate() {
    let value = row.try_get_raw(index).map_err(QueryError::from)?;
    let decoded = decode_sqlite(value).map_err(|error| {
      format!("SQLite 列 {} ({}) 解码失败: {error}", column.name(), column.type_info().name())
    })?;
    values.insert(column.name().to_string(), decoded);
  }
  Ok(values)
}

fn decode_mysql_row(row: &MySqlRow) -> Result<Map<String, JsonValue>, QueryError> {
  let mut values = Map::new();
  for (index, column) in row.columns().iter().enumerate() {
    let value = row.try_get_raw(index).map_err(QueryError::from)?;
    let decoded = decode_mysql(value).map_err(|error| {
      format!("MySQL 列 {} ({}) 解码失败: {error}", column.name(), column.type_info().name())
    })?;
    values.insert(column.name().to_string(), decoded);
  }
  Ok(values)
}

fn decode_postgres_row(row: &PgRow) -> Result<Map<String, JsonValue>, QueryError> {
  let mut values = Map::new();
  for (index, column) in row.columns().iter().enumerate() {
    let value = row.try_get_raw(index).map_err(QueryError::from)?;
    let decoded = decode_postgres(value).map_err(|error| {
      format!("PostgreSQL 列 {} ({}) 解码失败: {error}", column.name(), column.type_info().name())
    })?;
    values.insert(column.name().to_string(), decoded);
  }
  Ok(values)
}

fn decode_sqlite(value: SqliteValueRef<'_>) -> Result<JsonValue, QueryError> {
  if value.is_null() {
    return Ok(JsonValue::Null);
  }

  match value.type_info().name() {
    "TEXT" => json_value(ValueRef::to_owned(&value).try_decode::<String>()),
    "INTEGER" | "NUMERIC" => {
      tagged_display_value("bigint", ValueRef::to_owned(&value).try_decode::<i64>())
    }
    "REAL" => json_value(ValueRef::to_owned(&value).try_decode::<f64>()),
    "BOOLEAN" => json_value(ValueRef::to_owned(&value).try_decode::<bool>()),
    "DATE" => tagged_display_value("date", ValueRef::to_owned(&value).try_decode::<Date>()),
    "TIME" => tagged_display_value("time", ValueRef::to_owned(&value).try_decode::<Time>()),
    "DATETIME" => {
      tagged_display_value("datetime", ValueRef::to_owned(&value).try_decode::<PrimitiveDateTime>())
    }
    "BLOB" => tagged_binary_value(ValueRef::to_owned(&value).try_decode::<Vec<u8>>()),
    "NULL" => Ok(JsonValue::Null),
    type_name => Err(QueryError::message(format!("不支持的 SQLite 数据类型: {type_name}"))),
  }
}

fn decode_mysql(value: MySqlValueRef<'_>) -> Result<JsonValue, QueryError> {
  if value.is_null() {
    return Ok(JsonValue::Null);
  }

  let type_info = value.type_info();
  let type_name = type_info.name();
  match type_name {
    "JSON" => tagged_json_value(ValueRef::to_owned(&value).try_decode::<JsonValue>()),
    "DECIMAL" => tagged_display_value(
      "decimal",
      ValueRef::to_owned(&value).try_decode::<sqlx::types::BigDecimal>(),
    ),
    "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "INT UNSIGNED" | "MEDIUMINT UNSIGNED"
    | "BIGINT UNSIGNED" | "YEAR" => {
      tagged_display_value("bigint", ValueRef::to_owned(&value).try_decode::<u64>())
    }
    "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
      json_value(ValueRef::to_owned(&value).try_decode::<String>())
    }
    // BIT(n) 按无符号整数取值，保持精确；BIT(64) 仍在 u64 范围内
    "BIT" => tagged_display_value("bigint", ValueRef::to_owned(&value).try_decode::<u64>()),
    "TINYINT" | "SMALLINT" | "INT" | "MEDIUMINT" | "BIGINT" => {
      tagged_display_value("bigint", ValueRef::to_owned(&value).try_decode::<i64>())
    }
    "FLOAT" => json_value(ValueRef::to_owned(&value).try_decode::<f32>()),
    "DOUBLE" => json_value(ValueRef::to_owned(&value).try_decode::<f64>()),
    "BOOLEAN" => json_value(ValueRef::to_owned(&value).try_decode::<bool>()),
    "DATE" => tagged_display_value("date", ValueRef::to_owned(&value).try_decode::<Date>()),
    // MySQL 的 TIME 是时长而非时刻（-838:59:59 ~ 838:59:59），装不进 time::Time
    "TIME" => {
      let duration =
        ValueRef::to_owned(&value).try_decode::<time::Duration>().map_err(QueryError::from)?;
      Ok(tagged_value("time", format_mysql_time(duration)))
    }
    "DATETIME" => {
      tagged_display_value("datetime", ValueRef::to_owned(&value).try_decode::<PrimitiveDateTime>())
    }
    "TIMESTAMP" => {
      tagged_display_value("datetime", ValueRef::to_owned(&value).try_decode::<OffsetDateTime>())
    }
    "TINYBLOB" | "MEDIUMBLOB" | "BLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" | "GEOMETRY" => {
      tagged_binary_value(ValueRef::to_owned(&value).try_decode::<Vec<u8>>())
    }
    "NULL" => Ok(JsonValue::Null),
    _ => Err(QueryError::message(format!("不支持的 MySQL 数据类型: {type_name}"))),
  }
}

fn decode_postgres(value: PgValueRef<'_>) -> Result<JsonValue, QueryError> {
  if value.is_null() {
    return Ok(JsonValue::Null);
  }

  let type_info = value.type_info();
  let type_name = type_info.name();
  match type_name {
    "INT2" => json_value(ValueRef::to_owned(&value).try_decode::<i16>()),
    "INT4" => json_value(ValueRef::to_owned(&value).try_decode::<i32>()),
    "JSON" | "JSONB" => tagged_json_value(ValueRef::to_owned(&value).try_decode::<JsonValue>()),
    "CHAR" | "VARCHAR" | "TEXT" | "NAME" => {
      json_value(ValueRef::to_owned(&value).try_decode::<String>())
    }
    // UUID 此前与字符串共用分支，但 sqlx 不允许把 UUID 解成 String，
    // 任何 uuid 列都会报 mismatched types
    "UUID" => tagged_display_value("text", ValueRef::to_owned(&value).try_decode::<uuid::Uuid>()),
    "INT8" => tagged_display_value("bigint", ValueRef::to_owned(&value).try_decode::<i64>()),
    "NUMERIC" => tagged_display_value(
      "decimal",
      ValueRef::to_owned(&value).try_decode::<sqlx::types::BigDecimal>(),
    ),
    "FLOAT4" => json_value(ValueRef::to_owned(&value).try_decode::<f32>()),
    "FLOAT8" => json_value(ValueRef::to_owned(&value).try_decode::<f64>()),
    "BOOL" => json_value(ValueRef::to_owned(&value).try_decode::<bool>()),
    "DATE" => tagged_display_value("date", ValueRef::to_owned(&value).try_decode::<Date>()),
    "TIME" => tagged_display_value("time", ValueRef::to_owned(&value).try_decode::<Time>()),
    "TIMESTAMP" => {
      tagged_display_value("datetime", ValueRef::to_owned(&value).try_decode::<PrimitiveDateTime>())
    }
    "TIMESTAMPTZ" => {
      let value =
        ValueRef::to_owned(&value).try_decode::<DateTime<Utc>>().map_err(QueryError::from)?;
      Ok(tagged_value("datetime", value.to_rfc3339()))
    }
    "BYTEA" => tagged_binary_value(ValueRef::to_owned(&value).try_decode::<Vec<u8>>()),
    "TEXT[]" | "VARCHAR[]" | "NAME[]" => {
      json_value(ValueRef::to_owned(&value).try_decode::<Vec<String>>())
    }
    "INT2[]" => json_value(ValueRef::to_owned(&value).try_decode::<Vec<i16>>()),
    "INT4[]" => json_value(ValueRef::to_owned(&value).try_decode::<Vec<i32>>()),
    "INT8[]" => json_value(ValueRef::to_owned(&value).try_decode::<Vec<i64>>()),
    "INTERVAL" => {
      let interval = ValueRef::to_owned(&value)
        .try_decode::<sqlx::postgres::types::PgInterval>()
        .map_err(QueryError::from)?;
      Ok(tagged_value("time", format_pg_interval(&interval)))
    }
    "VOID" => Ok(JsonValue::Null),
    _ => Err(QueryError::message(format!("不支持的 PostgreSQL 数据类型: {type_name}"))),
  }
}

/// MySQL 的 TIME 是带符号时长，按它自己的 `[-]HH:MM:SS` 文本形式呈现。
fn format_mysql_time(duration: time::Duration) -> String {
  let sign = if duration.is_negative() { "-" } else { "" };
  let total = duration.abs();
  let hours = total.whole_hours();
  let minutes = total.whole_minutes() % 60;
  let seconds = total.whole_seconds() % 60;
  format!("{sign}{hours:02}:{minutes:02}:{seconds:02}")
}

/// PostgreSQL 的 interval 由「月 / 日 / 微秒」三段组成，没有统一的标量表示，
/// 这里按 PostgreSQL 自己的文本形式拼回去。
fn format_pg_interval(interval: &sqlx::postgres::types::PgInterval) -> String {
  let mut parts = Vec::new();
  if interval.months != 0 {
    parts.push(format!("{} mons", interval.months));
  }
  if interval.days != 0 {
    parts.push(format!("{} days", interval.days));
  }
  if interval.microseconds != 0 || parts.is_empty() {
    let total_seconds = interval.microseconds as f64 / 1_000_000.0;
    parts.push(format!("{total_seconds} secs"));
  }
  parts.join(" ")
}

fn json_value<T, E>(value: Result<T, E>) -> Result<JsonValue, QueryError>
where
  T: Serialize,
  E: std::fmt::Display,
{
  let decoded = value.map_err(display_error)?;
  serde_json::to_value(decoded).map_err(display_error)
}

fn tagged_display_value<T, E>(
  value_type: &str,
  value: Result<T, E>,
) -> Result<JsonValue, QueryError>
where
  T: std::fmt::Display,
  E: std::fmt::Display,
{
  value.map(|value| tagged_value(value_type, value.to_string())).map_err(display_error)
}

fn tagged_json_value<E>(value: Result<JsonValue, E>) -> Result<JsonValue, QueryError>
where
  E: std::fmt::Display,
{
  let value = value.map_err(display_error)?;
  let serialized = serde_json::to_string(&value).map_err(display_error)?;
  Ok(tagged_value("json", serialized))
}

fn tagged_binary_value<E>(value: Result<Vec<u8>, E>) -> Result<JsonValue, QueryError>
where
  E: std::fmt::Display,
{
  value
    .map(|bytes| {
      let encoded = bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
      tagged_value("binary", encoded)
    })
    .map_err(display_error)
}

/// 解码失败、序列化失败这类：错误来自我们这一侧，没有数据库给的结构可取，
/// 只留一句话。和 `QueryError::from(sqlx::Error)` 分开是为了不把
/// 「数据库说的」和「我们说的」混成一种东西。
fn display_error(error: impl std::fmt::Display) -> QueryError {
  QueryError::message(error.to_string())
}

fn tagged_value(value_type: &str, value: String) -> JsonValue {
  JsonValue::Object(Map::from_iter([
    ("type".to_string(), JsonValue::String(value_type.to_string())),
    ("value".to_string(), JsonValue::String(value)),
  ]))
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

  #[test]
  fn maps_driver_types_to_logical_types() {
    assert_eq!(sqlite_logical_type("INTEGER"), "integer");
    assert_eq!(sqlite_logical_type("BLOB"), "binary");
    assert_eq!(mysql_logical_type("DECIMAL"), "decimal");
    assert_eq!(mysql_logical_type("JSON"), "json");
    assert_eq!(postgres_logical_type("TIMESTAMPTZ"), "datetime");
    assert_eq!(postgres_logical_type("UUID"), "text");
    assert_eq!(postgres_logical_type("CUSTOM"), "unknown");
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
        Ok::<(), QueryError>(())
      },
      Duration::from_millis(1),
    )
    .await;

    let error = error.expect_err("pending query should time out");
    // 码单独成一个字段，不再拼在消息前缀里：消息是要翻译的，
    // 按前缀匹配等于把「这是超时」的判断绑在某一种语言上
    assert_eq!(error.code.as_deref(), Some(QUERY_TIMEOUT_CODE));
    assert_eq!(error.message, "查询执行超过 1 毫秒");
  }
}
