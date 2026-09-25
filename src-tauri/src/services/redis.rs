//! Redis：第二种非关系型库。
//!
//! 连接由后端持有，与 MongoDB 同一个办法：`test_connection` 连上之后把 [`RedisPool`]
//! 登记在 [`RedisRegistry`] 里，键是不带口令的 `redis://user@host:port/库号`。
//!
//! 和 MongoDB 不同、值得记住的：
//! - **一个库号一条连接。** `SELECT` 改的是整条连接的状态，而 `ConnectionManager` 是
//!   多路复用的——在它上面切库，同时在跑的另一条命令就落到别的库里。所以每个库号
//!   各开一条，第一次用到时才开（`RedisPool::connection`）。
//! - **键和值都是字节串**，不一定是 UTF-8。往前端送的是 [`RedisBytes`]：原样的
//!   base64（拿去定位用）加一份给人看的文字；前端回传的永远是 base64，不是那份文字。
//! - **只用 `SCAN` 族，不用 `KEYS`。** `KEYS` 在大库上会把整台服务端卡住。

use crate::models::{ConnectionProfile, TlsMode};
use crate::services::pool_registry::PoolRegistry;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use redis::{ConnectionAddr, IntoConnectionInfo, RedisConnectionInfo, Value};
use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// 与前端 `REDIS_SCHEME` 一致：连接串以它开头就归这里管
pub const REDIS_SCHEME: &str = "redis://";

/// 口令或用户名不对（`WRONGPASS`，或旧版的 `invalid password`）
pub const REDIS_AUTH_FAILED: &str = "DATAOMNI_REDIS_AUTH_FAILED";
/// 没给口令，而服务端要（`NOAUTH`）
pub const REDIS_AUTH_REQUIRED: &str = "DATAOMNI_REDIS_AUTH_REQUIRED";
/// 这个用户没有这条命令或这个键的权限（`NOPERM`，ACL）。冒号后面是服务端原话
pub const REDIS_NO_PERMISSION: &str = "DATAOMNI_REDIS_NO_PERMISSION";
/// 在时限内没连上：地址不通、TLS 对不上、服务没起
pub const REDIS_UNREACHABLE: &str = "DATAOMNI_REDIS_UNREACHABLE";
/// 服务端报错，冒号后面是 `错误码: 原话`
pub const REDIS_SERVER_ERROR: &str = "DATAOMNI_REDIS_SERVER_ERROR";
/// 超过了查询时限
pub const REDIS_TIMEOUT: &str = "DATAOMNI_REDIS_TIMEOUT";
/// 要看的键已经不在了（过期或被删）
pub const REDIS_KEY_GONE: &str = "DATAOMNI_REDIS_KEY_GONE";
/// 「库」那一格不是 0 或正整数
pub const REDIS_DATABASE_INVALID: &str = "DATAOMNI_REDIS_DATABASE_INVALID";
/// 前端传回来的键不是合法的 base64——只会是程序错误，报出来比拿错的键去查强
pub const REDIS_KEY_INVALID: &str = "DATAOMNI_REDIS_KEY_INVALID";
/// CA 证书文件读不了。冒号后面带着路径
pub const REDIS_TLS_FILE_INVALID: &str = "DATAOMNI_REDIS_TLS_FILE_INVALID";
/// 连接串对应的连接不在（断开之后还有请求过来）
pub const REDIS_NOT_CONNECTED: &str = "DATAOMNI_DB_SESSION_NOT_CONNECTED";

/// 连上的等待上限。和前端建立会话的 15 秒错开，让这里先报出原因
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 字符串值最多带多少字节过来。整份要看得另想办法（导出），界面上是一眼
const STRING_PREVIEW_BYTES: usize = 512 * 1024;

/// `SCAN` 一次让服务端看多少个槽位。`COUNT` 只是提示，服务端每次返回的个数不定
const SCAN_COUNT: u64 = 1_000;

pub type RedisRegistry = PoolRegistry<RedisPool>;

#[derive(Clone)]
pub struct RedisTarget {
  host: String,
  port: u16,
  username: String,
  password: String,
  /// 表单上「库」那一格，默认 0。对象树里另外几个库各开各的连接
  database: i64,
  tls: TlsMode,
  ca_certificate_path: Option<String>,
}

impl RedisTarget {
  pub fn from_profile(profile: &ConnectionProfile) -> Result<Self, String> {
    Ok(Self {
      host: profile.host.clone(),
      port: profile.port,
      username: profile.username.clone(),
      password: profile.password.clone(),
      database: database_index(profile.database.as_deref())?,
      tls: profile.effective_tls_mode(),
      ca_certificate_path: profile.ca_certificate_path.clone().filter(|path| !path.is_empty()),
    })
  }

  fn client(&self, database: i64) -> Result<redis::Client, String> {
    // `Required` 只加密不校验，与另外几家一致；`VerifyCa` 按完整校验（rustls 没有
    // 只放过主机名的开关），往严里走
    let address = match self.tls {
      TlsMode::Disabled => ConnectionAddr::Tcp(self.host.clone(), self.port),
      mode => ConnectionAddr::TcpTls {
        host: self.host.clone(),
        port: self.port,
        insecure: matches!(mode, TlsMode::Preferred | TlsMode::Required),
        tls_params: None,
      },
    };
    let mut settings = RedisConnectionInfo::default().set_db(database);
    if !self.username.is_empty() {
      settings = settings.set_username(&self.username);
    }
    if !self.password.is_empty() {
      settings = settings.set_password(&self.password);
    }
    let info = address.into_connection_info().map_err(describe_error)?.set_redis_settings(settings);
    match (&self.ca_certificate_path, self.tls) {
      (Some(path), mode) if mode != TlsMode::Disabled => {
        let root = std::fs::read(path)
          .map_err(|error| format!("{REDIS_TLS_FILE_INVALID}: {path}: {error}"))?;
        redis::Client::build_with_tls(
          info,
          redis::TlsCertificates { client_tls: None, root_cert: Some(root) },
        )
        .map_err(|error| format!("{REDIS_TLS_FILE_INVALID}: {path}: {error}"))
      }
      _ => redis::Client::open(info).map_err(describe_error),
    }
  }
}

/// 「库」那一格：空着是 0。别的写法当场拒——拿 `SELECT abc` 去问服务端，报出来的是
/// 一句「invalid DB index」，而且要等到连上之后
fn database_index(text: Option<&str>) -> Result<i64, String> {
  match text.map(str::trim).filter(|text| !text.is_empty()) {
    None => Ok(0),
    Some(text) => text
      .parse::<i64>()
      .ok()
      .filter(|index| *index >= 0)
      .ok_or_else(|| format!("{REDIS_DATABASE_INVALID}: {text}")),
  }
}

/// 一个连接配置在后端的全部：连接参数加每个库号一条连接
pub struct RedisPool {
  target: RedisTarget,
  connections: tokio::sync::Mutex<HashMap<i64, ConnectionManager>>,
}

impl RedisPool {
  /// 这个库号上的连接，第一次用到时才开。`ConnectionManager` 断了自己重连，
  /// 克隆一份就是同一条连接
  pub async fn connection(&self, database: i64) -> Result<ConnectionManager, String> {
    let mut connections = self.connections.lock().await;
    if let Some(connection) = connections.get(&database) {
      return Ok(connection.clone());
    }
    let connection = open(&self.target, database).await?;
    connections.insert(database, connection.clone());
    Ok(connection)
  }

  /// 配置里的那个库号：对象树总是列出它，哪怕里面一个键都没有
  pub fn default_database(&self) -> i64 {
    self.target.database
  }
}

/// 连上配置里的那个库并确认真的可用（`PING` 要认证，口令错在这一步报出来）
pub async fn connect(target: RedisTarget) -> Result<RedisPool, String> {
  let connection = open(&target, target.database).await?;
  let mut connections = HashMap::new();
  connections.insert(target.database, connection);
  Ok(RedisPool { target, connections: tokio::sync::Mutex::new(connections) })
}

async fn open(target: &RedisTarget, database: i64) -> Result<ConnectionManager, String> {
  let client = target.client(database)?;
  // 不设响应时限：每条命令外面各套一层查询超时（默认的 500 毫秒对大库上的 SCAN
  // 太短）。重试只留一次：连不上时要尽快说出来，不是在后台退避六轮
  let config = ConnectionManagerConfig::new()
    .set_connection_timeout(Some(CONNECT_TIMEOUT))
    .set_response_timeout(None)
    .set_number_of_retries(1);
  let attempt = async {
    let mut connection =
      client.get_connection_manager_with_config(config).await.map_err(describe_connect_error)?;
    redis::cmd("PING")
      .query_async::<String>(&mut connection)
      .await
      .map_err(describe_connect_error)?;
    Ok::<_, String>(connection)
  };
  match tokio::time::timeout(CONNECT_TIMEOUT + Duration::from_secs(2), attempt).await {
    Ok(result) => result,
    Err(_) => Err(format!("{REDIS_UNREACHABLE}: {}s", CONNECT_TIMEOUT.as_secs())),
  }
}

/// 连接阶段的错误：网络层的一律是「连不上」，认证与服务端的照常分
fn describe_connect_error(error: redis::RedisError) -> String {
  if error.is_io_error() || error.is_timeout() || error.is_connection_refusal() {
    return format!("{REDIS_UNREACHABLE}: {error}");
  }
  describe_error(error)
}

/// 驱动的错误 → 带码的一句话。认不出的原样给
pub fn describe_error(error: redis::RedisError) -> String {
  let detail = error.detail().unwrap_or_default().to_string();
  match error.code() {
    Some("NOAUTH") => return format!("{REDIS_AUTH_REQUIRED}: {detail}"),
    Some("WRONGPASS") => return format!("{REDIS_AUTH_FAILED}: {detail}"),
    Some("NOPERM") => return format!("{REDIS_NO_PERMISSION}: {detail}"),
    _ => {}
  }
  match error.kind() {
    redis::ErrorKind::AuthenticationFailed => format!("{REDIS_AUTH_FAILED}: {error}"),
    redis::ErrorKind::Server(_) | redis::ErrorKind::Extension => {
      format!("{REDIS_SERVER_ERROR}: {}: {detail}", error.code().unwrap_or("ERR"))
    }
    _ if error.is_timeout() => format!("{REDIS_TIMEOUT}: {error}"),
    _ => error.to_string(),
  }
}

async fn with_deadline<T>(
  timeout: Duration,
  work: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
  match tokio::time::timeout(timeout, work).await {
    Ok(result) => result,
    Err(_) => Err(format!("{REDIS_TIMEOUT}: {}ms", timeout.as_millis())),
  }
}

/// 一段字节串：`raw` 是原样的 base64，拿去定位；`text` 给人看——是 UTF-8 就原样，
/// 不是就按 redis-cli 的写法转义（`\xff`），并且 `binary` 为真，界面据此标出来
#[derive(Debug, Serialize, PartialEq)]
pub struct RedisBytes {
  pub raw: String,
  pub text: String,
  pub binary: bool,
}

impl RedisBytes {
  fn new(bytes: Vec<u8>) -> Self {
    let raw = BASE64.encode(&bytes);
    match String::from_utf8(bytes) {
      Ok(text) => Self { raw, text, binary: false },
      Err(error) => Self { raw, text: escape_bytes(error.as_bytes()), binary: true },
    }
  }
}

/// redis-cli 的写法：可打印的 ASCII 原样（反斜杠与双引号加转义），其余 `\xHH`
fn escape_bytes(bytes: &[u8]) -> String {
  let mut text = String::with_capacity(bytes.len());
  for &byte in bytes {
    match byte {
      b'\\' => text.push_str("\\\\"),
      b'"' => text.push_str("\\\""),
      0x20..=0x7e => text.push(char::from(byte)),
      _ => text.push_str(&format!("\\x{byte:02x}")),
    }
  }
  text
}

/// 前端传回来的键
pub fn decode_key(raw: &str) -> Result<Vec<u8>, String> {
  BASE64.decode(raw).map_err(|_| REDIS_KEY_INVALID.to_string())
}

/// 对象树的一行：一个逻辑库。形状与关系库的对象目录一致，`object_schema` 空着
#[derive(Debug, Serialize, PartialEq)]
pub struct KeyspaceEntry {
  pub object_schema: Option<String>,
  pub object_name: String,
  pub object_kind: &'static str,
  pub object_id: String,
  pub keys: u64,
}

/// 有键的库，加上配置里那个库（哪怕是空的）。数的是 `INFO keyspace`——它只列有键的库，
/// 也不用 `CONFIG GET databases`：那条在 ACL 里属于危险命令，只读用户多半没有
pub async fn list_keyspaces(pool: &RedisPool) -> Result<Vec<KeyspaceEntry>, String> {
  let mut connection = pool.connection(pool.default_database()).await?;
  let info: String = redis::cmd("INFO")
    .arg("keyspace")
    .query_async(&mut connection)
    .await
    .map_err(describe_error)?;
  let mut counts = parse_keyspace(&info);
  counts.entry(pool.default_database()).or_insert(0);
  let mut indexes: Vec<_> = counts.into_iter().collect();
  indexes.sort_unstable();
  Ok(
    indexes
      .into_iter()
      .map(|(index, keys)| KeyspaceEntry {
        object_schema: None,
        object_name: format!("db{index}"),
        object_kind: "keyspace",
        object_id: format!("db{index}"),
        keys,
      })
      .collect(),
  )
}

/// `db0:keys=12,expires=0,avg_ttl=0` 这样的行 → 库号与键数
fn parse_keyspace(info: &str) -> HashMap<i64, u64> {
  info
    .lines()
    .filter_map(|line| {
      let (name, fields) = line.trim().split_once(':')?;
      let index = name.strip_prefix("db")?.parse::<i64>().ok()?;
      let keys = fields.split(',').find_map(|field| field.strip_prefix("keys="))?.parse().ok()?;
      Some((index, keys))
    })
    .collect()
}

pub struct ScanRequest {
  pub database: i64,
  pub pattern: String,
  /// 上一页给的游标，第一页是 "0"
  pub cursor: String,
  /// 只要这一种类型（`SCAN … TYPE`）
  pub kind: Option<String>,
  /// 凑够这么多个就停；一次 `SCAN` 多给的不丢——丢了下一页就再也看不到它们
  pub page: usize,
  pub timeout: Duration,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyRow {
  pub key: RedisBytes,
  /// `TYPE` 的回答：string / hash / list / set / zset / stream，或模块类型的名字
  pub kind: String,
  /// 毫秒；-1 是不过期，-2 是这一刻已经没了
  pub ttl_ms: i64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ScanPage {
  pub keys: Vec<RedisKeyRow>,
  /// 下一页的游标；`None` 是扫完了。游标可以大过 2⁵³，所以是字符串
  pub cursor: Option<String>,
}

/// 按模式翻一页键，顺带每个键的类型与剩余时间（一次流水线取回，不是一个键一趟）
pub async fn scan(pool: &RedisPool, request: ScanRequest) -> Result<ScanPage, String> {
  let mut connection = pool.connection(request.database).await?;
  let started = Instant::now();
  let work = async {
    let mut cursor: u64 = request.cursor.parse().unwrap_or(0);
    let mut keys: Vec<Vec<u8>> = Vec::new();
    loop {
      let mut command = redis::cmd("SCAN");
      command.arg(cursor).arg("MATCH").arg(&request.pattern).arg("COUNT").arg(SCAN_COUNT);
      if let Some(kind) = &request.kind {
        command.arg("TYPE").arg(kind);
      }
      let (next, batch): (u64, Vec<Vec<u8>>) =
        command.query_async(&mut connection).await.map_err(describe_error)?;
      keys.extend(batch);
      cursor = next;
      // 大库里匹配得很稀时一页可能要扫很多轮；过了一半时限就先交出已有的，
      // 带着游标让人接着翻，而不是整页超时
      if cursor == 0 || keys.len() >= request.page || started.elapsed() > request.timeout / 2 {
        break;
      }
    }
    let rows = describe_keys(&mut connection, keys).await?;
    Ok(ScanPage { keys: rows, cursor: (cursor != 0).then(|| cursor.to_string()) })
  };
  with_deadline(request.timeout, work).await
}

async fn describe_keys(
  connection: &mut ConnectionManager,
  keys: Vec<Vec<u8>>,
) -> Result<Vec<RedisKeyRow>, String> {
  if keys.is_empty() {
    return Ok(Vec::new());
  }
  let mut pipe = redis::pipe();
  for key in &keys {
    pipe.cmd("TYPE").arg(key).cmd("PTTL").arg(key);
  }
  let replies: Vec<Value> = pipe.query_async(connection).await.map_err(describe_error)?;
  let mut replies = replies.into_iter();
  Ok(
    keys
      .into_iter()
      .map(|key| {
        let kind = match replies.next() {
          Some(Value::SimpleString(kind)) => kind,
          Some(Value::BulkString(kind)) => String::from_utf8_lossy(&kind).into_owned(),
          _ => "none".to_string(),
        };
        let ttl_ms = match replies.next() {
          Some(Value::Int(ttl)) => ttl,
          _ => -2,
        };
        RedisKeyRow { key: RedisBytes::new(key), kind, ttl_ms }
      })
      .collect(),
  )
}

/// 一个键的值，按类型各一种形状；集合类的都是一页，`next` 是下一页从哪接（`None` 是完了）。
/// 翻页的位置对前端是不透明的字符串：散列与集合是 `*SCAN` 的游标，列表与有序集合是
/// 下标，流是上一页最后一条的 ID
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RedisValue {
  String {
    size: u64,
    value: RedisBytes,
    truncated: bool,
  },
  Hash {
    length: u64,
    entries: Vec<(RedisBytes, RedisBytes)>,
    next: Option<String>,
  },
  List {
    length: u64,
    offset: u64,
    items: Vec<RedisBytes>,
    next: Option<String>,
  },
  Set {
    length: u64,
    members: Vec<RedisBytes>,
    next: Option<String>,
  },
  Zset {
    length: u64,
    offset: u64,
    entries: Vec<(RedisBytes, String)>,
    next: Option<String>,
  },
  Stream {
    length: u64,
    entries: Vec<StreamEntry>,
    next: Option<String>,
  },
  /// 模块类型（RedisJSON、布隆过滤器……）：说出类型名，不假装看得懂
  #[serde(rename_all = "camelCase")]
  Unsupported {
    redis_type: String,
  },
}

/// `XRANGE` 的一条：ID 与 `[f1, v1, …]`
type RawStreamEntry = (String, Vec<Vec<u8>>);

#[derive(Debug, Serialize, PartialEq)]
pub struct StreamEntry {
  pub id: String,
  pub fields: Vec<(RedisBytes, RedisBytes)>,
}

pub struct ValueRequest {
  pub database: i64,
  pub key: Vec<u8>,
  /// 上一页给的 `next`；第一页是 `None`
  pub position: Option<String>,
  pub page: u64,
  pub timeout: Duration,
}

pub async fn read_value(pool: &RedisPool, request: ValueRequest) -> Result<RedisValue, String> {
  let mut connection = pool.connection(request.database).await?;
  let work = async {
    let kind: String = redis::cmd("TYPE")
      .arg(&request.key)
      .query_async(&mut connection)
      .await
      .map_err(describe_error)?;
    let key = &request.key;
    let page = request.page.max(1);
    let position = request.position.as_deref();
    let offset: u64 = position.and_then(|position| position.parse().ok()).unwrap_or(0);
    let cursor = position.unwrap_or("0");
    let value = match kind.as_str() {
      "none" => return Err(REDIS_KEY_GONE.to_string()),
      "string" => {
        let (size, bytes): (u64, Vec<u8>) = redis::pipe()
          .cmd("STRLEN")
          .arg(key)
          .cmd("GETRANGE")
          .arg(key)
          .arg(0)
          .arg(STRING_PREVIEW_BYTES - 1)
          .query_async(&mut connection)
          .await
          .map_err(describe_error)?;
        let truncated = size > bytes.len() as u64;
        RedisValue::String { size, value: preview_bytes(bytes, truncated), truncated }
      }
      "hash" => {
        let (length, (next, flat)): (u64, (u64, Vec<Vec<u8>>)) = redis::pipe()
          .cmd("HLEN")
          .arg(key)
          .cmd("HSCAN")
          .arg(key)
          .arg(cursor)
          .arg("COUNT")
          .arg(page)
          .query_async(&mut connection)
          .await
          .map_err(describe_error)?;
        RedisValue::Hash {
          length,
          entries: pairs(flat),
          next: (next != 0).then(|| next.to_string()),
        }
      }
      "list" => {
        let end = offset + page - 1;
        let (length, items): (u64, Vec<Vec<u8>>) = redis::pipe()
          .cmd("LLEN")
          .arg(key)
          .cmd("LRANGE")
          .arg(key)
          .arg(offset)
          .arg(end)
          .query_async(&mut connection)
          .await
          .map_err(describe_error)?;
        RedisValue::List {
          length,
          offset,
          items: items.into_iter().map(RedisBytes::new).collect(),
          next: (end + 1 < length).then(|| (end + 1).to_string()),
        }
      }
      "set" => {
        let (length, (next, members)): (u64, (u64, Vec<Vec<u8>>)) = redis::pipe()
          .cmd("SCARD")
          .arg(key)
          .cmd("SSCAN")
          .arg(key)
          .arg(cursor)
          .arg("COUNT")
          .arg(page)
          .query_async(&mut connection)
          .await
          .map_err(describe_error)?;
        RedisValue::Set {
          length,
          members: members.into_iter().map(RedisBytes::new).collect(),
          next: (next != 0).then(|| next.to_string()),
        }
      }
      "zset" => {
        let end = offset + page - 1;
        let (length, flat): (u64, Vec<Vec<u8>>) = redis::pipe()
          .cmd("ZCARD")
          .arg(key)
          .cmd("ZRANGE")
          .arg(key)
          .arg(offset)
          .arg(end)
          .arg("WITHSCORES")
          .query_async(&mut connection)
          .await
          .map_err(describe_error)?;
        let entries = pairs(flat).into_iter().map(|(member, score)| (member, score.text)).collect();
        RedisValue::Zset {
          length,
          offset,
          entries,
          next: (end + 1 < length).then(|| (end + 1).to_string()),
        }
      }
      "stream" => {
        // 接着上一页最后一条往后读：`(` 是不含它自己（6.2 起）
        let start = position.map_or_else(|| "-".to_string(), |id| format!("({id}"));
        let (length, entries): (u64, Vec<RawStreamEntry>) = redis::pipe()
          .cmd("XLEN")
          .arg(key)
          .cmd("XRANGE")
          .arg(key)
          .arg(start)
          .arg("+")
          .arg("COUNT")
          .arg(page)
          .query_async(&mut connection)
          .await
          .map_err(describe_error)?;
        let next = (entries.len() as u64 == page)
          .then(|| entries.last().map(|(id, _)| id.clone()))
          .flatten();
        RedisValue::Stream {
          length,
          entries: entries
            .into_iter()
            .map(|(id, flat)| StreamEntry { id, fields: pairs(flat) })
            .collect(),
          next,
        }
      }
      other => RedisValue::Unsupported { redis_type: other.to_string() },
    };
    Ok(value)
  };
  with_deadline(request.timeout, work).await
}

/// 截断了的字符串值：截在一个多字节字符中间时，把那半个字符去掉再判断是不是 UTF-8——
/// 不然一段中文的前 512 KiB 会被当成二进制
fn preview_bytes(mut bytes: Vec<u8>, truncated: bool) -> RedisBytes {
  if truncated {
    if let Err(error) = std::str::from_utf8(&bytes) {
      if error.error_len().is_none() {
        bytes.truncate(error.valid_up_to());
      }
    }
  }
  RedisBytes::new(bytes)
}

/// `[f1, v1, f2, v2, …]` → `[(f1, v1), …]`
fn pairs(flat: Vec<Vec<u8>>) -> Vec<(RedisBytes, RedisBytes)> {
  let mut items = flat.into_iter();
  let mut pairs = Vec::new();
  while let (Some(first), Some(second)) = (items.next(), items.next()) {
    pairs.push((RedisBytes::new(first), RedisBytes::new(second)));
  }
  pairs
}

/// 改名的目标已经有了：不覆盖（`RENAMENX`）
pub const REDIS_KEY_EXISTS: &str = "DATAOMNI_REDIS_KEY_EXISTS";
/// 要改的值在打开之后被别处改过；不覆盖别人的改动
pub const REDIS_VALUE_CHANGED: &str = "DATAOMNI_REDIS_VALUE_CHANGED";

/// 界面上对一个键做的事。都是单个命令或一段先比对再写的脚本，发出去就生效
pub enum KeyChange {
  Delete,
  Rename {
    to: Vec<u8>,
  },
  /// `None` 是去掉过期（`PERSIST`）
  Expire {
    ttl_ms: Option<u64>,
  },
  /// 改字符串：服务端那份还是 `expected` 才写，剩余时间保留（`KEEPTTL`）
  SetString {
    expected: Vec<u8>,
    value: Vec<u8>,
  },
}

/// 比对后再写。多路复用的连接上没法 `WATCH`（它是整条连接的状态），而一段脚本在服务端
/// 是原子执行的：读、比、写之间插不进别的命令
const SET_STRING_IF_UNCHANGED: &str = r"
local current = redis.call('GET', KEYS[1])
if current == false then return -2 end
if current ~= ARGV[1] then return -1 end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1
";

pub async fn change_key(
  pool: &RedisPool,
  database: i64,
  key: Vec<u8>,
  change: KeyChange,
  timeout: Duration,
) -> Result<(), String> {
  let mut connection = pool.connection(database).await?;
  let work = async {
    let outcome: i64 = match change {
      KeyChange::Delete => {
        redis::cmd("UNLINK").arg(&key).query_async(&mut connection).await.map_err(describe_error)?
      }
      KeyChange::Rename { to } => {
        let renamed =
          redis::cmd("RENAMENX").arg(&key).arg(&to).query_async::<i64>(&mut connection).await;
        match renamed {
          Ok(0) => return Err(format!("{REDIS_KEY_EXISTS}: {}", RedisBytes::new(to).text)),
          Ok(_) => 1,
          // 源键不在时服务端报 `ERR no such key`
          Err(error) if error.detail().is_some_and(|detail| detail.contains("no such key")) => 0,
          Err(error) => return Err(describe_error(error)),
        }
      }
      KeyChange::Expire { ttl_ms: Some(ttl) } => redis::cmd("PEXPIRE")
        .arg(&key)
        .arg(ttl)
        .query_async(&mut connection)
        .await
        .map_err(describe_error)?,
      KeyChange::Expire { ttl_ms: None } => {
        // `PERSIST` 对「本来就不过期」也回 0，和「键不在」分不开，所以另问一次在不在
        let (_, exists): (i64, i64) = redis::pipe()
          .cmd("PERSIST")
          .arg(&key)
          .cmd("EXISTS")
          .arg(&key)
          .query_async(&mut connection)
          .await
          .map_err(describe_error)?;
        exists
      }
      KeyChange::SetString { expected, value } => {
        let outcome: i64 = redis::Script::new(SET_STRING_IF_UNCHANGED)
          .key(&key)
          .arg(expected)
          .arg(value)
          .invoke_async(&mut connection)
          .await
          .map_err(describe_error)?;
        match outcome {
          -1 => return Err(REDIS_VALUE_CHANGED.to_string()),
          -2 => 0,
          _ => 1,
        }
      }
    };
    if outcome == 0 {
      return Err(REDIS_KEY_GONE.to_string());
    }
    Ok(())
  };
  with_deadline(timeout, work).await
}

/// 要加的元素已经在了（hash 字段、set 成员、zset 成员）：不覆盖
pub const REDIS_ELEMENT_EXISTS: &str = "DATAOMNI_REDIS_ELEMENT_EXISTS";
/// 要改或删的元素已经不在了
pub const REDIS_ELEMENT_GONE: &str = "DATAOMNI_REDIS_ELEMENT_GONE";

/// 改一个值里面的一个元素。`expected` 是打开时看到的那份：服务端那份变了就不写。
/// 字节串都是原样的（hash 字段、成员可以是二进制）
pub enum ElementChange {
  /// `expected` 为 `None` 是新加一个字段（已经有了就不覆盖）
  HashSet {
    field: Vec<u8>,
    expected: Option<Vec<u8>>,
    value: Vec<u8>,
  },
  HashDelete {
    field: Vec<u8>,
  },
  ListSet {
    index: i64,
    expected: Vec<u8>,
    value: Vec<u8>,
  },
  ListDelete {
    index: i64,
    expected: Vec<u8>,
  },
  ListPush {
    value: Vec<u8>,
    head: bool,
  },
  SetAdd {
    member: Vec<u8>,
  },
  SetDelete {
    member: Vec<u8>,
  },
  /// `expected` 为 `None` 是新加一个成员；否则是改分数，服务端的分数得还是 `expected`
  ZsetSet {
    member: Vec<u8>,
    expected: Option<String>,
    score: String,
  },
  ZsetDelete {
    member: Vec<u8>,
  },
}

/// 每段脚本的回答：1 写了；-1 值变了；-2 键没了；-3 元素已经在；-4 元素没了。
/// 都先看键在不在：`HSET`、`SADD`、`ZADD` 对一个不在的键会建出一个新的——而人以为
/// 自己在改的那个键已经过期或被删了
const HASH_SET: &str = r"
if redis.call('EXISTS', KEYS[1]) == 0 then return -2 end
local current = redis.call('HGET', KEYS[1], ARGV[1])
if ARGV[3] == 'new' then
  if current then return -3 end
else
  if current == false then return -4 end
  if current ~= ARGV[4] then return -1 end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1
";

/// `HDEL` / `SREM` / `ZREM` 共用：命令名在 ARGV[1]
const MEMBER_DELETE: &str = r"
if redis.call('EXISTS', KEYS[1]) == 0 then return -2 end
if redis.call(ARGV[1], KEYS[1], ARGV[2]) == 0 then return -4 end
return 1
";

const LIST_SET: &str = r"
if redis.call('EXISTS', KEYS[1]) == 0 then return -2 end
local current = redis.call('LINDEX', KEYS[1], ARGV[1])
if current == false then return -4 end
if current ~= ARGV[2] then return -1 end
redis.call('LSET', KEYS[1], ARGV[1], ARGV[3])
return 1
";

/// 按下标删：Redis 没有这条命令。先比对，再把那一格换成一个一次性的记号，删掉这个记号——
/// 记号每次现造（ARGV[3]），不会和列表里真有的值撞上
const LIST_DELETE: &str = r"
if redis.call('EXISTS', KEYS[1]) == 0 then return -2 end
local current = redis.call('LINDEX', KEYS[1], ARGV[1])
if current == false then return -4 end
if current ~= ARGV[2] then return -1 end
redis.call('LSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('LREM', KEYS[1], 1, ARGV[3])
return 1
";

const SET_ADD: &str = r"
if redis.call('EXISTS', KEYS[1]) == 0 then return -2 end
if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then return -3 end
return 1
";

const ZSET_SET: &str = r"
if redis.call('EXISTS', KEYS[1]) == 0 then return -2 end
local current = redis.call('ZSCORE', KEYS[1], ARGV[1])
if ARGV[3] == 'new' then
  if current then return -3 end
else
  if current == false then return -4 end
  if current ~= ARGV[4] then return -1 end
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
return 1
";

pub async fn change_element(
  pool: &RedisPool,
  database: i64,
  key: Vec<u8>,
  change: ElementChange,
  timeout: Duration,
) -> Result<(), String> {
  let mut connection = pool.connection(database).await?;
  let (script, arguments): (&str, Vec<Vec<u8>>) = match change {
    ElementChange::HashSet { field, expected: None, value } => {
      (HASH_SET, vec![field, value, b"new".to_vec()])
    }
    ElementChange::HashSet { field, expected: Some(expected), value } => {
      (HASH_SET, vec![field, value, b"edit".to_vec(), expected])
    }
    ElementChange::HashDelete { field } => (MEMBER_DELETE, vec![b"HDEL".to_vec(), field]),
    ElementChange::ListSet { index, expected, value } => {
      (LIST_SET, vec![index.to_string().into_bytes(), expected, value])
    }
    ElementChange::ListDelete { index, expected } => {
      let marker = format!("__dataomni_removed_{}__", uuid::Uuid::new_v4()).into_bytes();
      (LIST_DELETE, vec![index.to_string().into_bytes(), expected, marker])
    }
    ElementChange::ListPush { value, head } => {
      // `*PUSHX` 只往已经在的列表里推，列表没了回 0
      let command = if head { "LPUSHX" } else { "RPUSHX" };
      let work = async {
        let length: i64 = redis::cmd(command)
          .arg(&key)
          .arg(value)
          .query_async(&mut connection)
          .await
          .map_err(describe_error)?;
        if length == 0 {
          return Err(REDIS_KEY_GONE.to_string());
        }
        Ok(())
      };
      return with_deadline(timeout, work).await;
    }
    ElementChange::SetAdd { member } => (SET_ADD, vec![member]),
    ElementChange::SetDelete { member } => (MEMBER_DELETE, vec![b"SREM".to_vec(), member]),
    ElementChange::ZsetSet { member, expected: None, score } => {
      (ZSET_SET, vec![member, score.into_bytes(), b"new".to_vec()])
    }
    ElementChange::ZsetSet { member, expected: Some(expected), score } => {
      (ZSET_SET, vec![member, score.into_bytes(), b"edit".to_vec(), expected.into_bytes()])
    }
    ElementChange::ZsetDelete { member } => (MEMBER_DELETE, vec![b"ZREM".to_vec(), member]),
  };
  let work = async {
    let script = redis::Script::new(script);
    let mut invocation = script.prepare_invoke();
    invocation.key(&key);
    for argument in arguments {
      invocation.arg(argument);
    }
    let outcome: i64 = invocation.invoke_async(&mut connection).await.map_err(describe_error)?;
    script_outcome(outcome)
  };
  with_deadline(timeout, work).await
}

fn script_outcome(outcome: i64) -> Result<(), String> {
  match outcome {
    -1 => Err(REDIS_VALUE_CHANGED.to_string()),
    -2 => Err(REDIS_KEY_GONE.to_string()),
    -3 => Err(REDIS_ELEMENT_EXISTS.to_string()),
    -4 => Err(REDIS_ELEMENT_GONE.to_string()),
    _ => Ok(()),
  }
}

/// 新建一个键：给类型与第一个元素（Redis 没有空的 hash / list / set）。键名已经有了就不建
pub struct NewKey {
  pub kind: String,
  /// string 的值；hash 的字段；list / set 的元素；zset 的成员；stream 的字段
  pub first: Vec<u8>,
  /// hash 与 stream 的值；zset 的分数；其余不用
  pub second: Vec<u8>,
  pub ttl_ms: Option<u64>,
}

const CREATE_KEY: &str = r"
if redis.call('EXISTS', KEYS[1]) == 1 then return -3 end
local kind = ARGV[1]
if kind == 'string' then redis.call('SET', KEYS[1], ARGV[2])
elseif kind == 'hash' then redis.call('HSET', KEYS[1], ARGV[2], ARGV[3])
elseif kind == 'list' then redis.call('RPUSH', KEYS[1], ARGV[2])
elseif kind == 'set' then redis.call('SADD', KEYS[1], ARGV[2])
elseif kind == 'zset' then redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2])
elseif kind == 'stream' then redis.call('XADD', KEYS[1], '*', ARGV[2], ARGV[3])
else return redis.error_reply('ERR unknown type ' .. kind) end
if ARGV[4] ~= '' then redis.call('PEXPIRE', KEYS[1], ARGV[4]) end
return 1
";

pub async fn create_key(
  pool: &RedisPool,
  database: i64,
  key: Vec<u8>,
  new_key: NewKey,
  timeout: Duration,
) -> Result<(), String> {
  let mut connection = pool.connection(database).await?;
  let work = async {
    let outcome: i64 = redis::Script::new(CREATE_KEY)
      .key(&key)
      .arg(new_key.kind)
      .arg(new_key.first)
      .arg(new_key.second)
      .arg(new_key.ttl_ms.map(|ttl| ttl.to_string()).unwrap_or_default())
      .invoke_async(&mut connection)
      .await
      .map_err(describe_error)?;
    if outcome == -3 {
      return Err(format!("{REDIS_KEY_EXISTS}: {}", RedisBytes::new(key.clone()).text));
    }
    Ok(())
  };
  with_deadline(timeout, work).await
}

/// 命令行里不许跑：这条会阻塞，共用的连接上别的请求都得排在它后面。冒号后面是命令名
pub const REDIS_COMMAND_BLOCKING: &str = "DATAOMNI_REDIS_COMMAND_BLOCKING";
/// 命令行里不许跑：这条会改共用连接的状态（切库、事务、换身份）。冒号后面是命令名
pub const REDIS_COMMAND_CONNECTION_STATE: &str = "DATAOMNI_REDIS_COMMAND_CONNECTION_STATE";
/// 命令行里什么都没写
pub const REDIS_COMMAND_EMPTY: &str = "DATAOMNI_REDIS_COMMAND_EMPTY";

/// 为什么这条不能在这里跑。
///
/// 这里的连接是多路复用、各处共用的一条：会阻塞的命令（`BLPOP`、`MONITOR`、订阅）
/// 在它返回之前，对象树、键列表、值面板发出的每一条都排在它后面；改连接状态的
/// （`SELECT`、`MULTI`、`AUTH`、`CLIENT REPLY`）会让同一条连接上别处的命令落进
/// 另一个库、进了事务队列、或者换了身份。切库用对象树
fn refusal(name: &str, arguments: &[Vec<u8>]) -> Option<&'static str> {
  const BLOCKING: &[&str] = &[
    "BLPOP",
    "BRPOP",
    "BRPOPLPUSH",
    "BLMOVE",
    "BLMPOP",
    "BZPOPMIN",
    "BZPOPMAX",
    "BZMPOP",
    "WAIT",
    "WAITAOF",
    "MONITOR",
    "SUBSCRIBE",
    "PSUBSCRIBE",
    "SSUBSCRIBE",
    "UNSUBSCRIBE",
    "PUNSUBSCRIBE",
    "SUNSUBSCRIBE",
    "SYNC",
    "PSYNC",
  ];
  const CONNECTION_STATE: &[&str] =
    &["SELECT", "MULTI", "EXEC", "DISCARD", "WATCH", "UNWATCH", "AUTH", "HELLO", "RESET", "QUIT"];
  if BLOCKING.contains(&name) {
    return Some(REDIS_COMMAND_BLOCKING);
  }
  if CONNECTION_STATE.contains(&name) {
    return Some(REDIS_COMMAND_CONNECTION_STATE);
  }
  let has =
    |word: &str| arguments.iter().any(|argument| argument.eq_ignore_ascii_case(word.as_bytes()));
  // `XREAD` 本身不阻塞，带了 `BLOCK` 才阻塞
  if matches!(name, "XREAD" | "XREADGROUP") && has("BLOCK") {
    return Some(REDIS_COMMAND_BLOCKING);
  }
  let first = arguments.first().map(|argument| argument.to_ascii_uppercase());
  if name == "CLIENT"
    && matches!(
      first.as_deref(),
      Some(b"REPLY" | b"TRACKING" | b"CACHING" | b"NO-EVICT" | b"NO-TOUCH")
    )
  {
    return Some(REDIS_COMMAND_CONNECTION_STATE);
  }
  None
}

/// 一条回答，形状照服务端给的（RESP2 与 RESP3 的都认）。前端按 redis-cli 的样子画
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RedisReply {
  Nil,
  Integer {
    value: i64,
  },
  Bulk {
    value: RedisBytes,
  },
  Status {
    value: String,
  },
  Error {
    message: String,
  },
  Array {
    items: Vec<RedisReply>,
  },
  Map {
    entries: Vec<(RedisReply, RedisReply)>,
  },
  Double {
    value: f64,
  },
  Boolean {
    value: bool,
  },
  /// 超出 64 位的整数，原样的十进制文字
  BigNumber {
    value: String,
  },
}

impl RedisReply {
  fn from_value(value: Value) -> Self {
    match value {
      Value::Nil => Self::Nil,
      Value::Int(value) => Self::Integer { value },
      Value::BulkString(bytes) => Self::Bulk { value: RedisBytes::new(bytes) },
      Value::SimpleString(value) => Self::Status { value },
      Value::Okay => Self::Status { value: "OK".to_string() },
      Value::Array(items) | Value::Set(items) | Value::Push { data: items, .. } => {
        Self::Array { items: items.into_iter().map(Self::from_value).collect() }
      }
      Value::Map(entries) => Self::Map {
        entries: entries
          .into_iter()
          .map(|(key, value)| (Self::from_value(key), Self::from_value(value)))
          .collect(),
      },
      Value::Attribute { data, .. } => Self::from_value(*data),
      Value::Double(value) => Self::Double { value },
      Value::Boolean(value) => Self::Boolean { value },
      Value::VerbatimString { text, .. } => {
        Self::Bulk { value: RedisBytes::new(text.into_bytes()) }
      }
      Value::BigNumber(digits) => {
        Self::BigNumber { value: String::from_utf8_lossy(&digits).into_owned() }
      }
      Value::ServerError(error) => Self::Error {
        message: format!("{} {}", error.code(), error.details().unwrap_or_default())
          .trim()
          .to_string(),
      },
      // `Value` 标了 non_exhaustive：驱动将来多一种形状时照原样说出来，不假装认识
      other => Self::Status { value: format!("{other:?}") },
    }
  }
}

/// 命令行：照原样发一条命令。参数是字节串（前端按 redis-cli 的规矩拆好、编成 base64），
/// 服务端的错误回答算作一条正常的回答（`(error) …`），不当作失败——那正是人要看的。
/// 网络断了、超时这类才是失败
pub async fn execute(
  pool: &RedisPool,
  database: i64,
  arguments: Vec<Vec<u8>>,
  timeout: Duration,
) -> Result<RedisReply, String> {
  let Some((name, rest)) = arguments.split_first() else {
    return Err(REDIS_COMMAND_EMPTY.to_string());
  };
  let name = String::from_utf8_lossy(name).to_ascii_uppercase();
  if let Some(reason) = refusal(&name, rest) {
    return Err(format!("{reason}: {name}"));
  }
  let mut connection = pool.connection(database).await?;
  let mut command = redis::cmd(&name);
  for argument in rest {
    command.arg(argument);
  }
  let work = async {
    use redis::aio::ConnectionLike;
    match connection.req_packed_command(&command).await {
      Ok(value) => Ok(RedisReply::from_value(value)),
      Err(error)
        if matches!(error.kind(), redis::ErrorKind::Server(_) | redis::ErrorKind::Extension) =>
      {
        Ok(RedisReply::Error {
          message: format!(
            "{} {}",
            error.code().unwrap_or("ERR"),
            error.detail().unwrap_or_default()
          ),
        })
      }
      Err(error) => Err(describe_error(error)),
    }
  };
  with_deadline(timeout, work).await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn bytes_that_are_not_utf8_are_escaped_and_flagged() {
    let text = RedisBytes::new("user:中文".as_bytes().to_vec());
    assert_eq!((text.text.as_str(), text.binary), ("user:中文", false));
    let binary = RedisBytes::new(vec![b'k', 0xff, b'\\', b'"', b'\n']);
    assert_eq!((binary.text.as_str(), binary.binary), ("k\\xff\\\\\\\"\\x0a", true));
    assert_eq!(decode_key(&binary.raw), Ok(vec![b'k', 0xff, b'\\', b'"', b'\n']));
  }

  #[test]
  fn a_string_cut_inside_a_character_is_still_text() {
    let mut bytes = "中文".as_bytes().to_vec();
    bytes.pop();
    let preview = preview_bytes(bytes.clone(), true);
    assert_eq!((preview.text.as_str(), preview.binary), ("中", false));
    // 反向：没截断时那半个字符是真的坏字节
    assert!(preview_bytes(bytes, false).binary);
  }

  #[test]
  fn the_keyspace_section_is_read_into_counts() {
    let info =
      "# Keyspace\r\ndb0:keys=12,expires=1,avg_ttl=0\r\ndb3:keys=5,expires=0,avg_ttl=0\r\n";
    let counts = parse_keyspace(info);
    assert_eq!(counts.get(&0), Some(&12));
    assert_eq!(counts.get(&3), Some(&5));
    assert_eq!(counts.len(), 2);
  }

  #[test]
  fn commands_that_block_or_change_the_shared_connection_are_refused() {
    assert_eq!(refusal("BLPOP", &[]), Some(REDIS_COMMAND_BLOCKING));
    assert_eq!(refusal("SELECT", &[b"3".to_vec()]), Some(REDIS_COMMAND_CONNECTION_STATE));
    assert_eq!(refusal("XREAD", &[b"block".to_vec(), b"0".to_vec()]), Some(REDIS_COMMAND_BLOCKING));
    assert_eq!(
      refusal("CLIENT", &[b"reply".to_vec(), b"off".to_vec()]),
      Some(REDIS_COMMAND_CONNECTION_STATE)
    );
    // 反向：不阻塞的同名兄弟照常跑
    assert_eq!(refusal("XREAD", &[b"COUNT".to_vec(), b"1".to_vec()]), None);
    assert_eq!(refusal("CLIENT", &[b"LIST".to_vec()]), None);
    assert_eq!(refusal("GET", &[b"k".to_vec()]), None);
  }

  #[test]
  fn the_database_field_is_a_non_negative_index() {
    assert_eq!(database_index(None), Ok(0));
    assert_eq!(database_index(Some(" ")), Ok(0));
    assert_eq!(database_index(Some("3")), Ok(3));
    assert!(database_index(Some("-1")).is_err());
    assert!(database_index(Some("abc")).is_err());
  }
}
