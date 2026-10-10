//! 按库的类型开一次只读会话，执行一条语句，然后回滚（`rfcs/agent-cli.md` §5.2）。
//!
//! 这一层是**数据库自己**拒绝写：PostgreSQL 与 MySQL 开只读事务，SQLite 与 DuckDB
//! 以只读方式打开文件。它挡不全（MySQL 的 DDL 会隐式提交，SQLite 的 `ATTACH` 能写出
//! 新文件），所以调用方在这之前一定已经过了 `read_only_gate`。永远以 `ROLLBACK` 结束：
//! 事务第一条就改回读写的话（PostgreSQL 会放行），写进去的也会被撤掉。

use crate::models::{ConnectionProfile, DatabaseType};
use crate::services::explain::{
  explain_statement, parse_plan, PlanDialect, QueryPlan, EXPLAIN_BYTE_LIMIT, EXPLAIN_ROW_LIMIT,
  SERVER_VERSION_QUERY,
};
use crate::services::query_executor::{
  PoolRef, QueryExecutionResult, QueryRow, SessionConnection, StreamOptions,
};
use crate::services::ssh_tunnel::{default_known_hosts, TunnelRegistry};
use crate::services::DEFAULT_QUERY_BATCH_SIZE;
use crate::services::{clickhouse, duckdb, oracle, sqlx_pool, QueryError};
use serde_json::Value as JsonValue;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri_plugin_sql::DbPool;

pub(super) enum Failure {
  /// 还没执行语句就失败了：隧道、连接、打开文件
  Connect(String),
  Database(QueryError),
  Unsupported(DatabaseType),
}

/// 这一版命令行能连的类型。其余的在 §6 的后几批
pub(super) fn supports(db_type: &DatabaseType) -> bool {
  matches!(
    db_type,
    DatabaseType::PostgreSQL
      | DatabaseType::MySQL
      | DatabaseType::SQLite
      | DatabaseType::DuckDB
      | DatabaseType::ClickHouse
      | DatabaseType::Oracle
  )
}

/// 一次调用里打开的库。隧道随它一起活到这次调用结束
pub(super) struct Opened {
  pool: Pool,
  /// 开只读事务的那一句。SQLite、DuckDB 以只读方式打开文件，ClickHouse 每条请求带
  /// `readonly = 1`，都不需要
  begin: Option<&'static str>,
  _tunnels: TunnelRegistry,
}

enum Pool {
  Sqlx(DbPool),
  DuckDb(Arc<duckdb::DuckDbPool>),
  Oracle(Arc<oracle::OraclePool>),
  ClickHouse(Arc<clickhouse::ClickHousePool>),
}

/// 建立连接最多等多久（含隧道）。和语句的超时分开算：库没起来时 sqlx 会对「连接被拒」
/// 退避重试到池子的 `acquire_timeout`（30 秒），等满了再报成语句超时，Agent 就分不清是库
/// 没起来还是语句太慢
const CONNECT_DEADLINE: Duration = Duration::from_secs(10);

/// `profile` 已经补上了凭据（`resolve_for_agents`）。`config_dir` 用来解析相对路径的
/// 库文件，和界面一样相对于应用的配置目录
pub(super) async fn open(
  profile: &ConnectionProfile,
  config_dir: Option<&Path>,
) -> Result<Opened, Failure> {
  tokio::time::timeout(CONNECT_DEADLINE, connect(profile, config_dir)).await.map_err(|_| {
    Failure::Connect(format!("could not connect within {} s", CONNECT_DEADLINE.as_secs()))
  })?
}

async fn connect(
  profile: &ConnectionProfile,
  config_dir: Option<&Path>,
) -> Result<Opened, Failure> {
  if !supports(&profile.db_type) {
    return Err(Failure::Unsupported(profile.db_type.clone()));
  }
  let tunnels = TunnelRegistry::default();
  let tunnel_port = match &profile.ssh_tunnel {
    None => None,
    Some(tunnel) => {
      let known_hosts = default_known_hosts()
        .ok_or_else(|| Failure::Connect("cannot locate ~/.ssh/known_hosts".to_string()))?;
      let port = tunnels
        .ensure(profile, tunnel, &known_hosts)
        .await
        .map_err(|error| Failure::Connect(error.to_string()))?;
      Some(port)
    }
  };

  let (pool, begin) = match profile.db_type {
    DatabaseType::PostgreSQL | DatabaseType::MySQL => {
      let begin = if profile.db_type == DatabaseType::PostgreSQL {
        "BEGIN READ ONLY"
      } else {
        "START TRANSACTION READ ONLY"
      };
      let pool = sqlx_pool::open(&profile.connection_string_via(tunnel_port))
        .await
        .map_err(Failure::Connect)?;
      (Pool::Sqlx(pool), Some(begin))
    }
    DatabaseType::SQLite => {
      let path = database_file(profile, config_dir)?;
      let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .read_only(true)
        .create_if_missing(false);
      let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| Failure::Connect(format!("{}: {error}", path.display())))?;
      (Pool::Sqlx(DbPool::Sqlite(pool)), None)
    }
    DatabaseType::DuckDB => {
      let path = database_file(profile, config_dir)?;
      let pool = duckdb::open_read_only(&path.to_string_lossy())
        .await
        .map_err(|error| Failure::Connect(format!("{}: {}", path.display(), error.message)))?;
      (Pool::DuckDb(pool), None)
    }
    DatabaseType::Oracle => {
      let reachable = match tunnel_port {
        Some(port) => profile.redirected_to("127.0.0.1", port),
        None => profile.clone(),
      };
      let target = oracle::OracleTarget::from_profile(&reachable);
      let connection =
        oracle::connect(&target).await.map_err(|error| Failure::Connect(error.message))?;
      // DDL 在只读事务里照样执行（§3.1 E3），挡它的是语句门；这里挡的是 DML
      (Pool::Oracle(oracle::OraclePool::new(target, connection)), Some("SET TRANSACTION READ ONLY"))
    }
    DatabaseType::ClickHouse => {
      // 不换主机：经隧道的 HTTPS 仍按原来的主机名校验证书（同界面）
      let target = clickhouse::ClickHouseTarget::from_profile(profile, tunnel_port);
      let pool = clickhouse::connect(target).await.map_err(Failure::Connect)?;
      pool.enforce_read_only().await.map_err(Failure::Database)?;
      (Pool::ClickHouse(pool), None)
    }
    _ => return Err(Failure::Unsupported(profile.db_type.clone())),
  };
  Ok(Opened { pool, begin, _tunnels: tunnels })
}

impl Opened {
  fn pool_ref(&self) -> PoolRef<'_> {
    match &self.pool {
      Pool::Sqlx(pool) => PoolRef::Sqlx(pool),
      Pool::DuckDb(pool) => PoolRef::DuckDb(pool),
      Pool::Oracle(pool) => PoolRef::Oracle(pool),
      Pool::ClickHouse(pool) => PoolRef::ClickHouse(pool),
    }
  }

  /// 执行一条已经过了语句门的语句
  pub(super) async fn run_read_only(
    &self,
    sql: &str,
    row_limit: usize,
  ) -> Result<QueryExecutionResult, Failure> {
    execute(self.pool_ref(), self.begin, sql, row_limit).await
  }

  /// 跑我们自己的目录查询（`schema_metadata`、`object_catalog`），表名与 schema 走绑定参数
  pub(super) async fn select(
    &self,
    sql: &str,
    params: Vec<JsonValue>,
  ) -> Result<Vec<JsonValue>, Failure> {
    let rows = match &self.pool {
      Pool::Sqlx(pool) => sqlx_pool::select(pool, sql, params).await.map(|rows| {
        rows.into_iter().map(|row| JsonValue::Object(row.into_iter().collect())).collect()
      }),
      Pool::DuckDb(pool) => pool.select(sql, &params).await.map(objects),
      Pool::Oracle(pool) => pool.select(sql, &params).await.map(objects),
      Pool::ClickHouse(pool) => pool.select(sql, &params).await.map(objects),
    };
    rows.map_err(Failure::Database)
  }

  /// 一条已经过了语句门的语句的执行计划。不带 ANALYZE，语句本身不执行；EXPLAIN 同样在
  /// 只读事务里、以回滚结束
  pub(super) async fn explain(
    &self,
    db_type: &DatabaseType,
    sql: &str,
  ) -> Result<QueryPlan, Failure> {
    // Oracle 的 `EXPLAIN PLAN` 要往会话的 PLAN_TABLE 写计划行，只读事务里报 ORA-01456（23ai 实测）。
    // 它只编译不执行语句，写进去的计划行由 `oracle::explain_plan` 读完就回滚，所以不开只读事务
    let begin = match self.pool {
      Pool::Oracle(_) => None,
      _ => self.begin,
    };
    let mut session = SessionConnection::acquire(self.pool_ref())
      .await
      .map_err(|error| Failure::Connect(error.message))?;
    if let Some(begin) = begin {
      session.execute_unprepared(begin).await.map_err(Failure::Database)?;
    }
    let plan = plan_in(&mut session, db_type, sql).await;
    if begin.is_some() {
      let _ = session.execute_unprepared("ROLLBACK").await;
    }
    plan.map_err(Failure::Database)
  }

  pub(super) async fn close(self) {
    if let Pool::Sqlx(pool) = self.pool {
      close(pool).await;
    }
  }
}

fn objects(rows: Vec<QueryRow>) -> Vec<JsonValue> {
  rows.into_iter().map(JsonValue::Object).collect()
}

pub(super) async fn run_read_only(
  profile: &ConnectionProfile,
  sql: &str,
  row_limit: usize,
  config_dir: Option<&Path>,
) -> Result<QueryExecutionResult, Failure> {
  let opened = open(profile, config_dir).await?;
  let result = opened.run_read_only(sql, row_limit).await;
  opened.close().await;
  result
}

async fn execute(
  pool: PoolRef<'_>,
  begin: Option<&str>,
  sql: &str,
  row_limit: usize,
) -> Result<QueryExecutionResult, Failure> {
  let mut session =
    SessionConnection::acquire(pool).await.map_err(|error| Failure::Connect(error.message))?;
  if let Some(begin) = begin {
    session.execute_unprepared(begin).await.map_err(Failure::Database)?;
  }
  let result = session.execute(sql, row_limit).await;
  if begin.is_some() {
    // 回滚失败时这条连接随后就关掉了，服务器在断开时同样回滚
    let _ = session.execute_unprepared("ROLLBACK").await;
  }
  result.map_err(Failure::Database)
}

/// 同界面的 `explain_query`：TiDB、OceanBase、CockroachDB 走 MySQL / PostgreSQL 的连接类型，
/// EXPLAIN 却各说各的，先问一句 `VERSION()`
async fn plan_in(
  session: &mut SessionConnection,
  db_type: &DatabaseType,
  sql: &str,
) -> Result<QueryPlan, QueryError> {
  let dialect = if PlanDialect::needs_server_version(db_type) {
    let version = match session.execute(SERVER_VERSION_QUERY, 1).await? {
      QueryExecutionResult::Rows { rows, .. } => rows
        .first()
        .and_then(|row| row.values().next())
        .map(|cell| cell.as_str().map(str::to_string).unwrap_or_else(|| cell.to_string()))
        .unwrap_or_default(),
      QueryExecutionResult::Affected { .. } => String::new(),
    };
    PlanDialect::detect(db_type, &version)
  } else {
    PlanDialect::from(db_type)
  };
  let statement = explain_statement(dialect.clone(), sql, false)?;
  let options =
    StreamOptions::limited(EXPLAIN_ROW_LIMIT, EXPLAIN_BYTE_LIMIT, DEFAULT_QUERY_BATCH_SIZE)
      .for_explain();
  let mut rows = Vec::new();
  session
    .execute_streaming(&statement, options, &mut |batch| {
      rows.extend(batch.rows);
      Ok(())
    })
    .await?;
  parse_plan(dialect, &rows, false)
}

async fn close(pool: DbPool) {
  match pool {
    DbPool::Sqlite(pool) => pool.close().await,
    DbPool::MySql(pool) => pool.close().await,
    DbPool::Postgres(pool) => pool.close().await,
  }
}

/// SQLite 与 DuckDB 的「库」是文件路径。相对路径和界面一样相对于应用的配置目录；
/// `:memory:` 在命令行里没有意义——每次调用都是一个空库
fn database_file(
  profile: &ConnectionProfile,
  config_dir: Option<&Path>,
) -> Result<PathBuf, Failure> {
  let database = profile.database.as_deref().unwrap_or_default();
  if database.is_empty() || database == ":memory:" {
    return Err(Failure::Connect("this connection has no database file".to_string()));
  }
  let path = Path::new(database);
  if path.is_absolute() {
    return Ok(path.to_path_buf());
  }
  config_dir
    .map(|dir| dir.join(path))
    .ok_or_else(|| Failure::Connect("cannot resolve a relative database path".to_string()))
}

#[cfg(test)]
mod tests {
  use super::*;
  use sqlx::Executor;

  /// 和 `tests/database_smoke.rs` 同一套环境变量，同一个规矩：只在 shell 里传
  fn profile_from_env(variable: &str, db_type: &str) -> Option<ConnectionProfile> {
    let raw = std::env::var(variable).ok()?;
    let url = url::Url::parse(&raw).expect("a valid test URL");
    let decode =
      |text: &str| urlencoding::decode(text).map(|text| text.into_owned()).unwrap_or_default();
    let profile = serde_json::json!({
      "id": "cli-smoke", "name": "cli-smoke", "db_type": db_type,
      "host": url.host_str().unwrap_or_default(), "port": url.port().unwrap_or(0),
      "database": url.path().trim_start_matches('/'), "username": decode(url.username()),
      "password": decode(url.password().unwrap_or_default()), "ssl": false,
      "options": {}, "tags": [],
    });
    Some(serde_json::from_value(profile).expect("a profile"))
  }

  /// 在只读会话里取计划。`Failure` 没有 `Debug`，断言失败时要看得到数据库的原话
  async fn plan_of(profile: &ConnectionProfile, sql: &str) -> Result<QueryPlan, String> {
    let describe = |failure: Failure| match failure {
      Failure::Connect(message) => message,
      Failure::Database(error) => error.to_string(),
      Failure::Unsupported(db_type) => format!("{db_type:?}"),
    };
    let opened = open(profile, None).await.map_err(describe)?;
    let plan = opened.explain(&profile.db_type, sql).await.map_err(describe);
    opened.close().await;
    plan
  }

  fn assert_has_plan(plan: Result<QueryPlan, String>) {
    match plan {
      Ok(plan) => assert!(!plan.roots.is_empty() && !plan.analyzed, "{plan:?}"),
      Err(error) => panic!("explain failed: {error}"),
    }
  }

  /// 只读事务确实开了：读照常，写被**数据库**拒绝（这一层不经过语句门），回滚后表里还是空的
  async fn check_read_only_transaction(profile: ConnectionProfile, admin_url: &str) {
    let admin = sqlx_pool::open(admin_url).await.expect("admin pool");
    // 测试库是共享的：上一次断言失败留下的行要先清掉，否则这次的「表是空的」会红在别处
    for setup in ["CREATE TABLE IF NOT EXISTS om_cli_probe (x INT)", "DELETE FROM om_cli_probe"] {
      match &admin {
        DbPool::Postgres(pool) => pool.execute(setup).await.map(|_| ()),
        DbPool::MySql(pool) => pool.execute(setup).await.map(|_| ()),
        DbPool::Sqlite(_) => unreachable!("only network databases here"),
      }
      .expect("prepare the probe table");
    }

    let read = run_read_only(&profile, "SELECT count(*) AS n FROM om_cli_probe", 10, None).await;
    assert!(matches!(read, Ok(QueryExecutionResult::Rows { .. })), "reads still work");
    assert_has_plan(plan_of(&profile, "SELECT count(*) AS n FROM om_cli_probe").await);
    let write = run_read_only(&profile, "INSERT INTO om_cli_probe VALUES (1)", 10, None).await;
    assert!(matches!(write, Err(Failure::Database(_))), "the database must refuse the write");

    let count = "SELECT count(*) FROM om_cli_probe";
    let rows: i64 = match &admin {
      DbPool::Postgres(pool) => sqlx::query_scalar(count).fetch_one(pool).await.expect("count"),
      DbPool::MySql(pool) => sqlx::query_scalar(count).fetch_one(pool).await.expect("count"),
      DbPool::Sqlite(_) => unreachable!("only network databases here"),
    };
    assert_eq!(rows, 0);
    let drop = "DROP TABLE om_cli_probe";
    let _ = match &admin {
      DbPool::Postgres(pool) => pool.execute(drop).await.map(|_| ()),
      DbPool::MySql(pool) => pool.execute(drop).await.map(|_| ()),
      DbPool::Sqlite(_) => Ok(()),
    };
    close(admin).await;
  }

  /// ClickHouse：每条请求带 `readonly = 1`，写和表函数被服务端拒绝；账号本身是 `readonly = 2`
  /// 时不带（带了会报 164），读照常
  #[tokio::test]
  async fn clickhouse_sessions_are_read_only() {
    let Some(profile) = profile_from_env("DATAOMNI_CLICKHOUSE_TEST_URL", "clickhouse") else {
      eprintln!("skipping: DATAOMNI_CLICKHOUSE_TEST_URL is not set");
      return;
    };
    let admin = clickhouse::connect(clickhouse::ClickHouseTarget::from_profile(&profile, None))
      .await
      .expect("admin connection");
    let mut session =
      SessionConnection::acquire(PoolRef::ClickHouse(&admin)).await.expect("session");
    for setup in [
      "CREATE TABLE IF NOT EXISTS om_cli_ch (x Int32) ENGINE = Memory",
      "TRUNCATE TABLE om_cli_ch",
      "CREATE USER IF NOT EXISTS om_cli_ro2 IDENTIFIED WITH no_password SETTINGS readonly = 2",
      "GRANT SELECT ON *.* TO om_cli_ro2",
    ] {
      session.execute_unprepared(setup).await.expect(setup);
    }

    let read = run_read_only(&profile, "SELECT count() AS n FROM om_cli_ch", 10, None).await;
    assert!(matches!(read, Ok(QueryExecutionResult::Rows { .. })), "reads still work");
    assert_has_plan(plan_of(&profile, "SELECT count() AS n FROM om_cli_ch").await);
    for sql in [
      "INSERT INTO om_cli_ch VALUES (1)",
      "SELECT * FROM url('http://127.0.0.1:1/x', 'CSV', 'a String')",
      "CREATE TABLE om_cli_ch2 (x Int32) ENGINE = Memory",
    ] {
      let refused = run_read_only(&profile, sql, 10, None).await;
      assert!(matches!(refused, Err(Failure::Database(_))), "the server must refuse: {sql}");
    }

    let mut read_only_account = profile.clone();
    read_only_account.username = "om_cli_ro2".to_string();
    read_only_account.password = String::new();
    let read = run_read_only(&read_only_account, "SELECT 1 AS one", 10, None).await;
    assert!(
      matches!(read, Ok(QueryExecutionResult::Rows { .. })),
      "a readonly = 2 account can read"
    );

    for cleanup in ["DROP USER IF EXISTS om_cli_ro2", "DROP TABLE IF EXISTS om_cli_ch"] {
      let _ = session.execute_unprepared(cleanup).await;
    }
  }

  /// Oracle：`SET TRANSACTION READ ONLY` 挡 DML（DDL 不挡，§3.1 E3，靠语句门）
  #[tokio::test]
  async fn oracle_sessions_refuse_dml() {
    let Some(profile) = profile_from_env("DATAOMNI_ORACLE_TEST_URL", "oracle") else {
      eprintln!("skipping: DATAOMNI_ORACLE_TEST_URL is not set");
      return;
    };
    let target = oracle::OracleTarget::from_profile(&profile);
    let admin =
      oracle::OraclePool::new(target.clone(), oracle::connect(&target).await.expect("connect"));
    let mut session = SessionConnection::acquire(PoolRef::Oracle(&admin)).await.expect("session");
    let _ = session.execute_unprepared("DROP TABLE om_cli_ora").await;
    session.execute_unprepared("CREATE TABLE om_cli_ora (x NUMBER)").await.expect("create");
    // 只读事务读的是事务开始时的快照，而 Oracle 判断「表在快照之后才建」的粒度是秒级的：
    // 刚建好就读报 ORA-01466（23ai 上实测）。真实用法里表不会是一秒前建的
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

    let read = run_read_only(&profile, "SELECT count(*) AS n FROM om_cli_ora", 10, None).await;
    assert!(matches!(read, Ok(QueryExecutionResult::Rows { .. })), "reads still work");
    assert_has_plan(plan_of(&profile, "SELECT count(*) AS n FROM om_cli_ora").await);
    let write = run_read_only(&profile, "INSERT INTO om_cli_ora VALUES (1)", 10, None).await;
    assert!(matches!(write, Err(Failure::Database(_))), "the database must refuse the write");

    let _ = session.execute_unprepared("DROP TABLE om_cli_ora").await;
  }

  /// §3 E6：每次调用都新建隧道与连接，折合几句「已经连上之后的查询」。按这个单位而不是毫秒判：
  /// 毫秒跟网络走，单位数是一次调用来回了多少趟，是代码决定的。实测（经代理到 cu，一趟约
  /// 170～250 ms）每次 4.2～4.4 秒、合 22～26 个单位：SSH 握手与认证、开连接、取连接前的 ping、
  /// BEGIN、预处理加执行、ROLLBACK。常驻进程能降到 5 个左右，用户定了 1.0 之前不做（§4）。
  /// 门留 25% 余量：同一台机器上几次运行之间就差 15%。它拦的是「每次调用明显变重了」，
  /// 比如多开了一次连接（8 个单位以上）。和 `tests/ssh_tunnel_smoke.rs` 同一套环境变量，只在 shell 里传
  #[tokio::test]
  async fn e6_a_tunnelled_call_takes_a_bounded_number_of_round_trips() {
    let variable = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let (
      Some(host),
      Some(username),
      Some(key),
      Some(target),
      Some(db_user),
      Some(db_password),
      Some(db_name),
    ) = (
      variable("DATAOMNI_SSH_TUNNEL_HOST"),
      variable("DATAOMNI_SSH_TUNNEL_USER"),
      variable("DATAOMNI_SSH_TUNNEL_KEY"),
      variable("DATAOMNI_SSH_TUNNEL_TARGET"),
      variable("DATAOMNI_SSH_TUNNEL_DB_USER"),
      variable("DATAOMNI_SSH_TUNNEL_DB_PASSWORD"),
      variable("DATAOMNI_SSH_TUNNEL_DB_NAME"),
    )
    else {
      eprintln!("skipping: the DATAOMNI_SSH_TUNNEL_* variables are not set");
      return;
    };
    let (target_host, target_port) = target.rsplit_once(':').expect("TARGET is host:port");
    let profile: ConnectionProfile = serde_json::from_value(serde_json::json!({
      "id": "cli-e6", "name": "cli-e6", "db_type": "mysql",
      "host": target_host, "port": target_port.parse::<u16>().expect("a port"),
      "database": db_name, "username": db_user, "password": db_password,
      "ssl": false, "tls_mode": "disabled", "options": {}, "tags": [],
      "ssh_tunnel": { "host": host, "username": username, "private_key_path": key },
    }))
    .expect("a profile");

    // 一个往返：一直开着的那条隧道连接上发一句简单查询协议的 `SELECT 1`。每一轮紧挨着量一次
    // 完整调用和几次往返，按轮算比值：分开两段量的话，网络在这几十秒里一变，比值就漂（实测 17～26）
    let held = open(&profile, None).await.ok().expect("open once");
    let mut session = SessionConnection::acquire(held.pool_ref()).await.expect("a session");
    let mut ratios = Vec::new();
    for _ in 0..10 {
      let started = std::time::Instant::now();
      let read = run_read_only(&profile, "SELECT 1 AS one", 1, None).await;
      assert!(matches!(read, Ok(QueryExecutionResult::Rows { .. })), "the tunnelled read works");
      let call = started.elapsed();
      let started = std::time::Instant::now();
      for _ in 0..3 {
        session.execute_unprepared("SELECT 1").await.expect("one round trip");
      }
      let trip = started.elapsed() / 3;
      ratios.push(call.as_secs_f64() / trip.as_secs_f64());
    }
    drop(session);
    held.close().await;
    ratios.sort_by(f64::total_cmp);
    let round_trips = ratios[ratios.len() / 2];
    eprintln!("E6: {round_trips:.1} round trips per call (per round: {ratios:.1?})");
    assert!(round_trips <= 32.0, "{round_trips:.1} round trips per call");
  }

  #[tokio::test]
  async fn postgres_sessions_are_read_only() {
    let Some(profile) = profile_from_env("DATAOMNI_POSTGRES_TEST_URL", "postgresql") else {
      eprintln!("skipping: DATAOMNI_POSTGRES_TEST_URL is not set");
      return;
    };
    let admin = std::env::var("DATAOMNI_POSTGRES_TEST_URL").unwrap_or_default();
    check_read_only_transaction(profile, &admin).await;
  }

  #[tokio::test]
  async fn mysql_sessions_are_read_only() {
    let Some(profile) = profile_from_env("DATAOMNI_MYSQL_TEST_URL", "mysql") else {
      eprintln!("skipping: DATAOMNI_MYSQL_TEST_URL is not set");
      return;
    };
    let admin = std::env::var("DATAOMNI_MYSQL_TEST_URL").unwrap_or_default();
    check_read_only_transaction(profile, &admin).await;
  }
}
