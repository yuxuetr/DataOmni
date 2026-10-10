//! `mongo`：MongoDB 的只读命令（`rfcs/agent-cli.md` §5.2、§6 第二批）。
//!
//! MongoDB 没有会话级的只读，门就是这里只有读的接口：`find`、`count`、`aggregate`、`explain`、
//! 列集合与看结构，没有 `runCommand`；聚合管道里有 `$out` / `$merge` 的直接拒绝（`parse_pipeline`）。
//! 文档按 relaxed Extended JSON 输出：Agent 拿到的是能直接解析的 JSON，不是 mongosh 的写法

use super::{session, CliError, Exit, DEFAULT_ROW_LIMIT, DEFAULT_TIMEOUT_SECONDS};
use super::{MAX_ROW_LIMIT, MAX_TIMEOUT_SECONDS};
use crate::models::ConnectionProfile;
use crate::services::mongo_shell;
use crate::services::mongodb::{
  self, ExplainTarget, FindRequest, MongoTarget, MONGO_PIPELINE_WRITES, MONGO_TIMEOUT,
};
use crate::services::query_executor::DEFAULT_QUERY_BYTE_LIMIT;
use ::mongodb::bson::{Bson, Document};
use serde_json::{json, Value};
use std::time::Duration;

pub(super) const USAGE: &str = "usage: dataomni cli mongo <connection> <operation> ...
  collections
  find <database>.<collection> [<filter>] [--sort S] [--skip N] [--limit N]
  count <database>.<collection> [<filter>]
  aggregate <database>.<collection> <pipeline> [--limit N]
  explain <database>.<collection> [<filter>] [--sort S] | [--pipeline P]
  structure <database>.<collection>
every operation also takes [--timeout SECONDS]";

pub(super) struct Arguments {
  pub(super) connection: String,
  pub(super) timeout: Duration,
  request: Request,
  /// 留痕里记摘要的那段文字：条件或管道
  pub(super) subject: String,
}

enum Request {
  Collections,
  Find { namespace: Namespace, filter: Document, sort: Document, skip: u64, limit: usize },
  Count { namespace: Namespace, filter: Document },
  Aggregate { namespace: Namespace, pipeline: Vec<Document>, limit: usize },
  Explain { namespace: Namespace, target: ExplainTarget },
  Structure { namespace: Namespace },
}

struct Namespace {
  database: String,
  collection: String,
}

impl Arguments {
  /// 留痕里的命令名
  pub(super) fn command(&self) -> &'static str {
    match self.request {
      Request::Collections => "mongo collections",
      Request::Find { .. } => "mongo find",
      Request::Count { .. } => "mongo count",
      Request::Aggregate { .. } => "mongo aggregate",
      Request::Explain { .. } => "mongo explain",
      Request::Structure { .. } => "mongo structure",
    }
  }
}

#[derive(Default)]
struct Flags {
  sort: Option<String>,
  skip: Option<u64>,
  limit: Option<usize>,
  pipeline: Option<String>,
  timeout: Option<u64>,
}

/// 参数读完、条件与管道解析完才去找连接：写库的管道在这里就被拒，不换来一次钥匙串读取
pub(super) fn parse(rest: &[String]) -> Result<Arguments, CliError> {
  let mut positional = Vec::new();
  let mut flags = Flags::default();
  let mut iter = rest.iter();
  while let Some(argument) = iter.next() {
    match argument.as_str() {
      "--sort" => flags.sort = Some(text_after("--sort", iter.next())?),
      "--pipeline" => flags.pipeline = Some(text_after("--pipeline", iter.next())?),
      "--skip" => {
        flags.skip = Some(super::number_after("--skip", iter.next(), 0, i64::MAX as u64)?)
      }
      "--limit" => {
        flags.limit =
          Some(super::number_after("--limit", iter.next(), 1, MAX_ROW_LIMIT as u64)? as usize)
      }
      "--timeout" => {
        flags.timeout = Some(super::number_after("--timeout", iter.next(), 1, MAX_TIMEOUT_SECONDS)?)
      }
      _ => positional.push(argument.as_str()),
    }
  }
  let timeout = Duration::from_secs(flags.timeout.take().unwrap_or(DEFAULT_TIMEOUT_SECONDS));
  let (connection, operation, rest) = match positional.as_slice() {
    [connection, operation, rest @ ..] => (connection.to_string(), *operation, rest),
    _ => return Err(CliError::usage(USAGE)),
  };
  let (request, subject) = match (operation, rest) {
    ("collections", []) => (Request::Collections, String::new()),
    ("find", [namespace, filter @ ..]) => {
      let (filter, subject) = optional_document("filter", filter)?;
      let sort = match flags.sort.take() {
        Some(sort) => document("--sort", &sort)?,
        None => Document::new(),
      };
      let request = Request::Find {
        namespace: namespace_of(namespace)?,
        filter,
        sort,
        skip: flags.skip.take().unwrap_or(0),
        limit: flags.limit.take().unwrap_or(DEFAULT_ROW_LIMIT),
      };
      (request, subject)
    }
    ("count", [namespace, filter @ ..]) => {
      let (filter, subject) = optional_document("filter", filter)?;
      (Request::Count { namespace: namespace_of(namespace)?, filter }, subject)
    }
    ("aggregate", [namespace, pipeline]) => {
      let text = super::read_argument(pipeline)?;
      let request = Request::Aggregate {
        namespace: namespace_of(namespace)?,
        pipeline: pipeline_of(&text)?,
        limit: flags.limit.take().unwrap_or(DEFAULT_ROW_LIMIT),
      };
      (request, text)
    }
    ("explain", [namespace, filter @ ..]) => {
      let namespace = namespace_of(namespace)?;
      match flags.pipeline.take() {
        Some(_) if !filter.is_empty() || flags.sort.is_some() => {
          return Err(CliError::usage("explain takes a filter and --sort, or --pipeline, not both"))
        }
        Some(pipeline) => {
          let text = super::read_argument(&pipeline)?;
          let target = ExplainTarget::Aggregate { pipeline: pipeline_of(&text)? };
          (Request::Explain { namespace, target }, text)
        }
        None => {
          let (filter, subject) = optional_document("filter", filter)?;
          let sort = match flags.sort.take() {
            Some(sort) => document("--sort", &sort)?,
            None => Document::new(),
          };
          (Request::Explain { namespace, target: ExplainTarget::Find { filter, sort } }, subject)
        }
      }
    }
    ("structure", [namespace]) => {
      (Request::Structure { namespace: namespace_of(namespace)? }, String::new())
    }
    _ => return Err(CliError::usage(USAGE)),
  };
  // 给了这个操作不认的选项就报错，而不是悄悄不理：`count --limit 5` 的人以为只数了 5 个
  let unused = [
    flags.sort.map(|_| "--sort"),
    flags.skip.map(|_| "--skip"),
    flags.limit.map(|_| "--limit"),
    flags.pipeline.map(|_| "--pipeline"),
  ];
  if let Some(flag) = unused.into_iter().flatten().next() {
    return Err(CliError::usage(format!("mongo {operation} does not take {flag}")));
  }
  Ok(Arguments { connection, timeout, request, subject })
}

fn text_after(flag: &str, value: Option<&String>) -> Result<String, CliError> {
  value.cloned().ok_or_else(|| CliError::usage(format!("{flag} takes a value")))
}

/// 数据库名里不能有点，集合名里可以：在第一个点处分开
fn namespace_of(text: &str) -> Result<Namespace, CliError> {
  match text.split_once('.') {
    Some((database, collection)) if !database.is_empty() && !collection.is_empty() => {
      Ok(Namespace { database: database.to_string(), collection: collection.to_string() })
    }
    _ => Err(CliError::usage(format!("expected <database>.<collection>, got {text}"))),
  }
}

fn document(what: &str, text: &str) -> Result<Document, CliError> {
  mongo_shell::parse_document(text).map_err(|error| CliError::usage(format!("{what}: {error}")))
}

/// 条件可以不给（全部文档），给了就只能给一个
fn optional_document(what: &str, rest: &[&str]) -> Result<(Document, String), CliError> {
  match rest {
    [] => Ok((Document::new(), String::new())),
    [text] => {
      let text = super::read_argument(text)?;
      Ok((document(what, &text)?, text))
    }
    _ => Err(CliError::usage(USAGE)),
  }
}

fn pipeline_of(text: &str) -> Result<Vec<Document>, CliError> {
  let value = mongo_shell::parse_value(text)
    .map_err(|error| CliError::usage(format!("pipeline: {error}")))?;
  mongodb::parse_pipeline(value).map_err(|error| match error.strip_prefix(MONGO_PIPELINE_WRITES) {
    Some(stage) => CliError::refused(format!(
      "the pipeline writes ({}); the command line only reads",
      stage.trim_start_matches(':').trim()
    )),
    None => CliError::usage(format!("pipeline: {error}")),
  })
}

/// 连上服务端（配了隧道先开隧道），跑这一个请求。隧道与客户端活到返回为止
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
    let client = mongodb::connect(&MongoTarget::from_profile(&reachable)).await?;
    Ok::<_, String>((tunnels, client))
  };
  let deadline = session::CONNECT_DEADLINE;
  let (_tunnels, client) = tokio::time::timeout(deadline, connect)
    .await
    .map_err(|_| {
      CliError::unavailable("connect", format!("could not connect within {} s", deadline.as_secs()))
    })?
    .map_err(|error| CliError::unavailable("connect", error))?;
  let timeout = arguments.timeout;
  let body = match &arguments.request {
    Request::Collections => {
      let entries = mongodb::list_collections(&client).await.map_err(database_error)?;
      let collections: Vec<Value> = entries
        .into_iter()
        .map(|entry| {
          json!({ "database": entry.object_schema, "name": entry.object_name, "kind": entry.object_kind })
        })
        .collect();
      json!({ "collections": collections })
    }
    Request::Find { namespace, filter, sort, skip, limit } => {
      let request = FindRequest {
        filter: filter.clone(),
        sort: sort.clone(),
        skip: *skip,
        limit: *limit as u64,
        timeout,
      };
      let (documents, has_more) =
        mongodb::find_documents(&client, &namespace.database, &namespace.collection, request)
          .await
          .map_err(database_error)?;
      documents_output(namespace, documents, has_more)
    }
    Request::Count { namespace, filter } => {
      let count = mongodb::count(
        &client,
        &namespace.database,
        &namespace.collection,
        filter.clone(),
        timeout,
      )
      .await
      .map_err(database_error)?;
      json!({ "namespace": label(namespace), "count": count })
    }
    Request::Aggregate { namespace, pipeline, limit } => {
      let (documents, has_more) = mongodb::aggregate_documents(
        &client,
        &namespace.database,
        &namespace.collection,
        pipeline.clone(),
        0,
        *limit as u64,
        timeout,
      )
      .await
      .map_err(database_error)?;
      documents_output(namespace, documents, has_more)
    }
    Request::Explain { namespace, target } => {
      let target = target.clone();
      let plan =
        mongodb::explain(&client, &namespace.database, &namespace.collection, target, timeout)
          .await
          .map_err(database_error)?;
      json!({ "namespace": label(namespace), "plan": plan })
    }
    Request::Structure { namespace } => {
      let structure =
        mongodb::collection_structure(&client, &namespace.database, &namespace.collection, timeout)
          .await
          .map_err(database_error)?;
      json!({ "namespace": label(namespace), "indexes": structure.indexes, "options": structure.options })
    }
  };
  Ok(body)
}

fn label(namespace: &Namespace) -> String {
  format!("{}.{}", namespace.database, namespace.collection)
}

/// 同 `query`：最多 `--limit` 个、合计不超过 16 MB，截了就说 `truncated`
fn documents_output(namespace: &Namespace, documents: Vec<Document>, has_more: bool) -> Value {
  let mut kept = Vec::with_capacity(documents.len());
  let mut bytes = 0usize;
  let mut truncated = has_more;
  for document in documents {
    let value = Bson::Document(document).into_relaxed_extjson();
    bytes += value.to_string().len();
    if bytes > DEFAULT_QUERY_BYTE_LIMIT {
      truncated = true;
      break;
    }
    kept.push(value);
  }
  json!({ "namespace": label(namespace), "documents": kept, "truncated": truncated })
}

fn database_error(message: String) -> CliError {
  let kind = if message.starts_with(MONGO_TIMEOUT) { "timeout" } else { "database" };
  CliError { exit: Exit::Database, kind, message, diagnosis: None }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::models::ConnectionProfile;

  fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|item| item.to_string()).collect()
  }

  fn refused(list: &[&str]) -> bool {
    matches!(parse(&args(list)), Err(CliError { exit: Exit::Refused, .. }))
  }

  fn usage(list: &[&str]) -> bool {
    matches!(parse(&args(list)), Err(CliError { exit: Exit::Usage, .. }))
  }

  /// §5.2：写库的阶段在解析时就拒，连接都不用找
  #[test]
  fn pipelines_that_write_are_refused() {
    assert!(refused(&["m", "aggregate", "db.c", "[{ $match: {} }, { $out: 'copy' }]"]));
    assert!(refused(&["m", "aggregate", "db.c", "[{ $merge: { into: 'copy' } }]"]));
    assert!(refused(&["m", "explain", "db.c", "--pipeline", "[{ $out: 'copy' }]"]));
    assert!(
      parse(&args(&["m", "aggregate", "db.c", "[{ $match: { a: 1 } }, { $count: 'n' }]"])).is_ok()
    );
  }

  #[test]
  fn arguments_are_checked() {
    assert!(parse(&args(&["m", "collections"])).is_ok());
    assert!(parse(&args(&[
      "m",
      "find",
      "db.c.with.dots",
      "{ a: { $gt: 1 } }",
      "--sort",
      "{ a: -1 }",
      "--limit",
      "5"
    ]))
    .is_ok());
    assert!(parse(&args(&["m", "explain", "db.c", "{ a: 1 }", "--sort", "{ a: 1 }"])).is_ok());
    for bad in [
      &["m"][..],
      &["m", "collections", "extra"],
      &["m", "runCommand", "db.c", "{ dropDatabase: 1 }"],
      &["m", "find", "nodot"],
      &["m", "find", ".c"],
      &["m", "find", "db.c", "{ not json"],
      &["m", "find", "db.c", "{}", "{}"],
      &["m", "count", "db.c", "--limit", "5"],
      &["m", "structure", "db.c", "--sort", "{ a: 1 }"],
      &["m", "aggregate", "db.c"],
      &["m", "aggregate", "db.c", "'not a pipeline'"],
      &["m", "explain", "db.c", "{ a: 1 }", "--pipeline", "[]"],
      &["m", "find", "db.c", "--limit", "0"],
    ] {
      assert!(usage(bad), "{bad:?}");
    }
  }

  /// 真库：`DATAOMNI_MONGODB_TEST_URL`（`mongodb://user:password@host:port/authSource`），只在 shell 里传。
  /// 每个操作都读到探针集合；写库的管道被拒之后集合没变、也没多出集合
  #[tokio::test]
  async fn mongo_operations_read_a_real_server() {
    let Ok(raw) = std::env::var("DATAOMNI_MONGODB_TEST_URL") else {
      eprintln!("skipping: DATAOMNI_MONGODB_TEST_URL is not set");
      return;
    };
    let url = url::Url::parse(&raw).expect("a valid test URL");
    let decode =
      |text: &str| urlencoding::decode(text).map(|text| text.into_owned()).unwrap_or_default();
    let profile: ConnectionProfile = serde_json::from_value(json!({
      "id": "cli-mongo", "name": "cli-mongo", "db_type": "mongodb",
      "host": url.host_str().unwrap_or_default(), "port": url.port().unwrap_or(27017),
      "database": url.path().trim_start_matches('/'), "username": decode(url.username()),
      "password": decode(url.password().unwrap_or_default()), "ssl": false,
      "options": {}, "tags": [],
    }))
    .expect("a profile");
    let admin = mongodb::connect(&MongoTarget::from_profile(&profile)).await.expect("admin client");
    let probe = admin.database("dataomni_test").collection::<Document>("om_cli_probe");
    probe.drop().await.expect("drop the probe");
    let seed: Vec<Document> =
      (1..=5).map(|n| ::mongodb::bson::doc! { "n": n, "even": n % 2 == 0 }).collect();
    probe.insert_many(seed).await.expect("seed");
    probe
      .create_index(::mongodb::IndexModel::builder().keys(::mongodb::bson::doc! { "n": 1 }).build())
      .await
      .expect("index");

    let call = |list: &[&str]| {
      let arguments =
        parse(&args(list)).unwrap_or_else(|error| panic!("{list:?}: {}", error.message));
      let profile = profile.clone();
      async move { run(&profile, &arguments).await.unwrap_or_else(|error| panic!("{}", error.message)) }
    };
    let listed = call(&["m", "collections"]).await;
    let names: Vec<&str> = listed["collections"]
      .as_array()
      .map(|list| list.iter().filter_map(|entry| entry["name"].as_str()).collect())
      .unwrap_or_default();
    assert!(names.contains(&"om_cli_probe"), "{listed}");

    let found = call(&[
      "m",
      "find",
      "dataomni_test.om_cli_probe",
      "{ even: true }",
      "--sort",
      "{ n: -1 }",
      "--limit",
      "1",
    ])
    .await;
    assert_eq!(found["documents"][0]["n"], json!(4), "{found}");
    assert_eq!(found["truncated"], json!(true));
    let counted = call(&["m", "count", "dataomni_test.om_cli_probe", "{ n: { $gt: 2 } }"]).await;
    assert_eq!(counted["count"], json!(3));
    let grouped = call(&[
      "m",
      "aggregate",
      "dataomni_test.om_cli_probe",
      "[{ $group: { _id: '$even', total: { $sum: '$n' } } }, { $sort: { _id: 1 } }]",
    ])
    .await;
    assert_eq!(
      grouped["documents"],
      json!([{ "_id": false, "total": 9 }, { "_id": true, "total": 6 }])
    );
    let explained = call(&["m", "explain", "dataomni_test.om_cli_probe", "{ n: 3 }"]).await;
    let stages = explained["plan"]["stages"].to_string();
    assert!(stages.contains("IXSCAN"), "{explained}");
    let structure = call(&["m", "structure", "dataomni_test.om_cli_probe"]).await;
    assert!(structure["indexes"].to_string().contains("n_1"), "{structure}");

    assert!(refused(&[
      "m",
      "aggregate",
      "dataomni_test.om_cli_probe",
      "[{ $out: 'om_cli_copy' }]"
    ]));
    assert_eq!(probe.count_documents(::mongodb::bson::doc! {}).await.expect("count"), 5);
    let collections = admin.database("dataomni_test").list_collection_names().await.expect("names");
    assert!(!collections.iter().any(|name| name == "om_cli_copy"));
    probe.drop().await.expect("clean up");
  }

  #[test]
  fn documents_are_relaxed_extended_json_and_capped_by_bytes() {
    let namespace = Namespace { database: "db".to_string(), collection: "c".to_string() };
    let id = ::mongodb::bson::oid::ObjectId::new();
    let documents = vec![
      ::mongodb::bson::doc! { "_id": id, "n": 1_i64, "at": ::mongodb::bson::DateTime::from_millis(0) },
    ];
    let output = documents_output(&namespace, documents, false);
    assert_eq!(output["documents"][0]["_id"], json!({ "$oid": id.to_hex() }));
    assert_eq!(output["documents"][0]["n"], json!(1));
    assert_eq!(output["truncated"], json!(false));

    let big = "x".repeat(DEFAULT_QUERY_BYTE_LIMIT / 2);
    let documents = (0..3).map(|_| ::mongodb::bson::doc! { "s": big.clone() }).collect();
    let output = documents_output(&namespace, documents, false);
    assert_eq!(output["documents"].as_array().map(Vec::len), Some(1));
    assert_eq!(output["truncated"], json!(true));
  }
}
