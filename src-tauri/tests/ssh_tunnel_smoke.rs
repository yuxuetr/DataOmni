//! 连真实 sshd 的隧道验收。默认**静默跳过**。
//!
//! 要跑就设下面这些环境变量，只在 shell 里传，**不要写进任何文件**：
//!
//! ```text
//! DATAOMNI_REQUIRE_SSH_TUNNEL_TESTS=1
//! DATAOMNI_SSH_TUNNEL_HOST=...
//! DATAOMNI_SSH_TUNNEL_PORT=22                      # 可选，默认 22
//! DATAOMNI_SSH_TUNNEL_USER=...
//! DATAOMNI_SSH_TUNNEL_KEY=/Users/me/.ssh/id_rsa    # 无口令私钥，别用 ~
//! DATAOMNI_SSH_TUNNEL_TARGET=127.0.0.1:23306       # 从跳板机看过去的库地址
//! DATAOMNI_SSH_TUNNEL_DB_USER=root
//! DATAOMNI_SSH_TUNNEL_DB_PASSWORD=...
//! DATAOMNI_SSH_TUNNEL_DB_NAME=dataomni_tunnel
//! ```
//!
//! 用 `env A=1 B=2 … cargo test` 写成一行，别用反斜杠续行：断了一截的话
//! 变量会落在上一条命令里，而那时**这套用例会报错而不是跳过**（见
//! `intends_to_run`）——静默跳过和全绿在 `cargo test` 的输出里分不开。
//!
//! **目标库必须是直连不到的**（只监听跳板机的 `127.0.0.1`）。这不是环境
//! 的一个细节而是整套验收的地基：如果它能被直连，那么「经隧道读到数据」
//! 这条断言在隧道完全没起作用的情况下也会是绿的。`the_target_must_not_be
//! _reachable_without_the_tunnel` 就是把这个前提本身变成一道门。

use dataomni_lib::models::{ConnectionProfile, DatabaseType, SshTunnelConfig, TlsMode};
use dataomni_lib::services::ssh_tunnel;
use std::path::PathBuf;
use std::time::Duration;

const REQUIRE_ENV: &str = "DATAOMNI_REQUIRE_SSH_TUNNEL_TESTS";

/// 拿一份完整的隧道配置，任何一项缺失就跳过（或在 REQUIRE 打开时报错）。
fn tunnel_setup() -> Option<(ConnectionProfile, SshTunnelConfig, PathBuf)> {
  let host = variable("DATAOMNI_SSH_TUNNEL_HOST")?;
  let username = variable("DATAOMNI_SSH_TUNNEL_USER")?;
  let private_key_path = variable("DATAOMNI_SSH_TUNNEL_KEY")?;
  let target = variable("DATAOMNI_SSH_TUNNEL_TARGET")?;
  let db_user = variable("DATAOMNI_SSH_TUNNEL_DB_USER")?;
  let db_password = variable("DATAOMNI_SSH_TUNNEL_DB_PASSWORD")?;
  let db_name = variable("DATAOMNI_SSH_TUNNEL_DB_NAME")?;

  let (target_host, target_port) = match target.rsplit_once(':') {
    Some((host, port)) => match port.parse::<u16>() {
      Ok(port) => (host.to_string(), port),
      Err(_) => panic!("DATAOMNI_SSH_TUNNEL_TARGET 的端口不是数字: {target}"),
    },
    None => panic!("DATAOMNI_SSH_TUNNEL_TARGET 要写成 host:port，收到的是 {target}"),
  };

  let ssh_port = match std::env::var("DATAOMNI_SSH_TUNNEL_PORT") {
    Ok(port) if !port.is_empty() => port.parse::<u16>().unwrap_or(22),
    _ => 22,
  };

  let tunnel = SshTunnelConfig {
    host,
    port: ssh_port,
    username,
    private_key_path,
    remote_host: Some(target_host.clone()),
    remote_port: Some(target_port),
  };

  // profile 的 host / port 故意和转发目标一致：那是最常见的填法，
  // 而且让「连接串有没有被改指向本地端口」这件事可观测——如果没改，
  // 连出去的就是直连，而直连必须失败（见下面那条门）
  let profile = ConnectionProfile {
    id: "ssh-tunnel-smoke".to_string(),
    name: "ssh tunnel smoke".to_string(),
    db_type: DatabaseType::MySQL,
    host: target_host,
    port: target_port,
    database: Some(db_name),
    username: db_user,
    password: db_password,
    tls_mode: Some(TlsMode::Disabled),
    ..Default::default()
  };

  Some((profile, tunnel, known_hosts_path()))
}

/// 设了一半也算「打算跑」。
///
/// 静默跳过和通过在 `cargo test` 的输出里长得一模一样（都是 `ok`），而
/// stderr 默认不显示。于是「多行命令粘贴时断了一截」这种事的表现是：
/// 一次什么都没验的运行，报出来是全绿。实际踩过一次——七个变量设了六个，
/// 唯独 REQUIRE 落在了上一条命令里。
///
/// 所以只要**任何一个** `DATAOMNI_SSH_TUNNEL_*` 出现，就把这套用例当成
/// 要跑的：缺哪个就报哪个，而不是假装没人想跑。
fn intends_to_run() -> bool {
  if std::env::var(REQUIRE_ENV).as_deref() == Ok("1") {
    return true;
  }
  std::env::vars()
    .any(|(name, value)| name.starts_with("DATAOMNI_SSH_TUNNEL_") && !value.is_empty())
}

fn variable(name: &str) -> Option<String> {
  match std::env::var(name) {
    Ok(value) if !value.is_empty() => Some(value),
    _ if intends_to_run() => {
      panic!(
        "{name} 没设。设了任何一个 DATAOMNI_SSH_TUNNEL_* 就说明想跑这套用例，\
         所以这里报错而不是跳过——多行命令断了一截时，静默跳过看起来和全绿一样"
      )
    }
    _ => {
      eprintln!("skipping ssh tunnel smoke test because {name} is not set");
      None
    }
  }
}

/// 默认用真的 `~/.ssh/known_hosts`——校验要在真实数据上跑过才算跑过。
///
/// 可以用 `DATAOMNI_SSH_TUNNEL_KNOWN_HOSTS` 指向别处，那是为了反向验证：
/// 指一份空的过去，`a_tunnel_reaches_...` 必须红在 HostKeyUnknown 上。
/// 一道从没红过的门和没有门是一回事。
fn known_hosts_path() -> PathBuf {
  if let Ok(path) = std::env::var("DATAOMNI_SSH_TUNNEL_KNOWN_HOSTS") {
    if !path.is_empty() {
      return PathBuf::from(path);
    }
  }
  #[allow(deprecated)]
  match std::env::home_dir() {
    Some(home) => home.join(".ssh").join("known_hosts"),
    None => PathBuf::from("known_hosts"),
  }
}

/// 整套验收的地基：目标库直连必须**连不上**。
///
/// 判据是「收到真实的 MySQL 握手包」，不是「`connect()` 返回成功」。后者在
/// 开着 TUN 模式代理的机器上对任何端口都为真——那正是 `6ea1f3f` 修的东西。
#[tokio::test]
async fn the_target_must_not_be_reachable_without_the_tunnel() {
  let Some((profile, _, _)) = tunnel_setup() else {
    return;
  };

  let greeting = read_mysql_greeting(&profile.host, profile.port).await;
  assert!(
    greeting.is_none(),
    "目标库能被直连（收到了握手包 {greeting:?}），那么「经隧道读到数据」那条断言就证明不了任何事。\
     请把它改成只监听跳板机的 127.0.0.1"
  );
}

/// 经隧道读到那一行标记。
#[tokio::test]
async fn a_tunnel_reaches_a_database_that_is_otherwise_unreachable() {
  let Some((profile, tunnel, known_hosts)) = tunnel_setup() else {
    return;
  };

  let registry = ssh_tunnel::TunnelRegistry::default();
  let local_port = match registry.ensure(&profile, &tunnel, &known_hosts).await {
    Ok(port) => port,
    Err(error) => panic!("隧道建不起来: {error}"),
  };

  // 本地端口后面必须是真的 MySQL，而不是一个接受连接就挂断的空壳
  let greeting = read_mysql_greeting("127.0.0.1", local_port).await;
  assert!(greeting.is_some(), "本地端口上没有 MySQL 在应答");

  let local = profile.redirected_to("127.0.0.1", local_port);
  let url = local.db_type.to_connection_string(&local);
  assert!(url.contains(&format!("127.0.0.1:{local_port}")), "{url}");

  let pool = match sqlx::mysql::MySqlPoolOptions::new()
    .max_connections(1)
    .acquire_timeout(Duration::from_secs(15))
    .connect(&url)
    .await
  {
    Ok(pool) => pool,
    Err(error) => panic!("经隧道连库失败: {error}"),
  };

  let note: String = match sqlx::query_scalar("SELECT note FROM tunnel_marker WHERE id = 1")
    .fetch_one(&pool)
    .await
  {
    Ok(note) => note,
    Err(error) => panic!("读 tunnel_marker 失败: {error}"),
  };
  assert_eq!(note, "reached-through-ssh-tunnel");

  pool.close().await;

  // 拆掉之后本地端口必须拒连。留着一个「接受连接但什么也不做」的端口，
  // 比直接拒连难查得多
  registry.close(&profile.id).await;
  let mut refused = false;
  for _ in 0..20 {
    if tokio::net::TcpStream::connect(("127.0.0.1", local_port)).await.is_err() {
      refused = true;
      break;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
  }
  assert!(refused, "隧道拆掉之后 127.0.0.1:{local_port} 还在接受连接");
}

/// 读服务端主动发来的握手包。
///
/// MySQL 一连上就发；收不到字节说明那头没有 MySQL，不管 `connect()` 是不是
/// 成功了。返回服务端版本串。
async fn read_mysql_greeting(host: &str, port: u16) -> Option<String> {
  use tokio::io::AsyncReadExt;

  let connecting = tokio::net::TcpStream::connect((host, port));
  let mut stream = tokio::time::timeout(Duration::from_secs(5), connecting).await.ok()?.ok()?;

  let mut buffer = [0u8; 128];
  let read =
    tokio::time::timeout(Duration::from_secs(2), stream.read(&mut buffer)).await.ok()?.ok()?;
  if read == 0 {
    return None;
  }

  // 4 字节包头 + 1 字节协议版本，然后是 NUL 结尾的版本串
  let version: Vec<u8> =
    buffer.get(5..read)?.iter().copied().take_while(|byte| *byte != 0).collect();
  String::from_utf8(version).ok().filter(|version| !version.is_empty())
}
