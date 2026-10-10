use crate::models::{ConnectionProfile, DatabaseType, TlsMode};
use hmac::{Hmac, Mac};
use keyring::Entry;
use serde::Deserialize;
use serde_json;
use sha2::Sha256;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

pub(crate) const CREDENTIAL_SERVICE: &str = "DataOmni";
/// 连接配置的文件名，放在应用的配置目录下（见 [`app_config_dir`]）
const CONNECTIONS_FILE: &str = "connections.json";
/// `tauri.conf.json` 的 `identifier`。Tauri 的 `app_config_dir` 就是系统配置目录下的这一层；
/// 命令行不起 Tauri，自己算同一个目录。两边一致由测试钉住
pub const APP_IDENTIFIER: &str = "com.dataomni.app";

/// 和 Tauri 的 `PathResolver::app_config_dir` 同一个算法
pub fn app_config_dir() -> Option<PathBuf> {
  dirs::config_dir().map(|dir| dir.join(APP_IDENTIFIER))
}

/// 开放凭证在钥匙串里的账号名（`rfcs/agent-cli.md` §5.4）
fn agent_grant_id(profile_id: &str) -> String {
  format!("{profile_id}#agent")
}

/// 凭证覆盖的那些字段：改了其中任何一项（比如把开发连接的主机换成生产库），旧凭证作废
fn agent_fingerprint(profile: &ConnectionProfile) -> String {
  let tunnel = profile.ssh_tunnel.as_ref();
  serde_json::json!([
    "dataomni-agent-read-v1",
    profile.id,
    profile.db_type,
    profile.host,
    profile.port,
    profile.database,
    profile.username,
    profile.environment,
    profile.agent_access,
    tunnel.map(|tunnel| (&tunnel.host, tunnel.port, &tunnel.username)),
  ])
  .to_string()
}

fn agent_mac(secret: &str) -> Hmac<Sha256> {
  // HMAC 收任意长度的键，`new_from_slice` 不会失败
  match Hmac::<Sha256>::new_from_slice(secret.as_bytes()) {
    Ok(mac) => mac,
    Err(_) => unreachable!("HMAC accepts keys of any length"),
  }
}

/// 用这个连接自己的口令签它的指纹。Agent 不知道口令，就造不出凭证
fn agent_grant(profile: &ConnectionProfile, secret: &str) -> String {
  let mut mac = agent_mac(secret);
  mac.update(agent_fingerprint(profile).as_bytes());
  mac.finalize().into_bytes().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn agent_grant_matches(profile: &ConnectionProfile, secret: &str, grant: &str) -> bool {
  let bytes: Option<Vec<u8>> = (0..grant.len())
    .step_by(2)
    .map(|index| grant.get(index..index + 2).and_then(|pair| u8::from_str_radix(pair, 16).ok()))
    .collect();
  let Some(bytes) = bytes else { return false };
  let mut mac = agent_mac(secret);
  mac.update(agent_fingerprint(profile).as_bytes());
  mac.verify_slice(&bytes).is_ok()
}
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
/// MongoDB 填了单独的客户端私钥文件：它要证书与私钥合在一个文件里
pub const MONGO_CLIENT_KEY_SEPARATE: &str = "DATAOMNI_MONGO_CLIENT_KEY_SEPARATE";
/// MongoDB 选了拿证书登录（X.509），却没填客户端证书或没开 TLS
pub const MONGO_X509_NEEDS_CERTIFICATE: &str = "DATAOMNI_MONGO_X509_NEEDS_CERTIFICATE";
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
/// 钥匙串在，但这次用不了：锁着而解锁框被取消，或者（Linux）还没有默认的密钥环。
/// 与 [`CREDENTIAL_STORE_UNAVAILABLE`] 分开，是因为该做的事不同：这里再连一次、在弹框里
/// 解锁就行，不用重启应用（Ubuntu 24.04 + gnome-keyring 上验过）
pub const CREDENTIAL_STORE_LOCKED: &str = "DATAOMNI_CREDENTIAL_STORE_LOCKED";
pub const CREDENTIAL_DELETE_FAILED: &str = "DATAOMNI_CREDENTIAL_DELETE_FAILED";
/// 钥匙串里没有这条连接的密码。保存过密码的连接才会走到这里
pub const CREDENTIAL_MISSING: &str = "DATAOMNI_CREDENTIAL_MISSING";
/// 把明文密码迁进钥匙串时失败。数据里带的是连接名
pub const CREDENTIAL_MIGRATION_FAILED: &str = "DATAOMNI_CREDENTIAL_MIGRATION_FAILED";
pub const CONFIG_DIR_UNAVAILABLE: &str = "DATAOMNI_CONFIG_DIR_UNAVAILABLE";
/// 连接配置写盘失败。增删改共用一条：对用户来说都是「这次改动没存住」
pub const CONFIG_SAVE_FAILED: &str = "DATAOMNI_CONFIG_SAVE_FAILED";
pub const CONNECTION_NOT_FOUND: &str = "DATAOMNI_CONNECTION_NOT_FOUND";
/// 导入的文件不是「导出连接」写出来的。最常拿错的是 `connections.json` 本身
pub const IMPORT_NOT_CONNECTIONS_FILE: &str = "DATAOMNI_IMPORT_NOT_CONNECTIONS_FILE";
/// 文件是更新的版本导出的，这一版不认得它的格式
pub const IMPORT_NEWER_VERSION: &str = "DATAOMNI_IMPORT_NEWER_VERSION";

const EXPORT_FORMAT: &str = "dataomni-connections";
const EXPORT_VERSION: u32 = 1;

/// 导出文件的外层。带上格式名和版本：导入时认得出拿错的文件，以后改格式也认得出旧文件
#[derive(serde::Serialize, serde::Deserialize)]
struct ConnectionsDocument {
  format: String,
  version: u32,
  connections: Vec<serde_json::Value>,
}

#[derive(Debug, serde::Serialize)]
pub struct ConnectionImport {
  pub imported: usize,
  /// 本机已经有同一个连接（名字、类型、地址、库、用户都一样），没再加一份
  pub skipped: usize,
}
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
pub(crate) fn describe_credential_read_failure(error: &keyring::Error) -> String {
  match error {
    keyring::Error::NoEntry => CREDENTIAL_MISSING.to_string(),
    keyring::Error::PlatformFailure(cause) => format!("{CREDENTIAL_STORE_REJECTED}: {cause}"),
    keyring::Error::NoStorageAccess(cause) => format!("{CREDENTIAL_STORE_LOCKED}: {cause}"),
    other => format!("{CREDENTIAL_STORE_UNAVAILABLE}: {other}"),
  }
}

/// 写入失败同理：锁着 / 没有默认密钥环单独说，其余照原话
pub(crate) fn describe_credential_write_failure(error: &keyring::Error) -> String {
  match error {
    keyring::Error::NoStorageAccess(cause) => format!("{CREDENTIAL_STORE_LOCKED}: {cause}"),
    other => format!("{CREDENTIAL_SAVE_FAILED}: {other}"),
  }
}

struct SystemCredentialStore;

#[derive(Default)]
struct LoadedConnections {
  connections: HashMap<String, ConnectionProfile>,
  newer_entries: Vec<serde_json::Value>,
  unknown_fields: HashMap<String, serde_json::Map<String, serde_json::Value>>,
  /// 读的时候把明文口令挪进了钥匙串，要立刻写回一次
  migrated: bool,
}

/// 原文里有、这一版的 `ConnectionProfile` 写不出来的字段。
///
/// 拿「这一版自己会写出哪些键」来比，而不是维护一张已知字段表：结构体的每个字段都会
/// 被写出（没有 `skip_serializing_if`），表就不会和结构体对不上。`password` 也会被写出，
/// 所以老版本落盘的明文口令不会被当成「不认得的字段」再补回文件里
fn unknown_fields(
  entry: &serde_json::Value,
  conn: &ConnectionProfile,
) -> Result<serde_json::Map<String, serde_json::Value>, serde_json::Error> {
  let known = serde_json::to_value(conn)?;
  let mut unknown = serde_json::Map::new();
  if let (Some(entry), Some(known)) = (entry.as_object(), known.as_object()) {
    for (key, value) in entry {
      if !known.contains_key(key) {
        unknown.insert(key.clone(), value.clone());
      }
    }
  }
  Ok(unknown)
}

impl CredentialStore for SystemCredentialStore {
  fn set_password(&self, profile_id: &str, password: &str) -> Result<(), String> {
    credential_entry(profile_id)?
      .set_password(password)
      .map_err(|error| describe_credential_write_failure(&error))
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
  /// 更新的版本写下、这一版读不懂的连接（新的连接类型、新的环境档位……）。
  /// 界面上看不到，保存时原样写回：退回旧版再升回来，它们还在
  newer_entries: Vec<serde_json::Value>,
  /// 读得懂的连接上，更新的版本加的、这一版不认得的字段。保存时按 id 补回去
  unknown_fields: HashMap<String, serde_json::Map<String, serde_json::Value>>,
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

    let config_path = app_dir.join(CONNECTIONS_FILE);
    Self::from_path(&config_path, Box::new(SystemCredentialStore))
  }

  /// 命令行用：只读打开。旧版留下的明文口令不迁进钥匙串、文件不回写——命令行不改配置
  /// （`rfcs/agent-cli.md` §8 第 7 条）。明文口令就留在内存里照常用
  pub fn open_read_only(config_dir: &std::path::Path) -> Result<Self, Box<dyn std::error::Error>> {
    Self::read_only_at(&config_dir.join(CONNECTIONS_FILE), Box::new(SystemCredentialStore))
  }

  /// 同 `open_read_only`，凭据库是空的内存实现
  #[cfg(test)]
  pub(crate) fn open_read_only_without_keychain(
    config_dir: &std::path::Path,
  ) -> Result<Self, Box<dyn std::error::Error>> {
    Self::read_only_at(&config_dir.join(CONNECTIONS_FILE), Box::<MemoryCredentialStore>::default())
  }

  fn read_only_at(
    config_path: &PathBuf,
    credential_store: Box<dyn CredentialStore>,
  ) -> Result<Self, Box<dyn std::error::Error>> {
    let loaded = Self::load_connections(config_path, credential_store.as_ref(), false)?;
    Ok(Self {
      config_path: config_path.clone(),
      connections: loaded.connections,
      newer_entries: loaded.newer_entries,
      unknown_fields: loaded.unknown_fields,
      credential_store,
      session_passwords: HashMap::new(),
    })
  }

  /// 加载已保存的连接配置
  fn from_path(
    config_path: &PathBuf,
    credential_store: Box<dyn CredentialStore>,
  ) -> Result<Self, Box<dyn std::error::Error>> {
    let loaded = Self::load_connections(config_path, credential_store.as_ref(), true)?;
    let migrated = loaded.migrated;
    let service = Self {
      config_path: config_path.clone(),
      connections: loaded.connections,
      newer_entries: loaded.newer_entries,
      unknown_fields: loaded.unknown_fields,
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
    migrate_passwords: bool,
  ) -> Result<LoadedConnections, Box<dyn std::error::Error>> {
    let mut loaded = LoadedConnections::default();
    if !config_path.exists() {
      return Ok(loaded);
    }

    // 带上路径：读不出来时用户要去改的就是这个文件，而 serde 的报错只有行列号
    let content = fs::read_to_string(config_path)
      .map_err(|error| format!("{}: {error}", config_path.display()))?;
    // 整份不是数组才算读不出来；数组里的每一条单独解析，一条读不懂不连累其余
    let entries: Vec<serde_json::Value> = serde_json::from_str(&content)
      .map_err(|error| format!("{}: {error}", config_path.display()))?;

    for entry in entries {
      let mut conn = match ConnectionProfile::deserialize(&entry) {
        Ok(conn) => conn,
        Err(error) => {
          log::warn!("连接配置里有一条这一版读不懂，保留原样: {error}");
          loaded.newer_entries.push(entry);
          continue;
        }
      };
      let unknown = unknown_fields(&entry, &conn)?;
      if !unknown.is_empty() {
        loaded.unknown_fields.insert(conn.id.clone(), unknown);
      }
      if migrate_passwords && !conn.password.is_empty() {
        credential_store
          .set_password(&conn.id, &conn.password)
          .map_err(|error| format!("{CREDENTIAL_MIGRATION_FAILED}: {} · {error}", conn.name))?;
        conn.credential_ref = Some(credential_ref(&conn.id));
        conn.password.clear();
        loaded.migrated = true;
      }

      loaded.connections.insert(conn.id.clone(), conn);
    }

    Ok(loaded)
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
          if let Some(unknown) = self.unknown_fields.get(&connection.id) {
            for (key, field) in unknown {
              object.entry(key.clone()).or_insert_with(|| field.clone());
            }
          }
        }
        Ok(value)
      })
      .chain(self.newer_entries.iter().cloned().map(Ok))
      .collect::<Result<Vec<_>, serde_json::Error>>()?;
    let content = serde_json::to_string_pretty(&connections)?;
    // 先写旁边的 .part 再改名：`fs::write` 先截断再写，写到一半崩溃或断电就留下
    // 一个空文件，所有连接一起没了。改名在同一个目录里是原子的，和导出、备份同一个做法
    let part = self.config_path.with_extension("json.part");
    fs::write(&part, content)?;
    fs::rename(&part, &self.config_path)?;
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
    self.refresh_agent_grant(&id)?;

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
    self.refresh_agent_grant(id)?;

    Ok(())
  }

  /// 按这个连接现在的样子重写开放凭证；不开放、或者没有要保护的口令，就删掉。
  /// 在配置写盘之后做：凭证写不进去时，命令行看不见这个连接（往关的方向错）
  fn refresh_agent_grant(&self, id: &str) -> Result<(), String> {
    let grant_id = agent_grant_id(id);
    let Some(connection) = self.connections.get(id) else {
      return self.credential_store.delete_password(&grant_id);
    };
    if connection.open_to_agents() {
      if let Some(secret) = self.stored_secret(connection)? {
        return self.credential_store.set_password(&grant_id, &agent_grant(connection, &secret));
      }
    }
    self.credential_store.delete_password(&grant_id)
  }

  /// 命令行会替调用方用上、而调用方自己拿不到的口令：库口令与隧道口令。
  /// 只算存下来的（钥匙串里的，或者旧版留在文件里的明文）；只在会话里输的命令行本来就用不了
  fn stored_secret(&self, connection: &ConnectionProfile) -> Result<Option<String>, String> {
    let password = if connection.credential_ref.is_some() {
      self.credential_store.get_password(&connection.id)?
    } else {
      connection.password.clone()
    };
    let tunnel = match connection.ssh_tunnel.as_ref() {
      Some(tunnel) if tunnel.secret_ref.is_some() => {
        self.credential_store.get_password(&ssh_credential_id(&connection.id))?
      }
      Some(tunnel) => tunnel.secret.clone(),
      None => String::new(),
    };
    if password.is_empty() && tunnel.is_empty() {
      return Ok(None);
    }
    Ok(Some(format!("{password}\u{0}{tunnel}")))
  }

  /// 命令行用：这个连接开放了、而且开放凭证对得上，才交出补好凭据的连接；否则 `None`，
  /// 调用方当作没有这个连接。只改配置文件开不了门（`rfcs/agent-cli.md` §5.4）
  pub fn resolve_for_agents(
    &self,
    connection: &ConnectionProfile,
  ) -> Result<Option<ConnectionProfile>, String> {
    if !connection.open_to_agents() {
      return Ok(None);
    }
    if let Some(secret) = self.stored_secret(connection)? {
      let grant = match self.credential_store.get_password(&agent_grant_id(&connection.id)) {
        Ok(grant) => grant,
        Err(error) if error == CREDENTIAL_MISSING => return Ok(None),
        Err(error) => return Err(error),
      };
      if !agent_grant_matches(connection, &secret, &grant) {
        return Ok(None);
      }
    }
    self.resolve_for_connection(connection).map(Some)
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
    // 连接已经没了，留下的凭证什么也证明不了；删不掉也不必让删除失败
    let _ = self.credential_store.delete_password(&agent_grant_id(id));

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

  /// 把所有连接写成一份可以拿到别的机器上导入的 JSON。
  ///
  /// 口令和 SSH 密钥**不导出**：它们只在钥匙串里，写进文件就是明文落盘。存过口令的连接
  /// 在文件里写成「不保存口令」，导入后第一次连接时会问——而不是带着一个取不到的钥匙串
  /// 引用，连的时候报「钥匙串里没有这条」。本机的 id 与时间戳也不带，导入时重新生成
  pub fn export_document(&self) -> Result<String, String> {
    let mut connections = self.connections.values().cloned().collect::<Vec<_>>();
    connections.sort_by(|left, right| left.name.cmp(&right.name));
    let connections = connections
      .into_iter()
      .map(|mut connection| {
        if connection.credential_ref.is_some() {
          connection.save_password = false;
        }
        let mut value = serde_json::to_value(&connection).map_err(|error| error.to_string())?;
        if let Some(object) = value.as_object_mut() {
          for key in ["id", "password", "credential_ref", "created_at", "updated_at"] {
            object.remove(key);
          }
          if let Some(tunnel) =
            object.get_mut("ssh_tunnel").and_then(|tunnel| tunnel.as_object_mut())
          {
            tunnel.remove("secret");
            tunnel.remove("secret_ref");
          }
        }
        Ok(value)
      })
      .collect::<Result<Vec<_>, String>>()?;
    let document = ConnectionsDocument {
      format: EXPORT_FORMAT.to_string(),
      version: EXPORT_VERSION,
      connections,
    };
    serde_json::to_string_pretty(&document).map_err(|error| error.to_string())
  }

  /// 导入 [`Self::export_document`] 写出的文件。每个连接拿新 id；本机已有的同一个连接跳过，
  /// 同一个文件导两次不会多出一份。整个文件先全部读懂再写：有一条读不懂就一条都不加
  pub fn import_document(&mut self, content: &str) -> Result<ConnectionImport, String> {
    let document: ConnectionsDocument = serde_json::from_str(content)
      .map_err(|error| format!("{IMPORT_NOT_CONNECTIONS_FILE}: {error}"))?;
    if document.format != EXPORT_FORMAT {
      return Err(format!("{IMPORT_NOT_CONNECTIONS_FILE}: {}", document.format));
    }
    if document.version > EXPORT_VERSION {
      return Err(format!("{IMPORT_NEWER_VERSION}: {}", document.version));
    }
    let incoming = document
      .connections
      .into_iter()
      .map(serde_json::from_value::<ConnectionProfile>)
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| format!("{IMPORT_NOT_CONNECTIONS_FILE}: {error}"))?;

    let same = |left: &ConnectionProfile, right: &ConnectionProfile| {
      left.name == right.name
        && left.db_type == right.db_type
        && left.host == right.host
        && left.port == right.port
        && left.database == right.database
        && left.username == right.username
    };
    let now = chrono::Utc::now().to_rfc3339();
    let mut report = ConnectionImport { imported: 0, skipped: 0 };
    let mut added = Vec::new();
    for mut connection in incoming {
      if self.connections.values().chain(added.iter()).any(|existing| same(existing, &connection)) {
        report.skipped += 1;
        continue;
      }
      connection.id = uuid::Uuid::new_v4().to_string();
      // 文件是别人给的：就算里面写了口令或钥匙串引用，也不认
      connection.password.clear();
      connection.credential_ref = None;
      connection.agent_access = crate::models::AgentAccess::Off;
      if let Some(tunnel) = connection.ssh_tunnel.as_mut() {
        tunnel.secret.clear();
        tunnel.secret_ref = None;
      }
      if connection.port == 0 {
        connection.port = connection.db_type.get_default_port();
      }
      connection.created_at = now.clone();
      connection.updated_at = now.clone();
      added.push(connection);
    }

    report.imported = added.len();
    if added.is_empty() {
      return Ok(report);
    }
    let ids = added.iter().map(|connection| connection.id.clone()).collect::<Vec<_>>();
    for connection in added {
      self.connections.insert(connection.id.clone(), connection);
    }
    if let Err(error) = self.save_connections() {
      for id in ids {
        self.connections.remove(&id);
      }
      return Err(format!("{CONFIG_SAVE_FAILED}: {error}"));
    }
    Ok(report)
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
    log::debug!("准备测试连接: {}", redact_connection_string(&connection_string));
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
    } else if resolved_config.password.is_empty()
      && !resolved_config.save_password
      // 还没存过的（新建表单里测）不可能有这次会话的口令：表单里空着就是没有
      && self.connections.contains_key(&resolved_config.id)
    {
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

    // 基本验证。真正的差别只有一个：SQLite 与 DuckDB 的「库」是一个文件路径，
    // 其余的要主机、端口、账号和库名
    let database_is_blank = config.database.as_deref().unwrap_or("").is_empty();
    if matches!(config.db_type, DatabaseType::SQLite | DatabaseType::DuckDB) {
      if database_is_blank {
        return Err(SQLITE_PATH_REQUIRED.to_string());
      }
    } else {
      if config.host.is_empty() {
        return Err(HOST_REQUIRED.to_string());
      }
      // MongoDB 可以不开认证，而「库」那一格是认证库，空着就是 `admin`；
      // Redis 大多只有口令（或干脆没有），用户名是 6.0 的 ACL 才有的，库号空着就是 0；
      // Neo4j 可以关着认证，库空着就是这个用户的主库；Elasticsearch 同样可以关着认证；
      // ClickHouse 用户名空着是 `default` 用户，库空着是这个用户的默认库
      let optional_login = matches!(
        config.db_type,
        DatabaseType::MongoDB
          | DatabaseType::Redis
          | DatabaseType::Neo4j
          | DatabaseType::Elasticsearch
          | DatabaseType::ClickHouse
      );
      if config.username.is_empty() && !optional_login {
        return Err(USERNAME_REQUIRED.to_string());
      }
      if config.port == 0 {
        return Err(PORT_INVALID.to_string());
      }
      if database_is_blank && !optional_login {
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
      if !config.save_password {
        self.remember_empty_session_password(&config.id);
      }
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
      if !config.save_password {
        self.remember_empty_session_password(&config.id);
      }
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
    self.remember_empty_session_password(&config.id);
    config.credential_ref = None;
    Ok(())
  }

  /// 不保存密码的连接，表单里密码空着提交就是「这次会话用空密码」。
  ///
  /// 密码提示打开的就是这张表单：不记下来，没设密码的库（Redis、不开认证的
  /// MongoDB）连一次弹一次表单，存了再连还是弹，绕不出去。已经输过的会话密码
  /// 不动——编辑表单不回显密码，空着提交在那种时候是「不改」。
  fn remember_empty_session_password(&mut self, id: &str) {
    self.session_passwords.entry(id.to_string()).or_default();
  }
}

pub(crate) fn credential_entry(profile_id: &str) -> Result<Entry, String> {
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

  // MongoDB 的驱动（和 mongosh 的 `--tlsCertificateKeyFile`）要证书与私钥在**同一个**
  // PEM 文件里，所以它只有一格。不替用户把两个文件拼成一个：那要把私钥另写一份到磁盘
  if config.db_type == DatabaseType::MongoDB {
    if has_client_key {
      return Err(MONGO_CLIENT_KEY_SEPARATE.to_string());
    }
    // 拿证书登录却没有证书（或没开 TLS、证书根本发不出去）：服务端只会回一句
    // 「认证失败」，这里先说清楚缺的是什么
    if config.mongo_x509()
      && (!has_client_certificate || config.effective_tls_mode() == TlsMode::Disabled)
    {
      return Err(MONGO_X509_NEEDS_CERTIFICATE.to_string());
    }
  } else if has_client_certificate != has_client_key {
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
        | DatabaseType::Redis
        | DatabaseType::Neo4j
        | DatabaseType::Elasticsearch
        | DatabaseType::ClickHouse
    )
  {
    return Err(TLS_CERTIFICATES_UNSUPPORTED.to_string());
  }
  // tiberius 能按 CA 校验服务端，但不带客户端证书登录——填了也不会生效，
  // 而用户会以为双向认证已经开着。Redis、Neo4j、Elasticsearch、ClickHouse 这一版同样只收 CA
  if has_client_certificate
    && matches!(
      config.db_type,
      DatabaseType::SqlServer
        | DatabaseType::Redis
        | DatabaseType::Neo4j
        | DatabaseType::Elasticsearch
        | DatabaseType::ClickHouse
    )
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

/// 测试用：不碰系统钥匙串。CI 的 Linux 上没有凭据库，读一下就报错；本机上则会去读用户的钥匙串
#[cfg(test)]
#[derive(Default)]
struct MemoryCredentialStore {
  passwords: std::sync::Mutex<HashMap<String, String>>,
}

#[cfg(test)]
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

#[cfg(test)]
mod tests {
  use super::*;
  use crate::models::ConnectionEnvironment;

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
      agent_access: crate::models::AgentAccess::Off,
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

  // gnome-keyring 锁着而解锁框被取消（原话 "prompt dismissed"），或者还没有默认的
  // 密钥环（原话 "result not returned from SS API"）：读和写都归到「锁着」那一条
  #[test]
  fn a_locked_store_is_told_apart_from_a_missing_one() {
    let locked =
      || keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("prompt dismissed")));

    let read = describe_credential_read_failure(&locked());
    let write = describe_credential_write_failure(&locked());

    assert!(read.starts_with(CREDENTIAL_STORE_LOCKED), "{read}");
    assert!(write.starts_with(CREDENTIAL_STORE_LOCKED), "{write}");
    assert!(read.contains("prompt dismissed"), "{read}");
    let other = keyring::Error::BadEncoding(vec![0xff]);
    assert!(describe_credential_write_failure(&other).starts_with(CREDENTIAL_SAVE_FAILED));
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
      "postgres://postgres:secret@localhost:5432/postgres?sslmode=disable"
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
      "postgres://postgres:legacy-secret@localhost:5432/postgres?sslmode=disable"
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
  fn an_unreadable_config_names_the_file_to_fix() {
    let config_path = temporary_config_path();
    fs::write(
      &config_path,
      // 整份读不出来（写到一半的文件、被手改坏）才报错；一条读不懂的连接不算，见
      // `connections_from_a_newer_version_neither_hide_the_others_nor_vanish_on_save`
      r#"[{"id":"a","name":"a","db_type":"mysql""#,
    )
    .unwrap();

    let error = ConnectionService::from_path(&config_path, Box::<MemoryCredentialStore>::default())
      .err()
      .unwrap()
      .to_string();
    assert!(error.contains(&config_path.display().to_string()), "{error}");
    assert!(error.contains("EOF"), "{error}");

    fs::remove_file(config_path).unwrap();
  }

  #[test]
  fn an_unsaved_connection_without_a_password_tests_with_an_empty_one() {
    // 新建表单里测一个不要口令的库（不勾保存密码）：还没存过，就不可能有这次会话的口令，
    // 表单里空着就是没有。此前报 SESSION_PASSWORD_REQUIRED，测不了
    let config_path = temporary_config_path();
    let service =
      ConnectionService::from_path(&config_path, Box::<MemoryCredentialStore>::default()).unwrap();
    let mut config = profile("", "");
    config.save_password = false;
    assert!(service.test_connection(&config).is_ok());

    fs::remove_file(config_path).ok();
  }

  #[test]
  fn an_empty_session_password_submitted_through_the_form_is_used_for_this_session() {
    let config_path = temporary_config_path();
    let mut service =
      ConnectionService::from_path(&config_path, Box::<MemoryCredentialStore>::default()).unwrap();
    let mut config = profile("profile-1", "");
    config.save_password = false;

    service.create_connection(config).unwrap();
    assert!(service.test_connection(service.get_connection("profile-1").unwrap()).is_ok());

    // 重启后照旧先问一次；提示打开的就是编辑表单，空着保存等于这次会话用空密码
    let mut restarted_service =
      ConnectionService::from_path(&config_path, Box::<MemoryCredentialStore>::default()).unwrap();
    let saved = restarted_service.get_connection("profile-1").unwrap().clone();
    assert!(restarted_service
      .test_connection(&saved)
      .unwrap_err()
      .starts_with(SESSION_PASSWORD_REQUIRED));
    restarted_service.update_connection("profile-1", saved).unwrap();
    assert!(restarted_service
      .test_connection(restarted_service.get_connection("profile-1").unwrap())
      .is_ok());

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

  /// MongoDB 的客户端证书是一个文件（证书加私钥），不成对；另给私钥文件就拒
  #[test]
  fn a_mongodb_client_certificate_is_one_file() {
    let mut config = profile("profile-1", "secret");
    config.db_type = DatabaseType::MongoDB;
    config.client_certificate_path = Some("/certs/client.pem".to_string());
    assert_eq!(validate_tls_configuration(&config), Ok(()));
    config.client_key_path = Some("/certs/client.key".to_string());
    assert_eq!(validate_tls_configuration(&config), Err(MONGO_CLIENT_KEY_SEPARATE.to_string()));
  }

  /// X.509 要有证书、要开 TLS；它的键落在 `$external`，不和同一台主机上不带凭据的
  /// 连接共用一个池子，表单上残留的用户名也不进键
  #[test]
  fn mongodb_x509_needs_a_certificate_and_keys_on_external() {
    let mut config = profile("profile-1", "");
    config.db_type = DatabaseType::MongoDB;
    config.username = "leftover".to_string();
    config.options.insert(
      crate::models::MONGO_AUTH_MECHANISM_OPTION.to_string(),
      crate::models::MONGO_X509.to_string(),
    );
    config.tls_mode = Some(TlsMode::VerifyFull);
    assert_eq!(validate_tls_configuration(&config), Err(MONGO_X509_NEEDS_CERTIFICATE.to_string()));
    config.client_certificate_path = Some("/certs/client.pem".to_string());
    assert_eq!(validate_tls_configuration(&config), Ok(()));
    config.tls_mode = Some(TlsMode::Disabled);
    assert_eq!(validate_tls_configuration(&config), Err(MONGO_X509_NEEDS_CERTIFICATE.to_string()));
    assert_eq!(config.connection_string_via(None), "mongodb://@localhost:5432/%24external");
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

  /// 「没有驱动就拒绝」那道门（`unsupported_database_message`）是给存档里的老配置、
  /// 手改的配置留的。ClickHouse 接上之后（2026-09-26）枚举里的每一种都有驱动了，这道门
  /// 暂时没有能挡的类型。以后往枚举里加一种还没接的类型时，把它加进这张单子——它会红，
  /// 那时换回「拒绝没有驱动的类型」的用例（git 里 `refuses_database_types_that_have_no_driver`）
  #[test]
  fn every_database_type_has_a_driver_for_now() {
    for db_type in [
      DatabaseType::MySQL,
      DatabaseType::PostgreSQL,
      DatabaseType::SQLite,
      DatabaseType::SqlServer,
      DatabaseType::Oracle,
      DatabaseType::MongoDB,
      DatabaseType::Redis,
      DatabaseType::Neo4j,
      DatabaseType::DuckDB,
      DatabaseType::ClickHouse,
      DatabaseType::Elasticsearch,
    ] {
      assert!(db_type.has_driver(), "{db_type:?}");
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
    let mut duckdb = sqlite.clone();
    duckdb.db_type = DatabaseType::DuckDB;
    assert_eq!(
      service.test_connection(&duckdb),
      Err(SQLITE_PATH_REQUIRED.to_string()),
      "DuckDB 同样是一个文件，缺路径要报路径，不能报成「缺主机」"
    );

    let mut mysql = profile("profile-1", "secret");
    mysql.db_type = DatabaseType::MySQL;
    mysql.host = String::new();
    assert_eq!(service.test_connection(&mysql), Err(HOST_REQUIRED.to_string()));
  }

  fn service_at(path: &PathBuf) -> ConnectionService {
    match ConnectionService::from_path(path, Box::<MemoryCredentialStore>::default()) {
      Ok(service) => service,
      Err(error) => panic!("服务应当建得起来: {error}"),
    }
  }

  /// 导出文件是拿去别的机器上用的：口令、SSH 密钥、钥匙串引用和本机的 id 都不该在里面
  #[test]
  fn exported_connections_carry_no_secrets_or_local_ids() {
    let mut service = service_at(&temporary_config_path());
    if let Err(error) = service.create_connection(tunnelled_with_secret("profile-1", "key-pass")) {
      panic!("保存不该失败: {error}");
    }

    let document = match service.export_document() {
      Ok(document) => document,
      Err(error) => panic!("导出不该失败: {error}"),
    };
    for leaked in [
      "\"secret\"",
      "key-pass",
      "system-keyring",
      "profile-1",
      "\"password\"",
      "credential_ref",
      "secret_ref",
    ] {
      assert!(!document.contains(leaked), "导出里不该有 {leaked}: {document}");
    }
    assert!(document.contains("\"format\": \"dataomni-connections\""), "{document}");
    assert!(document.contains("jump.example.com"), "隧道的地址要带上: {document}");
  }

  /// 换一台机器导入：拿到新 id，钥匙串里什么都没有；存过口令的那个连接时会问口令
  #[test]
  fn imported_connections_get_new_ids_and_ask_for_stored_passwords() {
    let mut source = service_at(&temporary_config_path());
    let mut open = profile("profile-2", "");
    open.name = "No password".to_string();
    for config in [profile("profile-1", "secret"), open] {
      if let Err(error) = source.create_connection(config) {
        panic!("保存不该失败: {error}");
      }
    }
    let document = match source.export_document() {
      Ok(document) => document,
      Err(error) => panic!("导出不该失败: {error}"),
    };

    let mut target = service_at(&temporary_config_path());
    let report = match target.import_document(&document) {
      Ok(report) => report,
      Err(error) => panic!("导入不该失败: {error}"),
    };
    assert_eq!((report.imported, report.skipped), (2, 0));

    let imported = target.get_connections();
    let stored = imported.iter().find(|config| config.name == "Local PostgreSQL");
    let Some(stored) = stored else { panic!("导入的连接应当在: {imported:?}") };
    assert!(stored.id != "profile-1" && !stored.id.is_empty(), "要给新 id: {}", stored.id);
    assert_eq!((stored.host.as_str(), stored.port), ("localhost", 5432));
    assert_eq!(stored.credential_ref, None);
    assert!(!stored.save_password, "原来存了口令、文件里没有：连接时要问");
    assert_eq!(
      target.resolve_for_connection(stored).map(|resolved| resolved.password),
      Err(SESSION_PASSWORD_REQUIRED.to_string())
    );

    // 原来就没有口令的，导入后照样直接连，不凭空多问一次
    let open = imported.iter().find(|config| config.name == "No password");
    let Some(open) = open else { panic!("导入的连接应当在: {imported:?}") };
    assert!(open.save_password);
    assert_eq!(
      target.resolve_for_connection(open).map(|resolved| resolved.password),
      Ok(String::new())
    );
  }

  /// 命令行只读打开：旧版留下的明文口令照常能用，但不迁进钥匙串，文件一个字节都不变
  #[test]
  fn read_only_open_neither_migrates_nor_rewrites() {
    let path = temporary_config_path();
    let mut legacy = profile("profile-1", "plain-secret");
    legacy.credential_ref = None;
    let content = match serde_json::to_string(&vec![legacy]) {
      Ok(content) => content,
      Err(error) => panic!("{error}"),
    };
    if let Err(error) = std::fs::write(&path, &content) {
      panic!("{error}");
    }
    let store = Box::<MemoryCredentialStore>::default();
    let service = match ConnectionService::read_only_at(&path, store) {
      Ok(service) => service,
      Err(error) => panic!("只读打开不该失败: {error}"),
    };
    let Some(connection) = service.get_connection("profile-1") else { panic!("连接应当在") };
    assert_eq!(
      service.resolve_for_connection(connection).map(|resolved| resolved.password),
      Ok("plain-secret".to_string())
    );
    assert_eq!(service.credential_store.get_password("profile-1").ok(), None, "不该写进钥匙串");
    assert_eq!(std::fs::read_to_string(&path).ok(), Some(content), "文件不该被改");
    let _ = std::fs::remove_file(&path);
  }

  /// 命令行自己算配置目录，用的标识必须和打包配置里的一致，否则读到的是一个空目录
  #[test]
  fn the_identifier_matches_the_tauri_config() {
    let config: serde_json::Value =
      match serde_json::from_str(include_str!("../../tauri.conf.json")) {
        Ok(config) => config,
        Err(error) => panic!("{error}"),
      };
    assert_eq!(config["identifier"].as_str(), Some(APP_IDENTIFIER));
  }

  fn open_profile(id: &str, password: &str) -> ConnectionProfile {
    let mut config = profile(id, password);
    config.agent_access = crate::models::AgentAccess::Read;
    config
  }

  fn agent_view(service: &ConnectionService, id: &str) -> Option<ConnectionProfile> {
    let Some(connection) = service.get_connection(id) else { panic!("连接应当在: {id}") };
    match service.resolve_for_agents(connection) {
      Ok(resolved) => resolved,
      Err(error) => panic!("不该出错: {error}"),
    }
  }

  /// 界面里开放的、存了口令的连接，命令行拿得到，而且拿到的带着口令
  #[test]
  fn a_connection_opened_in_the_app_is_visible_to_agents() {
    let mut service = service_at(&temporary_config_path());
    if let Err(error) = service.create_connection(open_profile("p1", "s3cret")) {
      panic!("{error}");
    }
    let resolved = agent_view(&service, "p1");
    assert_eq!(resolved.map(|resolved| resolved.password), Some("s3cret".to_string()));
  }

  /// `rfcs/agent-cli.md` §5.4：只改文件开不了门。生产连接被改成开发环境并开放，
  /// 没有凭证，看不见
  #[test]
  fn editing_the_config_file_does_not_open_a_connection() {
    let mut service = service_at(&temporary_config_path());
    let mut production = profile("p1", "prod-secret");
    production.environment = ConnectionEnvironment::Production;
    if let Err(error) = service.create_connection(production) {
      panic!("{error}");
    }
    let Some(stored) = service.connections.get_mut("p1") else { panic!("连接应当在") };
    stored.environment = ConnectionEnvironment::Development;
    stored.agent_access = crate::models::AgentAccess::Read;
    assert!(service.connections["p1"].open_to_agents(), "文件里看起来是开放的");
    assert!(agent_view(&service, "p1").is_none());
  }

  /// 开放之后再改主机（比如指向另一台用同一套口令的库），凭证作废
  #[test]
  fn changing_what_the_grant_covers_voids_it() {
    let mut service = service_at(&temporary_config_path());
    if let Err(error) = service.create_connection(open_profile("p1", "s3cret")) {
      panic!("{error}");
    }
    let Some(stored) = service.connections.get_mut("p1") else { panic!("连接应当在") };
    stored.host = "prod.internal".to_string();
    assert!(agent_view(&service, "p1").is_none());
  }

  /// 凭证本身不保密（钥匙串条目能被删了重建），保密的是算它的口令：不知道口令就造不出来
  #[test]
  fn a_grant_forged_without_the_password_is_rejected() {
    let mut service = service_at(&temporary_config_path());
    let mut closed = profile("p1", "s3cret");
    closed.agent_access = crate::models::AgentAccess::Off;
    if let Err(error) = service.create_connection(closed) {
      panic!("{error}");
    }
    let Some(stored) = service.connections.get_mut("p1") else { panic!("连接应当在") };
    stored.agent_access = crate::models::AgentAccess::Read;
    let forged = agent_grant(&service.connections["p1"], "guessed-password");
    if let Err(error) = service.credential_store.set_password(&agent_grant_id("p1"), &forged) {
      panic!("{error}");
    }
    assert!(agent_view(&service, "p1").is_none());
  }

  /// 改成生产、改回关、删掉连接，凭证都跟着没了；改口令后凭证跟着换
  #[test]
  fn the_grant_follows_the_connection() {
    let mut service = service_at(&temporary_config_path());
    let grant = |service: &ConnectionService| {
      service.credential_store.get_password(&agent_grant_id("p1")).ok()
    };
    if let Err(error) = service.create_connection(open_profile("p1", "s3cret")) {
      panic!("{error}");
    }
    assert!(grant(&service).is_some());

    let mut renamed = open_profile("p1", "n3w-secret");
    renamed.name = "renamed".to_string();
    if let Err(error) = service.update_connection("p1", renamed) {
      panic!("{error}");
    }
    assert_eq!(
      agent_view(&service, "p1").map(|resolved| resolved.password),
      Some("n3w-secret".to_string())
    );

    // 编辑表单不回显口令，空着提交是「不改」：凭证照样要按钥匙串里的口令重算
    let mut untouched = open_profile("p1", "");
    untouched.port = 6543;
    if let Err(error) = service.update_connection("p1", untouched) {
      panic!("{error}");
    }
    assert!(agent_view(&service, "p1").is_some());

    let mut production = open_profile("p1", "");
    production.environment = ConnectionEnvironment::Production;
    if let Err(error) = service.update_connection("p1", production) {
      panic!("{error}");
    }
    assert_eq!(grant(&service), None);

    if let Err(error) = service.update_connection("p1", open_profile("p1", "")) {
      panic!("{error}");
    }
    assert!(grant(&service).is_some());
    if let Err(error) = service.delete_connection("p1") {
      panic!("{error}");
    }
    assert_eq!(grant(&service), None);
  }

  /// 没有口令的连接（SQLite 文件、免密的库）不需要凭证：Agent 不经过命令行也能直接用它们
  #[test]
  fn connections_without_secrets_need_no_grant() {
    let mut service = service_at(&temporary_config_path());
    if let Err(error) = service.create_connection(open_profile("p1", "")) {
      panic!("{error}");
    }
    assert!(agent_view(&service, "p1").is_some());
    assert_eq!(service.credential_store.get_password(&agent_grant_id("p1")).ok(), None);
  }

  /// 文件是别人给的：里面写着「开放给 Agent」也不认，导进来一律是关
  #[test]
  fn imported_connections_are_never_open_to_agents() {
    let mut source = service_at(&temporary_config_path());
    let mut open = profile("profile-1", "");
    open.agent_access = crate::models::AgentAccess::Read;
    if let Err(error) = source.create_connection(open) {
      panic!("保存不该失败: {error}");
    }
    assert!(source.get_connections().iter().all(|config| config.open_to_agents()));
    let document = match source.export_document() {
      Ok(document) => document,
      Err(error) => panic!("导出不该失败: {error}"),
    };
    let mut target = service_at(&temporary_config_path());
    if let Err(error) = target.import_document(&document) {
      panic!("导入不该失败: {error}");
    }
    let imported = target.get_connections();
    assert_eq!(imported.len(), 1);
    assert!(imported.iter().all(|config| !config.open_to_agents()), "{imported:?}");
  }

  /// 同一个文件导两次，或导回原来那台机器：已经有的不再多出一份
  #[test]
  fn importing_the_same_connections_again_skips_them() {
    let mut service = service_at(&temporary_config_path());
    if let Err(error) = service.create_connection(profile("profile-1", "secret")) {
      panic!("保存不该失败: {error}");
    }
    let document = match service.export_document() {
      Ok(document) => document,
      Err(error) => panic!("导出不该失败: {error}"),
    };

    match service.import_document(&document) {
      Ok(report) => assert_eq!((report.imported, report.skipped), (0, 1)),
      Err(error) => panic!("导入不该失败: {error}"),
    }
    assert_eq!(service.get_connections().len(), 1);
  }

  #[test]
  fn import_rejects_files_that_are_not_exported_connections() {
    let mut service = service_at(&temporary_config_path());
    // 最容易拿错的就是 connections.json 本身：它是一个数组
    let rejected = [
      ("[]", IMPORT_NOT_CONNECTIONS_FILE),
      ("{\"connections\":[]}", IMPORT_NOT_CONNECTIONS_FILE),
      ("not json", IMPORT_NOT_CONNECTIONS_FILE),
      (
        "{\"format\":\"dataomni-connections\",\"version\":2,\"connections\":[]}",
        IMPORT_NEWER_VERSION,
      ),
    ];
    for (content, code) in rejected {
      match service.import_document(content) {
        Ok(report) => panic!("{content} 不该导得进: {} 个", report.imported),
        Err(error) => assert!(error.starts_with(code), "{content}: {error}"),
      }
    }
    assert!(service.get_connections().is_empty());
  }

  /// 0.5 写出的 `connections.json`。1.0 之后它必须一直读得出来：这条红了，就是改了落盘格式而没写迁移
  const ON_DISK_0_5: &str = include_str!("../../../fixtures/on-disk-0.5/connections.json");

  fn config_with(entries: &[serde_json::Value]) -> PathBuf {
    let path = temporary_config_path();
    let content = match serde_json::to_string_pretty(entries) {
      Ok(content) => content,
      Err(error) => panic!("样本应当写得出来: {error}"),
    };
    if let Err(error) = fs::write(&path, content) {
      panic!("样本应当写得进去: {error}");
    }
    path
  }

  fn sample_entries() -> Vec<serde_json::Value> {
    match serde_json::from_str(ON_DISK_0_5) {
      Ok(entries) => entries,
      Err(error) => panic!("样本是合法 JSON: {error}"),
    }
  }

  fn entries_on_disk(path: &PathBuf) -> Vec<serde_json::Value> {
    let content = match fs::read_to_string(path) {
      Ok(content) => content,
      Err(error) => panic!("配置文件应当在: {error}"),
    };
    match serde_json::from_str(&content) {
      Ok(entries) => entries,
      Err(error) => panic!("写回的仍是数组: {error}"),
    }
  }

  #[test]
  fn connections_written_by_0_5_still_load() {
    let service = service_at(&config_with(&sample_entries()));
    let connections = service.get_connections();
    assert_eq!(connections.len(), 5);
    let tunnelled = connections.iter().find(|connection| connection.name == "MySQL via bastion");
    let tunnel = tunnelled.and_then(|connection| connection.ssh_tunnel.as_ref());
    assert_eq!(tunnel.map(|tunnel| tunnel.port), Some(2222));
    assert!(tunnel.is_some_and(|tunnel| tunnel.secret_ref.is_some()));
    let production = connections.iter().find(|connection| connection.name == "生产 PostgreSQL");
    assert_eq!(
      production.map(|connection| connection.environment.clone()),
      Some(ConnectionEnvironment::Production)
    );
    assert_eq!(production.map(|connection| connection.tls_mode), Some(Some(TlsMode::VerifyFull)));
    let mongo = connections.iter().find(|connection| connection.db_type == DatabaseType::MongoDB);
    assert_eq!(
      mongo.and_then(|connection| connection.options.get("srv")).map(String::as_str),
      Some("true")
    );
  }

  /// 以后的版本加一种连接类型、一个环境档位，用户再退回这一版：读不懂的那几条只是看不到，
  /// 其余照常；随便存一次，它们原样还在文件里——升回去就又回来了
  #[test]
  fn connections_from_a_newer_version_neither_hide_the_others_nor_vanish_on_save() {
    let mut entries = sample_entries();
    let mut newer_type = entries[0].clone();
    newer_type["id"] = "f0000000-0000-4000-8000-000000000001".into();
    newer_type["db_type"] = "dameng".into();
    let mut newer_environment = entries[1].clone();
    newer_environment["id"] = "f0000000-0000-4000-8000-000000000002".into();
    newer_environment["environment"] = "qa".into();
    entries.push(newer_type.clone());
    entries.push(newer_environment.clone());
    let path = config_with(&entries);

    let mut service = service_at(&path);
    assert_eq!(service.get_connections().len(), 5);
    if let Err(error) = service.create_connection(profile("", "")) {
      panic!("保存不该失败: {error}");
    }

    let on_disk = entries_on_disk(&path);
    assert_eq!(on_disk.len(), 8);
    assert!(on_disk.contains(&newer_type));
    assert!(on_disk.contains(&newer_environment));
  }

  /// 以后的版本给连接加一个字段，退回这一版改了这个连接：新字段不能因为这一版不认得就被存丢
  #[test]
  fn fields_from_a_newer_version_survive_an_edit() {
    let mut entries = sample_entries();
    entries[2]["folder"] = "team-a".into();
    let id = entries[2]["id"].as_str().map(str::to_string).unwrap_or_default();
    let path = config_with(&entries);

    let mut service = service_at(&path);
    let Some(mut edited) =
      service.get_connections().into_iter().find(|connection| connection.id == id)
    else {
      panic!("样本里的连接应当读得出来");
    };
    edited.name = "renamed.sqlite".to_string();
    if let Err(error) = service.update_connection(&id, edited) {
      panic!("保存不该失败: {error}");
    }

    let on_disk = entries_on_disk(&path);
    let Some(saved) = on_disk.iter().find(|entry| entry["id"] == id.as_str()) else {
      panic!("改过的连接应当还在");
    };
    assert_eq!(saved["name"], "renamed.sqlite");
    assert_eq!(saved["folder"], "team-a");
    assert!(saved.get("password").is_none());
  }
}
