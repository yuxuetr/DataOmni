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

use crate::models::{ConnectionProfile, SshTunnelConfig};
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
pub const SSH_AUTH_REJECTED: &str = "DATAOMNI_SSH_AUTH_REJECTED";
pub const SSH_FAILED: &str = "DATAOMNI_SSH_FAILED";

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
      TunnelError::AuthRejected => write!(formatter, "{SSH_AUTH_REJECTED}"),
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
      return Err(TunnelError::Ssh {
        message: "这台跳板机用的是证书型主机密钥，当前版本没有实现对它的校验".to_string(),
      });
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
  let recorded = known_host_keys_path(host, port, known_hosts)
    .map_err(|error| TunnelError::Ssh { message: format!("读 known_hosts 失败: {error}") })?;

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

/// 用户自己的 `~/.ssh/known_hosts`——和命令行 `ssh` 读的是同一份。
///
/// 应用另存一份的后果是「ssh 连得上但这里连不上」，而且用户在两处各信任
/// 一次同一台主机。拿不到 home 时返回 `None`：那时报「读不到 known_hosts」，
/// 而不是拿一个空路径去校验然后把每台主机都当成没见过。
pub fn default_known_hosts() -> Option<PathBuf> {
  std::env::home_dir().map(|home| home.join(".ssh").join("known_hosts"))
}

/// 建一条隧道：连上跳板机、校验主机密钥、认证，然后在本地开一个端口转发。
pub async fn open(
  config: &ConnectionProfile,
  tunnel: &SshTunnelConfig,
  known_hosts: &Path,
) -> Result<ActiveTunnel, TunnelError> {
  let key = load_secret_key(&tunnel.private_key_path, None)
    .map_err(|error| TunnelError::PrivateKey { message: error.to_string() })?;

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
        message: format!("{} 秒内没有连上跳板机", CONNECT_TIMEOUT.as_secs()),
      })
    }
    Ok(session) => session?,
  };

  // RSA 私钥必须协商出 SHA-2 的签名算法。给 `None` 会用 SHA-1 的 `ssh-rsa`，
  // 而 OpenSSH 8.8 起默认不再接受它——那时报出来的是一句「认证失败」，
  // 看上去像钥匙不对，实际是签名算法过时了
  let hash_alg = session.best_supported_rsa_hash().await?.flatten();
  let authenticated = session
    .authenticate_publickey(&tunnel.username, PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg))
    .await?;
  if !authenticated.success() {
    return Err(TunnelError::AuthRejected);
  }

  // 只绑 127.0.0.1，端口交给操作系统挑。端口范围不再是问题——
  // 见 `f6464ae`：上限是 65535，不是曾经写在四处的 32767
  let listener = TcpListener::bind(("127.0.0.1", 0))
    .await
    .map_err(|error| TunnelError::Ssh { message: format!("本地端口开不出来: {error}") })?;
  let local_port = listener
    .local_addr()
    .map_err(|error| TunnelError::Ssh { message: format!("拿不到本地端口: {error}") })?
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

    // 会话死了的条目要先摘掉。留着它等于把用户接到一个已经空掉的端口上，
    // 而报出来的会是数据库驱动的「连不上」
    if let Some(existing) = entries.get(&config.id) {
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
