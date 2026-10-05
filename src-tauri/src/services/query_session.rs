use crate::services::query_error::{CONNECTION_LOST_CODE, PROTOCOL_ERROR_CODE};
use crate::services::query_executor::PoolRef;
use crate::services::query_executor::QUERY_TIMEOUT;
use crate::services::{
  transaction_state::{autocommit_assignment, TransactionState},
  QueryError, QueryExecutionResult, QueryExecutionSummary, QueryResultBatch, SessionConnection,
  StreamOptions, QUERY_TIMEOUT_CODE,
};
use sqlx::Executor;
use std::{collections::HashMap, sync::Arc};
use tauri_plugin_sql::DbPool;
use tokio::{
  sync::Mutex,
  task::JoinHandle,
  time::{timeout, Duration},
};

/// 这两条都是前端传错了参数，用户无从下手，但也不该看见中文
pub const SESSION_ID_EMPTY: &str = "DATAOMNI_SESSION_ID_EMPTY";
pub const SESSION_BOUND_ELSEWHERE: &str = "DATAOMNI_SESSION_BOUND_ELSEWHERE";
/// 这条连接的 SQL 会话里有一个没提交的事务，而这次写入走的是另一条连接
pub const SESSION_TRANSACTION_OPEN: &str = "DATAOMNI_SESSION_TRANSACTION_OPEN";

/// 连接和它的事务状态必须一起锁。
///
/// 分成两把锁，就可能读到「语句已经 COMMIT 了、状态还写着事务中」的中间态，
/// 而状态栏正是靠这个值决定要不要在关标签页时拦一下。
struct SessionRuntime {
  connection: SessionConnection,
  transaction: TransactionState,
  last_used: std::time::Instant,
  /// 怎么在服务端结束这条连接；问不到编号时是 `None`
  terminator: Option<Terminator>,
  /// 一条语句开始了还没回来。锁已经放开时它还是 true，就是执行的 future 被丢掉了（超时、取消）
  in_flight: bool,
  /// 上一条语句报出这条连接已经没了（[`connection_is_gone`]）。服务端那头的事务随之回滚；
  /// 不记下来的话状态一直停在「事务中 / 事务失败」，而 `ROLLBACK` 和之后每一条都报连接已断
  connection_gone: bool,
  pending_termination: PendingTermination,
  /// 用户在这条 MySQL 连接上执行过 `SET autocommit = 0`，见 `TransactionState::after_success`
  autocommit_off: bool,
}

/// 被放弃的语句在服务端停下了没有。下一条语句先等它：不然换上的新连接可能
/// 撞上旧连接还拿着的行锁
type PendingTermination = Arc<std::sync::Mutex<Option<JoinHandle<()>>>>;

/// 另取池里一条连接，结束一条 sqlx 会话连接（PostgreSQL、MySQL）。
///
/// 丢掉执行的 future 时服务端并不知道：点了取消的 `UPDATE` 照样跑完、提交
/// （PostgreSQL 16、MySQL 8.4 实测）。连接上还留着它没读完的回包——PostgreSQL 的
/// 下一条要等它跑完，MySQL 的下一条读到残包，报协议错或者给出 0 行。所以结束的是
/// 整条连接而不只是那条语句：它反正不能再用，服务端随之回滚它上面的事务，
/// 与状态栏上「事务没了」一致。SQL Server、Oracle、ClickHouse 各自在驱动里处理
///
/// SQLite 没有网络连接可断：被放弃的语句在 sqlx 的工作线程上接着跑，同一个标签页的
/// 下一条（包括 `ROLLBACK`）排在它后面，写语句跑完照样提交。它用 `sqlite3_interrupt`
/// 当场打断，连接接着用——内存库换一条连接就是换了一个库
///
/// 结束之前先核对那个编号上正在跑的是不是这条语句：经事务池（pgbouncer、Supabase）或
/// 复用连接的代理时，会话打开时问到的编号过后可能在服务别的客户端，照着结束就停掉了别人的连接
/// （本机 pgbouncer 1.26 实测）。对不上就不结束，被放弃的语句在服务端跑完
#[derive(Clone)]
enum Terminator {
  /// `CONNECTION_ID()`
  MySql(sqlx::MySqlPool, u64),
  /// `pg_backend_pid()`；openGauss 的是线程号，超出 int4
  Postgres(sqlx::PgPool, u64),
  Sqlite(SqliteHandle),
}

/// 会话连接的 `sqlite3*`。只拿来调 `sqlite3_interrupt`（SQLite 文档说可以从别的线程调）
/// 与工作线程空闲时的 `sqlite3_get_autocommit`
#[derive(Clone, Copy)]
struct SqliteHandle(std::ptr::NonNull<libsqlite3_sys::sqlite3>);

// SAFETY: 指针只交给 `sqlite3_interrupt`，它本来就是给别的线程用的；
// `sqlite3_get_autocommit` 只在 `lock_handle` 拿着工作线程时调
unsafe impl Send for SqliteHandle {}
unsafe impl Sync for SqliteHandle {}

/// 发结束语句要先从池里取一条连接，池满时会等；等不到就算了，下一条语句照样换连接
const TERMINATE_LIMIT: Duration = Duration::from_secs(10);

impl Terminator {
  /// 问这条连接在服务端的编号。问不到就只换连接、不停服务端那条——
  /// 不为了这个让整个会话开不起来
  async fn for_connection(connection: &mut SessionConnection, pool: PoolRef<'_>) -> Option<Self> {
    match (connection, pool) {
      (SessionConnection::MySql(connection), PoolRef::Sqlx(DbPool::MySql(pool))) => {
        let id: String = sqlx::query_scalar("SELECT CAST(CONNECTION_ID() AS CHAR)")
          .fetch_one(&mut **connection)
          .await
          .ok()?;
        let id: u64 = id.parse().ok()?;
        Some(Self::MySql(pool.clone(), id))
      }
      // openGauss 的编号是线程号，超出 int4，按文本取
      (SessionConnection::Postgres(connection), PoolRef::Sqlx(DbPool::Postgres(pool))) => {
        let pid: String = sqlx::query_scalar("SELECT pg_backend_pid()::text")
          .fetch_one(&mut **connection)
          .await
          .ok()?;
        let pid: u64 = pid.parse().ok()?;
        Some(Self::Postgres(pool.clone(), pid))
      }
      (SessionConnection::Sqlite(connection), _) => {
        let mut locked = connection.lock_handle().await.ok()?;
        Some(Self::Sqlite(SqliteHandle(locked.as_raw_handle())))
      }
      _ => None,
    }
  }

  /// `statement`：那条语句的开头，拿来核对编号上正在跑的是不是它
  async fn run(self, statement: String) {
    let outcome = timeout(TERMINATE_LIMIT, async {
      match self {
        Self::MySql(pool, id) => {
          // ID 在 MySQL 是 BIGINT UNSIGNED、在 MariaDB 是有符号的，按文本比，免得解码对不上类型
          let running: Option<String> = sqlx::query_scalar(
            "SELECT CAST(ID AS CHAR) FROM information_schema.PROCESSLIST \
             WHERE CAST(ID AS CHAR) = ? AND INSTR(INFO, ?) > 0",
          )
          .bind(id.to_string())
          .bind(&statement)
          .fetch_optional(&pool)
          .await?;
          if running.is_none() {
            return Ok(());
          }
          // MySQL 没有带条件的 KILL：两句之间那条刚好跑完、代理又把连接给了别人时仍会停错，
          // 窗口是一个往返。直连时编号一直是这个会话自己的
          pool.execute(format!("KILL {id}").as_str()).await.map(drop)
        }
        Self::Postgres(pool, pid) => sqlx::query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
           WHERE pid::text = $1 AND state = 'active' AND strpos(query, $2) > 0",
        )
        .bind(pid.to_string())
        .bind(&statement)
        .execute(&pool)
        .await
        .map(drop),
        Self::Sqlite(_) => Ok(()),
      }
    })
    .await;
    // 停不下来不算错：下一条语句照样换连接。记一笔，免得「服务端没停」查不到原因
    match outcome {
      Ok(Ok(())) => {}
      Ok(Err(error)) => eprintln!("结束被放弃的语句失败: {error}"),
      Err(_) => eprintln!("结束被放弃的语句超时"),
    }
  }
}

/// 执行期间拿着；没走到 `finish` 就被丢掉时，在服务端结束那条连接
struct TerminateOnDrop {
  terminator: Option<Terminator>,
  /// 语句的开头，见 [`Terminator::run`]
  statement: String,
  pending: PendingTermination,
}

impl TerminateOnDrop {
  fn finish(mut self) {
    self.terminator = None;
  }
}

impl Drop for TerminateOnDrop {
  fn drop(&mut self) {
    let Some(terminator) = self.terminator.take() else {
      return;
    };
    if let Terminator::Sqlite(SqliteHandle(handle)) = terminator {
      // SAFETY: 守卫在执行它的 future 里，排在会话锁与 `SessionEntry` 之后声明、先被丢掉，
      // 这时连接还在会话里，句柄有效；`sqlite3_interrupt` 可以从任何线程调
      unsafe { libsqlite3_sys::sqlite3_interrupt(handle.as_ptr()) };
      return;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
      return;
    };
    let handle = runtime.spawn(terminator.run(std::mem::take(&mut self.statement)));
    if let Ok(mut pending) = self.pending.lock() {
      *pending = Some(handle);
    }
  }
}

/// 服务端记下的语句文本里认这一段：开头 48 个字符。执行计划会在前面加 `EXPLAIN …`，
/// 服务端记的文本有长度上限（PostgreSQL 默认 1024 字节），所以不比整句
fn statement_fingerprint(sql: &str) -> String {
  sql.trim().chars().take(48).collect()
}

/// 这个错误说明会话连接不能再用了：传输层断开，服务端说完这句就断开，
/// 或者驱动读不懂回包、连接上剩着残包（见 `QueryError::from`）
fn connection_is_gone(error: &QueryError) -> bool {
  matches!(error.code.as_deref(), Some(CONNECTION_LOST_CODE | PROTOCOL_ERROR_CODE))
}

/// 执行被放弃之后还能不能接着用这条连接。sqlx 的两家网络库不能，见 [`Terminator`]；
/// SQLite 被打断之后照常能用
fn breaks_when_abandoned(connection: &SessionConnection) -> bool {
  matches!(connection, SessionConnection::MySql(_) | SessionConnection::Postgres(_))
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
  async fn open(pool: PoolRef<'_>) -> Result<Self, QueryError> {
    let mut connection = SessionConnection::acquire(pool).await?;
    let terminator = Terminator::for_connection(&mut connection, pool).await;
    Ok(Self {
      connection,
      transaction: TransactionState::default(),
      last_used: std::time::Instant::now(),
      terminator,
      in_flight: false,
      connection_gone: false,
      pending_termination: PendingTermination::default(),
      autocommit_off: false,
    })
  }

  /// 换一条新连接。旧连接上的会话变量（SET @x、search_path）与事务随它一起没了
  async fn replace_connection(&mut self, pool: PoolRef<'_>) -> Result<(), QueryError> {
    let fresh = Self::open(pool).await?;
    std::mem::replace(&mut self.connection, fresh.connection).discard();
    self.terminator = fresh.terminator;
    self.transaction = TransactionState::default();
    self.in_flight = false;
    self.connection_gone = false;
    self.autocommit_off = false;
    Ok(())
  }

  /// 上一条语句被放弃了：等服务端结束那条连接，再换一条。上一条报出连接已经没了，也换一条
  async fn recover_if_abandoned(&mut self, pool: PoolRef<'_>) -> Result<(), QueryError> {
    if self.connection_gone {
      return self.replace_connection(pool).await;
    }
    self.settle_interrupted().await;
    if !self.in_flight {
      return Ok(());
    }
    let pending = self.pending_termination.lock().ok().and_then(|mut pending| pending.take());
    if let Some(handle) = pending {
      let _ = handle.await;
    }
    self.replace_connection(pool).await
  }

  /// SQLite 被打断的语句停下之后，问它事务还在不在：打断的是写语句时 SQLite
  /// 自己回滚了整个事务，打断的是读语句时事务还在
  async fn settle_interrupted(&mut self) {
    if !self.in_flight || breaks_when_abandoned(&self.connection) {
      return;
    }
    if let SessionConnection::Sqlite(connection) = &mut self.connection {
      // 拿到句柄要等工作线程空下来，也就是被打断的那条真的停了
      if let Ok(mut locked) = connection.lock_handle().await {
        // SAFETY: `lock_handle` 拿着工作线程，这期间没有别人在用这个句柄
        let autocommit =
          unsafe { libsqlite3_sys::sqlite3_get_autocommit(locked.as_raw_handle().as_ptr()) };
        if autocommit != 0 {
          self.transaction = TransactionState::default();
        }
      }
    }
    self.in_flight = false;
  }

  /// 语句开始执行。守卫在语句回来之后交给 `statement_returned`
  fn statement_started(&mut self, sql: &str) -> TerminateOnDrop {
    self.in_flight = breaks_when_abandoned(&self.connection) || self.terminator.is_some();
    TerminateOnDrop {
      terminator: if self.in_flight { self.terminator.clone() } else { None },
      statement: statement_fingerprint(sql),
      pending: Arc::clone(&self.pending_termination),
    }
  }

  fn statement_returned(&mut self, guard: TerminateOnDrop) {
    guard.finish();
    self.in_flight = false;
  }

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

  /// 服务端报得出就用服务端的，否则用从语句推出来的。
  /// 上一条被放弃了的话，连接已经结束，事务随之回滚
  fn current_transaction(&self) -> TransactionState {
    // 连接没了时 PostgreSQL 驱动记着的还是最后那次的「事务失败」
    if self.connection_gone || (self.in_flight && breaks_when_abandoned(&self.connection)) {
      return TransactionState::default();
    }
    self.connection.observed_transaction().unwrap_or_else(|| self.transaction.clone())
  }

  fn record(&mut self, sql: &str, succeeded: bool) {
    if self.connection.observed_transaction().is_some() {
      return;
    }
    if succeeded {
      let mysql = self.connection.commits_implicitly_on_ddl();
      self.transaction.after_success(
        sql,
        &chrono::Utc::now().to_rfc3339(),
        mysql,
        self.autocommit_off,
      );
      if let Some(on) = autocommit_assignment(sql).filter(|_| mysql) {
        self.autocommit_off = !on;
      }
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
      runtime.recover_if_abandoned(pool.into()).await?;
      let guard = runtime.statement_started(sql);
      let result = runtime.connection.execute(sql, row_limit).await;
      runtime.statement_returned(guard);
      runtime.connection_gone = result.as_ref().is_err_and(connection_is_gone);
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
      Some(entry) => {
        let mut runtime = entry.runtime.lock().await;
        runtime.settle_interrupted().await;
        runtime.current_transaction()
      }
      None => TransactionState::default(),
    }
  }

  /// 连到同一个库（`pool_key` 相同）的会话里，有没有一个开着的事务。
  ///
  /// 网格提交、结构变更与导入走池里另一条连接：事务开着时它们写在事务外面——
  /// 状态栏说在事务里，回滚却撤不掉它们；还会去等那个事务手里的锁（SQLite
  /// 五秒后报 `database is locked`，PostgreSQL 一直等）。
  pub async fn transaction_open_on(&self, pool_key: &str) -> bool {
    // 先放掉表锁再逐个等：会话锁可能正被一条跑着的语句拿着
    let entries: Vec<_> = self
      .sessions
      .lock()
      .await
      .values()
      .filter(|entry| entry.pool_key == pool_key)
      .cloned()
      .collect();
    for entry in entries {
      let mut runtime = entry.runtime.lock().await;
      runtime.settle_interrupted().await;
      if runtime.current_transaction().in_transaction() {
        return true;
      }
    }
    false
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
      runtime.recover_if_abandoned(options.pool).await?;
      let idle = runtime.last_used.elapsed();
      if should_revalidate(idle, runtime.current_transaction().in_transaction())
        && !runtime.connection.responds_within(PING_LIMIT).await
      {
        // 连接本来就死了，上面的会话变量留着它也拿不回来
        runtime.replace_connection(options.pool).await?;
      }
      runtime.last_used = std::time::Instant::now();
      runtime.begin_if_needed(options.autocommit, options.sql).await?;
      let guard = runtime.statement_started(options.sql);
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
      runtime.statement_returned(guard);
      runtime.connection_gone = result.as_ref().is_err_and(connection_is_gone);
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

    let entry = Arc::new(SessionEntry {
      pool_key: pool_key.to_string(),
      runtime: Mutex::new(SessionRuntime::open(pool).await?),
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

  /// 另开连接的写入要先问这一句：只认同一个库上的会话，事务结束就放行。
  #[tokio::test]
  async fn reports_an_open_transaction_only_for_the_same_pool() {
    let pool = memory_pool().await;
    let sessions = QuerySessionState::default();
    assert!(!sessions.transaction_open_on("sqlite::memory:").await, "还没有会话");

    run(&sessions, &pool, "CREATE TABLE t (v TEXT)", true).await.expect("create");
    assert!(!sessions.transaction_open_on("sqlite::memory:").await, "自动提交的语句不留事务");

    run(&sessions, &pool, "BEGIN", true).await.expect("begin");
    assert!(sessions.transaction_open_on("sqlite::memory:").await);
    assert!(!sessions.transaction_open_on("sqlite:other.db").await, "别的库不受影响");

    run(&sessions, &pool, "ROLLBACK", true).await.expect("rollback");
    assert!(!sessions.transaction_open_on("sqlite::memory:").await);
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
