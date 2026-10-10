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
use crate::services::QueryError;
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

/// 开池子时在 acquire 超时内一条连接也没建起来。和查询时的 `POOL_TIMED_OUT` 分开：
/// 那时可能只是连接都被占着，而新开的池子里没有别人——就是主机没回应
pub const CONNECT_TIMED_OUT: &str = "DATAOMNI_CONNECT_TIMED_OUT";

fn describe_open_error(error: &sqlx::Error) -> String {
  match error {
    sqlx::Error::PoolTimedOut => format!("{CONNECT_TIMED_OUT}: {error}"),
    _ => error.to_string(),
  }
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
      .map_err(|error| describe_open_error(&error))?;
    return Ok(DbPool::Postgres(pool));
  }
  if handles(connection_string) {
    // 会话照服务器的设置，sqlx 改的几处都还回去，它们都是为 sqlx 自己方便：
    // - 默认连上就 `SET time_zone='+00:00'`，为的是按 UTC 解 TIMESTAMP；我们按字节照原样显示，用不着。
    //   留着的话服务器在东八区时 `NOW()` 差 8 小时，写进 DATETIME 的就是 UTC 的钟点
    // - sql_mode 里加 `PIPES_AS_CONCAT`：`id = 2 || n = 5` 成了 `id = (2 || n) = 5`，一行都不中；
    //   在这里建的存储过程、触发器、事件还会把它记下来，以后谁调用都照拼接算
    let options = MySqlConnectOptions::from_str(connection_string)
      .map_err(|error| error.to_string())?
      .timezone(None)
      .pipes_as_concat(false)
      .no_engine_substitution(false);
    let pool = MySqlPoolOptions::new()
      .idle_timeout(IDLE_TIMEOUT)
      // 握手时 sqlx 写死了 `CLIENT_IGNORE_SPACE`，服务器据此往会话的 sql_mode 加 `IGNORE_SPACE`，
      // 函数名成了保留字：`CREATE TABLE position (x INT)` 报语法错。服务器本来就开着的不动。
      // 它还 `SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci`，而 MySQL 8 的列默认 `utf8mb4_0900_ai_ci`：
      // 用户变量、`CAST(… AS CHAR)` 按连接的排序规则，跟列一比报 1267 Illegal mix of collations。
      // 服务器默认就是 utf8mb4 时照它的排序规则；不是的话（latin1 之类）列是什么说不准，不动
      .after_connect(|connection, _| {
        Box::pin(async move {
          sqlx::Executor::execute(
            connection,
            "SET SESSION sql_mode = IF(FIND_IN_SET('IGNORE_SPACE', @@GLOBAL.sql_mode), @@SESSION.sql_mode, \
             TRIM(BOTH ',' FROM REPLACE(CONCAT(',', @@SESSION.sql_mode, ','), ',IGNORE_SPACE,', ','))), \
             collation_connection = IF(@@collation_server LIKE 'utf8mb4\\_%', @@collation_server, \
             @@collation_connection)",
          )
          .await
          .map(|_| ())
        })
      })
      .connect_with(options)
      .await
      .map_err(|error| describe_open_error(&error))?;
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
/// 一行一个按列序的对象，值不带类型标签。数字一律按 f64 绑，也是插件的规矩。
///
/// 错误不照抄插件：插件给的是驱动原话（「expected to read 4 bytes, got 0 bytes at
/// EOF」），这里和执行查询走同一个归类（`QueryError::from`）：断线、取不到连接
/// 都带上前端认得的码，数据库报的错带着 SQLSTATE / 错误号，和 SQL Server、Oracle
/// 的目录命令返回同一个形状
pub async fn select(
  pool: &DbPool,
  sql: &str,
  params: Vec<JsonValue>,
) -> Result<Vec<IndexMap<String, JsonValue>>, QueryError> {
  macro_rules! bind_like_plugin {
    ($query:ident) => {
      for value in params {
        $query = match value {
          // 插件绑的是 `None::<JsonValue>`，PostgreSQL 把它当 jsonb：界面没写 schema 时发的
          // null 撞上 `COALESCE($2, current_schema())`，报 `COALESCE types jsonb and name
          // cannot be matched`。这里的参数只有表名、schema 这类名字，按文本绑
          JsonValue::Null => $query.bind(None::<String>),
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
            let raw = row.try_get_raw(index).map_err(QueryError::from)?;
            values.insert(column.name().to_string(), $to_json(raw).map_err(QueryError::message)?);
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
      let rows = query.fetch_all(pool).await.map_err(QueryError::from)?;
      decode_rows!(rows, mysql_to_json)
    }
    DbPool::Postgres(pool) => {
      let mut query = sqlx::query(sql);
      bind_like_plugin!(query);
      let rows = query.fetch_all(pool).await.map_err(QueryError::from)?;
      decode_rows!(rows, postgres_to_json)
    }
    // 界面的 SQLite 目录查询走插件；命令行不起插件，走这里（`cli::session`）
    DbPool::Sqlite(pool) => {
      let mut query = sqlx::query(sql);
      bind_like_plugin!(query);
      let rows = query.fetch_all(pool).await.map_err(QueryError::from)?;
      decode_rows!(rows, sqlite_to_json)
    }
  }
}

/// SQLite 的值只有五种存储类：目录查询里出现的是名字、类型名、序号与 0/1
fn sqlite_to_json(value: sqlx::sqlite::SqliteValueRef<'_>) -> Result<JsonValue, String> {
  use sqlx::{Decode, Sqlite, TypeInfo, ValueRef};
  if value.is_null() {
    return Ok(JsonValue::Null);
  }
  let kind = value.type_info().name().to_string();
  let decoded = match kind.as_str() {
    "INTEGER" => <i64 as Decode<Sqlite>>::decode(value).map(JsonValue::from),
    "REAL" => <f64 as Decode<Sqlite>>::decode(value).map(JsonValue::from),
    "BLOB" => <Vec<u8> as Decode<Sqlite>>::decode(value)
      .map(|bytes| JsonValue::String(bytes.iter().map(|byte| format!("{byte:02x}")).collect())),
    _ => <String as Decode<Sqlite>>::decode(value).map(JsonValue::String),
  };
  decoded.map_err(|error| format!("{kind}: {error}"))
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

  /// R7-mac：主机不回应时，「测试连接」等 30 秒之后印的是驱动原话
  /// 「pool timed out while waiting for an open connection」，读的人不知道是主机的事
  #[test]
  fn opening_names_a_silent_host_as_a_connect_timeout() {
    assert!(describe_open_error(&sqlx::Error::PoolTimedOut).starts_with(CONNECT_TIMED_OUT));
    // 其余的照驱动原话：拒绝连接、认证失败这些它自己说得清
    let refused = sqlx::Error::Io(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
    assert_eq!(describe_open_error(&refused), refused.to_string());
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
