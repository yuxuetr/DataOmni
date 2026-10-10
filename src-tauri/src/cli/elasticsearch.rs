//! `es`：Elasticsearch / OpenSearch 的只读命令（`rfcs/agent-cli.md` §5.2、§6 第二批）。
//!
//! 没有只读会话，门是「方法加路径」的白名单（[`check`]）：`GET` / `HEAD` 放行（刷新、落盘这类
//! 运维端点除外），`POST` 只放行查询类的端点，`PUT` / `DELETE` 一律拒。路径按段比对，
//! 不按子串：`/idx/_doc/_search` 是往 `idx` 里写一个 id 叫 `_search` 的文档，不是查询

use super::{session, CliError, Exit, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS};
use crate::models::ConnectionProfile;
use crate::services::elasticsearch::{self, EsRequest, EsTarget, ES_TIMEOUT};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub(super) const USAGE: &str = "usage: dataomni cli es <connection> <operation> ...
  indices
  request <METHOD> <path> [<body>]   (<body> may be - to read it from stdin)
both take [--timeout SECONDS]";

/// `POST` 放行的端点：路径里从第一个 `_` 开头的段起，整段等于其中一个。
/// `*` 是任意一段（文档 id）
const READ_POSTS: &[&[&str]] = &[
  &["_search"],
  &["_count"],
  &["_msearch"],
  &["_mget"],
  &["_field_caps"],
  &["_terms_enum"],
  &["_knn_search"],
  &["_mtermvectors"],
  &["_termvectors"],
  &["_termvectors", "*"],
  &["_explain", "*"],
  &["_validate", "query"],
  &["_search", "template"],
  &["_msearch", "template"],
  &["_render", "template"],
  &["_eql", "search"],
  &["_sql"],
  &["_sql", "translate"],
];

/// `GET` 也能触发的运维端点：不改文档，但会让集群干活（刷新、落盘、清缓存）
const GET_OPERATIONS: &[&str] =
  &["_refresh", "_flush", "_forcemerge", "_cache", "_reload_search_analyzers"];

/// 这条请求能不能在命令行里发。拒绝的理由是给 Agent 看的
fn check(method: &str, path: &str) -> Result<(), String> {
  let path = path.split(['?', '#']).next().unwrap_or("");
  let segments: Vec<&str> = path.split('/').filter(|segment| !segment.is_empty()).collect();
  let endpoint: Vec<&str> =
    segments.iter().skip_while(|segment| !segment.starts_with('_')).copied().collect();
  match method.to_ascii_uppercase().as_str() {
    "GET" | "HEAD" => match endpoint.iter().find(|segment| GET_OPERATIONS.contains(segment)) {
      Some(operation) => Err(format!("{operation} is an operation, not a read")),
      None => Ok(()),
    },
    "POST" => {
      let matches = |shape: &&[&str]| {
        shape.len() == endpoint.len()
          && shape.iter().zip(&endpoint).all(|(want, got)| *want == "*" || want == got)
      };
      if READ_POSTS.iter().any(matches) {
        Ok(())
      } else {
        Err(format!("POST {path} is not one of the search endpoints"))
      }
    }
    other => Err(format!("{other} changes data")),
  }
}

pub(super) struct Arguments {
  pub(super) connection: String,
  pub(super) timeout: Duration,
  request: Request,
  /// 留痕里记摘要的那段文字
  pub(super) subject: String,
}

enum Request {
  Indices,
  Send { method: String, path: String, body: Option<String> },
}

impl Arguments {
  pub(super) fn command(&self) -> &'static str {
    match self.request {
      Request::Indices => "es indices",
      Request::Send { .. } => "es request",
    }
  }
}

/// 白名单在这里就查：被拒的请求不换来一次钥匙串读取
pub(super) fn parse(rest: &[String]) -> Result<Arguments, CliError> {
  let mut positional: Vec<&str> = Vec::new();
  let mut timeout = DEFAULT_TIMEOUT_SECONDS;
  let mut iter = rest.iter();
  while let Some(argument) = iter.next() {
    match argument.as_str() {
      "--timeout" => {
        timeout = super::number_after("--timeout", iter.next(), 1, MAX_TIMEOUT_SECONDS)?
      }
      _ => positional.push(argument.as_str()),
    }
  }
  let (connection, request, subject) = match positional.as_slice() {
    [connection, "indices"] => (*connection, Request::Indices, String::new()),
    [connection, "request", method, path, body @ ..] if body.len() <= 1 => {
      if !path.starts_with('/') {
        return Err(CliError::usage(format!("the path starts with /, got {path}")));
      }
      check(method, path)
        .map_err(|reason| CliError::refused(format!("{reason}; the command line only reads")))?;
      let body = body.first().map(|body| super::read_argument(body)).transpose()?;
      let subject = format!("{} {path}", method.to_ascii_uppercase());
      let request =
        Request::Send { method: method.to_ascii_uppercase(), path: path.to_string(), body };
      (*connection, request, subject)
    }
    _ => return Err(CliError::usage(USAGE)),
  };
  Ok(Arguments {
    connection: connection.to_string(),
    timeout: Duration::from_secs(timeout),
    request,
    subject,
  })
}

pub(super) async fn run(
  profile: &ConnectionProfile,
  arguments: &Arguments,
) -> Result<Value, CliError> {
  let connect = async {
    let (tunnels, port) = session::tunnel(profile).await?;
    // 不换主机：经隧道的 HTTPS 仍按原来的主机名校验证书（同界面）
    let pool = elasticsearch::connect(EsTarget::from_profile(profile, port)).await?;
    Ok::<_, String>((tunnels, Arc::new(pool)))
  };
  let deadline = session::CONNECT_DEADLINE;
  let (_tunnels, pool) = tokio::time::timeout(deadline, connect)
    .await
    .map_err(|_| {
      CliError::unavailable("connect", format!("could not connect within {} s", deadline.as_secs()))
    })?
    .map_err(|error| CliError::unavailable("connect", error))?;
  let timeout = arguments.timeout;
  match &arguments.request {
    Request::Indices => {
      let objects = elasticsearch::list_objects(pool, timeout).await.map_err(database_error)?;
      let indices: Vec<Value> = objects
        .into_iter()
        .map(|object| json!({ "name": object.object_name, "kind": object.object_kind }))
        .collect();
      Ok(json!({ "indices": indices }))
    }
    Request::Send { method, path, body } => {
      // `_msearch` 的请求体是每行一份的 NDJSON，其余是一份 JSON
      let ndjson =
        path.split('?').next().unwrap_or("").split('/').any(|segment| segment == "_msearch");
      let request = EsRequest {
        method: method.clone(),
        path: path.clone(),
        body: body.clone(),
        ndjson,
        timeout,
      };
      let response = elasticsearch::run(pool, request).await.map_err(database_error)?;
      let body =
        serde_json::from_str::<Value>(&response.body).unwrap_or(Value::String(response.body));
      if response.status >= 400 {
        return Err(CliError {
          exit: Exit::Database,
          kind: "database",
          message: format!("HTTP {}: {}", response.status, body),
          diagnosis: None,
        });
      }
      Ok(json!({ "status": response.status, "body": body }))
    }
  }
}

fn database_error(message: String) -> CliError {
  let kind = if message.starts_with(ES_TIMEOUT) { "timeout" } else { "database" };
  CliError { exit: Exit::Database, kind, message, diagnosis: None }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::models::ConnectionProfile;

  #[test]
  fn reads_pass_and_everything_else_is_refused() {
    for (method, path) in [
      ("GET", "/"),
      ("GET", "/books/_search?q=title:rust"),
      ("get", "/books/_mapping"),
      ("HEAD", "/books"),
      ("GET", "/books/_doc/1"),
      ("POST", "/books/_search"),
      ("POST", "/books,films/_count"),
      ("POST", "/_msearch"),
      ("POST", "/books/_explain/1"),
      ("POST", "/books/_validate/query?explain"),
      ("POST", "/_search/template"),
      ("POST", "/_sql?format=json"),
    ] {
      assert_eq!(check(method, path), Ok(()), "{method} {path}");
    }
    for (method, path) in [
      ("PUT", "/books/_doc/1"),
      ("DELETE", "/books"),
      ("PATCH", "/books"),
      ("POST", "/books/_doc"),
      ("POST", "/books/_doc/_search"),
      ("POST", "/books/_update/1"),
      ("POST", "/books/_delete_by_query"),
      ("POST", "/books/_update_by_query"),
      ("POST", "/_bulk"),
      ("POST", "/books/_mapping"),
      ("POST", "/books/_close"),
      ("POST", "/_reindex"),
      ("POST", "/books/_search/extra"),
      ("POST", "/books"),
      ("GET", "/books/_refresh"),
      ("GET", "/_flush"),
      ("GET", "/books/_cache/clear"),
    ] {
      assert!(check(method, path).is_err(), "{method} {path}");
    }
  }

  /// 真库：`DATAOMNI_ELASTICSEARCH_TEST_URL`（`http(s)://user:password@host:port`），只在 shell 里传。
  /// HTTPS 时另给 `DATAOMNI_ELASTICSEARCH_TEST_CA`。只碰 `om_cli_probe` 索引，用完删掉
  #[tokio::test]
  async fn es_reads_and_writes_are_refused() {
    let Ok(raw) = std::env::var("DATAOMNI_ELASTICSEARCH_TEST_URL") else {
      eprintln!("skipping: DATAOMNI_ELASTICSEARCH_TEST_URL is not set");
      return;
    };
    let url = url::Url::parse(&raw).expect("a valid test URL");
    let https = url.scheme() == "https";
    let ca = std::env::var("DATAOMNI_ELASTICSEARCH_TEST_CA").ok();
    let profile: ConnectionProfile = serde_json::from_value(json!({
      "id": "cli-es", "name": "cli-es", "db_type": "elasticsearch",
      "host": url.host_str().unwrap_or_default(), "port": url.port().unwrap_or(9200),
      "username": url.username(), "password": url.password().unwrap_or_default(),
      "ssl": https, "tls_mode": if https { "verify-ca" } else { "disabled" },
      "ca_certificate_path": ca, "options": {}, "tags": [],
    }))
    .expect("a profile");
    let admin = Arc::new(
      elasticsearch::connect(EsTarget::from_profile(&profile, None)).await.expect("admin"),
    );
    let send = |method: &str, path: &str, body: Option<&str>| {
      let request = EsRequest {
        method: method.to_string(),
        path: path.to_string(),
        body: body.map(str::to_string),
        ndjson: false,
        timeout: Duration::from_secs(20),
      };
      elasticsearch::run(Arc::clone(&admin), request)
    };
    send("DELETE", "/om_cli_probe", None).await.expect("clean");
    for n in 1..=3 {
      let body = format!("{{\"n\": {n}}}");
      send("PUT", &format!("/om_cli_probe/_doc/{n}?refresh=true"), Some(&body))
        .await
        .expect("seed");
    }

    let args = |list: &[&str]| list.iter().map(|item| item.to_string()).collect::<Vec<_>>();
    let call = |list: &[&str]| {
      let parsed = parse(&args(list));
      let profile = profile.clone();
      async move {
        let arguments = parsed.unwrap_or_else(|error| panic!("{}", error.message));
        run(&profile, &arguments).await.unwrap_or_else(|error| panic!("{}", error.message))
      }
    };
    let indices = call(&["e", "indices"]).await;
    assert!(indices.to_string().contains("om_cli_probe"), "{indices}");
    let searched = call(&[
      "e",
      "request",
      "POST",
      "/om_cli_probe/_search",
      "{\"query\": {\"range\": {\"n\": {\"gte\": 2}}}}",
    ])
    .await;
    assert_eq!(searched["body"]["hits"]["total"]["value"], json!(2), "{searched}");
    let counted = call(&["e", "request", "GET", "/om_cli_probe/_count"]).await;
    assert_eq!(counted["body"]["count"], json!(3), "{counted}");
    let multi = call(&[
      "e",
      "request",
      "POST",
      "/_msearch",
      "{\"index\": \"om_cli_probe\"}\n{\"query\": {\"match_all\": {}}}\n",
    ])
    .await;
    assert_eq!(multi["body"]["responses"][0]["hits"]["total"]["value"], json!(3), "{multi}");

    for (method, path) in [
      ("PUT", "/om_cli_probe/_doc/9"),
      ("POST", "/om_cli_probe/_doc"),
      ("POST", "/om_cli_probe/_doc/_search"),
      ("POST", "/om_cli_probe/_delete_by_query"),
      ("POST", "/om_cli_probe/_mapping"),
      ("DELETE", "/om_cli_probe"),
    ] {
      let refused = matches!(
        parse(&args(&["e", "request", method, path, "{\"n\": 9}"])),
        Err(CliError { exit: Exit::Refused, .. })
      );
      assert!(refused, "{method} {path}");
    }
    let after = send("GET", "/om_cli_probe/_count", None).await.expect("count");
    assert!(after.body.contains("\"count\":3"), "{}", after.body);
    send("DELETE", "/om_cli_probe", None).await.expect("clean up");
  }

  #[test]
  fn arguments_are_checked() {
    let args = |list: &[&str]| list.iter().map(|item| item.to_string()).collect::<Vec<_>>();
    assert!(parse(&args(&["e", "indices"])).is_ok());
    assert!(parse(&args(&["e", "request", "POST", "/b/_search", "{}"])).is_ok());
    assert!(matches!(
      parse(&args(&["e", "request", "DELETE", "/b"])),
      Err(CliError { exit: Exit::Refused, .. })
    ));
    for bad in [
      &["e"][..],
      &["e", "indices", "x"],
      &["e", "request", "GET"],
      &["e", "request", "GET", "b/_search"],
      &["e", "request", "POST", "/b/_search", "{}", "{}"],
    ] {
      assert!(matches!(parse(&args(bad)), Err(CliError { exit: Exit::Usage, .. })), "{bad:?}");
    }
  }
}
