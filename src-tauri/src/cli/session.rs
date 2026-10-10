//! 按库的类型开一次只读会话，执行一条语句，然后回滚（`rfcs/agent-cli.md` §5.2）。
//!
//! 这一层是**数据库自己**拒绝写：PostgreSQL 与 MySQL 开只读事务，SQLite 与 DuckDB
//! 以只读方式打开文件。它挡不全（MySQL 的 DDL 会隐式提交，SQLite 的 `ATTACH` 能写出
//! 新文件），所以调用方在这之前一定已经过了 `read_only_gate`。永远以 `ROLLBACK` 结束：
//! 事务第一条就改回读写的话（PostgreSQL 会放行），写进去的也会被撤掉。

use crate::models::{ConnectionProfile, DatabaseType};
use crate::services::query_executor::{PoolRef, QueryExecutionResult, SessionConnection};
use crate::services::ssh_tunnel::{default_known_hosts, TunnelRegistry};
use crate::services::{clickhouse, duckdb, sqlx_pool, QueryError};
use std::path::{Path, PathBuf};
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
  )
}

/// `profile` 已经补上了凭据（`resolve_for_connection`）。`config_dir` 用来解析相对路径的
/// 库文件，和界面一样相对于应用的配置目录
pub(super) async fn run_read_only(
  profile: &ConnectionProfile,
  sql: &str,
  row_limit: usize,
  config_dir: Option<&Path>,
) -> Result<QueryExecutionResult, Failure> {
  if !supports(&profile.db_type) {
    return Err(Failure::Unsupported(profile.db_type.clone()));
  }
  // 活到这次调用结束：隧道随它一起拆
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

  match profile.db_type {
    DatabaseType::PostgreSQL | DatabaseType::MySQL => {
      let begin = if profile.db_type == DatabaseType::PostgreSQL {
        "BEGIN READ ONLY"
      } else {
        "START TRANSACTION READ ONLY"
      };
      let pool = sqlx_pool::open(&profile.connection_string_via(tunnel_port))
        .await
        .map_err(Failure::Connect)?;
      let result = execute(PoolRef::Sqlx(&pool), Some(begin), sql, row_limit).await;
      close(pool).await;
      result
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
      let pool = DbPool::Sqlite(pool);
      let result = execute(PoolRef::Sqlx(&pool), None, sql, row_limit).await;
      close(pool).await;
      result
    }
    DatabaseType::DuckDB => {
      let path = database_file(profile, config_dir)?;
      let pool = duckdb::open_read_only(&path.to_string_lossy())
        .await
        .map_err(|error| Failure::Connect(format!("{}: {}", path.display(), error.message)))?;
      execute(PoolRef::DuckDb(&pool), None, sql, row_limit).await
    }
    DatabaseType::ClickHouse => {
      // 不换主机：经隧道的 HTTPS 仍按原来的主机名校验证书（同界面）
      let target = clickhouse::ClickHouseTarget::from_profile(profile, tunnel_port);
      let pool = clickhouse::connect(target).await.map_err(Failure::Connect)?;
      pool.enforce_read_only().await.map_err(Failure::Database)?;
      execute(PoolRef::ClickHouse(&pool), None, sql, row_limit).await
    }
    _ => Err(Failure::Unsupported(profile.db_type.clone())),
  }
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
