//! MySQL / PostgreSQL 的连接池由这里开，不用插件的 `Database.load`。
//!
//! 插件那一份有两处不能接受：
//! - 池子全用 sqlx 的默认值，空闲连接留 10 分钟。VPN、NAT、云负载均衡会把空闲了
//!   几分钟的 TCP 流悄悄丢掉（实测经 Shadowrocket 隧道：3 分钟还在，6 分钟就没了），
//!   而 sqlx 取连接前那一下 ping 没有超时——应用放着几分钟再回来，第一个操作要等满
//!   30 秒，然后报「pool timed out while waiting for an open connection」。
//! - 库不存在时它会 `CREATE DATABASE`：连接表单里库名打错一个字母，服务器上就多出
//!   一个空库。
//!
//! 开好的池子照样登记进插件的 `DbInstances`，前端用 `Database.get` 拿句柄，
//! 插件的 `select` / `execute` 不受影响。SQLite 仍走插件：文件路径的映射和
//! 「不存在就建」对本地文件是合适的。
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::str::FromStr;
use std::time::Duration;
use tauri_plugin_sql::DbPool;

/// 空闲连接留多久。要比常见的空闲回收短：AWS NLB 350 秒、Azure 负载均衡 4 分钟、
/// 家用路由器和各种隧道常见几分钟。代价是停下来超过一分钟后，第一条语句多一次握手
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// 这个连接串归不归这里开
pub fn handles(connection_string: &str) -> bool {
  ["mysql://", "mariadb://", "postgres://", "postgresql://"]
    .iter()
    .any(|scheme| connection_string.starts_with(scheme))
}

pub async fn open(connection_string: &str) -> Result<DbPool, String> {
  if connection_string.starts_with("postgres://") || connection_string.starts_with("postgresql://")
  {
    let options =
      PgConnectOptions::from_str(connection_string).map_err(|error| error.to_string())?;
    let pool = PgPoolOptions::new()
      .idle_timeout(IDLE_TIMEOUT)
      .connect_with(options)
      .await
      .map_err(|error| error.to_string())?;
    return Ok(DbPool::Postgres(pool));
  }
  if handles(connection_string) {
    let options =
      MySqlConnectOptions::from_str(connection_string).map_err(|error| error.to_string())?;
    let pool = MySqlPoolOptions::new()
      .idle_timeout(IDLE_TIMEOUT)
      .connect_with(options)
      .await
      .map_err(|error| error.to_string())?;
    return Ok(DbPool::MySql(pool));
  }
  Err(format!("unsupported connection string scheme: {}", scheme_of(connection_string)))
}

/// 报错时只说 scheme：连接串里有口令
fn scheme_of(connection_string: &str) -> &str {
  connection_string.split(':').next().unwrap_or_default()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_the_two_network_families_are_opened_here() {
    assert!(handles("mysql://u:p@h:3306/db"));
    assert!(handles("postgres://u:p@h:5432/db?sslmode=disable"));
    assert!(handles("postgresql://u:p@h/db"));
    // SQLite 仍归插件：它要做路径映射
    assert!(!handles("sqlite:/tmp/a.db"));
    assert!(!handles("sqlserver://h"));
  }

  #[test]
  fn an_unsupported_scheme_is_named_without_the_password() {
    match tauri::async_runtime::block_on(open("sqlite:secret@/tmp/a.db")) {
      Ok(_) => panic!("sqlite is not opened here"),
      Err(error) => assert!(!error.contains("secret"), "{error}"),
    }
  }

  /// 空闲回收要短于实测会被隧道丢掉的时长（3～6 分钟之间）
  #[test]
  fn idle_connections_are_closed_before_a_tunnel_would_drop_them() {
    assert!(IDLE_TIMEOUT < Duration::from_secs(180));
  }
}
