use crate::models::{ConnectionProfile, DatabaseType, TlsMode};
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
/// Oracle 的 TLS（TCPS）要钱包，这一版还没接。不拦的话选了「要求 TLS」照样以明文
/// 连上，而表单上写着加密
pub const ORACLE_TLS_UNSUPPORTED: &str = "DATAOMNI_ORACLE_TLS_UNSUPPORTED";
pub const SQLITE_PATH_REQUIRED: &str = "DATAOMNI_SQLITE_PATH_REQUIRED";
/// MongoDB 按 SRV 记录连时不能再走 SSH 隧道
pub const MONGO_SRV_WITH_TUNNEL: &str = "DATAOMNI_MONGO_SRV_WITH_TUNNEL";
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
/// 钥匙串拒绝访问。最常见的成因是条目由另一个签名身份写入（未签名的开发构建
/// 每次重建都换身份），这句解释放在前端文案里
pub const CREDENTIAL_STORE_REJECTED: &str = "DATAOMNI_CREDENTIAL_STORE_REJECTED";

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
    keyring::Error::NoEntry => CREDENTIAL_MISSING.to_string(),
    keyring::Error::PlatformFailure(cause) => format!("{CREDENTIAL_STORE_REJECTED}: {cause}"),
    other => format!("{CREDENTIAL_STORE_UNAVAILABLE}: {other}"),
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
    self.persist_submitted_ssh_secret(&mut config, None)?;
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
    self.persist_submitted_ssh_secret(&mut config, Some(&existing))?;

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
    // 隧道那份也要删。漏掉的后果是钥匙串里留下一条没人认领的密钥，而用户
    // 在界面上已经看不到这个连接了
    if connection.ssh_tunnel.as_ref().is_some_and(|tunnel| tunnel.secret_ref.is_some()) {
      if let Err(error) = self.credential_store.delete_password(&ssh_credential_id(id)) {
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
    // SRV 的服务端地址在 DNS 里、可能是一组成员，一条隧道只转发一个地址。
    // 放在建隧道之前拒，不白建一条
    if config.mongo_srv() && config.ssh_tunnel.is_some() {
      return Err(MONGO_SRV_WITH_TUNNEL.to_string());
    }

    let mut resolved_config = config.clone();
    if resolved_config.password.is_empty() && resolved_config.credential_ref.is_some() {
      resolved_config.password = self.credential_store.get_password(&resolved_config.id)?;
    } else if resolved_config.password.is_empty() && !resolved_config.save_password {
      resolved_config.password = self
        .session_passwords
        .get(&resolved_config.id)
        .cloned()
        .ok_or_else(|| SESSION_PASSWORD_REQUIRED.to_string())?;
    }

    // 隧道的那份口令同样从钥匙串取。取不到就直说：拿一个空口令去解密一把
    // 有口令的私钥，报出来的会是「私钥读不了」，指向完全错误的方向
    if let Some(tunnel) = resolved_config.ssh_tunnel.as_mut() {
      if tunnel.secret.is_empty() && tunnel.secret_ref.is_some() {
        tunnel.secret = self.credential_store.get_password(&ssh_credential_id(&config.id))?;
      }
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
      // MongoDB 可以不开认证，而「库」那一格是认证库，空着就是 `admin`
      let is_mongodb = config.db_type == DatabaseType::MongoDB;
      if config.username.is_empty() && !is_mongodb {
        return Err(USERNAME_REQUIRED.to_string());
      }
      if config.port == 0 {
        return Err(PORT_INVALID.to_string());
      }
      if database_is_blank && !is_mongodb {
        return Err(DATABASE_REQUIRED.to_string());
      }
    }

    Ok(resolved_config)
  }

  /// 隧道口令落钥匙串，`config` 里只留一个引用。
  ///
  /// `existing` 是这个 profile 之前存着的那一份：编辑连接时口令那一格是空的
  /// （界面不会把存着的口令回填），空**不等于**「删掉它」。没有这一步，
  /// 改一次端口就会把口令弄丢，而表现是下一次连接报「私钥读不了」。
  fn persist_submitted_ssh_secret(
    &mut self,
    config: &mut ConnectionProfile,
    existing: Option<&ConnectionProfile>,
  ) -> Result<(), String> {
    let previous_ref =
      existing.and_then(|profile| profile.ssh_tunnel.as_ref()).and_then(|t| t.secret_ref.clone());

    let Some(tunnel) = config.ssh_tunnel.as_mut() else {
      // 隧道被关掉了，那份口令没有任何东西再用得上它。留着等于在钥匙串里
      // 攒一条没人认领的密钥
      if previous_ref.is_some() {
        self.credential_store.delete_password(&ssh_credential_id(&config.id))?;
      }
      return Ok(());
    };

    if tunnel.secret.is_empty() {
      tunnel.secret_ref = previous_ref;
      return Ok(());
    }

    self.credential_store.set_password(&ssh_credential_id(&config.id), &tunnel.secret)?;
    tunnel.secret_ref = Some(credential_ref(&ssh_credential_id(&config.id)));
    tunnel.secret.clear();
    Ok(())
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
    .map_err(|error| describe_store_unavailable(&error, Entry::store_status()))
}

/// 钥匙串打不开时，把真正的原因交出去。
///
/// keyring 只在第一次建条目时初始化一次平台存储，结果缓存到进程结束。初始化
/// 失败之后，每次 `Entry::new` 都只报一句 "No default store has been set"，
/// 真正的原因（Linux 上最常见的是没人提供 Secret Service）只留在
/// `store_status` 里。也因为这份缓存，钥匙串装好之后要重启应用才用得上——
/// 这句话在前端文案里。
fn describe_store_unavailable(
  error: &keyring::Error,
  store_status: &keyring::Result<()>,
) -> String {
  let cause = match (error, store_status) {
    (keyring::Error::NoDefaultStore, Err(init_error)) => init_error.to_string(),
    _ => error.to_string(),
  };
  format!("{CREDENTIAL_STORE_UNAVAILABLE}: {cause}")
}

fn credential_ref(profile_id: &str) -> String {
  format!("{CREDENTIAL_REF_PREFIX}{profile_id}")
}

/// SSH 的那份密钥在钥匙串里的键。
///
/// `{id}#ssh` 而不是另起一个 service 名：`#` 不会出现在 uuid 里，所以它和
/// 任何一个 profile 自己的键都撞不上，而已保存的数据库密码一条都不用迁移。
/// 见 `rfcs/ssh-tunnel.md` §4。
fn ssh_credential_id(profile_id: &str) -> String {
  format!("{profile_id}#ssh")
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
    && !matches!(
      config.db_type,
      DatabaseType::MySQL
        | DatabaseType::PostgreSQL
        | DatabaseType::SqlServer
        | DatabaseType::MongoDB
    )
  {
    return Err(TLS_CERTIFICATES_UNSUPPORTED.to_string());
  }
  // tiberius 能按 CA 校验服务端，但不带客户端证书登录——填了也不会生效，
  // 而用户会以为双向认证已经开着。MongoDB 的驱动要证书与私钥合在一个文件里，
  // 表单上是分开的两格，这一版不替用户拼
  if has_client_certificate
    && matches!(config.db_type, DatabaseType::SqlServer | DatabaseType::MongoDB)
  {
    return Err(TLS_CERTIFICATES_UNSUPPORTED.to_string());
  }
  if config.db_type == DatabaseType::Oracle
    && (config.effective_tls_mode() != TlsMode::Disabled || has_certificate_paths)
  {
    return Err(ORACLE_TLS_UNSUPPORTED.to_string());
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
    tunnelled_with_secret(id, "")
  }

  fn tunnelled_with_secret(id: &str, secret: &str) -> ConnectionProfile {
    ConnectionProfile {
      ssh_tunnel: Some(crate::models::SshTunnelConfig {
        host: "jump.example.com".to_string(),
        port: 22,
        username: "ops".to_string(),
        private_key_path: "~/.ssh/id_rsa".to_string(),
        auth: crate::models::SshAuthMethod::PrivateKey,
        secret: secret.to_string(),
        secret_ref: None,
        remote_host: Some("127.0.0.1".to_string()),
        remote_port: Some(23306),
      }),
      ..profile(id, "secret")
    }
  }

  /// 隧道的口令和数据库密码是**两条**钥匙串条目，键不同、互不覆盖。
  ///
  /// 同一个键的后果是后写的那一份把先写的顶掉：改一次 SSH 口令，数据库
  /// 密码就没了，而报出来的是「认证失败」。
  #[test]
  fn the_ssh_secret_gets_its_own_key_and_never_touches_disk() {
    let config_path = temporary_config_path();
    let store = Box::<MemoryCredentialStore>::default();
    let mut service = match ConnectionService::from_path(&config_path, store) {
      Ok(service) => service,
      Err(error) => panic!("服务应当建得起来: {error}"),
    };

    if let Err(error) = service.create_connection(tunnelled_with_secret("profile-1", "key-pass")) {
      panic!("保存带隧道的连接不该失败: {error}");
    }

    let content = match fs::read_to_string(&config_path) {
      Ok(content) => content,
      Err(error) => panic!("配置应当读得出: {error}"),
    };
    assert!(!content.contains("key-pass"), "私钥口令不该落盘: {content}");
    assert!(content.contains("system-keyring://connection/profile-1#ssh"), "{content}");

    // 两份密钥都要取得回来，而且是各自那一份
    let saved = match service.get_connection("profile-1") {
      Some(saved) => saved.clone(),
      None => panic!("刚保存的连接应当在"),
    };
    let resolved = match service.resolve_for_connection(&saved) {
      Ok(resolved) => resolved,
      Err(error) => panic!("解析不该失败: {error}"),
    };
    assert_eq!(resolved.password, "secret", "数据库密码不该被 SSH 那份顶掉");
    match resolved.ssh_tunnel {
      Some(tunnel) => assert_eq!(tunnel.secret, "key-pass", "私钥口令应当从钥匙串取回来"),
      None => panic!("隧道配置应当还在"),
    }

    let _ = fs::remove_file(&config_path);
  }

  /// 编辑连接时口令那一格是空的——界面不会把存着的口令回填。
  /// 空**不等于**删掉它，否则改一次端口就把口令弄丢了。
  #[test]
  fn editing_a_connection_without_retyping_the_ssh_secret_keeps_it() {
    let config_path = temporary_config_path();
    let store = Box::<MemoryCredentialStore>::default();
    let mut service = match ConnectionService::from_path(&config_path, store) {
      Ok(service) => service,
      Err(error) => panic!("服务应当建得起来: {error}"),
    };

    if let Err(error) = service.create_connection(tunnelled_with_secret("profile-1", "key-pass")) {
      panic!("保存不该失败: {error}");
    }

    // 只改了端口，两个口令格都是空的
    let mut edited = tunnelled("profile-1");
    edited.password = String::new();
    if let Some(tunnel) = edited.ssh_tunnel.as_mut() {
      tunnel.port = 2222;
    }
    if let Err(error) = service.update_connection("profile-1", edited) {
      panic!("更新不该失败: {error}");
    }

    let saved = match service.get_connection("profile-1") {
      Some(saved) => saved.clone(),
      None => panic!("连接应当还在"),
    };
    let resolved = match service.resolve_for_connection(&saved) {
      Ok(resolved) => resolved,
      Err(error) => panic!("解析不该失败: {error}"),
    };
    match resolved.ssh_tunnel {
      Some(tunnel) => {
        assert_eq!(tunnel.port, 2222, "改的那一项要生效");
        assert_eq!(tunnel.secret, "key-pass", "没重填的口令不该被清掉");
      }
      None => panic!("隧道配置应当还在"),
    }

    let _ = fs::remove_file(&config_path);
  }

  /// 关掉隧道之后那份口令没有任何东西再用得上它。
  #[test]
  fn turning_the_tunnel_off_removes_its_secret() {
    let config_path = temporary_config_path();
    let store = Box::<MemoryCredentialStore>::default();
    let mut service = match ConnectionService::from_path(&config_path, store) {
      Ok(service) => service,
      Err(error) => panic!("服务应当建得起来: {error}"),
    };

    if let Err(error) = service.create_connection(tunnelled_with_secret("profile-1", "key-pass")) {
      panic!("保存不该失败: {error}");
    }

    let mut without_tunnel = profile("profile-1", "");
    without_tunnel.ssh_tunnel = None;
    if let Err(error) = service.update_connection("profile-1", without_tunnel) {
      panic!("更新不该失败: {error}");
    }

    match service.credential_store.get_password("profile-1#ssh") {
      Err(error) if error == CREDENTIAL_MISSING => {}
      other => panic!("关掉隧道之后那份口令该没了: {other:?}"),
    }
    // 数据库密码不受牵连
    match service.credential_store.get_password("profile-1") {
      Ok(password) => assert_eq!(password, "secret"),
      Err(error) => panic!("数据库密码不该被一起删掉: {error}"),
    }

    let _ = fs::remove_file(&config_path);
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

  // Ubuntu 22.04 容器里没有 Secret Service 时，界面上实际印出来的细节是
  // "No default store has been set, so cannot search or create entries"
  #[test]
  fn a_store_that_never_initialised_reports_why() {
    let init_error = keyring::Error::PlatformFailure(Box::new(std::io::Error::other(
      "org.freedesktop.secrets was not provided by any .service files",
    )));

    let message = describe_store_unavailable(&keyring::Error::NoDefaultStore, &Err(init_error));

    assert!(message.starts_with(CREDENTIAL_STORE_UNAVAILABLE), "{message}");
    assert!(message.contains("org.freedesktop.secrets was not provided"), "{message}");
    assert!(!message.contains("No default store"), "{message}");
  }

  #[test]
  fn other_entry_errors_are_reported_as_they_are() {
    let error = keyring::Error::Invalid("service".to_string(), "empty".to_string());

    let message = describe_store_unavailable(&error, &Ok(()));

    assert_eq!(message, format!("{CREDENTIAL_STORE_UNAVAILABLE}: {error}"));
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

  /// MongoDB 可以不开认证，「库」那一格是认证库、空着就是 admin；两条都不该被
  /// 关系库那套「必须有用户名、必须有库名」拦下。反向：关系库照旧要
  #[test]
  fn mongodb_needs_neither_a_username_nor_a_database() {
    let config_path = temporary_config_path();
    let service =
      ConnectionService::from_path(&config_path, Box::<MemoryCredentialStore>::default()).unwrap();
    let mut config = profile("profile-1", "");
    config.db_type = DatabaseType::MongoDB;
    config.username = String::new();
    config.database = None;
    let resolved = service.resolve_for_connection(&config).unwrap();
    assert_eq!(resolved.connection_string_via(None), "mongodb://@localhost:5432/admin");

    let mut relational = profile("profile-2", "secret");
    relational.username = String::new();
    assert_eq!(
      service.resolve_for_connection(&relational).err(),
      Some(USERNAME_REQUIRED.to_string())
    );
  }

  /// SRV 的连接串没有端口（地址在 DNS 里），和同一台主机的直连是两个键；
  /// 再挂一条隧道就拒——隧道只转发一个地址，而 SRV 给的是一组
  #[test]
  fn a_mongodb_srv_profile_has_no_port_and_no_tunnel() {
    let config_path = temporary_config_path();
    let service =
      ConnectionService::from_path(&config_path, Box::<MemoryCredentialStore>::default()).unwrap();
    let mut config = profile("profile-1", "");
    config.db_type = DatabaseType::MongoDB;
    config.host = "cluster0.example.net".to_string();
    config.database = None;
    config.options.insert(crate::models::MONGO_SRV_OPTION.to_string(), "true".to_string());
    let resolved = service.resolve_for_connection(&config).unwrap();
    assert_eq!(
      resolved.connection_string_via(None),
      "mongodb+srv://postgres@cluster0.example.net/"
    );

    let tunnelled = ConnectionProfile { ssh_tunnel: tunnelled("profile-1").ssh_tunnel, ..config };
    assert_eq!(
      service.resolve_for_connection(&tunnelled).err(),
      Some(MONGO_SRV_WITH_TUNNEL.to_string())
    );
  }

  /// 界面已经把这些类型的按钮置灰了，但存档里可能留着更早版本存下的配置，
  /// 而配置文件是纯文本、用户改得动。这条断言的是「界面不是唯一的门」
  #[test]
  fn refuses_database_types_that_have_no_driver() {
    let config_path = temporary_config_path();
    let service =
      ConnectionService::from_path(&config_path, Box::<MemoryCredentialStore>::default()).unwrap();

    for db_type in [
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
