//! AI 设计用到的命令。
//!
//! 命令本身在所有构建里都注册，没开 `ai` feature 时一律返回 [`AI_NOT_IN_BUILD`]——
//! 发往模型服务的代码（`services::ai`）不在那种构建的二进制里。前端先问
//! [`ai_available`]，没有就不显示任何 AI 入口。

use crate::services::QueryError;

/// 这个构建没有编进 AI（`--no-default-features` 的内网构建）
#[cfg(not(feature = "ai"))]
pub const AI_NOT_IN_BUILD: &str = "DATAOMNI_AI_NOT_IN_BUILD";

/// Key 在钥匙串里的账户名。同一个服务名下，`#` 开头不会和连接的 uuid 撞上（`#ssh` 同理）。
/// 一次只存一份：换一家模型服务就重新填 Key
#[cfg(feature = "ai")]
const AI_KEY_ACCOUNT: &str = "#ai";

#[tauri::command]
pub fn ai_available() -> bool {
  cfg!(feature = "ai")
}

#[cfg(feature = "ai")]
#[tauri::command]
pub async fn ai_complete(request: crate::services::ai::AiRequest) -> Result<String, QueryError> {
  use crate::services::connection_service::{credential_entry, describe_credential_read_failure};
  let key = credential_entry(AI_KEY_ACCOUNT)
    .and_then(|entry| {
      entry.get_password().map_err(|error| describe_credential_read_failure(&error))
    })
    .map_err(QueryError::message)?;
  crate::services::ai::complete(&request, &key).await
}

#[cfg(not(feature = "ai"))]
#[tauri::command]
pub async fn ai_complete(request: serde_json::Value) -> Result<String, QueryError> {
  let _ = request;
  Err(QueryError::message(AI_NOT_IN_BUILD))
}

/// 存 Key。空串等于删掉：设置里清空那一格再保存，就是不想留着它
#[tauri::command]
pub fn ai_save_key(key: String) -> Result<(), String> {
  #[cfg(feature = "ai")]
  {
    use crate::services::connection_service::{
      credential_entry, CREDENTIAL_DELETE_FAILED, CREDENTIAL_SAVE_FAILED,
    };
    let entry = credential_entry(AI_KEY_ACCOUNT)?;
    let key = key.trim();
    if key.is_empty() {
      return match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("{CREDENTIAL_DELETE_FAILED}: {error}")),
      };
    }
    entry.set_password(key).map_err(|error| format!("{CREDENTIAL_SAVE_FAILED}: {error}"))
  }
  #[cfg(not(feature = "ai"))]
  {
    let _ = key;
    Err(AI_NOT_IN_BUILD.to_string())
  }
}

/// 钥匙串里有没有 Key。只回答有没有，Key 本身不回到界面上
#[tauri::command]
pub fn ai_has_key() -> Result<bool, String> {
  #[cfg(feature = "ai")]
  {
    use crate::services::connection_service::{credential_entry, describe_credential_read_failure};
    match credential_entry(AI_KEY_ACCOUNT)?.get_password() {
      Ok(_) => Ok(true),
      Err(keyring::Error::NoEntry) => Ok(false),
      Err(error) => Err(describe_credential_read_failure(&error)),
    }
  }
  #[cfg(not(feature = "ai"))]
  {
    Ok(false)
  }
}
