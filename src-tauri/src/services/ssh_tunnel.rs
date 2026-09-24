//! SSH 隧道：本地开一个端口，转发到跳板机后面的数据库。
//!
//! 这是整个连接路径上唯一一处「连接串不是纯函数的产物」。没有隧道的时候
//! `to_connection_string` 拿 profile 算出一个字符串就完了；有隧道的时候，
//! 字符串里的 `127.0.0.1:<端口>` 背后是一条活着的 SSH 会话，要有人负责
//! 建立、复用、拆除，以及在它死掉时报出来。那个人就是 [`TunnelRegistry`]。
//!
//! 设计说明与验收标准在 `rfcs/ssh-tunnel.md`。几条刻意的边界：
//!
//! - **只监听 `127.0.0.1`。** 本地那个端口上没有任何认证，绑到 `0.0.0.0`
//!   等于把跳板机后面的数据库开放给同一个网络里的所有人。
//! - **主机密钥一定校验，没有跳过的开关。** 不校验的 SSH 客户端可以被中间人
//!   劫持，而劫持成功时功能看起来是完全正常的。
//! - **不自动重连。** 会话断了就把隧道从注册表里摘掉，下一次请求重新建立；
//!   「重连期间已经发出去的查询怎么办」是连接池的问题，不在这里回答。

use crate::models::{ConnectionProfile, SshAuthMethod, SshTunnelConfig};
use russh::client::{self, Handle};
use russh::keys::known_hosts::known_host_keys_path;
use russh::keys::{
  load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate,
};
use russh::ChannelStream;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

/// 建立会话的上限。比诊断那边的 5 秒宽一些：这里要走完 TCP、密钥交换、
/// 认证三段，而且用户是明确地在等一条隧道建起来。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// 失败的原因要分开报，因为用户的下一步完全不同：主机密钥变了是安全事件，
/// 没有记录是一次待确认的首连，认证失败是钥匙不对，连不上是网络。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TunnelError {
  /// known_hosts 里有同算法的记录，但密钥和服务器给的不一样。
  /// 这是**可能有中间人**，不是一个可以点「继续」的提示。
  /// `recorded` 是记着的那些指纹，`fingerprint` 是服务器这次给的
  HostKeyChanged {
    recorded: Vec<String>,
    fingerprint: String,
  },
  /// known_hosts 里没有这台主机。要用户看过指纹之后显式信任
  HostKeyUnknown {
    fingerprint: String,
  },
  PrivateKey {
    message: String,
  },
  /// 私钥是加密的，而没有给口令
  PrivateKeyLocked,
  /// 给了口令，但解不开这把私钥
  PrivateKeyPassphrase,
  AuthRejected,
  Ssh {
    message: String,
  },
}

impl From<russh::Error> for TunnelError {
  fn from(error: russh::Error) -> Self {
    TunnelError::Ssh { message: error.to_string() }
  }
}

/// 送到界面上的写法是 `CODE: 数据`，和 `connection_service` 里那一套一致。
///
/// 冒号后面只放数据（指纹、操作系统给的原因），句子在前端的文案目录里——
/// 否则英文界面上会印出中文，这在 TLS 那边已经真的发生过。
pub const SSH_HOST_KEY_CHANGED: &str = "DATAOMNI_SSH_HOST_KEY_CHANGED";
pub const SSH_HOST_KEY_UNKNOWN: &str = "DATAOMNI_SSH_HOST_KEY_UNKNOWN";
pub const SSH_PRIVATE_KEY_UNREADABLE: &str = "DATAOMNI_SSH_PRIVATE_KEY_UNREADABLE";
/// 私钥有口令而这里没有口令。和「读不了」分开：用户的下一步是去填那一格，
/// 不是去查文件权限
pub const SSH_PRIVATE_KEY_LOCKED: &str = "DATAOMNI_SSH_PRIVATE_KEY_LOCKED";
/// 口令不对。和「认证被拒」分开：钥匙本身没问题，是解锁它的口令错了——
/// 报成认证失败会让人去查服务器上的 authorized_keys，而那边什么事都没有
pub const SSH_PRIVATE_KEY_PASSPHRASE: &str = "DATAOMNI_SSH_PRIVATE_KEY_PASSPHRASE";
pub const SSH_AUTH_REJECTED: &str = "DATAOMNI_SSH_AUTH_REJECTED";
pub const SSH_FAILED: &str = "DATAOMNI_SSH_FAILED";
pub const SSH_HOST_KEY_CERTIFICATE: &str = "DATAOMNI_SSH_HOST_KEY_CERTIFICATE";
pub const SSH_KNOWN_HOSTS_UNREADABLE: &str = "DATAOMNI_SSH_KNOWN_HOSTS_UNREADABLE";
pub const SSH_CONNECT_TIMEOUT: &str = "DATAOMNI_SSH_CONNECT_TIMEOUT";
pub const SSH_LOCAL_PORT_UNAVAILABLE: &str = "DATAOMNI_SSH_LOCAL_PORT_UNAVAILABLE";

impl std::fmt::Display for TunnelError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      // 两个指纹之间用箭头分开：记录的在左，服务器这次给的在右。
      // 箭头不属于任何一种语言，所以可以留在数据里
      TunnelError::HostKeyChanged { recorded, fingerprint } => {
        write!(formatter, "{SSH_HOST_KEY_CHANGED}: {} → {fingerprint}", recorded.join(" / "))
      }
      TunnelError::HostKeyUnknown { fingerprint } => {
        write!(formatter, "{SSH_HOST_KEY_UNKNOWN}: {fingerprint}")
      }
      TunnelError::PrivateKey { message } => {
        write!(formatter, "{SSH_PRIVATE_KEY_UNREADABLE}: {message}")
      }
      TunnelError::PrivateKeyLocked => write!(formatter, "{SSH_PRIVATE_KEY_LOCKED}"),
      TunnelError::PrivateKeyPassphrase => write!(formatter, "{SSH_PRIVATE_KEY_PASSPHRASE}"),
      TunnelError::AuthRejected => write!(formatter, "{SSH_AUTH_REJECTED}"),
      // `message` 本身可能已经是一个码（超时、本地端口、known_hosts 读不了
      // 都是自己产生的），那时不要再套一层 `SSH_FAILED:`——前端只认开头那个码，
      // 套两层的结果是里面那个永远查不到
      TunnelError::Ssh { message } if message.starts_with("DATAOMNI_") => {
        write!(formatter, "{message}")
      }
      TunnelError::Ssh { message } => write!(formatter, "{SSH_FAILED}: {message}"),
    }
  }
}

/// 只做一件事：拿服务器给的主机密钥去比 known_hosts。
///
/// `known_hosts` 是注入的而不是写死 `~/.ssh/known_hosts`，因为三种处置
/// （匹配 / 变了 / 没记录）必须能用临时文件测出来。
struct HostKeyCheck {
  host: String,
  port: u16,
  known_hosts: PathBuf,
}

impl client::Handler for HostKeyCheck {
  type Error = TunnelError;

  async fn check_server_key(
    &mut self,
    server_public_key: &PublicKeyOrCertificate,
  ) -> Result<bool, Self::Error> {
    let PublicKeyOrCertificate::PublicKey { key, .. } = server_public_key else {
      // 证书型主机密钥要按 CA 校验，是另一套机制。没有实现就不要假装通过
      return Err(TunnelError::Ssh { message: SSH_HOST_KEY_CERTIFICATE.to_string() });
    };

    verify_host_key(&self.host, self.port, key, &self.known_hosts).map(|()| true)
  }
}

/// 三种处置：对得上、对不上、没见过。
///
/// 自己比而不用 `check_known_hosts_path`，是因为那个函数的错误里带的行号
/// 会算错——它在跳过 `#` 注释行时不给行号计数器加一，所以注释上面有几行，
/// 报出来的行号就少几。指着错的行让人去核对，比不给行号更糟。这里改成报
/// **记录着的指纹**：那正是用户要拿去比的东西，而且不依赖行的算法。
///
/// 抽成独立函数是为了能直接测——走 `client::Handler` 得先有一台服务器。
fn verify_host_key(
  host: &str,
  port: u16,
  key: &PublicKey,
  known_hosts: &Path,
) -> Result<(), TunnelError> {
  let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
  let recorded = known_host_keys_path(host, port, known_hosts).map_err(|error| {
    TunnelError::Ssh { message: format!("{SSH_KNOWN_HOSTS_UNREADABLE}: {error}") }
  })?;

  if recorded.iter().any(|(_, candidate)| candidate == key) {
    return Ok(());
  }

  // 有同算法的记录却对不上 = 密钥变了；连同算法的记录都没有 = 没见过这台
  // 主机。两者的下一步完全不同：前者要去查为什么变了，后者只需要核一次指纹。
  // 合成一句话的后果是用户要么把首连当成攻击，要么把攻击当成首连
  let conflicting: Vec<String> = recorded
    .iter()
    .filter(|(_, candidate)| candidate.algorithm() == key.algorithm())
    .map(|(_, candidate)| candidate.fingerprint(HashAlg::Sha256).to_string())
    .collect();

  if conflicting.is_empty() {
    Err(TunnelError::HostKeyUnknown { fingerprint })
  } else {
    Err(TunnelError::HostKeyChanged { recorded: conflicting, fingerprint })
  }
}

/// 一条建好的隧道。
///
/// `local_port` 是给连接串用的；`_shutdown` 一旦被 drop，转发任务就会退出——
/// 这样「拆除隧道」就是「把这个结构丢掉」，不需要额外记着调什么。
pub struct ActiveTunnel {
  pub local_port: u16,
  session: Arc<Handle<HostKeyCheck>>,
  _shutdown: tokio::sync::oneshot::Sender<()>,
}

impl ActiveTunnel {
  /// SSH 会话还活着吗。死了就该重建，而不是让用户连一个已经空掉的本地端口
  pub fn is_alive(&self) -> bool {
    !self.session.is_closed()
  }
}

/// 把开头的 `~` 换成当前用户的主目录。
///
/// 不展开的后果是一句「文件不存在」，而用户填的正是界面上占位符提示的
/// `~/.ssh/id_rsa`——命令行 `ssh` 认这个写法，没有理由这里不认。曾经的做法
/// 是在错误里写「路径不能用 ~」，那是让用户去迁就一个本该由程序做的展开。
///
/// `~other/…`（别人的主目录）**不展开**：那要查 passwd，而且几乎没人这么填。
/// 原样交给文件系统去报「不存在」，好过猜一个路径然后读到别的文件。
fn expand_home(path: &str) -> String {
  let Some(rest) = path.strip_prefix('~') else {
    return path.to_string();
  };
  // `~` 单独一个，或者 `~/…`；`~name` 的下一个字符不是分隔符，不动它
  if !rest.is_empty() && !rest.starts_with('/') {
    return path.to_string();
  }
  let Some(home) = std::env::home_dir() else {
    return path.to_string();
  };
  format!("{}{rest}", home.display())
}

/// 用户自己的 `~/.ssh/known_hosts`——和命令行 `ssh` 读的是同一份。
///
/// 应用另存一份的后果是「ssh 连得上但这里连不上」，而且用户在两处各信任
/// 一次同一台主机。拿不到 home 时返回 `None`：那时报「读不到 known_hosts」，
/// 而不是拿一个空路径去校验然后把每台主机都当成没见过。
pub fn default_known_hosts() -> Option<PathBuf> {
  std::env::home_dir().map(|home| home.join(".ssh").join("known_hosts"))
}

/// 读私钥，把三种失败分开报。
///
/// 三种的下一步完全不同：**有口令而没填**要去填那一格；**口令不对**要改那一格；
/// **读不了**（不存在、没权限、格式不认）要去查文件。全报成「私钥读不了」的
/// 后果是最常见的一种——给密钥加了口令——看起来像文件坏了。
fn read_private_key(tunnel: &SshTunnelConfig) -> Result<russh::keys::PrivateKey, TunnelError> {
  let key_path = expand_home(&tunnel.private_key_path);
  // 空口令与「没有口令」要一样对待：用户把那一格留空就是没有口令。
  // 传一个空字符串进去，russh 会拿它当真口令去解密，于是一把本来没有口令的
  // 钥匙会解失败
  let passphrase = Some(tunnel.secret.as_str()).filter(|secret| !secret.is_empty());
  match load_secret_key(&key_path, passphrase) {
    Ok(key) => Ok(key),
    Err(russh::keys::Error::KeyIsEncrypted) => Err(TunnelError::PrivateKeyLocked),
    // russh 把解密失败归到 ssh-key 的 Crypto 上。这里只在**给了口令**时才
    // 当成口令错——没给口令走的是上面那一支
    Err(russh::keys::Error::SshKey(russh::keys::ssh_key::Error::Crypto))
      if passphrase.is_some() =>
    {
      Err(TunnelError::PrivateKeyPassphrase)
    }
    Err(error) => Err(TunnelError::PrivateKey { message: format!("{key_path}: {error}") }),
  }
}

/// 建一条隧道：连上跳板机、校验主机密钥、认证，然后在本地开一个端口转发。
pub async fn open(
  config: &ConnectionProfile,
  tunnel: &SshTunnelConfig,
  known_hosts: &Path,
) -> Result<ActiveTunnel, TunnelError> {
  // 私钥要在连之前读：钥匙不对就不必去打扰跳板机。口令登录没有这一步
  let key = match tunnel.auth {
    SshAuthMethod::PrivateKey => Some(read_private_key(tunnel)?),
    SshAuthMethod::Password => None,
  };

  let ssh_config = Arc::new(client::Config {
    inactivity_timeout: None,
    keepalive_interval: Some(Duration::from_secs(30)),
    ..Default::default()
  });
  let handler = HostKeyCheck {
    host: tunnel.host.clone(),
    port: tunnel.port,
    known_hosts: known_hosts.to_path_buf(),
  };

  let connecting = client::connect(ssh_config, (tunnel.host.as_str(), tunnel.port), handler);
  let mut session = match tokio::time::timeout(CONNECT_TIMEOUT, connecting).await {
    Err(_) => {
      return Err(TunnelError::Ssh {
        message: format!("{SSH_CONNECT_TIMEOUT}: {}", CONNECT_TIMEOUT.as_secs()),
      })
    }
    Ok(session) => session?,
  };

  let authenticated = match key {
    Some(key) => {
      // RSA 私钥必须协商出 SHA-2 的签名算法。给 `None` 会用 SHA-1 的 `ssh-rsa`，
      // 而 OpenSSH 8.8 起默认不再接受它——那时报出来的是一句「认证失败」，
      // 看上去像钥匙不对，实际是签名算法过时了
      let hash_alg = session.best_supported_rsa_hash().await?.flatten();
      session
        .authenticate_publickey(
          &tunnel.username,
          PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
        )
        .await?
    }
    None => session.authenticate_password(&tunnel.username, &tunnel.secret).await?,
  };
  if !authenticated.success() {
    return Err(TunnelError::AuthRejected);
  }

  // 只绑 127.0.0.1，端口交给操作系统挑。端口范围不再是问题——
  // 见 `f6464ae`：上限是 65535，不是曾经写在四处的 32767
  let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|error| TunnelError::Ssh {
    message: format!("{SSH_LOCAL_PORT_UNAVAILABLE}: {error}"),
  })?;
  let local_port = listener
    .local_addr()
    .map_err(|error| TunnelError::Ssh {
      message: format!("{SSH_LOCAL_PORT_UNAVAILABLE}: {error}"),
    })?
    .port();

  let (target_host, target_port) = tunnel.target(config);
  let session = Arc::new(session);
  let (shutdown, shutdown_signal) = tokio::sync::oneshot::channel();
  tokio::spawn(forward(listener, Arc::clone(&session), target_host, target_port, shutdown_signal));

  Ok(ActiveTunnel { local_port, session, _shutdown: shutdown })
}

/// 接一条本地连接就开一条 SSH 通道，然后双向拷贝。
///
/// `shutdown` 被 drop（即 `ActiveTunnel` 被丢掉）时这个循环退出，监听口随之
/// 关闭；本地端口从此拒连，而不是接受连接然后无声地什么也不做。
async fn forward(
  listener: TcpListener,
  session: Arc<Handle<HostKeyCheck>>,
  target_host: String,
  target_port: u16,
  mut shutdown: tokio::sync::oneshot::Receiver<()>,
) {
  loop {
    let incoming = tokio::select! {
      _ = &mut shutdown => return,
      incoming = listener.accept() => incoming,
    };

    let Ok((local, _)) = incoming else { return };
    let Ok(channel) = session
      .channel_open_direct_tcpip(target_host.clone(), target_port as u32, "127.0.0.1", 0)
      .await
    else {
      // 开不出通道通常意味着会话已经没了。让本次连接断掉，由 `is_alive`
      // 在下一次请求时决定重建——这里重试只会把同一个失败重复一遍
      continue;
    };

    tokio::spawn(pump(local, channel.into_stream()));
  }
}

async fn pump(mut local: TcpStream, mut remote: ChannelStream<client::Msg>) {
  // 任一方向结束就一起收尾。忽略错误是对的：对端正常关闭连接在这里
  // 表现为一个 io 错误，而它不是异常
  let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
}

/// 谁在用哪条隧道。
///
/// 按 profile id 复用：同一个连接反复测试、断开重连，不应该每次都新建一条
/// SSH 会话。放在 Tauri 的 state 里，随应用一起活。
#[derive(Default)]
pub struct TunnelRegistry {
  entries: Mutex<HashMap<String, ActiveTunnel>>,
}

impl TunnelRegistry {
  /// 保证这个 profile 有一条活着的隧道，返回本地端口。
  pub async fn ensure(
    &self,
    config: &ConnectionProfile,
    tunnel: &SshTunnelConfig,
    known_hosts: &Path,
  ) -> Result<u16, TunnelError> {
    let mut entries = self.entries.lock().await;

    // 草稿还没有 id（连接表单里「测试连接」是在保存之前点的），这时不能复用：
    // 所有草稿共用空字符串这一个键，第二个草稿会连上第一个草稿的跳板机，
    // 而界面上显示的是它自己填的那一台。宁可每次重建
    if config.id.is_empty() {
      entries.remove(&config.id);
    } else if let Some(existing) = entries.get(&config.id) {
      // 会话死了的条目要先摘掉。留着它等于把用户接到一个已经空掉的端口上，
      // 而报出来的会是数据库驱动的「连不上」
      if existing.is_alive() {
        return Ok(existing.local_port);
      }
      entries.remove(&config.id);
    }

    let opened = open(config, tunnel, known_hosts).await?;
    let local_port = opened.local_port;
    entries.insert(config.id.clone(), opened);
    Ok(local_port)
  }

  /// 这个 profile 现在用的是哪个本地端口。没有活着的隧道就是 `None`。
  ///
  /// 和 `ensure` 分开：执行查询那条路只该**查**，不该顺手建。隧道死了的话
  /// 连接池也早就死了，这时重建一条只会换来一个新端口，拼出的连接串照样
  /// 对不上池子的键——多一次握手，少一条能看懂的错误。
  pub async fn local_port(&self, profile_id: &str) -> Option<u16> {
    let entries = self.entries.lock().await;
    entries.get(profile_id).filter(|tunnel| tunnel.is_alive()).map(|tunnel| tunnel.local_port)
  }

  /// 拆掉这个 profile 的隧道。没有也算成功——断开一条不存在的连接不是错误
  pub async fn close(&self, profile_id: &str) {
    self.entries.lock().await.remove(profile_id);
  }

  pub async fn close_all(&self) {
    self.entries.lock().await.clear();
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use russh::keys::ssh_key::PublicKey as SshPublicKey;
  use std::io::Write;

  /// 两把一次性的测试公钥，**不带注释字段**。
  ///
  /// 注释必须省掉：`PublicKey` 的相等里算上了注释，而真实的两侧都没有注释——
  /// known_hosts 那边 russh 只取 base64 部分（`parse_public_key_base64`），
  /// 服务器那边给过来的密钥本身也不带。带上注释的样本会让一把对得上的钥匙
  /// 被判成「密钥变了」。
  const KEY_A: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG7U2WGxQHvxmwP/IWqpPZnDq8zjABHZAkhbLaffslnw";
  const KEY_B: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKU4I52iBnVvN/UOo3M8Npm93+2cqzpf+UQ5ELFS8psD";

  fn public_key(openssh: &str) -> PublicKey {
    match SshPublicKey::from_openssh(openssh) {
      Ok(key) => key,
      Err(error) => panic!("测试用的公钥应当解析得出: {error}"),
    }
  }

  /// 造一把私钥写到临时文件里，返回路径。`passphrase` 为空就是不加密。
  ///
  /// 现造而不是在仓库里放一个密钥文件：那种文件会被密钥扫描器报，
  /// 而且一份固定的样本只能覆盖一种算法。
  fn private_key_file(passphrase: &str) -> PathBuf {
    use ssh_key::{getrandom::SysRng, rand_core::UnwrapErr};
    let mut rng = UnwrapErr(SysRng);
    let key = match ssh_key::PrivateKey::random(&mut rng, ssh_key::Algorithm::Ed25519) {
      Ok(key) => key,
      Err(error) => panic!("测试用的私钥应当造得出: {error}"),
    };
    let key = if passphrase.is_empty() {
      key
    } else {
      match key.encrypt(&mut rng, passphrase.as_bytes()) {
        Ok(encrypted) => encrypted,
        Err(error) => panic!("加密应当成功: {error}"),
      }
    };
    let pem = match key.to_openssh(ssh_key::LineEnding::LF) {
      Ok(pem) => pem,
      Err(error) => panic!("应当写得出 OpenSSH 格式: {error}"),
    };
    let path = std::env::temp_dir().join(format!("dataomni-key-{}", uuid::Uuid::new_v4()));
    if let Err(error) = std::fs::write(&path, pem.as_bytes()) {
      panic!("临时私钥应当写得进: {error}");
    }
    path
  }

  fn key_tunnel(path: &Path, secret: &str) -> SshTunnelConfig {
    SshTunnelConfig {
      host: "jump.example.com".to_string(),
      port: 22,
      username: "ops".to_string(),
      private_key_path: path.display().to_string(),
      auth: SshAuthMethod::PrivateKey,
      secret: secret.to_string(),
      secret_ref: None,
      remote_host: None,
      remote_port: None,
    }
  }

  /// 三种失败要分开报，因为用户的下一步完全不同。
  ///
  /// 全报成「私钥读不了」的后果是：最常见的一种——**给密钥加了口令**——
  /// 看起来像文件坏了，而用户会去查权限、换路径，唯独不会去填那一格。
  #[test]
  fn a_locked_key_a_wrong_passphrase_and_an_unreadable_file_are_three_different_things() {
    let locked = private_key_file("hunter2");

    match read_private_key(&key_tunnel(&locked, "")) {
      Err(TunnelError::PrivateKeyLocked) => {}
      other => panic!("有口令却没填，该报「要口令」: {other:?}"),
    }
    match read_private_key(&key_tunnel(&locked, "wrong")) {
      Err(TunnelError::PrivateKeyPassphrase) => {}
      other => panic!("口令不对，该单独报出来而不是说认证失败: {other:?}"),
    }
    if let Err(error) = read_private_key(&key_tunnel(&locked, "hunter2")) {
      panic!("口令对了就该读得出: {error:?}");
    }

    let missing = locked.with_extension("gone");
    match read_private_key(&key_tunnel(&missing, "")) {
      Err(TunnelError::PrivateKey { message }) => {
        assert!(message.contains(&missing.display().to_string()), "要带上路径: {message}");
      }
      other => panic!("文件不在该报读不了，并且带上路径: {other:?}"),
    }

    let _ = std::fs::remove_file(&locked);
  }

  /// 没有口令的私钥照样要能用——这是第一个增量唯一支持的情形，不能回退。
  ///
  /// 顺带钉住「那一格留空」与「那一格填了但这把钥匙没加密」都放行：
  /// 把空串当成真口令传下去，会让一把好钥匙解不开。
  #[test]
  fn a_key_without_a_passphrase_still_opens_whether_or_not_one_is_typed() {
    let plain = private_key_file("");

    if let Err(error) = read_private_key(&key_tunnel(&plain, "")) {
      panic!("无口令私钥应当读得出: {error:?}");
    }
    if let Err(error) = read_private_key(&key_tunnel(&plain, "irrelevant")) {
      panic!("多填的口令不该把一把没加密的钥匙判成坏的: {error:?}");
    }

    let _ = std::fs::remove_file(&plain);
  }

  /// 写一份临时 known_hosts。`entries` 是整行，和真文件里长得一样
  fn known_hosts_file(entries: &[&str]) -> PathBuf {
    let path = std::env::temp_dir().join(format!("dataomni-known-hosts-{}", uuid::Uuid::new_v4()));
    let mut file = match std::fs::File::create(&path) {
      Ok(file) => file,
      Err(error) => panic!("临时文件应当建得出: {error}"),
    };
    for entry in entries {
      if let Err(error) = writeln!(file, "{entry}") {
        panic!("临时文件应当写得进: {error}");
      }
    }
    path
  }

  /// `~` 要像命令行 ssh 那样展开。
  ///
  /// 这一条是被界面上的占位符逼出来的：那里写着 `~/.ssh/id_rsa`，照着填
  /// 得到的是「文件不存在」。
  #[test]
  fn a_leading_tilde_expands_to_the_home_directory() {
    let Some(home) = std::env::home_dir() else {
      // 拿不到 home 时展开无从谈起，这条用例也就没有意义
      return;
    };
    let home = home.display().to_string();

    assert_eq!(expand_home("~/.ssh/id_rsa"), format!("{home}/.ssh/id_rsa"));
    assert_eq!(expand_home("~"), home);

    // 绝对路径与相对路径原样通过
    assert_eq!(expand_home("/Users/someone/.ssh/id_rsa"), "/Users/someone/.ssh/id_rsa");
    assert_eq!(expand_home("keys/id_rsa"), "keys/id_rsa");

    // `~other` 是别人的主目录，要查 passwd 才知道在哪。猜一个路径可能读到
    // 完全不相干的文件，不如原样交给文件系统去报「不存在」
    assert_eq!(expand_home("~deploy/.ssh/id_rsa"), "~deploy/.ssh/id_rsa");

    // `~` 不在开头就不是主目录的意思
    assert_eq!(expand_home("./~/id_rsa"), "./~/id_rsa");
  }

  /// 有记录且匹配——唯一一种可以继续的情形。
  #[test]
  fn a_recorded_and_matching_host_key_is_accepted() {
    let known_hosts = known_hosts_file(&[&format!("jump.example.com {KEY_A}")]);

    assert_eq!(verify_host_key("jump.example.com", 22, &public_key(KEY_A), &known_hosts), Ok(()));

    let _ = std::fs::remove_file(&known_hosts);
  }

  /// 有同算法的记录但密钥变了——这是安全事件，必须拒绝并报出行号。
  ///
  /// 行号是为了让用户能自己去看那一行：主机重装过系统和真有中间人，
  /// 从这里是分不出来的，得由人去核。
  #[test]
  fn a_changed_host_key_is_refused_and_reports_the_recorded_fingerprint() {
    let known_hosts = known_hosts_file(&[
      "# 这是注释，不算一行记录",
      &format!("other.example.com {KEY_A}"),
      &format!("jump.example.com {KEY_A}"),
    ]);

    // 服务器给的是 B，记录的是 A
    match verify_host_key("jump.example.com", 22, &public_key(KEY_B), &known_hosts) {
      Err(TunnelError::HostKeyChanged { recorded, fingerprint }) => {
        // 报的是记着的指纹，而不是 known_hosts 的行号——russh 的行号在有
        // `#` 注释行时会少算，这份样本第一行就是注释，正好踩中
        let expected = public_key(KEY_A).fingerprint(HashAlg::Sha256).to_string();
        assert_eq!(recorded, vec![expected]);
        assert!(fingerprint.starts_with("SHA256:"), "指纹要能和 ssh 打印的对上: {fingerprint}");
      }
      other => panic!("主机密钥变了必须拒绝，而不是 {other:?}"),
    }

    let _ = std::fs::remove_file(&known_hosts);
  }

  /// 没有记录——拒绝，但报的是「待确认的首连」，不是「可能有中间人」。
  ///
  /// 这两件事必须分开：混成一句话，用户要么把首连当成攻击，要么把攻击
  /// 当成首连点掉。
  #[test]
  fn an_unknown_host_is_refused_separately_from_a_changed_one() {
    let known_hosts = known_hosts_file(&[&format!("other.example.com {KEY_A}")]);

    match verify_host_key("jump.example.com", 22, &public_key(KEY_A), &known_hosts) {
      Err(TunnelError::HostKeyUnknown { fingerprint }) => {
        assert!(fingerprint.starts_with("SHA256:"), "{fingerprint}");
      }
      other => panic!("没有记录的主机应当报 HostKeyUnknown，而不是 {other:?}"),
    }

    // known_hosts 根本不存在时也是「没有记录」，不是一个读文件的错误：
    // 全新的机器上这个文件就是不存在的
    let missing = std::env::temp_dir().join("dataomni-known-hosts-does-not-exist");
    let _ = std::fs::remove_file(&missing);
    match verify_host_key("jump.example.com", 22, &public_key(KEY_A), &missing) {
      Err(TunnelError::HostKeyUnknown { .. }) => {}
      other => panic!("known_hosts 不存在时应当报 HostKeyUnknown，而不是 {other:?}"),
    }

    let _ = std::fs::remove_file(&known_hosts);
  }

  /// 非默认端口在 known_hosts 里写成 `[host]:port`。
  ///
  /// 写错这一条的表现是：22 端口的记录会被用来给 2222 端口放行，
  /// 也就是校验在跳板机换端口之后静默失效。
  #[test]
  fn a_non_default_port_needs_its_own_bracketed_entry() {
    let known_hosts = known_hosts_file(&[&format!("[jump.example.com]:2222 {KEY_A}")]);

    assert_eq!(verify_host_key("jump.example.com", 2222, &public_key(KEY_A), &known_hosts), Ok(()));

    // 同一把钥匙、同一台主机，但端口是 22：记录对不上，必须当成没有记录
    match verify_host_key("jump.example.com", 22, &public_key(KEY_A), &known_hosts) {
      Err(TunnelError::HostKeyUnknown { .. }) => {}
      other => panic!("22 端口没有记录，不该被 2222 的记录放行: {other:?}"),
    }

    let _ = std::fs::remove_file(&known_hosts);
  }
}
