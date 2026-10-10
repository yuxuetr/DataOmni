//! `neo4j`：Neo4j 的只读命令（`rfcs/agent-cli.md` §5.2、§6 第二批）。
//!
//! 两层：先 `EXPLAIN` 问服务端这条是什么类型（不执行），只放行 `r`；再在**读模式**的事务里跑，
//! 服务端拒绝其中的写。`CALL` 一个会写的过程、字符串里写着 `DELETE` 却只是读，都由服务端判，
//! 不按关键字猜（同界面确认框用的 `query_type`）

use super::{session, CliError, Exit, DEFAULT_ROW_LIMIT, DEFAULT_TIMEOUT_SECONDS};
use super::{MAX_ROW_LIMIT, MAX_TIMEOUT_SECONDS};
use crate::models::ConnectionProfile;
use crate::services::neo4j::{self, CypherRequest, Neo4jTarget, NEO4J_TIMEOUT};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub(super) const USAGE: &str = "usage: dataomni cli neo4j <connection> <operation> ...
  labels
  run <cypher> [--limit N]       (<cypher> may be - to read it from stdin)
both take [--db DATABASE] [--timeout SECONDS]";

pub(super) struct Arguments {
  pub(super) connection: String,
  pub(super) timeout: Duration,
  database: Option<String>,
  request: Request,
  /// 留痕里记摘要的那段文字
  pub(super) subject: String,
}

enum Request {
  Labels,
  Run { query: String, limit: usize },
}

impl Arguments {
  pub(super) fn command(&self) -> &'static str {
    match self.request {
      Request::Labels => "neo4j labels",
      Request::Run { .. } => "neo4j run",
    }
  }
}

pub(super) fn parse(rest: &[String]) -> Result<Arguments, CliError> {
  let mut positional: Vec<&str> = Vec::new();
  let mut database = None;
  let mut limit = None;
  let mut timeout = DEFAULT_TIMEOUT_SECONDS;
  let mut iter = rest.iter();
  while let Some(argument) = iter.next() {
    match argument.as_str() {
      "--db" => {
        let value = iter.next().ok_or_else(|| CliError::usage("--db takes a database name"))?;
        database = Some(value.clone());
      }
      "--limit" => {
        limit = Some(super::number_after("--limit", iter.next(), 1, MAX_ROW_LIMIT as u64)? as usize)
      }
      "--timeout" => {
        timeout = super::number_after("--timeout", iter.next(), 1, MAX_TIMEOUT_SECONDS)?
      }
      _ => positional.push(argument.as_str()),
    }
  }
  let (connection, request, subject) = match positional.as_slice() {
    [connection, "labels"] if limit.is_none() => (*connection, Request::Labels, String::new()),
    [connection, "run", query] => {
      let query = super::read_argument(query)?;
      let request =
        Request::Run { query: query.clone(), limit: limit.unwrap_or(DEFAULT_ROW_LIMIT) };
      (*connection, request, query)
    }
    _ => return Err(CliError::usage(USAGE)),
  };
  Ok(Arguments {
    connection: connection.to_string(),
    timeout: Duration::from_secs(timeout),
    database,
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
    let reachable = match port {
      Some(port) => profile.redirected_to("127.0.0.1", port),
      None => profile.clone(),
    };
    let pool = neo4j::connect(Neo4jTarget::from_profile(&reachable)).await?;
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
    Request::Labels => {
      let objects = neo4j::list_objects(pool, timeout).await.map_err(database_error)?;
      let objects: Vec<Value> = objects
        .into_iter()
        .filter(|object| arguments.database.as_ref().is_none_or(|database| *database == object.object_schema))
        .map(|object| json!({ "database": object.object_schema, "name": object.object_name, "kind": object.object_kind }))
        .collect();
      Ok(json!({ "objects": objects }))
    }
    Request::Run { query, limit } => {
      let kind =
        neo4j::query_type(Arc::clone(&pool), arguments.database.clone(), query.clone(), timeout)
          .await
          .map_err(database_error)?;
      if kind != Some("r") {
        return Err(CliError::refused(format!(
          "the server classifies this query as {}; the command line only runs read queries",
          kind.unwrap_or("unknown")
        )));
      }
      let request = CypherRequest {
        database: arguments.database.clone(),
        query: query.clone(),
        limit: *limit,
        timeout,
        read_all: false,
        read_only: true,
      };
      let result = neo4j::run(pool, request).await.map_err(database_error)?;
      Ok(json!({ "result": result }))
    }
  }
}

fn database_error(message: String) -> CliError {
  let kind = if message.starts_with(NEO4J_TIMEOUT) { "timeout" } else { "database" };
  CliError { exit: Exit::Database, kind, message, diagnosis: None }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::models::ConnectionProfile;

  fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|item| item.to_string()).collect()
  }

  /// 真库：`DATAOMNI_NEO4J_TEST_URL`（`bolt://user:password@host:port`），只在 shell 里传。
  /// 只碰 `OmCliProbe` 标签的节点，用完删掉
  #[tokio::test]
  async fn neo4j_reads_and_the_server_refuses_writes_twice() {
    let Ok(raw) = std::env::var("DATAOMNI_NEO4J_TEST_URL") else {
      eprintln!("skipping: DATAOMNI_NEO4J_TEST_URL is not set");
      return;
    };
    let url = url::Url::parse(&raw).expect("a valid test URL");
    let decode =
      |text: &str| urlencoding::decode(text).map(|text| text.into_owned()).unwrap_or_default();
    let profile: ConnectionProfile = serde_json::from_value(json!({
      "id": "cli-neo4j", "name": "cli-neo4j", "db_type": "neo4j",
      "host": url.host_str().unwrap_or_default(), "port": url.port().unwrap_or(7687),
      "database": "", "username": decode(url.username()),
      "password": decode(url.password().unwrap_or_default()), "ssl": false,
      "options": {}, "tags": [],
    }))
    .expect("a profile");
    let admin = Arc::new(neo4j::connect(Neo4jTarget::from_profile(&profile)).await.expect("admin"));
    let cypher = |query: &str, read_only: bool| {
      let request = CypherRequest {
        database: None,
        query: query.to_string(),
        limit: 100,
        timeout: Duration::from_secs(10),
        read_all: false,
        read_only,
      };
      neo4j::run(Arc::clone(&admin), request)
    };
    cypher("MATCH (n:OmCliProbe) DETACH DELETE n", false).await.expect("clean");
    cypher("CREATE (:OmCliProbe {n: 1})", false).await.expect("seed");

    let call = |list: &[&str]| {
      let parsed = parse(&args(list));
      let profile = profile.clone();
      async move {
        let arguments = parsed.unwrap_or_else(|error| panic!("{}", error.message));
        run(&profile, &arguments).await
      }
    };
    let labels = call(&["g", "labels"]).await.unwrap_or_else(|error| panic!("{}", error.message));
    assert!(labels.to_string().contains("OmCliProbe"), "{labels}");
    let read = call(&["g", "run", "MATCH (n:OmCliProbe) RETURN n.n AS n"])
      .await
      .unwrap_or_else(|error| panic!("{}", error.message));
    assert_eq!(read["result"]["rows"].as_array().map(Vec::len), Some(1), "{read}");

    for write in [
      "CREATE (:OmCliProbe {n: 2})",
      "MATCH (n:OmCliProbe) SET n.n = 2",
      "MATCH (n:OmCliProbe) DETACH DELETE n",
      "CREATE INDEX om_cli_probe_n IF NOT EXISTS FOR (n:OmCliProbe) ON (n.n)",
    ] {
      match call(&["g", "run", write]).await {
        Err(CliError { exit: Exit::Refused, .. }) => {}
        other => panic!("{write} was not refused: {:?}", other.map(|value| value.to_string())),
      }
    }
    // 第二层单独验：不问类型、直接在读模式里写，服务端也拒
    assert!(
      cypher("CREATE (:OmCliProbe {n: 3})", true).await.is_err(),
      "read mode let a write through"
    );

    let left = cypher("MATCH (n:OmCliProbe) RETURN n.n AS n", false).await.expect("count");
    assert_eq!(left.rows.len(), 1);
    cypher("MATCH (n:OmCliProbe) DETACH DELETE n", false).await.expect("clean up");
  }

  #[test]
  fn arguments_are_checked() {
    assert!(parse(&args(&["g", "labels", "--db", "neo4j"])).is_ok());
    assert!(parse(&args(&["g", "run", "MATCH (n) RETURN n", "--limit", "5"])).is_ok());
    for bad in [
      &["g"][..],
      &["g", "labels", "extra"],
      &["g", "labels", "--limit", "5"],
      &["g", "run"],
      &["g", "run", "a", "b"],
      &["g", "write", "CREATE (n)"],
      &["g", "run", "RETURN 1", "--db"],
    ] {
      assert!(matches!(parse(&args(bad)), Err(CliError { exit: Exit::Usage, .. })), "{bad:?}");
    }
  }
}
