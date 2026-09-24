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
//! 这两家的目录查询与关池子也不走插件，走这里的 [`select`] / [`close`]：插件的
//! 那两条命令持着 `DbInstances` 的读锁等网络，理由见 [`shared`]。SQLite 仍走插件：
//! 文件路径的映射和「不存在就建」对本地文件是合适的，本地查询也不会挂在网络上。
use crate::services::plugin_decode::{mysql_to_json, postgres_to_json};
use indexmap::IndexMap;
use serde_json::Value as JsonValue;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Column, Row};
use std::str::FromStr;
use std::time::Duration;
use tauri_plugin_sql::{DbInstances, DbPool};

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

/// 这条连接串的池子，**拿到就放掉 `DbInstances` 的锁**。
///
/// 池子本身是 `Arc`，复制一份很便宜。不能持着锁去等网络：一条查询挂在断掉的连接上
/// （服务器停了、VPN 悄悄丢了流），读锁就一直不还；下一次开池子要拿写锁，就一直等；
/// 而 tokio 的读写锁是公平的，排着的写者后面，新来的读者也进不去——一个库断了，
/// 所有连接的查询、测试、新建一起卡住，只有重启应用能解（回归里的 F24）。
pub async fn shared(instances: &DbInstances, connection_string: &str) -> Option<DbPool> {
  let pools = instances.0.read().await;
  pools.get(connection_string).map(|pool| match pool {
    DbPool::Sqlite(pool) => DbPool::Sqlite(pool.clone()),
    DbPool::MySql(pool) => DbPool::MySql(pool.clone()),
    DbPool::Postgres(pool) => DbPool::Postgres(pool.clone()),
  })
}

/// 登记一个池子。同一个串再开一次（测试连接之后真的连上）就换掉旧的；旧池子里被
/// 会话借走的连接照常用完再关
pub async fn register(instances: &DbInstances, connection_string: String, pool: DbPool) {
  instances.0.write().await.insert(connection_string, pool);
}

/// 关掉并摘掉一个池子。sqlx 的 `close` 要等借出去的连接都还回来，一条挂住的连接
/// 就能让它永远不返回，所以放到后台去等，界面上的「断开」不跟着挂
pub async fn close(instances: &DbInstances, connection_string: &str) -> bool {
  let removed = instances.0.write().await.remove(connection_string);
  match removed {
    Some(pool) => {
      tauri::async_runtime::spawn(async move {
        match pool {
          DbPool::Sqlite(pool) => pool.close().await,
          DbPool::MySql(pool) => pool.close().await,
          DbPool::Postgres(pool) => pool.close().await,
        }
      });
      true
    }
    None => false,
  }
}

/// 前端目录查询的那条路，照插件 `select` 的规矩绑参数、解码，返回同样的形状：
/// 一行一个按列序的对象，值不带类型标签。数字一律按 f64 绑，也是插件的规矩
pub async fn select(
  pool: &DbPool,
  sql: &str,
  params: Vec<JsonValue>,
) -> Result<Vec<IndexMap<String, JsonValue>>, String> {
  macro_rules! bind_like_plugin {
    ($query:ident) => {
      for value in params {
        $query = match value {
          JsonValue::Null => $query.bind(None::<JsonValue>),
          JsonValue::String(text) => $query.bind(text),
          JsonValue::Number(number) => $query.bind(number.as_f64().unwrap_or_default()),
          other => $query.bind(other),
        };
      }
    };
  }
  macro_rules! decode_rows {
    ($rows:expr, $to_json:ident) => {
      $rows
        .iter()
        .map(|row| {
          let mut values = IndexMap::new();
          for (index, column) in row.columns().iter().enumerate() {
            let raw = row.try_get_raw(index).map_err(|error| error.to_string())?;
            values.insert(column.name().to_string(), $to_json(raw)?);
          }
          Ok(values)
        })
        .collect()
    };
  }
  match pool {
    DbPool::MySql(pool) => {
      let mut query = sqlx::query(sql);
      bind_like_plugin!(query);
      let rows = query.fetch_all(pool).await.map_err(|error| error.to_string())?;
      decode_rows!(rows, mysql_to_json)
    }
    DbPool::Postgres(pool) => {
      let mut query = sqlx::query(sql);
      bind_like_plugin!(query);
      let rows = query.fetch_all(pool).await.map_err(|error| error.to_string())?;
      decode_rows!(rows, postgres_to_json)
    }
    DbPool::Sqlite(_) => Err("sqlite catalog queries go through the plugin".to_string()),
  }
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

  /// 池子要在运行时里建（`connect_lazy` 会起后台任务）
  async fn sqlite_instances(key: &str) -> (DbInstances, sqlx::SqlitePool) {
    let pool = sqlx::sqlite::SqlitePoolOptions::new().connect_lazy("sqlite::memory:").unwrap();
    let instances = DbInstances::default();
    instances.0.write().await.insert(key.to_string(), DbPool::Sqlite(pool.clone()));
    (instances, pool)
  }

  /// F24 的门：拿到池子之后锁必须已经放了，否则挂住的查询会挡住所有写者
  #[test]
  fn a_shared_pool_does_not_keep_the_registry_locked() {
    tauri::async_runtime::block_on(async {
      let (instances, _pool) = sqlite_instances("sqlite:a").await;
      let shared = shared(&instances, "sqlite:a").await;
      assert!(shared.is_some());
      assert!(instances.0.try_write().is_ok(), "holding a pool must not hold the lock");
    });
  }

  /// 反向：持着读锁时写者确实进不去——上面那条绿不是因为 try_write 永远成功
  #[test]
  fn a_held_read_guard_does_block_writers() {
    tauri::async_runtime::block_on(async {
      let (instances, _pool) = sqlite_instances("sqlite:a").await;
      let _guard = instances.0.read().await;
      assert!(instances.0.try_write().is_err());
    });
  }

  #[test]
  fn closing_removes_the_pool_and_closes_it() {
    tauri::async_runtime::block_on(async {
      let (instances, pool) = sqlite_instances("sqlite:a").await;
      assert!(close(&instances, "sqlite:a").await);
      assert!(shared(&instances, "sqlite:a").await.is_none());
      assert!(!close(&instances, "sqlite:a").await);
      // 关是在后台做的
      for _ in 0..50 {
        if pool.is_closed() {
          return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
      }
      panic!("pool was not closed");
    });
  }

  /// 空闲回收要短于实测会被隧道丢掉的时长（3～6 分钟之间）
  #[test]
  fn idle_connections_are_closed_before_a_tunnel_would_drop_them() {
    assert!(IDLE_TIMEOUT < Duration::from_secs(180));
  }
}
