use crate::models::{ConnectionProfile, DatabaseType};
use keyring::Entry;
use serde_json;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const CREDENTIAL_SERVICE: &str = "DataOmni";
const CREDENTIAL_REF_PREFIX: &str = "system-keyring://connection/";
const SESSION_PASSWORD_REQUIRED: &str = "SESSION_PASSWORD_REQUIRED";

trait CredentialStore: Send + Sync {
  fn set_password(&self, profile_id: &str, password: &str) -> Result<(), String>;
  fn get_password(&self, profile_id: &str) -> Result<String, String>;
  fn delete_password(&self, profile_id: &str) -> Result<(), String>;
}

/// 把凭据读取失败翻译成用户能据以行动的说明。
///
/// macOS 在钥匙串 ACL 校验不通过时返回的原文是「用户名或密码不正确」，
/// 指向的却不是数据库账号——照搬只会把人引到错误的方向。未签名的开发
/// 构建每次重建都换一个代码签名身份，旧条目因此拒绝访问，这是最常见的成因。
fn describe_credential_read_failure(error: &keyring::Error) -> String {
  match error {
    keyring::Error::NoEntry => {
      "系统凭据库中没有这个连接的密码，请在连接配置中重新输入并保存。".to_string()
    }
    keyring::Error::PlatformFailure(cause) => format!(
      "系统凭据库拒绝了访问：{cause}。\n       常见原因是该条目由另一个版本的应用写入（未签名的开发构建每次重建都会更换签名身份），\n       在连接配置中重新输入并保存密码即可重建条目。"
    ),
    other => format!("无法从系统凭据库读取凭据: {other}"),
  }
}

struct SystemCredentialStore;

impl CredentialStore for SystemCredentialStore {
  fn set_password(&self, profile_id: &str, password: &str) -> Result<(), String> {
    credential_entry(profile_id)?
      .set_password(password)
      .map_err(|error| format!("无法将凭据保存到系统凭据库: {error}"))
  }

  fn get_password(&self, profile_id: &str) -> Result<String, String> {
    credential_entry(profile_id)?
      .get_password()
      .map_err(|error| describe_credential_read_failure(&error))
  }

  fn delete_password(&self, profile_id: &str) -> Result<(), String> {
    match credential_entry(profile_id)?.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
      Err(error) => Err(format!("无法从系统凭据库删除凭据: {error}")),
    }
  }
}

pub struct ConnectionService {
  config_path: PathBuf,
  connections: HashMap<String, ConnectionProfile>,
  credential_store: Box<dyn CredentialStore>,
  session_passwords: HashMap<String, String>,
}

impl ConnectionService {
  pub fn new(app_handle: &tauri::AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
    let app_dir =
      app_handle.path().app_config_dir().map_err(|e| format!("无法获取应用配置目录: {}", e))?;

    // 确保配置目录存在
    if !app_dir.exists() {
      fs::create_dir_all(&app_dir)?;
    }

    let config_path = app_dir.join("connections.json");
    Self::from_path(&config_path, Box::new(SystemCredentialStore))
  }

  /// 加载已保存的连接配置
  fn from_path(
    config_path: &PathBuf,
    credential_store: Box<dyn CredentialStore>,
  ) -> Result<Self, Box<dyn std::error::Error>> {
    let (connections, migrated) = Self::load_connections(config_path, credential_store.as_ref())?;
    let service = Self {
      config_path: config_path.clone(),
      connections,
      credential_store,
      session_passwords: HashMap::new(),
    };

    if migrated {
      service.save_connections()?;
    }

    Ok(service)
  }

  fn load_connections(
    config_path: &PathBuf,
    credential_store: &dyn CredentialStore,
  ) -> Result<(HashMap<String, ConnectionProfile>, bool), Box<dyn std::error::Error>> {
    if !config_path.exists() {
      return Ok((HashMap::new(), false));
    }

    let content = fs::read_to_string(config_path)?;
    let mut connections: Vec<ConnectionProfile> = serde_json::from_str(&content)?;
    let mut map = HashMap::new();
    let mut migrated = false;

    for mut conn in connections.drain(..) {
      if !conn.password.is_empty() {
        credential_store
          .set_password(&conn.id, &conn.password)
          .map_err(|error| format!("迁移连接 {} 的凭据失败: {error}", conn.name))?;
        conn.credential_ref = Some(credential_ref(&conn.id));
        conn.password.clear();
        migrated = true;
      }

      map.insert(conn.id.clone(), conn);
    }

    Ok((map, migrated))
  }

  /// 保存连接配置到文件
  fn save_connections(&self) -> Result<(), Box<dyn std::error::Error>> {
    let connections = self
      .connections
      .values()
      .map(|connection| {
        let mut value = serde_json::to_value(connection)?;
        if let Some(object) = value.as_object_mut() {
          object.remove("password");
        }
        Ok(value)
      })
      .collect::<Result<Vec<_>, serde_json::Error>>()?;
    let content = serde_json::to_string_pretty(&connections)?;
    fs::write(&self.config_path, content)?;
    Ok(())
  }

  /// 创建新的数据库连接配置
  pub fn create_connection(&mut self, mut config: ConnectionProfile) -> Result<String, String> {
    // 确保ID唯一
    if config.id.is_empty() {
      config.id = uuid::Uuid::new_v4().to_string();
    }

    // 设置默认端口
    if config.port == 0 {
      config.port = config.db_type.get_default_port();
    }

    // 更新时间戳
    config.updated_at = chrono::Utc::now().to_rfc3339();

    let id = config.id.clone();
    self.persist_submitted_password(&mut config)?;
    self.connections.insert(id.clone(), config);

    self.save_connections().map_err(|e| format!("保存连接配置失败: {}", e))?;

    Ok(id)
  }

  /// 更新数据库连接配置
  pub fn update_connection(
    &mut self,
    id: &str,
    mut config: ConnectionProfile,
  ) -> Result<(), String> {
    let Some(existing) = self.connections.get(id).cloned() else {
      return Err("连接不存在".to_string());
    };

    config.id = id.to_string();
    config.updated_at = chrono::Utc::now().to_rfc3339();
    if config.password.is_empty() {
      self.apply_existing_password_policy(&existing, &mut config)?;
    } else {
      self.persist_submitted_password(&mut config)?;
    }

    self.connections.insert(id.to_string(), config);

    self.save_connections().map_err(|e| format!("更新连接配置失败: {}", e))?;

    Ok(())
  }

  /// 删除数据库连接配置
  pub fn delete_connection(&mut self, id: &str) -> Result<(), String> {
    let Some(connection) = self.connections.remove(id) else {
      return Err("连接不存在".to_string());
    };

    if connection.credential_ref.is_some() {
      if let Err(error) = self.credential_store.delete_password(id) {
        self.connections.insert(id.to_string(), connection);
        return Err(error);
      }
    }
    self.session_passwords.remove(id);

    if let Err(error) = self.save_connections() {
      self.connections.insert(id.to_string(), connection);
      return Err(format!("删除连接配置失败: {error}"));
    }

    Ok(())
  }

  /// 获取所有连接配置
  pub fn get_connections(&self) -> Vec<ConnectionProfile> {
    self.connections.values().cloned().collect()
  }

  /// 根据ID获取连接配置
  pub fn get_connection(&self, id: &str) -> Option<&ConnectionProfile> {
    self.connections.get(id)
  }

  pub fn resolve_connection_string(&self, id: &str) -> Result<String, String> {
    let connection = self.connections.get(id).ok_or_else(|| "连接不存在".to_string())?;
    self.test_connection(connection)
  }

  /// 测试数据库连接 - 实际尝试连接并返回连接字符串
  pub fn test_connection(&self, config: &ConnectionProfile) -> Result<String, String> {
    validate_tls_configuration(config)?;

    let mut resolved_config = config.clone();
    if resolved_config.password.is_empty() && resolved_config.credential_ref.is_some() {
      resolved_config.password = self.credential_store.get_password(&resolved_config.id)?;
    } else if resolved_config.password.is_empty() && !resolved_config.save_password {
      resolved_config.password =
        self.session_passwords.get(&resolved_config.id).cloned().ok_or_else(|| {
          format!("{SESSION_PASSWORD_REQUIRED}: 此连接未保存密码，请输入本次会话密码")
        })?;
    }

    let connection_string = resolved_config.db_type.to_connection_string(&resolved_config);
    println!("🔗 准备测试数据库连接: {}", redact_connection_string(&connection_string));

    // 基本验证
    match config.db_type {
      DatabaseType::SQLite | DatabaseType::DuckDB => {
        if config.database.is_none() || config.database.as_ref().unwrap().is_empty() {
          return Err("数据库文件路径不能为空".to_string());
        }
      }
      DatabaseType::MySQL | DatabaseType::PostgreSQL | DatabaseType::ClickHouse => {
        if config.host.is_empty() {
          return Err("主机地址不能为空".to_string());
        }
        if config.username.is_empty() {
          return Err("用户名不能为空".to_string());
        }
        if config.port == 0 {
          return Err("端口号无效，必须在1-65535范围内".to_string());
        }
        if config.database.is_none() || config.database.as_ref().unwrap().is_empty() {
          return Err("数据库名不能为空".to_string());
        }
      }
      DatabaseType::MongoDB | DatabaseType::Neo4j => {
        if config.host.is_empty() {
          return Err("主机地址不能为空".to_string());
        }
        if config.port == 0 {
          return Err("端口号无效，必须在1-65535范围内".to_string());
        }
        // MongoDB 和 Neo4j 可以不需要用户名密码
      }
      DatabaseType::Redis => {
        if config.host.is_empty() {
          return Err("主机地址不能为空".to_string());
        }
        if config.port == 0 {
          return Err("端口号无效，必须在1-65535范围内".to_string());
        }
        // Redis 可以不需要用户名密码
      }
      DatabaseType::Elasticsearch => {
        if config.host.is_empty() {
          return Err("主机地址不能为空".to_string());
        }
        if config.port == 0 {
          return Err("端口号无效，必须在1-65535范围内".to_string());
        }
        // Elasticsearch 可以不需要用户名密码
      }
    }

    println!("✅ 连接配置验证通过，返回连接字符串用于前端测试");
    Ok(connection_string)
  }

  fn persist_submitted_password(&mut self, config: &mut ConnectionProfile) -> Result<(), String> {
    if config.password.is_empty() {
      config.credential_ref = None;
      return Ok(());
    }

    if config.save_password {
      self.credential_store.set_password(&config.id, &config.password)?;
      self.session_passwords.remove(&config.id);
      config.credential_ref = Some(credential_ref(&config.id));
    } else {
      if config.credential_ref.is_some() {
        self.credential_store.delete_password(&config.id)?;
      }
      self.session_passwords.insert(config.id.clone(), config.password.clone());
      config.credential_ref = None;
    }

    config.password.clear();
    Ok(())
  }

  fn apply_existing_password_policy(
    &mut self,
    existing: &ConnectionProfile,
    config: &mut ConnectionProfile,
  ) -> Result<(), String> {
    if existing.save_password == config.save_password {
      config.credential_ref = existing.credential_ref.clone();
      return Ok(());
    }

    if config.save_password {
      let password = self
        .session_passwords
        .get(&config.id)
        .cloned()
        .ok_or_else(|| format!("{SESSION_PASSWORD_REQUIRED}: 保存密码前请重新输入密码"))?;
      self.credential_store.set_password(&config.id, &password)?;
      self.session_passwords.remove(&config.id);
      config.credential_ref = Some(credential_ref(&config.id));
      return Ok(());
    }

    if existing.credential_ref.is_some() {
      let password = self.credential_store.get_password(&config.id)?;
      self.session_passwords.insert(config.id.clone(), password);
      self.credential_store.delete_password(&config.id)?;
    }
    config.credential_ref = None;
    Ok(())
  }
}

fn credential_entry(profile_id: &str) -> Result<Entry, String> {
  Entry::new(CREDENTIAL_SERVICE, profile_id).map_err(|error| format!("无法访问系统凭据库: {error}"))
}

fn credential_ref(profile_id: &str) -> String {
  format!("{CREDENTIAL_REF_PREFIX}{profile_id}")
}

fn validate_tls_configuration(config: &ConnectionProfile) -> Result<(), String> {
  let has_client_certificate =
    config.client_certificate_path.as_ref().is_some_and(|path| !path.is_empty());
  let has_client_key = config.client_key_path.as_ref().is_some_and(|path| !path.is_empty());

  if has_client_certificate != has_client_key {
    return Err("客户端证书和私钥必须同时配置".to_string());
  }

  let has_certificate_paths =
    config.ca_certificate_path.as_ref().is_some_and(|path| !path.is_empty())
      || has_client_certificate;
  if has_certificate_paths
    && !matches!(config.db_type, DatabaseType::MySQL | DatabaseType::PostgreSQL)
  {
    return Err("当前数据库驱动不支持自定义 TLS 证书".to_string());
  }

  Ok(())
}

fn redact_connection_string(connection_string: &str) -> String {
  let redacted_credentials = redact_url_credentials(connection_string);
  let Some((base, query)) = redacted_credentials.split_once('?') else {
    return redacted_credentials;
  };

  let redacted_query = query
    .split('&')
    .map(|parameter| {
      let Some((key, value)) = parameter.split_once('=') else {
        return parameter.to_string();
      };

      if is_sensitive_parameter(key) {
        format!("{key}=***")
      } else {
        format!("{key}={value}")
      }
    })
    .collect::<Vec<_>>()
    .join("&");

  format!("{base}?{redacted_query}")
}

fn redact_url_credentials(connection_string: &str) -> String {
  if let Some(start) = connection_string.find("://") {
    if let Some(at_pos) = connection_string[start + 3..].find('@') {
      let prefix = &connection_string[..start + 3];
      let suffix = &connection_string[start + 3 + at_pos..];
      if let Some(colon_pos) = connection_string[start + 3..start + 3 + at_pos].find(':') {
        let username = &connection_string[start + 3..start + 3 + colon_pos];
        return format!("{}{}:***{}", prefix, username, suffix);
      }
    }
  }
  connection_string.to_string()
}

fn is_sensitive_parameter(key: &str) -> bool {
  matches!(
    key.to_ascii_lowercase().as_str(),
    "password"
      | "passwd"
      | "pwd"
      | "token"
      | "access_token"
      | "refresh_token"
      | "api_key"
      | "apikey"
      | "secret"
  )
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::models::ConnectionEnvironment;
  use std::sync::Mutex;

  #[derive(Default)]
  struct MemoryCredentialStore {
    passwords: Mutex<HashMap<String, String>>,
  }

  impl CredentialStore for MemoryCredentialStore {
    fn set_password(&self, profile_id: &str, password: &str) -> Result<(), String> {
      self
        .passwords
        .lock()
        .map_err(|error| error.to_string())?
        .insert(profile_id.to_string(), password.to_string());
      Ok(())
    }

    fn get_password(&self, profile_id: &str) -> Result<String, String> {
      self
        .passwords
        .lock()
        .map_err(|error| error.to_string())?
        .get(profile_id)
        .cloned()
        .ok_or_else(|| "凭据不存在".to_string())
    }

    fn delete_password(&self, profile_id: &str) -> Result<(), String> {
      self.passwords.lock().map_err(|error| error.to_string())?.remove(profile_id);
      Ok(())
    }
  }

  fn profile(id: &str, password: &str) -> ConnectionProfile {
    ConnectionProfile {
      id: id.to_string(),
      name: "Local PostgreSQL".to_string(),
      db_type: DatabaseType::PostgreSQL,
      host: "localhost".to_string(),
      port: 5432,
      database: Some("postgres".to_string()),
      username: "postgres".to_string(),
      password: password.to_string(),
      ssl: false,
      tls_mode: None,
      ca_certificate_path: None,
      client_certificate_path: None,
      client_key_path: None,
      save_password: true,
      options: HashMap::new(),
      tags: Vec::new(),
      environment: ConnectionEnvironment::Development,
      credential_ref: None,
      created_at: "2026-09-17T00:00:00Z".to_string(),
      updated_at: "2026-09-17T00:00:00Z".to_string(),
    }
  }

  fn temporary_config_path() -> PathBuf {
    std::env::temp_dir().join(format!("dataomni-{}.json", uuid::Uuid::new_v4()))
  }

  #[test]
  fn saves_passwords_only_in_the_credential_store() {
    let config_path = temporary_config_path();
    let store = Box::<MemoryCredentialStore>::default();
    let mut service = ConnectionService::from_path(&config_path, store).unwrap();

    service.create_connection(profile("profile-1", "secret")).unwrap();

    let content = fs::read_to_string(&config_path).unwrap();
    assert!(!content.contains("secret"));
    assert!(!content.contains("\"password\""));
    assert!(content.contains("system-keyring://connection/profile-1"));

    let saved = service.get_connection("profile-1").unwrap();
    assert!(saved.password.is_empty());
    assert_eq!(
      service.test_connection(saved).unwrap(),
      "postgres://postgres:secret@localhost:5432/postgres?sslmode=disable&connect_timeout=30"
    );

    fs::remove_file(config_path).unwrap();
  }

  #[test]
  fn migrates_legacy_plaintext_passwords() {
    let config_path = temporary_config_path();
    let mut legacy_profile = serde_json::to_value(profile("profile-1", "")).unwrap();
    legacy_profile["password"] = serde_json::Value::String("legacy-secret".to_string());
    fs::write(&config_path, serde_json::to_string_pretty(&vec![legacy_profile]).unwrap()).unwrap();

    let service =
      ConnectionService::from_path(&config_path, Box::<MemoryCredentialStore>::default()).unwrap();

    let content = fs::read_to_string(&config_path).unwrap();
    assert!(!content.contains("legacy-secret"));
    assert!(!content.contains("\"password\""));
    assert_eq!(
      service.test_connection(service.get_connection("profile-1").unwrap()).unwrap(),
      "postgres://postgres:legacy-secret@localhost:5432/postgres?sslmode=disable&connect_timeout=30"
    );

    fs::remove_file(config_path).unwrap();
  }

  #[test]
  fn keeps_session_only_passwords_out_of_disk_and_system_storage() {
    let config_path = temporary_config_path();
    let store = Box::<MemoryCredentialStore>::default();
    let mut service = ConnectionService::from_path(&config_path, store).unwrap();
    let mut config = profile("profile-1", "session-secret");
    config.save_password = false;

    service.create_connection(config).unwrap();

    let content = fs::read_to_string(&config_path).unwrap();
    assert!(!content.contains("session-secret"));
    assert!(!content.contains("system-keyring://"));
    assert!(content.contains("\"save_password\": false"));
    assert!(service
      .test_connection(service.get_connection("profile-1").unwrap())
      .unwrap()
      .contains("session-secret"));

    let restarted_service =
      ConnectionService::from_path(&config_path, Box::<MemoryCredentialStore>::default()).unwrap();
    assert!(restarted_service
      .test_connection(restarted_service.get_connection("profile-1").unwrap())
      .unwrap_err()
      .starts_with(SESSION_PASSWORD_REQUIRED));

    fs::remove_file(config_path).unwrap();
  }

  #[test]
  fn redacts_connection_credentials_and_sensitive_parameters() {
    let redacted = redact_connection_string(
      "postgres://admin:secret@localhost/app?sslmode=require&token=abc123",
    );

    assert_eq!(redacted, "postgres://admin:***@localhost/app?sslmode=require&token=***");
    assert!(!redacted.contains("secret"));
    assert!(!redacted.contains("abc123"));
  }

  #[test]
  fn rejects_incomplete_client_certificate_configuration() {
    let mut config = profile("profile-1", "secret");
    config.client_certificate_path = Some("/certs/client.pem".to_string());

    assert_eq!(
      validate_tls_configuration(&config),
      Err("客户端证书和私钥必须同时配置".to_string())
    );
  }
}
