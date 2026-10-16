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

use crate::models::ConnectionProfile;
use crate::services::http_endpoint::{error_chain, EndpointError, HttpEndpoint};
use crate::services::pool_registry::PoolRegistry;
use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 与前端 `ELASTICSEARCH_SCHEME` 一致：连接串以它开头就归这里管
pub const ELASTICSEARCH_SCHEME: &str = "elasticsearch://";

/// 用户名或口令不对（401）
pub const ES_AUTH_FAILED: &str = "DATAOMNI_ES_AUTH_FAILED";
/// API Key 不对、过期了或已作废（同样是 401，但要让人去看的是 key 而不是口令）
pub const ES_API_KEY_REJECTED: &str = "DATAOMNI_ES_API_KEY_REJECTED";
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
/// 这个账号没有列索引的权限（`_resolve/index` 回 403）。ES 的 `read` 就够，OpenSearch 的 `read`
/// 不含 `indices:admin/resolve/index`。冒号后面是服务端那句原话
pub const ES_NO_PERMISSION: &str = "DATAOMNI_ES_NO_PERMISSION";
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

/// 每个请求带什么凭据
#[derive(Clone, Debug, PartialEq)]
enum EsAuth {
  /// 用户名空着：服务端关着认证
  Anonymous,
  Basic {
    username: String,
    password: String,
  },
  /// `Authorization: ApiKey` 后面那一段，已经是 base64
  ApiKey(String),
}

#[derive(Clone)]
pub struct EsTarget {
  endpoint: HttpEndpoint,
  auth: EsAuth,
}

impl EsTarget {
  /// 隧道端口单独传：HTTPS 要按原来的主机名校验证书（见 `HttpEndpoint::from_profile`）
  pub fn from_profile(profile: &ConnectionProfile, tunnel_port: Option<u16>) -> Self {
    let auth = if profile.es_api_key() {
      EsAuth::ApiKey(api_key_credential(&profile.password))
    } else if profile.username.is_empty() {
      EsAuth::Anonymous
    } else {
      EsAuth::Basic { username: profile.username.clone(), password: profile.password.clone() }
    };
    Self { endpoint: HttpEndpoint::from_profile(profile, tunnel_port), auth }
  }
}

/// 建 key 时 ES 回的是 `id`、`api_key` 与 `encoded`（前两者 `id:api_key` 的 base64），Kibana 只给
/// `encoded`。两种都收：带冒号的就是没编码的那种，替人编上
fn api_key_credential(key: &str) -> String {
  use base64::Engine;
  let key = key.trim();
  if key.contains(':') {
    base64::engine::general_purpose::STANDARD.encode(key)
  } else {
    key.to_string()
  }
}

/// 连接串（池子的键）里代替用户名的那一段：key 的 SHA-256 取前 8 字节。key 本身是服务端
/// 生成的随机串，这几个字节反推不出它
pub fn api_key_fingerprint(key: &str) -> String {
  use sha2::{Digest, Sha256};
  let digest = Sha256::digest(api_key_credential(key).as_bytes());
  let hex: String = digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect();
  format!("api-key-{hex}")
}

fn endpoint_error(error: EndpointError) -> String {
  match error {
    EndpointError::Unreachable(reason) => format!("{ES_UNREACHABLE}: {reason}"),
    EndpointError::CertificateFile(reason) => format!("{ES_TLS_FILE_INVALID}: {reason}"),
  }
}

/// 一个连接配置在后端的全部：reqwest 的客户端（它自己管着连接池）、根地址与凭据
pub struct EsPool {
  client: Client,
  base: Url,
  auth: EsAuth,
}

impl EsPool {
  fn request(&self, method: Method, url: Url) -> reqwest::RequestBuilder {
    let request = self.client.request(method, url);
    match &self.auth {
      EsAuth::Anonymous => request,
      EsAuth::Basic { username, password } => request.basic_auth(username, Some(password)),
      EsAuth::ApiKey(key) => {
        request.header(reqwest::header::AUTHORIZATION, format!("ApiKey {key}"))
      }
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
    client: target.endpoint.client(CONNECT_TIMEOUT, None).map_err(endpoint_error)?,
    base: target.endpoint.base_url().map_err(endpoint_error)?,
    auth: target.auth.clone(),
  };
  let (status, body) = pool
    .send(Method::GET, "/", None, CONNECT_TIMEOUT)
    .await
    .map_err(|error| error.replacen(ES_TIMEOUT, ES_UNREACHABLE, 1))?;
  match status {
    StatusCode::UNAUTHORIZED => {
      let code =
        if matches!(pool.auth, EsAuth::ApiKey(_)) { ES_API_KEY_REJECTED } else { ES_AUTH_FAILED };
      Err(format!("{code}: {}", error_reason(&body)))
    }
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
  if status == StatusCode::FORBIDDEN {
    return Err(format!("{ES_NO_PERMISSION}: {}", error_reason(&body)));
  }
  if !status.is_success() {
    return Err(format!("{ES_SERVER_ERROR}: HTTP {}: {}", status.as_u16(), error_reason(&body)));
  }
  let resolved: Resolved =
    serde_json::from_str(&body).map_err(|error| format!("{ES_SERVER_ERROR}: {error}"))?;
  Ok(objects_of(resolved))
}

/// 点号开头的不进树：ES 把它们标成隐藏、本来就不在回答里；OpenSearch 的系统索引
/// （`.opendistro_security`、`.plugins-ml-config`）没有这个标，会混在用户的索引里。
/// ES 8 起用户也建不出不隐藏的点号索引，所以这一条在 ES 上不丢东西
fn objects_of(resolved: Resolved) -> Vec<EsObject> {
  [("index", resolved.indices), ("alias", resolved.aliases), ("data-stream", resolved.data_streams)]
    .into_iter()
    .flat_map(|(kind, named)| {
      named.into_iter().filter(|Named { name }| !name.starts_with('.')).map(
        move |Named { name }| EsObject {
          object_id: format!("{kind}:{name}"),
          object_schema: String::new(),
          object_name: name,
          object_kind: kind,
        },
      )
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
    EsPool { client: Client::new(), base: Url::parse(base).unwrap(), auth: EsAuth::Anonymous }
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
      auth: EsAuth::Anonymous,
    };
    let error = pool.send(Method::GET, "/big", None, Duration::from_secs(20)).await.unwrap_err();
    assert_eq!(error, format!("{ES_RESPONSE_TOO_LARGE}: {MAX_RESPONSE_BYTES}"));
  }

  fn profile(username: &str, password: &str, api_key: bool) -> ConnectionProfile {
    let options = if api_key {
      serde_json::json!({ crate::models::ES_AUTH_OPTION: crate::models::ES_API_KEY })
    } else {
      serde_json::json!({})
    };
    serde_json::from_value(serde_json::json!({
      "name": "es", "db_type": "elasticsearch", "host": "127.0.0.1", "port": 9200,
      "username": username, "password": password, "ssl": false,
      "options": options, "tags": []
    }))
    .unwrap()
  }

  #[test]
  fn an_api_key_profile_sends_the_key_and_not_the_username() {
    let encoded = "VnVhQ2ZHY0JDZGJrUW0tZTVhT3g6dWkybHAyYXhUTm1zeWFrdzl0dk5udw==";
    assert_eq!(
      EsTarget::from_profile(&profile("elastic", encoded, true), None).auth,
      EsAuth::ApiKey(encoded.to_string())
    );
    // 没编码的 `id:api_key` 替人编上；两头的空白是粘贴带进来的
    assert_eq!(
      EsTarget::from_profile(
        &profile("", " VuaCfGcBCdbkQm-e5aOx:ui2lp2axTNmsyakw9tvNnw\n", true),
        None
      )
      .auth,
      EsAuth::ApiKey(encoded.to_string())
    );
    assert_eq!(
      EsTarget::from_profile(&profile("elastic", "secret", false), None).auth,
      EsAuth::Basic { username: "elastic".to_string(), password: "secret".to_string() }
    );
    assert_eq!(EsTarget::from_profile(&profile("", "", false), None).auth, EsAuth::Anonymous);
  }

  #[test]
  fn two_api_keys_on_one_server_get_two_pools_without_the_key_in_the_name() {
    let first = profile("", "a2V5LW9uZTpzZWNyZXQ=", true);
    let second = profile("", "a2V5LXR3bzpzZWNyZXQ=", true);
    let first_key = first.db_type.to_connection_string(&first);
    let second_key = second.db_type.to_connection_string(&second);
    assert_ne!(first_key, second_key);
    // 两种写法是同一把 key，就是同一个池子
    let raw = profile("", "key-one:secret", true);
    assert_eq!(raw.db_type.to_connection_string(&raw), first_key);
    assert!(first_key.starts_with("elasticsearch://api-key-"), "{first_key}");
    assert!(!first_key.contains("a2V5") && !first_key.contains("secret"), "{first_key}");
    let basic = profile("elastic", "a2V5LW9uZTpzZWNyZXQ=", false);
    assert_eq!(
      basic.db_type.to_connection_string(&basic),
      "elasticsearch://elastic@127.0.0.1:9200"
    );
  }

  /// 本机起一个只回 401 的服务：看请求头里带的是什么，以及报的是 key 不对而不是口令不对
  #[tokio::test]
  async fn a_rejected_api_key_is_named_as_such() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
      let (mut socket, _) = listener.accept().await.unwrap();
      let mut request = vec![0u8; 4096];
      let read = socket.read(&mut request).await.unwrap();
      let body = r#"{"error":{"reason":"unable to authenticate with provided credentials"}}"#;
      let response = format!(
        "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
      );
      socket.write_all(response.as_bytes()).await.unwrap();
      String::from_utf8_lossy(&request[..read]).to_ascii_lowercase()
    });
    let mut api_key = profile("elastic", "key-one:secret", true);
    api_key.port = port;
    let error = connect(EsTarget::from_profile(&api_key, None)).await.err().unwrap_or_default();
    assert_eq!(
      error,
      format!("{ES_API_KEY_REJECTED}: unable to authenticate with provided credentials")
    );
    let request = server.await.unwrap();
    assert!(request.contains("authorization: apikey a2v5lw9uztpzzwnyzxq="), "{request}");
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

    // OpenSearch 的系统索引不带 hidden 标，按名字挡掉
    let opensearch: Resolved = serde_json::from_str(
      r#"{"indices":[{"name":".opendistro_security","attributes":["open"]},{"name":"books","attributes":["open"]}]}"#,
    )
    .unwrap();
    let names: Vec<_> =
      objects_of(opensearch).into_iter().map(|object| object.object_name).collect();
    assert_eq!(names, ["books"]);
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
