use crate::models::ConnectionProfile;
use crate::services::{ssh_tunnel, ConnectionService, TunnelRegistry};
use std::sync::Mutex;
use tauri::{AppHandle, State};

// 全局连接服务状态
pub type ConnectionServiceState = Mutex<Option<ConnectionService>>;

#[tauri::command]
pub async fn create_connection(
  config: ConnectionProfile,
  app_handle: AppHandle,
  service_state: State<'_, ConnectionServiceState>,
) -> Result<String, String> {
  println!("🔧 创建数据库连接: {}", config.name);

  let mut service_guard = service_state.lock().map_err(|e| format!("获取服务状态失败: {}", e))?;

  // 初始化服务（如果尚未初始化）
  if service_guard.is_none() {
    let service =
      ConnectionService::new(&app_handle).map_err(|e| format!("初始化连接服务失败: {}", e))?;
    *service_guard = Some(service);
  }

  if let Some(service) = service_guard.as_mut() {
    service.create_connection(config)
  } else {
    Err("连接服务未初始化".to_string())
  }
}

#[tauri::command]
pub async fn update_connection(
  id: String,
  config: ConnectionProfile,
  app_handle: AppHandle,
  service_state: State<'_, ConnectionServiceState>,
) -> Result<(), String> {
  println!("📝 更新数据库连接: {} (ID: {})", config.name, id);

  let mut service_guard = service_state.lock().map_err(|e| format!("获取服务状态失败: {}", e))?;

  // 初始化服务（如果尚未初始化）
  if service_guard.is_none() {
    let service =
      ConnectionService::new(&app_handle).map_err(|e| format!("初始化连接服务失败: {}", e))?;
    *service_guard = Some(service);
  }

  if let Some(service) = service_guard.as_mut() {
    service.update_connection(&id, config)
  } else {
    Err("连接服务未初始化".to_string())
  }
}

#[tauri::command]
pub async fn delete_connection(
  id: String,
  app_handle: AppHandle,
  service_state: State<'_, ConnectionServiceState>,
) -> Result<(), String> {
  println!("🗑️ 删除数据库连接: {}", id);

  let mut service_guard = service_state.lock().map_err(|e| format!("获取服务状态失败: {}", e))?;

  // 初始化服务（如果尚未初始化）
  if service_guard.is_none() {
    let service =
      ConnectionService::new(&app_handle).map_err(|e| format!("初始化连接服务失败: {}", e))?;
    *service_guard = Some(service);
  }

  if let Some(service) = service_guard.as_mut() {
    service.delete_connection(&id)
  } else {
    Err("连接服务未初始化".to_string())
  }
}

#[tauri::command]
pub async fn get_connections(
  app_handle: AppHandle,
  service_state: State<'_, ConnectionServiceState>,
) -> Result<Vec<ConnectionProfile>, String> {
  println!("📋 获取所有数据库连接");

  let mut service_guard = service_state.lock().map_err(|e| format!("获取服务状态失败: {}", e))?;

  // 初始化服务（如果尚未初始化）
  if service_guard.is_none() {
    let service =
      ConnectionService::new(&app_handle).map_err(|e| format!("初始化连接服务失败: {}", e))?;
    *service_guard = Some(service);
  }

  if let Some(service) = service_guard.as_ref() {
    Ok(service.get_connections())
  } else {
    Err("连接服务未初始化".to_string())
  }
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
  let resolved = {
    let mut service_guard = service_state.lock().map_err(|e| format!("获取服务状态失败: {}", e))?;

    // 初始化服务（如果尚未初始化）
    if service_guard.is_none() {
      let service =
        ConnectionService::new(&app_handle).map_err(|e| format!("初始化连接服务失败: {}", e))?;
      *service_guard = Some(service);
    }

    let Some(service) = service_guard.as_ref() else {
      return Err("连接服务未初始化".to_string());
    };
    service.resolve_for_connection(&config)?
  };

  let Some(tunnel) = resolved.ssh_tunnel.clone() else {
    return Ok(resolved.db_type.to_connection_string(&resolved));
  };

  let Some(known_hosts) = ssh_tunnel::default_known_hosts() else {
    return Err(crate::services::connection_service::KNOWN_HOSTS_NO_HOME.to_string());
  };

  let local_port =
    tunnels.ensure(&resolved, &tunnel, &known_hosts).await.map_err(|error| error.to_string())?;

  // 连接串必须指向本地转发端口。不改的话隧道建起来了却没人走它，
  // 而库要是恰好也能直连，这个功能看起来就是好的
  let local = resolved.redirected_to("127.0.0.1", local_port);
  println!("🔒 SSH 隧道已就绪: 127.0.0.1:{local_port} → {}:{}", tunnel.host, tunnel.port);
  Ok(local.db_type.to_connection_string(&local))
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
