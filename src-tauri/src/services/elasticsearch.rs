//! Elasticsearch：第四种非关系型库。
//!
//! 连接由后端持有，与另外三家同一个办法：`test_connection` 连上之后把 [`EsPool`] 登记在
//! [`EsRegistry`] 里，键是不带口令的 `elasticsearch://user@host:port`。
//!
//! 和前几家不同、值得记住的：
//! - **没有驱动**，就是 HTTP（reqwest）。控制台要的是「任意方法 + 任意路径 + 原样的请求体」，
//!   按端点生成的官方 crate 在这里只剩一层转发（TODOs 4.3）。
//! - **响应体原样送前端**：`_source` 里超过 2^53 的整数过一遍 `serde_json::Value` 就不再是原来的数，
//!   怎么解析交给前端（`utils/esJson.ts`）。这里只在对象树这种自己读的地方解析。
//! - **状态码不是错误**：404、400 是服务端的回答，照原样给控制台看；只有连不上、超时、
//!   认证失败这些才是命令的错误。
//! - **时限只在客户端**：ES 在连接断开时取消正在跑的搜索（TODOs 4.3 有实测）。

use crate::models::{ConnectionProfile, TlsMode};
use crate::services::pool_registry::PoolRegistry;
use reqwest::{Certificate, Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 与前端 `ELASTICSEARCH_SCHEME` 一致：连接串以它开头就归这里管
pub const ELASTICSEARCH_SCHEME: &str = "elasticsearch://";

/// 用户名或口令不对（401）
pub const ES_AUTH_FAILED: &str = "DATAOMNI_ES_AUTH_FAILED";
/// 在时限内没连上：地址不通、TLS 对不上、HTTP 连到了 HTTPS 端口。冒号后面是原因
pub const ES_UNREACHABLE: &str = "DATAOMNI_ES_UNREACHABLE";
/// 连上的不是 Elasticsearch（Kibana 的端口、别的 HTTP 服务）
pub const ES_NOT_ELASTICSEARCH: &str = "DATAOMNI_ES_NOT_ELASTICSEARCH";
/// 超过了查询时限
pub const ES_TIMEOUT: &str = "DATAOMNI_ES_TIMEOUT";
/// CA 证书文件读不了或不是证书。冒号后面带着路径
pub const ES_TLS_FILE_INVALID: &str = "DATAOMNI_ES_TLS_FILE_INVALID";
/// 响应体超过上限。冒号后面是上限的字节数
pub const ES_RESPONSE_TOO_LARGE: &str = "DATAOMNI_ES_RESPONSE_TOO_LARGE";
/// 方法不认识，或路径不是以一个 `/` 开头的本服务端路径。冒号后面是原文
pub const ES_REQUEST_INVALID: &str = "DATAOMNI_ES_REQUEST_INVALID";
/// 服务端的回答读不懂（对象树那种自己要解析的地方）。冒号后面是原因
pub const ES_SERVER_ERROR: &str = "DATAOMNI_ES_SERVER_ERROR";
/// 连接串对应的连接不在（断开之后还有请求过来）
pub const ES_NOT_CONNECTED: &str = "DATAOMNI_DB_SESSION_NOT_CONNECTED";

/// 连上的等待上限。和前端建立会话的 15 秒错开，让这里先报出原因
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 一次响应最多收这么多字节。`size: 10000` 加上大文档能到几百 MB，整份进 WebView 会把界面拖死；
/// 到了就报错，让人把 `size` 或 `_source` 收小，而不是给半份 JSON
pub const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

pub type EsRegistry = PoolRegistry<EsPool>;

#[derive(Clone)]
pub struct EsTarget {
  host: String,
  port: u16,
  username: String,
  password: String,
  tls: TlsMode,
  ca_certificate_path: Option<String>,
  /// 经 SSH 隧道时本地转发的端口
  tunnel_port: Option<u16>,
}

impl EsTarget {
  /// 隧道端口单独传，不像另外几家那样把主机换成 127.0.0.1：HTTPS 要按原来的主机名校验证书
  pub fn from_profile(profile: &ConnectionProfile, tunnel_port: Option<u16>) -> Self {
    Self {
      host: profile.host.trim().to_string(),
      port: profile.port,
      username: profile.username.clone(),
      password: profile.password.clone(),
      tls: profile.effective_tls_mode(),
      ca_certificate_path: profile.ca_certificate_path.clone().filter(|path| !path.is_empty()),
      tunnel_port,
    }
  }

  /// 请求发往的根地址。经隧道、主机是 IP 时只能写 127.0.0.1（`resolve` 只管域名），
  /// 这时证书按 127.0.0.1 校验，校验不过就是那句 TLS 错误
  fn base_url(&self) -> Result<Url, String> {
    let scheme = if self.tls == TlsMode::Disabled { "http" } else { "https" };
    let host = match (self.tunnel_port, self.host.parse::<IpAddr>()) {
      (Some(_), Ok(_)) => "127.0.0.1".to_string(),
      (_, Ok(IpAddr::V6(address))) => format!("[{address}]"),
      _ => self.host.clone(),
    };
    let port = match (self.tunnel_port, self.host.parse::<IpAddr>()) {
      (Some(local), Ok(_)) => local,
      _ => self.port,
    };
    Url::parse(&format!("{scheme}://{host}:{port}"))
      .map_err(|error| format!("{ES_UNREACHABLE}: {}: {error}", self.host))
  }

  fn client(&self) -> Result<Client, String> {
    // 不走系统代理：数据库连接是直连的，另外几家的驱动都不认代理；经隧道时连的是 127.0.0.1，
    // 被代理接走就连不到了
    let mut builder = Client::builder().no_proxy().connect_timeout(CONNECT_TIMEOUT);
    if let (Some(local), Err(_)) = (self.tunnel_port, self.host.parse::<IpAddr>()) {
      builder = builder.resolve(&self.host, SocketAddr::from(([127, 0, 0, 1], local)));
    }
    let certificates = match (&self.ca_certificate_path, self.tls) {
      (Some(path), TlsMode::VerifyCa | TlsMode::VerifyFull) => Some(read_certificates(path)?),
      _ => None,
    };
    // `Preferred` / `Required` 只加密不校验，与另外几家一致。`VerifyCa` 校验证书链、不管主机名——
    // rustls 只在「只信这份 CA」时才肯不管主机名；没给 CA 就按完整校验，往严里走
    builder = match (self.tls, certificates) {
      (TlsMode::Disabled, _) => builder,
      (TlsMode::Preferred | TlsMode::Required, _) => builder.tls_danger_accept_invalid_certs(true),
      (TlsMode::VerifyCa, Some(certificates)) => {
        builder.tls_certs_only(certificates).tls_danger_accept_invalid_hostnames(true)
      }
      (_, Some(certificates)) => builder.tls_certs_merge(certificates),
      (_, None) => builder,
    };
    builder.build().map_err(|error| format!("{ES_UNREACHABLE}: {}", error_chain(&error)))
  }
}

/// PEM 里的全部证书（CA 文件常常是一条链）
fn read_certificates(path: &str) -> Result<Vec<Certificate>, String> {
  let pem =
    std::fs::read(path).map_err(|error| format!("{ES_TLS_FILE_INVALID}: {path}: {error}"))?;
  let certificates = Certificate::from_pem_bundle(&pem)
    .map_err(|error| format!("{ES_TLS_FILE_INVALID}: {path}: {error}"))?;
  if certificates.is_empty() {
    return Err(format!("{ES_TLS_FILE_INVALID}: {path}"));
  }
  Ok(certificates)
}

/// 一个连接配置在后端的全部：reqwest 的客户端（它自己管着连接池）、根地址与凭据
pub struct EsPool {
  client: Client,
  base: Url,
  /// 用户名空着就是服务端关着认证
  credentials: Option<(String, String)>,
}

impl EsPool {
  fn request(&self, method: Method, url: Url) -> reqwest::RequestBuilder {
    let request = self.client.request(method, url);
    match &self.credentials {
      Some((username, password)) => request.basic_auth(username, Some(password)),
      None => request,
    }
  }

  /// 路径拼到根地址上，拼出来的必须还是这台服务端：`//别的主机/…` 在 URL 里是换主机，
  /// 而口令会跟着发过去
  fn url(&self, path_and_query: &str) -> Result<Url, String> {
    if !path_and_query.starts_with('/') || path_and_query.starts_with("//") {
      return Err(format!("{ES_REQUEST_INVALID}: {path_and_query}"));
    }
    let url =
      Url::parse(&format!("{}{}", self.base.as_str().trim_end_matches('/'), path_and_query))
        .map_err(|error| format!("{ES_REQUEST_INVALID}: {path_and_query}: {error}"))?;
    if url.host_str() != self.base.host_str()
      || url.port_or_known_default() != self.base.port_or_known_default()
    {
      return Err(format!("{ES_REQUEST_INVALID}: {path_and_query}"));
    }
    Ok(url)
  }

  /// 发一次请求，响应体读到上限为止
  async fn send(
    &self,
    method: Method,
    path_and_query: &str,
    body: Option<(String, &'static str)>,
    timeout: Duration,
  ) -> Result<(StatusCode, String), String> {
    let mut request = self.request(method, self.url(path_and_query)?).timeout(timeout);
    if let Some((body, content_type)) = body {
      request = request.header(reqwest::header::CONTENT_TYPE, content_type).body(body);
    }
    let mut response = request.send().await.map_err(|error| describe_error(&error, timeout))?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) =
      response.chunk().await.map_err(|error| describe_error(&error, timeout))?
    {
      if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
        return Err(format!("{ES_RESPONSE_TOO_LARGE}: {MAX_RESPONSE_BYTES}"));
      }
      bytes.extend_from_slice(&chunk);
    }
    Ok((status, String::from_utf8_lossy(&bytes).into_owned()))
  }
}

/// 连上并 `GET /`：口令错在这一步报出来。只有索引读权限的用户在这里拿到 403（要 `monitor`）——
/// 认证已经过了，照样算连上
pub async fn connect(target: EsTarget) -> Result<EsPool, String> {
  let pool = EsPool {
    client: target.client()?,
    base: target.base_url()?,
    credentials: (!target.username.is_empty())
      .then(|| (target.username.clone(), target.password.clone())),
  };
  let (status, body) = pool
    .send(Method::GET, "/", None, CONNECT_TIMEOUT)
    .await
    .map_err(|error| error.replacen(ES_TIMEOUT, ES_UNREACHABLE, 1))?;
  match status {
    StatusCode::UNAUTHORIZED => Err(format!("{ES_AUTH_FAILED}: {}", error_reason(&body))),
    StatusCode::FORBIDDEN => Ok(pool),
    status if status.is_success() && is_elasticsearch_root(&body) => Ok(pool),
    status => Err(format!("{ES_NOT_ELASTICSEARCH}: HTTP {}", status.as_u16())),
  }
}

/// `GET /` 的回答里有 `version.number`，Kibana 或别的 HTTP 服务没有
fn is_elasticsearch_root(body: &str) -> bool {
  serde_json::from_str::<serde_json::Value>(body)
    .ok()
    .and_then(|root| root.pointer("/version/number").and_then(|number| number.as_str()).map(|_| ()))
    .is_some()
}

/// 错误回答里给人看的那一句：`error.reason`，没有就是原文
fn error_reason(body: &str) -> String {
  serde_json::from_str::<serde_json::Value>(body)
    .ok()
    .and_then(|root| {
      root.pointer("/error/reason").and_then(|reason| reason.as_str()).map(str::to_string)
    })
    .unwrap_or_else(|| body.chars().take(300).collect())
}

fn describe_error(error: &reqwest::Error, timeout: Duration) -> String {
  if error.is_timeout() {
    return format!("{ES_TIMEOUT}: {}ms", timeout.as_millis());
  }
  format!("{ES_UNREACHABLE}: {}", error_chain(error))
}

/// reqwest 的 Display 只说「error sending request」「builder error」，原因在 source 链上
fn error_chain(error: &reqwest::Error) -> String {
  let mut message = error.to_string();
  let mut source = std::error::Error::source(error);
  while let Some(cause) = source {
    message = format!("{message}: {cause}");
    source = cause.source();
  }
  message
}

/// 对象树的一行，形状与关系库的对象目录一致。没有库这一层，`object_schema` 空着
#[derive(Debug, Serialize, PartialEq)]
pub struct EsObject {
  pub object_schema: String,
  pub object_name: String,
  pub object_kind: &'static str,
  pub object_id: String,
}

#[derive(Deserialize)]
struct Resolved {
  #[serde(default)]
  indices: Vec<Named>,
  #[serde(default)]
  aliases: Vec<Named>,
  #[serde(default)]
  data_streams: Vec<Named>,
}

#[derive(Deserialize)]
struct Named {
  name: String,
}

/// 索引、别名、数据流。`_resolve/index` 只要索引的读权限（`_cat/indices` 要 `monitor`），
/// 默认不含隐藏的——数据流的后备索引 `.ds-…` 与系统索引都是隐藏的
pub async fn list_objects(pool: Arc<EsPool>, timeout: Duration) -> Result<Vec<EsObject>, String> {
  let (status, body) = pool.send(Method::GET, "/_resolve/index/*", None, timeout).await?;
  if !status.is_success() {
    return Err(format!("{ES_SERVER_ERROR}: HTTP {}: {}", status.as_u16(), error_reason(&body)));
  }
  let resolved: Resolved =
    serde_json::from_str(&body).map_err(|error| format!("{ES_SERVER_ERROR}: {error}"))?;
  Ok(objects_of(resolved))
}

fn objects_of(resolved: Resolved) -> Vec<EsObject> {
  [("index", resolved.indices), ("alias", resolved.aliases), ("data-stream", resolved.data_streams)]
    .into_iter()
    .flat_map(|(kind, named)| {
      named.into_iter().map(move |Named { name }| EsObject {
        object_id: format!("{kind}:{name}"),
        object_schema: String::new(),
        object_name: name,
        object_kind: kind,
      })
    })
    .collect()
}

/// 控制台里的一条请求。请求体已经在前端拆好：一份 JSON，或 `_bulk` 那种每行一份的 NDJSON
pub struct EsRequest {
  pub method: String,
  pub path: String,
  pub body: Option<String>,
  pub ndjson: bool,
  pub timeout: Duration,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EsResponse {
  pub status: u16,
  /// 原样的响应体（HEAD 是空的）
  pub body: String,
  pub elapsed_ms: u64,
}

pub async fn run(pool: Arc<EsPool>, request: EsRequest) -> Result<EsResponse, String> {
  let method = parse_method(&request.method)?;
  let content_type = if request.ndjson { "application/x-ndjson" } else { "application/json" };
  let started = Instant::now();
  let (status, body) = pool
    .send(method, &request.path, request.body.map(|body| (body, content_type)), request.timeout)
    .await?;
  Ok(EsResponse {
    status: status.as_u16(),
    body,
    elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
  })
}

/// ES 的 REST 只用这五个；别的（`TRACE`、打错的）在发出去之前拦下
fn parse_method(method: &str) -> Result<Method, String> {
  match method.to_ascii_uppercase().as_str() {
    "GET" => Ok(Method::GET),
    "POST" => Ok(Method::POST),
    "PUT" => Ok(Method::PUT),
    "DELETE" => Ok(Method::DELETE),
    "HEAD" => Ok(Method::HEAD),
    _ => Err(format!("{ES_REQUEST_INVALID}: {method}")),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn pool(base: &str) -> EsPool {
    EsPool { client: Client::new(), base: Url::parse(base).unwrap(), credentials: None }
  }

  /// 本机起一个 HTTP 服务，回答比上限多一截：读到上限就停、报错，不是整份读完再说
  #[tokio::test]
  async fn a_huge_response_is_refused_instead_of_half_read() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let total = MAX_RESPONSE_BYTES + 1024 * 1024;
    tokio::spawn(async move {
      let (mut socket, _) = listener.accept().await.unwrap();
      let mut request = [0u8; 4096];
      let _ = socket.read(&mut request).await;
      let head = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {total}\r\n\r\n"
      );
      let _ = socket.write_all(head.as_bytes()).await;
      let chunk = vec![b' '; 64 * 1024];
      let mut sent = 0;
      while sent < total {
        // 客户端到了上限就断开，这边写失败是预期的
        if socket.write_all(&chunk[..chunk.len().min(total - sent)]).await.is_err() {
          break;
        }
        sent += chunk.len();
      }
    });
    let pool = EsPool {
      client: Client::builder().no_proxy().build().unwrap(),
      base: Url::parse(&format!("http://{address}")).unwrap(),
      credentials: None,
    };
    let error = pool.send(Method::GET, "/big", None, Duration::from_secs(20)).await.unwrap_err();
    assert_eq!(error, format!("{ES_RESPONSE_TOO_LARGE}: {MAX_RESPONSE_BYTES}"));
  }

  #[test]
  fn paths_cannot_leave_the_server() {
    let pool = pool("https://es.internal:9200");
    assert_eq!(
      pool.url("/books/_search?size=1").unwrap().as_str(),
      "https://es.internal:9200/books/_search?size=1"
    );
    for escape in
      ["//evil.example/x", "@evil.example/x", "books/_search", "", "http://evil.example/"]
    {
      let error = pool.url(escape).unwrap_err();
      assert!(error.starts_with(ES_REQUEST_INVALID), "{escape}: {error}");
    }
  }

  #[test]
  fn tunnels_keep_the_host_name_for_certificates() {
    let mut target = EsTarget {
      host: "es.internal".to_string(),
      port: 9200,
      username: String::new(),
      password: String::new(),
      tls: TlsMode::VerifyFull,
      ca_certificate_path: None,
      tunnel_port: Some(40001),
    };
    // 域名：地址不变，连接经 `resolve` 落到本地端口
    assert_eq!(target.base_url().unwrap().as_str(), "https://es.internal:9200/");
    // IP：`resolve` 管不到，只能直接写本地端口
    target.host = "10.0.0.5".to_string();
    assert_eq!(target.base_url().unwrap().as_str(), "https://127.0.0.1:40001/");
    target.tunnel_port = None;
    target.tls = TlsMode::Disabled;
    assert_eq!(target.base_url().unwrap().as_str(), "http://10.0.0.5:9200/");
    target.host = "::1".to_string();
    assert_eq!(target.base_url().unwrap().as_str(), "http://[::1]:9200/");
  }

  #[test]
  fn only_rest_methods_are_sent() {
    assert_eq!(parse_method("get").unwrap(), Method::GET);
    assert_eq!(parse_method("HEAD").unwrap(), Method::HEAD);
    assert!(parse_method("TRACE").unwrap_err().starts_with(ES_REQUEST_INVALID));
    assert!(parse_method("PATCH").unwrap_err().starts_with(ES_REQUEST_INVALID));
  }

  #[test]
  fn resolved_names_become_tree_objects() {
    let resolved: Resolved = serde_json::from_str(
      r#"{"indices":[{"name":"books","aliases":["library"],"attributes":["open"]}],
          "aliases":[{"name":"library","indices":["books"]}],
          "data_streams":[{"name":"logs-app-web","backing_indices":[".ds-x"],"timestamp_field":"@timestamp"}]}"#,
    )
    .unwrap();
    let objects = objects_of(resolved);
    let kinds: Vec<_> =
      objects.iter().map(|object| (object.object_kind, object.object_name.as_str())).collect();
    assert_eq!(kinds, [("index", "books"), ("alias", "library"), ("data-stream", "logs-app-web")]);
    assert_eq!(objects[2].object_id, "data-stream:logs-app-web");
  }

  #[test]
  fn root_answers_tell_elasticsearch_apart() {
    assert!(is_elasticsearch_root(
      r#"{"name":"n","version":{"number":"9.5.3"},"tagline":"You Know, for Search"}"#
    ));
    assert!(!is_elasticsearch_root(r#"{"statusCode":404,"error":"Not Found"}"#));
    assert!(!is_elasticsearch_root("<html>Kibana</html>"));
    assert_eq!(
      error_reason(
        r#"{"error":{"root_cause":[],"type":"security_exception","reason":"unable to authenticate"},"status":401}"#
      ),
      "unable to authenticate"
    );
  }
}
