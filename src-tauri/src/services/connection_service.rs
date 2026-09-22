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

/// 送到界面上的校验错误一律写成 `CODE: 细节`。
///
/// 后端这些串是硬编码中文，英文界面上会原样印出中文——实际见过：把 SSH 私钥
/// 填进 TLS 的客户端私钥格子之后，英文界面报的是「客户端证书和私钥必须同时
/// 配置」。前端按 CODE 查文案，查不到就把整串照原样显示，所以加一个新错误
/// 而忘了配文案时，用户看到的不会比今天更糟。
///
/// 冒号后面只放**数据**（类型名、指纹、操作系统给的原因），不放句子——
/// 句子在文案目录里，数据由 `{detail}` 带进去。这个约定跟已有的
/// `SESSION_PASSWORD_REQUIRED` 是同一套。
pub const UNSUPPORTED_DATABASE: &str = "DATAOMNI_UNSUPPORTED_DATABASE";
pub const TLS_CLIENT_PAIR_REQUIRED: &str = "DATAOMNI_TLS_CLIENT_PAIR_REQUIRED";
pub const TLS_CERTIFICATES_UNSUPPORTED: &str = "DATAOMNI_TLS_CERTIFICATES_UNSUPPORTED";
pub const SQLITE_PATH_REQUIRED: &str = "DATAOMNI_SQLITE_PATH_REQUIRED";
pub const HOST_REQUIRED: &str = "DATAOMNI_HOST_REQUIRED";
pub const USERNAME_REQUIRED: &str = "DATAOMNI_USERNAME_REQUIRED";
pub const PORT_INVALID: &str = "DATAOMNI_PORT_INVALID";
pub const DATABASE_REQUIRED: &str = "DATAOMNI_DATABASE_REQUIRED";
pub const KNOWN_HOSTS_NO_HOME: &str = "DATAOMNI_KNOWN_HOSTS_NO_HOME";
pub const SSH_TUNNEL_NOT_ESTABLISHED: &str = "DATAOMNI_SSH_TUNNEL_NOT_ESTABLISHED";
/// 系统钥匙串打不开：Linux 上没装 Secret Service、或者会话不带钥匙串
pub const CREDENTIAL_STORE_UNAVAILABLE: &str = "DATAOMNI_CREDENTIAL_STORE_UNAVAILABLE";
pub const CREDENTIAL_SAVE_FAILED: &str = "DATAOMNI_CREDENTIAL_SAVE_FAILED";
pub const CREDENTIAL_DELETE_FAILED: &str = "DATAOMNI_CREDENTIAL_DELETE_FAILED";
/// 钥匙串里没有这条连接的密码。保存过密码的连接才会走到这里
pub const CREDENTIAL_MISSING: &str = "DATAOMNI_CREDENTIAL_MISSING";
/// 把明文密码迁进钥匙串时失败。数据里带的是连接名
pub const CREDENTIAL_MIGRATION_FAILED: &str = "DATAOMNI_CREDENTIAL_MIGRATION_FAILED";
pub const CONFIG_DIR_UNAVAILABLE: &str = "DATAOMNI_CONFIG_DIR_UNAVAILABLE";
/// 连接配置写盘失败。增删改共用一条：对用户来说都是「这次改动没存住」
pub const CONFIG_SAVE_FAILED: &str = "DATAOMNI_CONFIG_SAVE_FAILED";
pub const CONNECTION_NOT_FOUND: &str = "DATAOMNI_CONNECTION_NOT_FOUND";

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
      .map_err(|error| format!("{CREDENTIAL_SAVE_FAILED}: {error}"))
  }

  fn get_password(&self, profile_id: &str) -> Result<String, String> {
    credential_entry(profile_id)?
      .get_password()
      .map_err(|error| describe_credential_read_failure(&error))
  }

  fn delete_password(&self, profile_id: &str) -> Result<(), String> {
    match credential_entry(profile_id)?.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
      Err(error) => Err(format!("{CREDENTIAL_DELETE_FAILED}: {error}")),
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
      app_handle.path().app_config_dir().map_err(|e| format!("{CONFIG_DIR_UNAVAILABLE}: {e}"))?;

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
          .map_err(|error| format!("{CREDENTIAL_MIGRATION_FAILED}: {} · {error}", conn.name))?;
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

    self.save_connections().map_err(|e| format!("{CONFIG_SAVE_FAILED}: {e}"))?;

    Ok(id)
  }

  /// 更新数据库连接配置
  pub fn update_connection(
    &mut self,
    id: &str,
    mut config: ConnectionProfile,
  ) -> Result<(), String> {
    let Some(existing) = self.connections.get(id).cloned() else {
      return Err(CONNECTION_NOT_FOUND.to_string());
    };

    config.id = id.to_string();
    config.updated_at = chrono::Utc::now().to_rfc3339();
    if config.password.is_empty() {
      self.apply_existing_password_policy(&existing, &mut config)?;
    } else {
      self.persist_submitted_password(&mut config)?;
    }

    self.connections.insert(id.to_string(), config);

    self.save_connections().map_err(|e| format!("{CONFIG_SAVE_FAILED}: {e}"))?;

    Ok(())
  }

  /// 删除数据库连接配置
  pub fn delete_connection(&mut self, id: &str) -> Result<(), String> {
    let Some(connection) = self.connections.remove(id) else {
      return Err(CONNECTION_NOT_FOUND.to_string());
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
      return Err(format!("{CONFIG_SAVE_FAILED}: {error}"));
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

  /// 按 id 算连接串。有隧道的连接必须把本地转发端口传进来。
  ///
  /// 端口是参数而不是这里自己去查：建隧道是异步的，而这个类型从上到下都是
  /// 同步的校验与钥匙串读取。让调用方先拿到端口，换来的是「连接串该指向哪」
  /// 只有 `connection_string_via` 一处说了算。
  pub fn resolve_connection_string(
    &self,
    id: &str,
    tunnel_port: Option<u16>,
  ) -> Result<String, String> {
    let connection = self.connections.get(id).ok_or_else(|| CONNECTION_NOT_FOUND.to_string())?;
    let resolved = self.resolve_for_connection(connection)?;

    // 配了隧道却没有活着的隧道：这时按原地址拼串会拼出一个连得上但不是
    // 目标库的地址，或者一个查不到池子的键。两种都比直说难查
    if resolved.ssh_tunnel.is_some() && tunnel_port.is_none() {
      return Err(SSH_TUNNEL_NOT_ESTABLISHED.to_string());
    }

    Ok(resolved.connection_string_via(tunnel_port))
  }

  /// 测试数据库连接 - 实际尝试连接并返回连接字符串
  pub fn test_connection(&self, config: &ConnectionProfile) -> Result<String, String> {
    let resolved_config = self.resolve_for_connection(config)?;

    // 拼 URL 放在校验之后：校验不过的配置不该被拼成串打进日志
    let connection_string = resolved_config.connection_string_via(None);
    println!("🔗 准备测试数据库连接: {}", redact_connection_string(&connection_string));
    println!("✅ 连接配置验证通过，返回连接字符串用于前端测试");
    Ok(connection_string)
  }

  /// 校验配置、补上凭据，返回一份可以直接拼 URL 的 profile。
  ///
  /// 和 `test_connection` 分开是 SSH 隧道要的：有隧道时 URL 必须指向本地
  /// 转发端口，而那个端口要先把隧道建起来才知道——建隧道是异步的，而这里
  /// 全是同步的校验与钥匙串读取。分开之后调用方可以「先校验、再建隧道、
  /// 最后拼串」，而校验规则只有这一份。
  pub fn resolve_for_connection(
    &self,
    config: &ConnectionProfile,
  ) -> Result<ConnectionProfile, String> {
    // 第一道，也是这个方法里唯一一件与配置内容无关的事：这个类型有没有驱动。
    // 放在最前面，是因为后面每一步——读钥匙串、拼 URL、校验字段——对一个
    // 连不上的类型来说都是白做，而且做了还会给出「配置验证通过」的假象
    if !config.db_type.has_driver() {
      return Err(unsupported_database_message(&config.db_type));
    }

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

    // 基本验证。过了上面那道门只剩三种类型，真正的差别只有一个：
    // SQLite 的「库」是一个文件路径，另两种要主机、端口、账号和库名
    let database_is_blank = config.database.as_deref().unwrap_or("").is_empty();
    if matches!(config.db_type, DatabaseType::SQLite) {
      if database_is_blank {
        return Err(SQLITE_PATH_REQUIRED.to_string());
      }
    } else {
      if config.host.is_empty() {
        return Err(HOST_REQUIRED.to_string());
      }
      if config.username.is_empty() {
        return Err(USERNAME_REQUIRED.to_string());
      }
      if config.port == 0 {
        return Err(PORT_INVALID.to_string());
      }
      if database_is_blank {
        return Err(DATABASE_REQUIRED.to_string());
      }
    }

    Ok(resolved_config)
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
        .ok_or_else(|| SESSION_PASSWORD_REQUIRED.to_string())?;
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
  Entry::new(CREDENTIAL_SERVICE, profile_id)
    .map_err(|error| format!("{CREDENTIAL_STORE_UNAVAILABLE}: {error}"))
}

fn credential_ref(profile_id: &str) -> String {
  format!("{CREDENTIAL_REF_PREFIX}{profile_id}")
}

/// 没驱动时给出的那句话。
///
/// 说清三件事：哪个类型、为什么不行、现在能用什么。只说「不支持」会让用户
/// 反复检查主机和密码——那是配置问题的症状，而这里根本没走到配置。
fn unsupported_database_message(db_type: &DatabaseType) -> String {
  format!("{UNSUPPORTED_DATABASE}: {db_type:?}")
}

fn validate_tls_configuration(config: &ConnectionProfile) -> Result<(), String> {
  let has_client_certificate =
    config.client_certificate_path.as_ref().is_some_and(|path| !path.is_empty());
  let has_client_key = config.client_key_path.as_ref().is_some_and(|path| !path.is_empty());

  if has_client_certificate != has_client_key {
    return Err(TLS_CLIENT_PAIR_REQUIRED.to_string());
  }

  let has_certificate_paths =
    config.ca_certificate_path.as_ref().is_some_and(|path| !path.is_empty())
      || has_client_certificate;
  if has_certificate_paths
    && !matches!(config.db_type, DatabaseType::MySQL | DatabaseType::PostgreSQL)
  {
    return Err(TLS_CERTIFICATES_UNSUPPORTED.to_string());
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
        .ok_or_else(|| CREDENTIAL_MISSING.to_string())
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
      ssh_tunnel: None,
      created_at: "2026-09-17T00:00:00Z".to_string(),
      updated_at: "2026-09-17T00:00:00Z".to_string(),
    }
  }

  fn tunnelled(id: &str) -> ConnectionProfile {
    ConnectionProfile {
      ssh_tunnel: Some(crate::models::SshTunnelConfig {
        host: "jump.example.com".to_string(),
        port: 22,
        username: "ops".to_string(),
        private_key_path: "~/.ssh/id_rsa".to_string(),
        remote_host: Some("127.0.0.1".to_string()),
        remote_port: Some(23306),
      }),
      ..profile(id, "secret")
    }
  }

  /// 前端 `Database.load` 用的串，和后端执行查询时算的串，必须一模一样。
  ///
  /// 这是本轮实际踩到的坑：`test_connection` 那条路做了隧道重定向，
  /// `resolve_connection_string` 那条路没做，于是连上之后对象树能列出表
  /// （它走前端自己的句柄），一执行查询就报「数据库会话未连接」——因为
  /// `DbInstances` 是按连接串做键的，两份串差了 host:port。
  ///
  /// 现在两条路都走 `connection_string_via`，这一条钉住它们不再分家。
  #[test]
  fn both_paths_agree_on_the_connection_string_of_a_tunnelled_profile() {
    let config_path = temporary_config_path();
    let mut service =
      match ConnectionService::from_path(&config_path, Box::<MemoryCredentialStore>::default()) {
        Ok(service) => service,
        Err(error) => panic!("空配置应当能建起服务: {error}"),
      };

    let id = match service.create_connection(tunnelled("tunnel-1")) {
      Ok(id) => id,
      Err(error) => panic!("保存连接不该失败: {error}"),
    };

    // 前端那条路：命令层建好隧道之后拿着本地端口拼串
    let Some(saved) = service.get_connection(&id) else {
      panic!("刚存进去的连接应当取得出来");
    };
    let resolved = match service.resolve_for_connection(&saved.clone()) {
      Ok(resolved) => resolved,
      Err(error) => panic!("校验不该失败: {error}"),
    };
    let from_test_connection = resolved.connection_string_via(Some(49201));

    // 后端那条路：执行查询时按 id 重算
    let from_query_path = match service.resolve_connection_string(&id, Some(49201)) {
      Ok(url) => url,
      Err(error) => panic!("按 id 取串不该失败: {error}"),
    };

    assert_eq!(from_test_connection, from_query_path);
    assert!(from_test_connection.contains("127.0.0.1:49201"), "{from_test_connection}");
    // 原来的地址一个字都不该留下：留着就说明重定向只做了一半
    assert!(!from_test_connection.contains("localhost:5432"), "{from_test_connection}");

    let _ = std::fs::remove_file(&config_path);
  }

  /// 配了隧道却没有活着的隧道时，直说，不要拼一个连得上别处的串。
  #[test]
  fn a_tunnelled_profile_without_a_live_tunnel_says_so() {
    let config_path = temporary_config_path();
    let mut service =
      match ConnectionService::from_path(&config_path, Box::<MemoryCredentialStore>::default()) {
        Ok(service) => service,
        Err(error) => panic!("空配置应当能建起服务: {error}"),
      };

    let tunnelled_id = match service.create_connection(tunnelled("tunnel-2")) {
      Ok(id) => id,
      Err(error) => panic!("保存连接不该失败: {error}"),
    };
    assert_eq!(
      service.resolve_connection_string(&tunnelled_id, None),
      Err(SSH_TUNNEL_NOT_ESTABLISHED.to_string())
    );

    // 没配隧道的连接不受影响：传 None 就是它的正常情形
    let plain_id = match service.create_connection(profile("plain-1", "secret")) {
      Ok(id) => id,
      Err(error) => panic!("保存连接不该失败: {error}"),
    };
    let url = match service.resolve_connection_string(&plain_id, None) {
      Ok(url) => url,
      Err(error) => panic!("没有隧道的连接不该报错: {error}"),
    };
    assert!(url.contains("localhost:5432"), "{url}");

    let _ = std::fs::remove_file(&config_path);
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

    assert_eq!(validate_tls_configuration(&config), Err(TLS_CLIENT_PAIR_REQUIRED.to_string()));
  }

  /// 界面已经把这些类型的按钮置灰了，但存档里可能留着更早版本存下的配置，
  /// 而配置文件是纯文本、用户改得动。这条断言的是「界面不是唯一的门」
  #[test]
  fn refuses_database_types_that_have_no_driver() {
    let config_path = temporary_config_path();
    let service =
      ConnectionService::from_path(&config_path, Box::<MemoryCredentialStore>::default()).unwrap();

    for db_type in [
      DatabaseType::MongoDB,
      DatabaseType::Redis,
      DatabaseType::Neo4j,
      DatabaseType::DuckDB,
      DatabaseType::ClickHouse,
      DatabaseType::Elasticsearch,
    ] {
      let mut config = profile("profile-1", "secret");
      config.db_type = db_type.clone();

      let error = service.test_connection(&config).expect_err("没有驱动就不该通过");
      // 理由要说清是哪个类型：码点明「为什么」，冒号后面的数据点明「哪一个」
      assert_eq!(error, format!("{UNSUPPORTED_DATABASE}: {db_type:?}"));
    }
  }

  /// 反向：三种有驱动的类型必须仍然走完原来的校验，而不是被这道门顺手挡掉
  #[test]
  fn keeps_validating_the_three_supported_types() {
    let config_path = temporary_config_path();
    let service =
      ConnectionService::from_path(&config_path, Box::<MemoryCredentialStore>::default()).unwrap();

    let mut sqlite = profile("profile-1", "");
    sqlite.db_type = DatabaseType::SQLite;
    sqlite.database = None;
    assert_eq!(
      service.test_connection(&sqlite),
      Err(SQLITE_PATH_REQUIRED.to_string()),
      "SQLite 缺文件路径要报路径，不能报成「没有驱动」"
    );

    let mut mysql = profile("profile-1", "secret");
    mysql.db_type = DatabaseType::MySQL;
    mysql.host = String::new();
    assert_eq!(service.test_connection(&mysql), Err(HOST_REQUIRED.to_string()));
  }
}
