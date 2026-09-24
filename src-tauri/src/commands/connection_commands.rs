use crate::models::{ConnectionProfile, DatabaseType};
use crate::services::oracle::{self, OraclePool, OracleRegistry, OracleTarget};
use crate::services::{
  sql_server, ssh_tunnel, ConnectionService, SqlServerPool, SqlServerRegistry, SqlServerTarget,
  TunnelRegistry,
};
use std::sync::Mutex;
use tauri::{AppHandle, State};

// 全局连接服务状态
pub type ConnectionServiceState = Mutex<Option<ConnectionService>>;

/// 拿不到服务状态的锁——上一次持有它的线程 panic 了。用户无从下手，
/// 但也不该看见一句中文
pub const SERVICE_STATE_UNAVAILABLE: &str = "DATAOMNI_SERVICE_STATE_UNAVAILABLE";
/// 连接服务建不起来：读不到配置目录、配置文件坏了之类
pub const SERVICE_INIT_FAILED: &str = "DATAOMNI_SERVICE_INIT_FAILED";

/// 取连接服务，没初始化就地初始化。
///
/// 五个命令原来把同一段抄了五遍：加锁、没有就建、还是没有就报「未初始化」。
/// 抄五遍的代价不只是行数——那一段里有三条错误串，于是同一句话在文件里有
/// 十五处，而「未初始化」那一支在初始化刚刚成功之后根本不可能走到。
///
/// 这里用 `slot.insert(...)` 让「刚建好却还是 None」在类型上就不存在，
/// 不需要再写一条永远不会执行的错误分支。
fn with_service<T>(
  service_state: &State<'_, ConnectionServiceState>,
  app_handle: &AppHandle,
  action: impl FnOnce(&mut ConnectionService) -> Result<T, String>,
) -> Result<T, String> {
  let mut guard =
    service_state.lock().map_err(|error| format!("{SERVICE_STATE_UNAVAILABLE}: {error}"))?;

  let service = match &mut *guard {
    Some(service) => service,
    slot => slot.insert(
      ConnectionService::new(app_handle)
        .map_err(|error| format!("{SERVICE_INIT_FAILED}: {error}"))?,
    ),
  };

  action(service)
}

#[tauri::command]
pub async fn create_connection(
  config: ConnectionProfile,
  app_handle: AppHandle,
  service_state: State<'_, ConnectionServiceState>,
) -> Result<String, String> {
  println!("🔧 创建数据库连接: {}", config.name);

  with_service(&service_state, &app_handle, |service| service.create_connection(config))
}

#[tauri::command]
pub async fn update_connection(
  id: String,
  config: ConnectionProfile,
  app_handle: AppHandle,
  service_state: State<'_, ConnectionServiceState>,
) -> Result<(), String> {
  println!("📝 更新数据库连接: {} (ID: {})", config.name, id);

  with_service(&service_state, &app_handle, |service| service.update_connection(&id, config))
}

#[tauri::command]
pub async fn delete_connection(
  id: String,
  app_handle: AppHandle,
  service_state: State<'_, ConnectionServiceState>,
) -> Result<(), String> {
  println!("🗑️ 删除数据库连接: {}", id);

  with_service(&service_state, &app_handle, |service| service.delete_connection(&id))
}

#[tauri::command]
pub async fn get_connections(
  app_handle: AppHandle,
  service_state: State<'_, ConnectionServiceState>,
) -> Result<Vec<ConnectionProfile>, String> {
  println!("📋 获取所有数据库连接");

  with_service(&service_state, &app_handle, |service| Ok(service.get_connections()))
}

/// 连接失败之后查一遍断在哪一段。
///
/// 不经过 `ConnectionService`：这里只看主机、端口和文件路径，用不到凭据，
/// 也不该因为服务没初始化而查不成——而「连不上」的时候服务正好最可能没初始化。
#[tauri::command]
pub async fn diagnose_connection(
  config: ConnectionProfile,
) -> Result<crate::services::ConnectionDiagnosis, String> {
  println!("🩺 诊断数据库连接: {}", config.name);
  Ok(crate::services::diagnose(&config).await)
}

#[tauri::command]
pub async fn test_connection(
  config: ConnectionProfile,
  app_handle: AppHandle,
  service_state: State<'_, ConnectionServiceState>,
  tunnels: State<'_, TunnelRegistry>,
  sql_server_registry: State<'_, SqlServerRegistry>,
  oracle_registry: State<'_, OracleRegistry>,
) -> Result<String, String> {
  println!("🧪 测试数据库连接: {}", config.name);

  // 校验与读钥匙串都是同步的，锁在这个块里拿了就还——下面建隧道要 await,
  // 而跨 await 持有 std 的 MutexGuard 会把整个命令变成不可 Send
  let resolved =
    with_service(&service_state, &app_handle, |service| service.resolve_for_connection(&config))?;

  let local_port = match resolved.ssh_tunnel.clone() {
    None => None,
    Some(tunnel) => {
      let Some(known_hosts) = ssh_tunnel::default_known_hosts() else {
        return Err(crate::services::connection_service::KNOWN_HOSTS_NO_HOME.to_string());
      };
      let port = tunnels
        .ensure(&resolved, &tunnel, &known_hosts)
        .await
        .map_err(|error| error.to_string())?;
      println!("🔒 SSH 隧道已就绪: 127.0.0.1:{port} → {}:{}", tunnel.host, tunnel.port);
      Some(port)
    }
  };

  // 连接串必须和执行查询那条路算出来的**逐字节相同**（有隧道时指向本地转发
  // 端口）——两边都走 `connection_string_via`，就没有第二份实现可以走偏
  let connection_string = resolved.connection_string_via(local_port);

  // 另外三家到这里就够了：前端拿连接串去 `Database.load`，由插件去连。
  // SQL Server 不归插件管，在这里真的连上，连接留给后面的命令用
  if resolved.db_type == DatabaseType::SqlServer {
    let reachable = match local_port {
      Some(port) => resolved.redirected_to("127.0.0.1", port),
      None => resolved,
    };
    let target = SqlServerTarget::from_profile(&reachable);
    let client = sql_server::connect(&target).await.map_err(|error| error.message)?;
    let pool = SqlServerPool::new(target, client).await.map_err(|error| error.message)?;
    sql_server_registry.insert(connection_string.clone(), pool);
  } else if resolved.db_type == DatabaseType::Oracle {
    // Oracle 同样由后端持有
    let reachable = match local_port {
      Some(port) => resolved.redirected_to("127.0.0.1", port),
      None => resolved,
    };
    let target = OracleTarget::from_profile(&reachable);
    let connection = oracle::connect(&target).await.map_err(|error| error.message)?;
    oracle_registry.insert(connection_string.clone(), OraclePool::new(target, connection));
  }
  Ok(connection_string)
}

/// 为 MySQL / PostgreSQL 开池子并登记进插件的 `DbInstances`，前端随后用
/// `Database.get` 拿句柄。为什么不用插件的 `Database.load`，见 `services::sqlx_pool`
#[tauri::command]
pub async fn open_database_pool(
  connection_string: String,
  database_instances: State<'_, tauri_plugin_sql::DbInstances>,
) -> Result<(), String> {
  let pool = crate::services::sqlx_pool::open(&connection_string).await?;
  crate::services::sqlx_pool::register(&database_instances, connection_string, pool).await;
  Ok(())
}

/// MySQL / PostgreSQL 的目录查询。代替插件的 `select`：那一条持着锁等网络
#[tauri::command]
pub async fn sqlx_select(
  connection_string: String,
  sql: String,
  params: Vec<serde_json::Value>,
  database_instances: State<'_, tauri_plugin_sql::DbInstances>,
) -> Result<Vec<indexmap::IndexMap<String, serde_json::Value>>, String> {
  let pool = crate::services::sqlx_pool::shared(&database_instances, &connection_string)
    .await
    .ok_or_else(|| crate::commands::database_commands::DB_SESSION_NOT_CONNECTED.to_string())?;
  crate::services::sqlx_pool::select(&pool, &sql, params).await
}

/// 代替插件的 `close`：那一条持着锁等所有借出去的连接还回来
#[tauri::command]
pub async fn close_sqlx_pool(
  connection_string: String,
  database_instances: State<'_, tauri_plugin_sql::DbInstances>,
) -> Result<bool, String> {
  Ok(crate::services::sqlx_pool::close(&database_instances, &connection_string).await)
}

/// SQL Server 连接上的目录查询：前端对另外三家走插件的 `select`，对这一家走这里。
/// 返回的形状与插件一致——一行一个对象，值不带类型标签。
#[tauri::command]
pub async fn sql_server_select(
  connection_string: String,
  sql: String,
  params: Vec<serde_json::Value>,
  sql_server_registry: State<'_, SqlServerRegistry>,
) -> Result<Vec<crate::services::QueryRow>, crate::services::QueryError> {
  let pool = sql_server_registry.get(&connection_string).ok_or_else(|| {
    crate::services::QueryError::message(
      crate::commands::database_commands::DB_SESSION_NOT_CONNECTED,
    )
  })?;
  pool.select(&sql, &params).await
}

/// Oracle 连接上的目录查询。与 `sql_server_select` 同一个角色、同一种返回形状
#[tauri::command]
pub async fn oracle_select(
  connection_string: String,
  sql: String,
  params: Vec<serde_json::Value>,
  oracle_registry: State<'_, OracleRegistry>,
) -> Result<Vec<crate::services::QueryRow>, crate::services::QueryError> {
  let pool = oracle_registry.get(&connection_string).ok_or_else(|| {
    crate::services::QueryError::message(
      crate::commands::database_commands::DB_SESSION_NOT_CONNECTED,
    )
  })?;
  pool.select(&sql, &params).await
}

#[tauri::command]
pub fn close_oracle(connection_string: String, oracle_registry: State<'_, OracleRegistry>) -> bool {
  oracle_registry.remove(&connection_string)
}

/// 断开时把登记的池子去掉。池子里的空闲连接随之关闭；会话连接由
/// `release_database_session` 另行释放。
#[tauri::command]
pub fn close_sql_server(
  connection_string: String,
  sql_server_registry: State<'_, SqlServerRegistry>,
) -> bool {
  sql_server_registry.remove(&connection_string)
}

/// 断开连接时拆掉隧道。
///
/// 没有隧道也算成功——前端不知道某个连接有没有隧道，让它无条件调一次比
/// 让它先去问一遍简单，而多出来的代价只是一次空的 IPC。
#[tauri::command]
pub async fn close_ssh_tunnel(
  connection_id: String,
  tunnels: State<'_, TunnelRegistry>,
) -> Result<(), String> {
  tunnels.close(&connection_id).await;
  Ok(())
}
