use crate::models::ConnectionProfile;
use crate::services::ConnectionService;
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
pub fn test_connection(
  config: ConnectionProfile,
  app_handle: AppHandle,
  service_state: State<'_, ConnectionServiceState>,
) -> Result<String, String> {
  println!("🧪 测试数据库连接: {}", config.name);

  let mut service_guard = service_state.lock().map_err(|e| format!("获取服务状态失败: {}", e))?;

  // 初始化服务（如果尚未初始化）
  if service_guard.is_none() {
    let service =
      ConnectionService::new(&app_handle).map_err(|e| format!("初始化连接服务失败: {}", e))?;
    *service_guard = Some(service);
  }

  if let Some(service) = service_guard.as_ref() {
    service.test_connection(&config)
  } else {
    Err("连接服务未初始化".to_string())
  }
}
