use crate::services::{
  QueryError, QueryExecutionResult, QueryExecutionSummary, QueryResultBatch, SessionConnection,
  StreamOptions, QUERY_TIMEOUT_CODE,
};
use std::{collections::HashMap, sync::Arc};
use tauri_plugin_sql::DbPool;
use tokio::{
  sync::Mutex,
  time::{timeout, Duration},
};

struct SessionEntry {
  pool_key: String,
  connection: Mutex<SessionConnection>,
}

#[derive(Default)]
pub struct QuerySessionState {
  sessions: Mutex<HashMap<String, Arc<SessionEntry>>>,
}

pub struct StreamingQueryOptions<'a> {
  pub session_id: &'a str,
  pub pool_key: &'a str,
  pub pool: &'a DbPool,
  pub sql: &'a str,
  pub row_limit: usize,
  pub byte_limit: usize,
  pub batch_size: usize,
  pub timeout_duration: Duration,
}

impl QuerySessionState {
  pub async fn execute(
    &self,
    session_id: &str,
    pool_key: &str,
    pool: &DbPool,
    sql: &str,
    row_limit: usize,
    timeout_duration: Duration,
  ) -> Result<QueryExecutionResult, QueryError> {
    if session_id.trim().is_empty() {
      return Err(QueryError::message("数据库 Session ID 不能为空"));
    }

    let entry = self.get_or_create(session_id, pool_key, pool).await?;
    if entry.pool_key != pool_key {
      return Err(QueryError::message("数据库 Session 已绑定到其他连接"));
    }

    timeout(timeout_duration, async {
      let mut connection = entry.connection.lock().await;
      connection.execute(sql, row_limit).await
    })
    .await
    .map_err(|_| {
      QueryError::with_code(
        QUERY_TIMEOUT_CODE,
        format!("查询执行超过 {} 毫秒", timeout_duration.as_millis()),
      )
    })?
  }

  pub async fn release(&self, session_id: &str) -> bool {
    self.sessions.lock().await.remove(session_id).is_some()
  }

  pub async fn execute_streaming(
    &self,
    options: StreamingQueryOptions<'_>,
    sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
  ) -> Result<QueryExecutionSummary, QueryError> {
    if options.session_id.trim().is_empty() {
      return Err(QueryError::message("数据库 Session ID 不能为空"));
    }

    let entry = self.get_or_create(options.session_id, options.pool_key, options.pool).await?;
    if entry.pool_key != options.pool_key {
      return Err(QueryError::message("数据库 Session 已绑定到其他连接"));
    }

    timeout(options.timeout_duration, async {
      let mut connection = entry.connection.lock().await;
      connection
        .execute_streaming(
          options.sql,
          StreamOptions::limited(options.row_limit, options.byte_limit, options.batch_size),
          sink,
        )
        .await
    })
    .await
    .map_err(|_| {
      QueryError::with_code(
        QUERY_TIMEOUT_CODE,
        format!("查询执行超过 {} 毫秒", options.timeout_duration.as_millis()),
      )
    })?
  }

  async fn get_or_create(
    &self,
    session_id: &str,
    pool_key: &str,
    pool: &DbPool,
  ) -> Result<Arc<SessionEntry>, QueryError> {
    if let Some(entry) = self.sessions.lock().await.get(session_id).cloned() {
      return Ok(entry);
    }

    let connection = SessionConnection::acquire(pool).await?;
    let entry =
      Arc::new(SessionEntry { pool_key: pool_key.to_string(), connection: Mutex::new(connection) });
    let mut sessions = self.sessions.lock().await;
    Ok(sessions.entry(session_id.to_string()).or_insert_with(|| entry.clone()).clone())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use sqlx::sqlite::SqlitePoolOptions;

  #[tokio::test]
  async fn keeps_transaction_statements_on_the_same_sqlite_connection() {
    let pool = SqlitePoolOptions::new()
      .max_connections(2)
      .connect("sqlite::memory:")
      .await
      .expect("connect to SQLite");
    let db_pool = DbPool::Sqlite(pool);
    let sessions = QuerySessionState::default();
    let timeout = Duration::from_secs(1);

    sessions
      .execute(
        "session-1",
        "sqlite::memory:",
        &db_pool,
        "CREATE TEMP TABLE transaction_test (value TEXT NOT NULL)",
        100,
        timeout,
      )
      .await
      .expect("create temporary table");
    sessions
      .execute("session-1", "sqlite::memory:", &db_pool, "BEGIN", 100, timeout)
      .await
      .expect("begin transaction");
    sessions
      .execute(
        "session-1",
        "sqlite::memory:",
        &db_pool,
        "INSERT INTO transaction_test (value) VALUES ('pending')",
        100,
        timeout,
      )
      .await
      .expect("insert inside transaction");

    let result = sessions
      .execute(
        "session-1",
        "sqlite::memory:",
        &db_pool,
        "SELECT value FROM transaction_test",
        100,
        timeout,
      )
      .await
      .expect("read inside transaction");
    match result {
      QueryExecutionResult::Rows { rows, .. } => assert_eq!(rows.len(), 1),
      QueryExecutionResult::Affected { .. } => panic!("expected rows"),
    }

    sessions
      .execute("session-1", "sqlite::memory:", &db_pool, "ROLLBACK", 100, timeout)
      .await
      .expect("rollback transaction");
    let result = sessions
      .execute(
        "session-1",
        "sqlite::memory:",
        &db_pool,
        "SELECT value FROM transaction_test",
        100,
        timeout,
      )
      .await
      .expect("read after rollback");
    match result {
      QueryExecutionResult::Rows { rows, .. } => assert!(rows.is_empty()),
      QueryExecutionResult::Affected { .. } => panic!("expected rows"),
    }

    assert!(sessions.release("session-1").await);
    assert!(!sessions.release("session-1").await);
  }

  #[tokio::test]
  async fn rejects_reusing_a_session_for_another_pool() {
    let pool = DbPool::Sqlite(
      SqlitePoolOptions::new().connect("sqlite::memory:").await.expect("connect to SQLite"),
    );
    let sessions = QuerySessionState::default();

    sessions
      .execute("session-1", "pool-1", &pool, "SELECT 1", 100, Duration::from_secs(1))
      .await
      .expect("bind session");
    let error = sessions
      .execute("session-1", "pool-2", &pool, "SELECT 1", 100, Duration::from_secs(1))
      .await
      .expect_err("reject another pool");

    assert_eq!(error.message, "数据库 Session 已绑定到其他连接");
  }
}
