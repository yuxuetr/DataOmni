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

/// 钥匙串里没有 Key：还没在设置里填。连接那句 `CREDENTIAL_MISSING` 说的是「这个连接的密码」，
/// 放在这里指错了地方
#[cfg(feature = "ai")]
pub const AI_KEY_MISSING: &str = "DATAOMNI_AI_KEY_MISSING";
/// Key 没存进钥匙串。和连接的密码不同：密码存不进去，这次还能照用；Key 存不进去，
/// AI 就用不了，也没有「不保存、每次输入」这条退路
#[cfg(feature = "ai")]
pub const AI_KEY_SAVE_FAILED: &str = "DATAOMNI_AI_KEY_SAVE_FAILED";

/// 读 Key 失败的说明：没有条目单说，其余（锁着、被拒）与连接的密码是同一回事
#[cfg(feature = "ai")]
fn describe_key_read_failure(error: &keyring::Error) -> String {
  match error {
    keyring::Error::NoEntry => AI_KEY_MISSING.to_string(),
    other => crate::services::connection_service::describe_credential_read_failure(other),
  }
}

#[tauri::command]
pub fn ai_available() -> bool {
  cfg!(feature = "ai")
}

#[cfg(feature = "ai")]
#[tauri::command]
pub async fn ai_complete(request: crate::services::ai::AiRequest) -> Result<String, QueryError> {
  use crate::services::connection_service::credential_entry;
  let key = credential_entry(AI_KEY_ACCOUNT)
    .and_then(|entry| entry.get_password().map_err(|error| describe_key_read_failure(&error)))
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
    use crate::services::connection_service::{credential_entry, CREDENTIAL_DELETE_FAILED};
    let entry = credential_entry(AI_KEY_ACCOUNT)?;
    let key = key.trim();
    if key.is_empty() {
      return match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("{CREDENTIAL_DELETE_FAILED}: {error}")),
      };
    }
    entry.set_password(key).map_err(|error| format!("{AI_KEY_SAVE_FAILED}: {error}"))
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

#[cfg(all(test, feature = "ai"))]
mod tests {
  use super::*;

  #[test]
  fn a_missing_key_says_so_instead_of_blaming_a_connection_password() {
    assert_eq!(describe_key_read_failure(&keyring::Error::NoEntry), AI_KEY_MISSING);
  }
}
