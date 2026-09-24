use crate::services::query_executor::PoolRef;
use crate::services::query_executor::QUERY_TIMEOUT;
use crate::services::{
  transaction_state::TransactionState, QueryError, QueryExecutionResult, QueryExecutionSummary,
  QueryResultBatch, SessionConnection, StreamOptions, QUERY_TIMEOUT_CODE,
};
use std::{collections::HashMap, sync::Arc};
use tauri_plugin_sql::DbPool;
use tokio::{
  sync::Mutex,
  time::{timeout, Duration},
};

/// 这两条都是前端传错了参数，用户无从下手，但也不该看见中文
pub const SESSION_ID_EMPTY: &str = "DATAOMNI_SESSION_ID_EMPTY";
pub const SESSION_BOUND_ELSEWHERE: &str = "DATAOMNI_SESSION_BOUND_ELSEWHERE";

/// 连接和它的事务状态必须一起锁。
///
/// 分成两把锁，就可能读到「语句已经 COMMIT 了、状态还写着事务中」的中间态，
/// 而状态栏正是靠这个值决定要不要在关标签页时拦一下。
struct SessionRuntime {
  connection: SessionConnection,
  transaction: TransactionState,
  last_used: std::time::Instant,
}

/// 会话连接空闲超过这么久，下一条语句之前先问一句它还在不在。
/// 比常见的 NAT / VPN 空闲回收（几分钟）短，又长到连着敲语句时不会每条都多一次往返
const REVALIDATE_AFTER: Duration = Duration::from_secs(60);
/// 活着的连接 ping 一次是一个往返；三秒还没回，当它死了
const PING_LIMIT: Duration = Duration::from_secs(3);

/// 要不要先确认连接还活着。事务里不换：连接真断了，事务也已经没了，
/// 换一条新的接着跑等于假装它还在——让那条语句照常失败、报出来
fn should_revalidate(idle: Duration, in_transaction: bool) -> bool {
  !in_transaction && idle >= REVALIDATE_AFTER
}

struct SessionEntry {
  pool_key: String,
  runtime: Mutex<SessionRuntime>,
}

impl SessionRuntime {
  /// 关掉自动提交时，不在事务里就先开一个。
  ///
  /// 只在语句本身与事务无关时补：用户自己写的 `BEGIN` 不需要前面再来一条，
  /// 而在 `COMMIT` 前面补一条 `BEGIN` 是开一个立刻提交的空事务。
  async fn begin_if_needed(&mut self, autocommit: bool, sql: &str) -> Result<(), QueryError> {
    self.connection.set_autocommit(autocommit);
    if autocommit
      || self.current_transaction().in_transaction()
      || self.connection.controls_transaction(sql)
    {
      return Ok(());
    }
    let Some(begin) = self.connection.begin_statement() else {
      return Ok(());
    };
    self.connection.execute(begin, 1).await?;
    self.record(begin, true);
    Ok(())
  }

  /// 服务端报得出就用服务端的，否则用从语句推出来的
  fn current_transaction(&self) -> TransactionState {
    self.connection.observed_transaction().unwrap_or_else(|| self.transaction.clone())
  }

  fn record(&mut self, sql: &str, succeeded: bool) {
    if self.connection.observed_transaction().is_some() {
      return;
    }
    if succeeded {
      self.transaction.after_success(
        sql,
        &chrono::Utc::now().to_rfc3339(),
        self.connection.commits_implicitly_on_ddl(),
      );
    } else {
      self.transaction.after_failure(self.connection.aborts_transaction_on_error());
    }
  }
}

#[derive(Default)]
pub struct QuerySessionState {
  sessions: Mutex<HashMap<String, Arc<SessionEntry>>>,
}

pub struct StreamingQueryOptions<'a> {
  pub session_id: &'a str,
  pub pool_key: &'a str,
  pub pool: PoolRef<'a>,
  pub sql: &'a str,
  /// false 时，不在事务里就先发一条 `BEGIN`。
  ///
  /// 客户端做，不用服务端开关：PostgreSQL 根本没有服务端的自动提交设置
  /// （它是客户端概念，psql 的 `\set AUTOCOMMIT off` 与 JDBC 的
  /// `setAutoCommit(false)` 都是这么做的），SQLite 也没有。
  pub autocommit: bool,
  /// 见 `StreamOptions::explain_plan`
  pub explain_plan: bool,
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
      return Err(QueryError::message(SESSION_ID_EMPTY));
    }

    let entry = self.get_or_create(session_id, pool_key, pool.into()).await?;
    if entry.pool_key != pool_key {
      return Err(QueryError::message(SESSION_BOUND_ELSEWHERE));
    }

    timeout(timeout_duration, async {
      let mut runtime = entry.runtime.lock().await;
      let result = runtime.connection.execute(sql, row_limit).await;
      runtime.record(sql, result.is_ok());
      result
    })
    .await
    .map_err(|_| {
      QueryError::with_code(
        QUERY_TIMEOUT_CODE,
        format!("{QUERY_TIMEOUT}: {}", timeout_duration.as_millis()),
      )
    })?
  }

  pub async fn release(&self, session_id: &str) -> bool {
    self.sessions.lock().await.remove(session_id).is_some()
  }

  /// 这条 session 现在的事务状态。
  ///
  /// 没有这条 session 就是「没在事务里」——还没执行过任何语句的标签页
  /// 确实不在事务里，而不是「状态未知」。
  pub async fn transaction(&self, session_id: &str) -> TransactionState {
    let entry = self.sessions.lock().await.get(session_id).cloned();
    match entry {
      Some(entry) => entry.runtime.lock().await.current_transaction(),
      None => TransactionState::default(),
    }
  }

  pub async fn execute_streaming(
    &self,
    options: StreamingQueryOptions<'_>,
    sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
  ) -> Result<QueryExecutionSummary, QueryError> {
    if options.session_id.trim().is_empty() {
      return Err(QueryError::message(SESSION_ID_EMPTY));
    }

    let entry = self.get_or_create(options.session_id, options.pool_key, options.pool).await?;
    if entry.pool_key != options.pool_key {
      return Err(QueryError::message(SESSION_BOUND_ELSEWHERE));
    }

    timeout(options.timeout_duration, async {
      let mut runtime = entry.runtime.lock().await;
      let idle = runtime.last_used.elapsed();
      if should_revalidate(idle, runtime.current_transaction().in_transaction())
        && !runtime.connection.responds_within(PING_LIMIT).await
      {
        // 旧连接上的会话变量（SET @x、search_path）随它一起没了——连接本来就死了，
        // 留着它也拿不回来
        let fresh = SessionConnection::acquire(options.pool).await?;
        std::mem::replace(&mut runtime.connection, fresh).discard();
        runtime.transaction = TransactionState::default();
      }
      runtime.last_used = std::time::Instant::now();
      runtime.begin_if_needed(options.autocommit, options.sql).await?;
      let result = runtime
        .connection
        .execute_streaming(
          options.sql,
          {
            let stream =
              StreamOptions::limited(options.row_limit, options.byte_limit, options.batch_size);
            if options.explain_plan {
              stream.for_explain()
            } else {
              stream
            }
          },
          sink,
        )
        .await;
      runtime.record(options.sql, result.is_ok());
      result
    })
    .await
    .map_err(|_| {
      QueryError::with_code(
        QUERY_TIMEOUT_CODE,
        format!("{QUERY_TIMEOUT}: {}", options.timeout_duration.as_millis()),
      )
    })?
  }

  async fn get_or_create(
    &self,
    session_id: &str,
    pool_key: &str,
    pool: PoolRef<'_>,
  ) -> Result<Arc<SessionEntry>, QueryError> {
    if let Some(entry) = self.sessions.lock().await.get(session_id).cloned() {
      return Ok(entry);
    }

    let connection = SessionConnection::acquire(pool).await?;
    let entry = Arc::new(SessionEntry {
      pool_key: pool_key.to_string(),
      runtime: Mutex::new(SessionRuntime {
        connection,
        transaction: TransactionState::default(),
        last_used: std::time::Instant::now(),
      }),
    });
    let mut sessions = self.sessions.lock().await;
    Ok(sessions.entry(session_id.to_string()).or_insert_with(|| entry.clone()).clone())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_idle_session_is_checked_before_use_but_never_inside_a_transaction() {
    // 连着敲语句时不多一次往返
    assert!(!should_revalidate(Duration::from_secs(5), false));
    // 空闲够久了，先问一句
    assert!(should_revalidate(REVALIDATE_AFTER, false));
    // 事务里不换连接：断了就让语句照常失败，不假装事务还在
    assert!(!should_revalidate(Duration::from_secs(600), true));
  }
  use crate::services::transaction_state::TransactionStatus;
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

  async fn memory_pool() -> DbPool {
    DbPool::Sqlite(
      SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("connect to SQLite"),
    )
  }

  async fn run(
    sessions: &QuerySessionState,
    pool: &DbPool,
    sql: &str,
    autocommit: bool,
  ) -> Result<QueryExecutionSummary, QueryError> {
    sessions
      .execute_streaming(
        StreamingQueryOptions {
          session_id: "s1",
          pool_key: "sqlite::memory:",
          pool: pool.into(),
          sql,
          autocommit,
          explain_plan: false,
          row_limit: 100,
          byte_limit: 1 << 20,
          batch_size: 10,
          timeout_duration: Duration::from_secs(5),
        },
        &mut |_| Ok(()),
      )
      .await
  }

  /// 事务状态得从**真的跑过的语句**推出来，不是从我们打算跑的语句。
  #[tokio::test]
  async fn tracks_the_transaction_across_begin_and_rollback() {
    let pool = memory_pool().await;
    let sessions = QuerySessionState::default();

    run(&sessions, &pool, "CREATE TABLE t (v TEXT)", true).await.expect("create");
    assert_eq!(sessions.transaction("s1").await.status, TransactionStatus::Idle);

    run(&sessions, &pool, "BEGIN", true).await.expect("begin");
    let state = sessions.transaction("s1").await;
    assert_eq!(state.status, TransactionStatus::Active);
    assert!(state.started_at.is_some(), "事务中必须给得出开始时间: {state:?}");

    run(&sessions, &pool, "INSERT INTO t (v) VALUES ('x')", true).await.expect("insert");
    assert_eq!(sessions.transaction("s1").await.status, TransactionStatus::Active);

    run(&sessions, &pool, "ROLLBACK", true).await.expect("rollback");
    assert_eq!(sessions.transaction("s1").await, TransactionState::default());
  }

  /// 关掉自动提交之后，一条普通的 INSERT 也在事务里——所以回滚能把它撤掉。
  ///
  /// 这才是这个开关的意义。只把状态栏点亮而语句仍然各自提交，是最糟的形态：
  /// 界面说在事务里，按回滚却什么也没撤销。
  #[tokio::test]
  async fn turning_autocommit_off_puts_a_plain_statement_inside_a_transaction() {
    let pool = memory_pool().await;
    let sessions = QuerySessionState::default();

    run(&sessions, &pool, "CREATE TABLE t (v TEXT)", true).await.expect("create");
    run(&sessions, &pool, "INSERT INTO t (v) VALUES ('x')", false).await.expect("insert");
    assert_eq!(
      sessions.transaction("s1").await.status,
      TransactionStatus::Active,
      "关掉自动提交之后这条 INSERT 应该开了一个事务"
    );

    run(&sessions, &pool, "ROLLBACK", true).await.expect("rollback");
    let result = sessions
      .execute("s1", "sqlite::memory:", &pool, "SELECT v FROM t", 100, Duration::from_secs(5))
      .await
      .expect("read back");
    match result {
      QueryExecutionResult::Rows { rows, .. } => {
        assert!(rows.is_empty(), "回滚该把那一行撤掉，否则开关只是个装饰")
      }
      QueryExecutionResult::Affected { .. } => panic!("expected rows"),
    }
  }

  /// 自己写的 `BEGIN` 前面不该再补一条。
  #[tokio::test]
  async fn autocommit_off_does_not_double_begin() {
    let pool = memory_pool().await;
    let sessions = QuerySessionState::default();
    // SQLite 不允许嵌套 BEGIN；补了就会在这里报
    // "cannot start a transaction within a transaction"
    run(&sessions, &pool, "BEGIN", false).await.expect("自己写的 BEGIN 前面不该再补一条");
    assert_eq!(sessions.transaction("s1").await.status, TransactionStatus::Active);
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

    assert_eq!(error.message, SESSION_BOUND_ELSEWHERE);
  }
}
