//! 连接失败之后：到底断在哪一段。
//!
//! 驱动只会说一句「连不上」，而用户接下来的动作完全取决于断点在哪：
//! 主机名拼错了要改主机，端口不通要找防火墙或确认服务在跑，端口通了却失败
//! 就只剩账号、TLS 和库名。这三件事的下一步互不相同，而现在它们共用同一句话。
//!
//! 这不是假想的缺口。`connectionStore` 里已经有一处手写的补救——
//! 把驱动的 `invalid port number` 换成「端口超出范围」，因为原话没法据以行动。
//! 那是一个实例，这里覆盖的是同一类问题。
//!
//! **刻意不做代理诊断。** 路线图那一条写着「代理与网络诊断」，但对本项目
//! 而言前半句会给出错误的线索：MySQL / PostgreSQL 走的是各自的 TCP 协议，
//! sqlx 不读 `HTTP_PROXY`，系统 HTTP 代理对它们没有任何影响。报一句
//! 「检测到系统代理」只会让人去关代理，然后发现问题还在。

use crate::models::{ConnectionProfile, DatabaseType};
use serde::Serialize;
use std::net::SocketAddr;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;

/// 每一步给用户的开销上限。
///
/// 5 秒不是「等够久」，是「别让诊断本身变成又一次卡住」——用户点它的时候
/// 已经等过一次超时了。DNS 和 TCP 各自计时。
const STEP_TIMEOUT: Duration = Duration::from_secs(5);

/// SQLite 文件头。见 https://www.sqlite.org/fileformat.html
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

/// 连上端口之后，愿意为「那头到底有没有服务」多等多久。
///
/// PostgreSQL 这一侧每次都会等满这段时间（服务端沉默，等客户端先开口），
/// 所以它是直接加在诊断耗时上的。半秒换一个可信的结论值得。
const PEEK_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDiagnosis {
  /// 按执行顺序；一步失败就停，后面的步骤问不出东西来
  pub steps: Vec<DiagnosisStep>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosisStep {
  /// 前端按这个键选文案，所以是稳定的标识而不是给人看的句子
  pub name: &'static str,
  pub ok: bool,
  /// 事实本身：解析到的地址、耗时、操作系统给的失败原因。
  /// 不在这里写结论，结论由前端按 `name` + `ok` 组合出来
  pub detail: String,
  pub elapsed_ms: u64,
}

impl DiagnosisStep {
  fn new(name: &'static str, ok: bool, detail: String, started: Instant) -> Self {
    Self { name, ok, detail, elapsed_ms: started.elapsed().as_millis() as u64 }
  }
}

/// 查一遍这个配置的网络可达性。
///
/// 只做外部可观测的检查，不发数据库协议的任何一个字节：一是不必重复
/// `test_connection` 已经做的事，二是探测不该因为账号不对而失败。
pub async fn diagnose(config: &ConnectionProfile) -> ConnectionDiagnosis {
  let steps = match config.db_type {
    DatabaseType::SQLite => vec![inspect_sqlite_file(config.database.as_deref())],
    // 只剩 MySQL 与 PostgreSQL：两者都是「主机 + 端口」，走同一套探测。
    // 没有驱动的类型到不了这里，`test_connection` 在更早一步就拒绝了
    _ => probe_host(&config.host, config.port).await,
  };

  ConnectionDiagnosis { steps }
}

/// SQLite 的「连接」其实是打开一个文件，所以要问的是文件的问题。
///
/// 三种失败长得都像「连不上」，但原因分别是路径错、权限不对、和
/// 「这是个文件但不是 SQLite 库」——最后一种最容易卡住人：驱动只会说
/// 文件打不开或者不是数据库，看上去像是文件坏了。
fn inspect_sqlite_file(database: Option<&str>) -> DiagnosisStep {
  let started = Instant::now();

  let Some(path) = database.filter(|path| !path.is_empty()) else {
    return DiagnosisStep::new("sqliteFile", false, "未填写数据库文件路径".to_string(), started);
  };

  if path == ":memory:" {
    return DiagnosisStep::new("sqliteMemory", true, path.to_string(), started);
  }

  let metadata = match std::fs::metadata(path) {
    Ok(metadata) => metadata,
    Err(error) => {
      return DiagnosisStep::new("sqliteFile", false, format!("{path}：{error}"), started)
    }
  };

  if metadata.is_dir() {
    return DiagnosisStep::new("sqliteFile", false, format!("{path} 是一个目录"), started);
  }

  // 空文件是合法的新库：sqlx 会在第一次写入时补上文件头。
  // 把它报成「不是 SQLite 文件」会挡住「新建一个库」这个正常用法
  if metadata.len() == 0 {
    return DiagnosisStep::new("sqliteEmpty", true, path.to_string(), started);
  }

  let mut header = [0u8; 16];
  match read_header(path, &mut header) {
    Err(error) => DiagnosisStep::new("sqliteFile", false, format!("{path}：{error}"), started),
    Ok(read) if read == header.len() && header == SQLITE_MAGIC => {
      DiagnosisStep::new("sqliteFile", true, format!("{path}（{} 字节）", metadata.len()), started)
    }
    Ok(_) => DiagnosisStep::new("sqliteMagic", false, path.to_string(), started),
  }
}

fn read_header(path: &str, buffer: &mut [u8]) -> std::io::Result<usize> {
  use std::io::Read;

  let mut file = std::fs::File::open(path)?;
  let mut filled = 0;
  while filled < buffer.len() {
    match file.read(&mut buffer[filled..])? {
      0 => break,
      read => filled += read,
    }
  }
  Ok(filled)
}

/// 先解析，再连端口。顺序有意义：解析不了的时候连端口无从下手，
/// 报出来的也会是同一个 DNS 错误，看上去像两个问题。
async fn probe_host(host: &str, port: u16) -> Vec<DiagnosisStep> {
  if host.is_empty() {
    let started = Instant::now();
    return vec![DiagnosisStep::new("resolve", false, "未填写主机地址".to_string(), started)];
  }
  if port == 0 {
    let started = Instant::now();
    return vec![DiagnosisStep::new("tcp", false, "未填写端口".to_string(), started)];
  }

  let started = Instant::now();
  let addresses =
    match tokio::time::timeout(STEP_TIMEOUT, tokio::net::lookup_host((host, port))).await {
      Err(_) => {
        return vec![DiagnosisStep::new(
          "resolve",
          false,
          format!("{host}：{} 秒内没有结果", STEP_TIMEOUT.as_secs()),
          started,
        )]
      }
      Ok(Err(error)) => {
        return vec![DiagnosisStep::new("resolve", false, format!("{host}：{error}"), started)]
      }
      Ok(Ok(addresses)) => addresses.collect::<Vec<_>>(),
    };

  let Some(&target) = addresses.first() else {
    // 解析成功但一个地址都没有：少见，但报「解析成功」再接一个连接失败
    // 会让人以为是端口问题
    return vec![DiagnosisStep::new("resolve", false, format!("{host}：没有解析到地址"), started)];
  };

  let resolved = DiagnosisStep::new(
    "resolve",
    true,
    addresses.iter().map(|address| address.ip().to_string()).collect::<Vec<_>>().join(", "),
    started,
  );

  let started = Instant::now();
  let connected = match tokio::time::timeout(STEP_TIMEOUT, TcpStream::connect(target)).await {
    Err(_) => DiagnosisStep::new(
      "tcp",
      false,
      format!("{target}：{} 秒内没有响应", STEP_TIMEOUT.as_secs()),
      started,
    ),
    Ok(Err(error)) => DiagnosisStep::new("tcp", false, format!("{target}：{error}"), started),
    Ok(Ok(stream)) => confirm_someone_is_listening(&stream, target, started).await,
  };

  vec![resolved, connected]
}

/// 连上之后再听一小会儿，确认那头真有服务在。
///
/// `connect()` 成功不等于端口上有东西。开了 TUN 模式代理的机器（macOS 上
/// Clash / V2Ray 很常见）会替被代理网段完成握手：实测本机到一台 VPS 的
/// 33306、35432、49999 三个端口全部「连上」并收到 0 字节，而其中只有 33306
/// 上真有数据库，且它只监听 127.0.0.1。照 `connect()` 的结果报「端口可达」，
/// 用户就会按结论去查账号、TLS 和库名——而真正的原因是这个端口没有服务。
///
/// 三种情形分得开，且不需要知道对面说什么协议：
/// - 收到字节：服务端先开口（MySQL 一连上就发握手包）——通。
/// - 等到超时还连着：沉默的服务端在等客户端先说（PostgreSQL 是这样）——通。
/// - 读到 0 字节或出错：接受了连接又立刻关掉——不通。
async fn confirm_someone_is_listening(
  stream: &TcpStream,
  target: SocketAddr,
  started: Instant,
) -> DiagnosisStep {
  let mut first_byte = [0u8; 1];
  match tokio::time::timeout(PEEK_TIMEOUT, stream.peek(&mut first_byte)).await {
    // 超时是好消息：连接还在，只是对面在等我们先说话
    Err(_) => DiagnosisStep::new("tcp", true, target.to_string(), started),
    Ok(Ok(0)) => DiagnosisStep::new("tcpDropped", false, target.to_string(), started),
    Ok(Ok(_)) => DiagnosisStep::new("tcp", true, target.to_string(), started),
    Ok(Err(error)) => {
      DiagnosisStep::new("tcpDropped", false, format!("{target}：{error}"), started)
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::models::{ConnectionEnvironment, TlsMode};
  use std::collections::HashMap;
  use std::io::Write;

  fn profile(db_type: DatabaseType) -> ConnectionProfile {
    ConnectionProfile {
      id: "probe".to_string(),
      name: "probe".to_string(),
      db_type,
      host: String::new(),
      port: 0,
      database: None,
      username: String::new(),
      password: String::new(),
      ssl: false,
      tls_mode: Some(TlsMode::Disabled),
      ca_certificate_path: None,
      client_certificate_path: None,
      client_key_path: None,
      save_password: false,
      options: HashMap::new(),
      tags: Vec::new(),
      environment: ConnectionEnvironment::Development,
      credential_ref: None,
      created_at: "2026-09-22T00:00:00Z".to_string(),
      updated_at: "2026-09-22T00:00:00Z".to_string(),
    }
  }

  fn temporary_path(suffix: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("dataomni-probe-{}{suffix}", uuid::Uuid::new_v4()))
  }

  #[tokio::test]
  async fn reports_the_port_it_actually_reached() {
    // 真的开一个监听口，而不是赌某个端口是通的
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();

    let mut config = profile(DatabaseType::PostgreSQL);
    config.host = "127.0.0.1".to_string();
    config.port = port;

    let diagnosis = diagnose(&config).await;
    let names: Vec<_> = diagnosis.steps.iter().map(|step| step.name).collect();
    assert_eq!(names, vec!["resolve", "tcp"]);
    assert!(diagnosis.steps.iter().all(|step| step.ok), "{:?}", diagnosis.steps);
    assert!(diagnosis.steps[1].detail.contains(&port.to_string()));
  }

  #[tokio::test]
  async fn a_port_that_accepts_then_hangs_up_is_not_a_reachable_port() {
    // TUN 模式代理的行为：替对面完成握手，随后立刻断开。
    // 该绿的那一侧是 `reports_the_port_it_actually_reached`——监听着但不说话。
    // 反向验证过：把 `confirm_someone_is_listening` 换回直接报 ok，这一条变红
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
      while let Ok((stream, _)) = listener.accept().await {
        drop(stream);
      }
    });

    let mut config = profile(DatabaseType::MySQL);
    config.host = "127.0.0.1".to_string();
    config.port = port;

    let diagnosis = diagnose(&config).await;
    assert_eq!(diagnosis.steps.len(), 2, "{:?}", diagnosis.steps);
    assert_eq!(diagnosis.steps[1].name, "tcpDropped");
    assert!(!diagnosis.steps[1].ok, "接受了连接又断开，不能报成端口可达");
  }

  #[tokio::test]
  async fn separates_a_closed_port_from_an_unknown_host() {
    // 绑上再丢掉：这个端口刚刚还在监听，现在确定没人听
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);

    let mut closed = profile(DatabaseType::MySQL);
    closed.host = "127.0.0.1".to_string();
    closed.port = port;

    let diagnosis = diagnose(&closed).await;
    assert_eq!(diagnosis.steps.len(), 2, "解析成功就要把两步都报出来");
    assert!(diagnosis.steps[0].ok, "127.0.0.1 一定解析得出来");
    assert!(!diagnosis.steps[1].ok, "端口没人听，这一步必须是失败");
    assert_eq!(diagnosis.steps[1].name, "tcp");

    // 主机名解析不了时**只**有一步：接一个 TCP 失败会让人以为还有端口问题
    let mut unknown = profile(DatabaseType::MySQL);
    unknown.host = "this-host-does-not-exist.invalid".to_string();
    unknown.port = 5432;

    let diagnosis = diagnose(&unknown).await;
    assert_eq!(diagnosis.steps.len(), 1);
    assert_eq!(diagnosis.steps[0].name, "resolve");
    assert!(!diagnosis.steps[0].ok);
  }

  #[tokio::test]
  async fn tells_a_real_sqlite_file_from_a_file_that_merely_exists() {
    let real = temporary_path(".db");
    let mut file = std::fs::File::create(&real).expect("create");
    file.write_all(SQLITE_MAGIC).expect("write header");
    file.write_all(&[0u8; 32]).expect("write body");
    drop(file);

    let mut config = profile(DatabaseType::SQLite);
    config.database = Some(real.to_string_lossy().to_string());
    let diagnosis = diagnose(&config).await;
    assert_eq!(diagnosis.steps.len(), 1);
    assert!(diagnosis.steps[0].ok, "{:?}", diagnosis.steps[0]);
    assert_eq!(diagnosis.steps[0].name, "sqliteFile");

    // 指到一份 CSV 上是真实发生过的误操作。驱动只说「文件不是数据库」，
    // 听起来像文件坏了，而实际是选错了文件。
    //
    // 这份内容刻意长于 16 字节的文件头：短文件会因为「读不满一个文件头」
    // 而被判掉，那条路径绕过了魔数比较。最初写成 12 字节的 `id,name\n1,a\n`，
    // 于是把魔数比较整个删掉这条断言依然是绿的——一道没在验它要验的东西的门
    let wrong = temporary_path(".csv");
    std::fs::write(&wrong, b"id,name,email,created_at\n1,a,a@example.com,2026-09-22\n")
      .expect("write csv");
    config.database = Some(wrong.to_string_lossy().to_string());
    let diagnosis = diagnose(&config).await;
    assert_eq!(diagnosis.steps[0].name, "sqliteMagic");
    assert!(!diagnosis.steps[0].ok);

    // 缺文件与「是个目录」都要能区分出来
    config.database = Some(temporary_path(".db").to_string_lossy().to_string());
    assert_eq!(diagnose(&config).await.steps[0].name, "sqliteFile");
    config.database = Some(std::env::temp_dir().to_string_lossy().to_string());
    let diagnosis = diagnose(&config).await;
    assert!(!diagnosis.steps[0].ok);
    assert!(diagnosis.steps[0].detail.contains("目录"));

    std::fs::remove_file(real).expect("cleanup");
    std::fs::remove_file(wrong).expect("cleanup");
  }

  /// 空文件是「新建一个库」的正常起点，不能报成选错文件
  #[tokio::test]
  async fn an_empty_file_is_a_new_database_not_a_wrong_one() {
    let empty = temporary_path(".db");
    std::fs::write(&empty, b"").expect("create empty");

    let mut config = profile(DatabaseType::SQLite);
    config.database = Some(empty.to_string_lossy().to_string());

    let diagnosis = diagnose(&config).await;
    assert_eq!(diagnosis.steps[0].name, "sqliteEmpty");
    assert!(diagnosis.steps[0].ok);

    std::fs::remove_file(empty).expect("cleanup");
  }

  #[tokio::test]
  async fn missing_fields_are_named_instead_of_probed() {
    let diagnosis = diagnose(&profile(DatabaseType::SQLite)).await;
    assert_eq!(diagnosis.steps[0].name, "sqliteFile");
    assert!(diagnosis.steps[0].detail.contains("未填写"));

    let diagnosis = diagnose(&profile(DatabaseType::PostgreSQL)).await;
    assert_eq!(diagnosis.steps[0].name, "resolve");
    assert!(diagnosis.steps[0].detail.contains("未填写"));

    let mut no_port = profile(DatabaseType::PostgreSQL);
    no_port.host = "127.0.0.1".to_string();
    let diagnosis = diagnose(&no_port).await;
    assert_eq!(diagnosis.steps[0].name, "tcp");
    assert!(diagnosis.steps[0].detail.contains("未填写"));
  }
}
