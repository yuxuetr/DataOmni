use crate::models::ConnectionProfile;
use crate::services::{ssh_tunnel, ConnectionService, TunnelRegistry};
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
) -> Result<String, String> {
  println!("🧪 测试数据库连接: {}", config.name);

  // 校验与读钥匙串都是同步的，锁在这个块里拿了就还——下面建隧道要 await,
  // 而跨 await 持有 std 的 MutexGuard 会把整个命令变成不可 Send
  let resolved =
    with_service(&service_state, &app_handle, |service| service.resolve_for_connection(&config))?;

  let Some(tunnel) = resolved.ssh_tunnel.clone() else {
    return Ok(resolved.connection_string_via(None));
  };

  let Some(known_hosts) = ssh_tunnel::default_known_hosts() else {
    return Err(crate::services::connection_service::KNOWN_HOSTS_NO_HOME.to_string());
  };

  let local_port =
    tunnels.ensure(&resolved, &tunnel, &known_hosts).await.map_err(|error| error.to_string())?;

  // 连接串必须指向本地转发端口，而且要和执行查询那条路算出来的**逐字节
  // 相同**——两边都走 `connection_string_via`，就没有第二份实现可以走偏
  println!("🔒 SSH 隧道已就绪: 127.0.0.1:{local_port} → {}:{}", tunnel.host, tunnel.port);
  Ok(resolved.connection_string_via(Some(local_port)))
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
