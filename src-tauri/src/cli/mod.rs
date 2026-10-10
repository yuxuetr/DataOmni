//! `dataomni cli …`：给 Agent 与终端用的命令行（`rfcs/agent-cli.md`）。
//!
//! 和应用是同一个二进制：macOS 的钥匙串按代码身份授权，同一个二进制读得到界面存的口令，
//! 另编一个程序每次升级都要多弹一次框（§3.1 E1）。`main` 在起 Tauri 之前分流到这里，
//! 不建窗口。
//!
//! 输出给程序读：结果是 stdout 上的一个 JSON，错误是 stderr 上的一个 JSON，退出码区分
//! 「数据库报错 / 参数错 / 被权限门拒绝 / 连不上」（§7）。文字用英文：命令行的读者多半是
//! Agent，界面的语言设置在 WebView 里，这里读不到。

mod audit;
mod dictionary;
mod elasticsearch;
mod mongo;
mod neo4j;
mod redis;
mod session;

use crate::models::{ConnectionProfile, DatabaseType};
use crate::services::connection_service::{app_config_dir, ConnectionService, APP_IDENTIFIER};
use crate::services::query_executor::QueryExecutionResult;
use crate::services::read_only_gate;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 默认最多回多少行。Agent 的上下文按字计费，一张大表整张倒进去是浪费，要更多就明说
const DEFAULT_ROW_LIMIT: usize = 200;
const MAX_ROW_LIMIT: usize = 10_000;
const DEFAULT_TIMEOUT_SECONDS: u64 = 30;
const MAX_TIMEOUT_SECONDS: u64 = 600;
/// 读口令最多等多久。钥匙串要授权时这一步会一直卡着，等到有人点了弹框
const KEYCHAIN_DEADLINE: Duration = Duration::from_secs(10);

/// 输出格式的版本。字段改名或改含义时加一，只加字段不加
const OUTPUT_SCHEMA: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
  Ok = 0,
  Database = 1,
  Usage = 2,
  /// 被权限门拒绝。Agent 靠它区分「换个写法」和「这条路不通」
  Refused = 3,
  /// 连不上、缺凭据、钥匙串在等授权
  Unavailable = 4,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliError {
  pub exit: Exit,
  pub kind: &'static str,
  pub message: String,
  /// `test` 连不上时断在哪一段（`connection_probe::diagnose` 的步骤）
  pub diagnosis: Option<Value>,
}

impl CliError {
  fn usage(message: impl Into<String>) -> Self {
    Self { exit: Exit::Usage, kind: "usage", message: message.into(), diagnosis: None }
  }

  fn unavailable(kind: &'static str, message: impl Into<String>) -> Self {
    Self { exit: Exit::Unavailable, kind, message: message.into(), diagnosis: None }
  }

  fn refused(message: impl Into<String>) -> Self {
    Self { exit: Exit::Refused, kind: "refused", message: message.into(), diagnosis: None }
  }

  /// 没开放的、生产的、不存在的连接都是这一句：不让调用方分辨出「有，但不给你」
  fn not_found(name: &str) -> Self {
    Self {
      exit: Exit::Usage,
      kind: "not_found",
      message: format!("no connection named {name} is open to the command line"),
      diagnosis: None,
    }
  }
}

const HELP: &str = "\
DataOmni command line: read-only access to connections you opened to agents in DataOmni.

Usage: dataomni cli <command> [arguments]

Commands:
  connections        List the connections open to the command line
  query <connection> <sql> [--limit N] [--timeout SECONDS]
                     Run one read-only statement. <connection> is a name or id
                     from `connections`; <sql> may be - to read it from stdin.
                     At most 200 rows by default (--limit up to 10000), 30 s timeout.
  schema <connection> [<table> [--schema S]]
                     Without a table: the tables and views. With a table: its
                     columns, indexes (one row per index column) and foreign keys.
  explain <connection> <sql> [--timeout SECONDS]
                     The execution plan of one read-only statement, as a tree
                     (plan.roots) plus the database's own text (plan.raw). Never
                     ANALYZE: the statement itself does not run.
  dictionary <connection>
                     A Markdown data dictionary of the whole database: every
                     table's columns, types, nullability, primary and foreign
                     keys. Read it before writing SQL. Printed as Markdown, not JSON.
  mongo <connection> <operation> ...
                     MongoDB, read only: collections; find, count, aggregate,
                     explain and structure on <database>.<collection>. Filters and
                     pipelines are mongosh syntax; documents come back as relaxed
                     Extended JSON. Pipelines with $out or $merge are refused.
                     explain runs the query (executionStats) but returns no
                     documents. `dataomni cli mongo` alone shows its usage.
  redis <connection> <operation> ...
                     Redis, read only: keyspaces; scan [<pattern>]; get <key>;
                     command <name> [<argument>...], which runs only commands the
                     server itself flags readonly (asked with COMMAND INFO).
                     --db N picks the logical database. `dataomni cli redis` alone
                     shows its usage.
  neo4j <connection> labels | run <cypher> [--limit N]
                     Neo4j, read only: the labels and relationship types; or one
                     Cypher query, run only if the server classifies it as a read
                     (asked with EXPLAIN) and then in a read-mode transaction.
                     --db picks the database.
  es <connection> indices | request <METHOD> <path> [<body>]
                     Elasticsearch / OpenSearch, read only: the indices, aliases
                     and data streams; or one REST request. GET and HEAD pass
                     (except _refresh, _flush, _forcemerge, _cache); POST only to
                     search endpoints (_search, _count, _msearch, _mget, ...);
                     PUT and DELETE never. The body is parsed JSON when it is JSON.
  export <connection> <sql> --out FILE [--format csv|json] [--delimiter C]
         [--no-header] [--null TEXT] [--bom] [--timeout SECONDS]
                     Write every row of one read-only statement to a new local
                     file (never overwrites), the same bytes the DataOmni export
                     writes. 300 s timeout by default.
  ddl <connection> <table> [--schema S]
                     The definition the database itself gives for a table or
                     view (SHOW CREATE TABLE, sqlite_master, DBMS_METADATA, ...).
                     PostgreSQL has it for views only; use schema for its tables.
  backup <connection> --out PATH [--database D]
                     Back up to a new path the way DataOmni does: pg_dump (custom
                     format), mysqldump, mongodump (--database picks the database),
                     SQLite VACUUM INTO, DuckDB EXPORT DATABASE. All read-only on
                     the database; the dump tools must be installed. No timeout.
  csv-preview <file> [--delimiter C] [--no-header] [--rows N]
                     A local CSV file: the delimiter and encoding it was read with
                     (sniffed unless given), the header, the first rows (50 by
                     default) and the rows whose field count does not match.
  test <connection>  Connect the way query does, run nothing, report ok. When a
                     network connection fails, error.diagnosis says whether the
                     name resolved and the port answered.
  version            Print the DataOmni version
  help               Print this help

Output is JSON on stdout (dictionary prints Markdown); errors are JSON on stderr.
Exit codes: 0 ok, 1 database error, 2 usage error, 3 refused by the access rules,
4 unavailable (cannot connect, missing credentials, keychain waiting for approval).

A connection is visible here only if \"Command line & agent access\" is set to
read-only in its DataOmni settings. Production connections are never visible.
Nothing on this command line can widen that.
";

/// 命令行读写的两个目录。测试换成临时目录，不碰本机真实的配置与日志
struct Dirs {
  config: Option<PathBuf>,
  log: Option<PathBuf>,
}

/// 和 Tauri 的 `PathResolver::app_log_dir` 同一个算法
fn app_log_dir() -> Option<PathBuf> {
  #[cfg(target_os = "macos")]
  let dir = dirs::home_dir().map(|home| home.join("Library/Logs").join(APP_IDENTIFIER));
  #[cfg(not(target_os = "macos"))]
  let dir = dirs::data_local_dir().map(|dir| dir.join(APP_IDENTIFIER).join("logs"));
  dir
}

/// 安装包里的 Instant Client。和 Tauri 的 `resource_dir` 同一个算法，只是不起 Tauri
fn bundled_oracle_client() -> Option<PathBuf> {
  let exe = std::env::current_exe().ok()?;
  let exe_dir = exe.parent()?;
  #[cfg(target_os = "macos")]
  let resources = exe_dir.join("../Resources");
  #[cfg(target_os = "linux")]
  let resources = exe_dir
    .join("../lib/DataOmni")
    .canonicalize()
    .unwrap_or_else(|_| PathBuf::from("/usr/lib/DataOmni"));
  #[cfg(not(any(target_os = "macos", target_os = "linux")))]
  let resources = exe_dir.to_path_buf();
  Some(resources.join("instantclient"))
}

/// 入口：`args` 是 `cli` 之后的参数。返回进程退出码
pub fn run(args: &[String]) -> i32 {
  if let Some(dir) = bundled_oracle_client() {
    crate::services::oracle::pin_client_dir(dir);
  }
  let stdout = std::io::stdout();
  let stderr = std::io::stderr();
  let dirs = Dirs { config: app_config_dir(), log: app_log_dir() };
  run_with(args, &dirs, &mut stdout.lock(), &mut stderr.lock())
}

fn run_with(args: &[String], dirs: &Dirs, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
  let result = dispatch(args, dirs);
  // 写不进 stdout / stderr（管道被关了）时也没有别处可说，退出码照样给
  match result {
    Ok(Output::Json(value)) => {
      let _ = writeln!(out, "{value}");
      Exit::Ok as i32
    }
    Ok(Output::Text(text)) => {
      let _ = write!(out, "{text}");
      Exit::Ok as i32
    }
    Err(error) => {
      let mut body = json!({
        "schema": OUTPUT_SCHEMA,
        "error": { "kind": error.kind, "message": error.message },
      });
      if let Some(diagnosis) = error.diagnosis {
        body["error"]["diagnosis"] = diagnosis;
      }
      let _ = writeln!(err, "{body}");
      error.exit as i32
    }
  }
}

enum Output {
  Json(Value),
  Text(String),
}

fn dispatch(args: &[String], dirs: &Dirs) -> Result<Output, CliError> {
  let config_dir = dirs.config.as_deref();
  let Some((command, rest)) = args.split_first() else {
    return Ok(Output::Text(HELP.to_string()));
  };
  match command.as_str() {
    "help" | "--help" | "-h" => Ok(Output::Text(HELP.to_string())),
    "version" | "--version" => {
      no_arguments(command, rest)?;
      Ok(Output::Json(json!({ "schema": OUTPUT_SCHEMA, "version": env!("CARGO_PKG_VERSION") })))
    }
    "connections" => {
      no_arguments(command, rest)?;
      let service = open_service(config_dir)?;
      Ok(Output::Json(list_open(&service)))
    }
    "query" => query(rest, config_dir, dirs.log.as_deref()).map(Output::Json),
    "schema" => schema(rest, config_dir, dirs.log.as_deref()).map(Output::Json),
    "explain" => explain(rest, config_dir, dirs.log.as_deref()).map(Output::Json),
    "test" => test(rest, config_dir, dirs.log.as_deref()).map(Output::Json),
    "dictionary" => dictionary(rest, config_dir, dirs.log.as_deref()).map(Output::Text),
    "mongo" => mongo(rest, config_dir, dirs.log.as_deref()).map(Output::Json),
    "redis" => redis(rest, config_dir, dirs.log.as_deref()).map(Output::Json),
    "neo4j" => neo4j(rest, config_dir, dirs.log.as_deref()).map(Output::Json),
    "es" => es(rest, config_dir, dirs.log.as_deref()).map(Output::Json),
    "csv-preview" => csv_preview(rest).map(Output::Json),
    "export" => export(rest, config_dir, dirs.log.as_deref()).map(Output::Json),
    "ddl" => ddl(rest, config_dir, dirs.log.as_deref()).map(Output::Json),
    "backup" => backup(rest, config_dir, dirs.log.as_deref()).map(Output::Json),
    other => Err(CliError::usage(format!("unknown command {other}; run `dataomni cli help`"))),
  }
}

struct QueryArguments {
  connection: String,
  sql: String,
  row_limit: usize,
  timeout: Duration,
}

/// `query` 与 `explain` 的参数。`usage` 是那条命令的用法；没有 `--limit` 的命令传
/// `accepts_limit = false`，给了就报错，而不是悄悄不理
fn parse_statement_arguments(
  rest: &[String],
  usage: &str,
  accepts_limit: bool,
) -> Result<QueryArguments, CliError> {
  let mut positional = Vec::new();
  let mut row_limit = DEFAULT_ROW_LIMIT;
  let mut timeout_seconds = DEFAULT_TIMEOUT_SECONDS;
  let mut iter = rest.iter();
  while let Some(argument) = iter.next() {
    match argument.as_str() {
      "--limit" if accepts_limit => {
        row_limit = number_after("--limit", iter.next(), 1, MAX_ROW_LIMIT as u64)? as usize
      }
      "--timeout" => {
        timeout_seconds = number_after("--timeout", iter.next(), 1, MAX_TIMEOUT_SECONDS)?
      }
      _ => positional.push(argument.clone()),
    }
  }
  let [connection, sql] =
    <[String; 2]>::try_from(positional).map_err(|_| CliError::usage(usage))?;
  let sql = read_argument(&sql)?;
  Ok(QueryArguments { connection, sql, row_limit, timeout: Duration::from_secs(timeout_seconds) })
}

/// `-` 表示从标准输入读：语句、条件、管道都可能长得不便写在命令行上
fn read_argument(text: &str) -> Result<String, CliError> {
  if text != "-" {
    return Ok(text.to_string());
  }
  let mut read = String::new();
  std::io::stdin()
    .read_to_string(&mut read)
    .map_err(|error| CliError::usage(format!("cannot read stdin: {error}")))?;
  Ok(read)
}

fn number_after(flag: &str, value: Option<&String>, min: u64, max: u64) -> Result<u64, CliError> {
  value
    .and_then(|value| value.parse::<u64>().ok())
    .filter(|number| (min..=max).contains(number))
    .ok_or_else(|| CliError::usage(format!("{flag} takes a number from {min} to {max}")))
}

fn query(
  rest: &[String],
  config_dir: Option<&Path>,
  log_dir: Option<&Path>,
) -> Result<Value, CliError> {
  let usage = "usage: dataomni cli query <connection> <sql> [--limit N] [--timeout SECONDS]";
  let arguments = parse_statement_arguments(rest, usage, true)?;
  let service = open_service(config_dir)?;
  let profile = find_open(&service, &arguments.connection)?;
  let started = Instant::now();
  let outcome = run_query(&service, &profile, &arguments, config_dir);
  audit::record(log_dir, "query", &profile.name, &arguments.sql, &outcome, started.elapsed());
  let result = outcome?;
  Ok(query_output(&profile, result, started.elapsed()))
}

fn run_query(
  service: &ConnectionService,
  profile: &ConnectionProfile,
  arguments: &QueryArguments,
  config_dir: Option<&Path>,
) -> Result<QueryExecutionResult, CliError> {
  // 先过语句门、再看类型，最后才读口令：被拒的语句不该换来一次钥匙串弹框
  read_only_gate::check(&arguments.sql)
    .map_err(|refusal| CliError::refused(refusal.to_string()))?;
  if !session::supports(&profile.db_type) {
    return Err(unsupported(&profile.db_type));
  }
  let resolved = resolve_verified(service, profile)?;
  let run = session::run_read_only(&resolved, &arguments.sql, arguments.row_limit, config_dir);
  block_on_within(arguments.timeout, "the statement", async { run.await.map_err(session_error) })
}

fn explain(
  rest: &[String],
  config_dir: Option<&Path>,
  log_dir: Option<&Path>,
) -> Result<Value, CliError> {
  let usage = "usage: dataomni cli explain <connection> <sql> [--timeout SECONDS]";
  let arguments = parse_statement_arguments(rest, usage, false)?;
  let service = open_service(config_dir)?;
  let profile = find_open(&service, &arguments.connection)?;
  let started = Instant::now();
  let outcome = run_explain(&service, &profile, &arguments, config_dir);
  audit::record(log_dir, "explain", &profile.name, &arguments.sql, &outcome, started.elapsed());
  let plan = outcome?;
  Ok(json!({
    "schema": OUTPUT_SCHEMA,
    "connection": profile.name,
    "plan": plan,
    "elapsed_ms": started.elapsed().as_millis() as u64,
  }))
}

fn run_explain(
  service: &ConnectionService,
  profile: &ConnectionProfile,
  arguments: &QueryArguments,
  config_dir: Option<&Path>,
) -> Result<crate::services::explain::QueryPlan, CliError> {
  // 包进 EXPLAIN 之前先过语句门：门只放读语句，EXPLAIN 永远不带 ANALYZE
  read_only_gate::check(&arguments.sql)
    .map_err(|refusal| CliError::refused(refusal.to_string()))?;

  if !session::supports(&profile.db_type) {
    return Err(unsupported(&profile.db_type));
  }
  let resolved = resolve_verified(service, profile)?;
  block_on_within(arguments.timeout, "the plan", async {
    let opened = session::open(&resolved, config_dir).await.map_err(session_error)?;
    let plan = opened.explain(&resolved.db_type, &arguments.sql).await;
    opened.close().await;
    plan.map_err(session_error)
  })
}

fn test(
  rest: &[String],
  config_dir: Option<&Path>,
  log_dir: Option<&Path>,
) -> Result<Value, CliError> {
  let [connection] = rest else {
    return Err(CliError::usage("usage: dataomni cli test <connection>"));
  };
  let service = open_service(config_dir)?;
  let profile = find_open(&service, connection)?;
  let started = Instant::now();
  let outcome = run_test(&service, &profile, config_dir);
  audit::record(log_dir, "test", &profile.name, "", &outcome, started.elapsed());
  outcome?;
  Ok(json!({
    "schema": OUTPUT_SCHEMA,
    "connection": profile.name,
    "ok": true,
    "elapsed_ms": started.elapsed().as_millis() as u64,
  }))
}

fn run_test(
  service: &ConnectionService,
  profile: &ConnectionProfile,
  config_dir: Option<&Path>,
) -> Result<(), CliError> {
  if !session::supports(&profile.db_type) {
    return Err(unsupported(&profile.db_type));
  }
  let resolved = resolve_verified(service, profile)?;
  let timeout = Duration::from_secs(DEFAULT_TIMEOUT_SECONDS);
  block_on_within(timeout, "the connection", async {
    match session::open(&resolved, config_dir).await {
      Ok(opened) => {
        opened.close().await;
        Ok(())
      }
      Err(failure) => {
        let mut error = session_error(failure);
        // 只探网络库的主机与端口：文件库的报错里已经有路径与系统给的原因；经隧道的连接
        // 探到的是隧道后面的地址，从这台机器本来就到不了，结论会是错的
        let networked = !matches!(profile.db_type, DatabaseType::SQLite | DatabaseType::DuckDB);
        if error.kind == "connect" && networked && profile.ssh_tunnel.is_none() {
          let steps = crate::services::diagnose(profile).await.steps;
          error.diagnosis = serde_json::to_value(steps).ok();
        }
        Err(error)
      }
    }
  })
}

fn dictionary(
  rest: &[String],
  config_dir: Option<&Path>,
  log_dir: Option<&Path>,
) -> Result<String, CliError> {
  let [connection] = rest else {
    return Err(CliError::usage("usage: dataomni cli dictionary <connection>"));
  };
  let service = open_service(config_dir)?;
  let profile = find_open(&service, connection)?;
  let started = Instant::now();
  let outcome = run_dictionary(&service, &profile, config_dir);
  audit::record(log_dir, "dictionary", &profile.name, "", &outcome, started.elapsed());
  outcome
}

fn run_dictionary(
  service: &ConnectionService,
  profile: &ConnectionProfile,
  config_dir: Option<&Path>,
) -> Result<String, CliError> {
  let queries = crate::services::er_diagram_queries(&profile.db_type)
    .filter(|_| session::supports(&profile.db_type))
    .ok_or_else(|| unsupported(&profile.db_type))?;
  let database = profile.database.clone().unwrap_or_default();
  // 同 `list_objects`：没有库名时 MySQL 的目录条件恒不匹配，字典会是空的，像是库里没有表
  if queries.parameter_count > 0 && database.is_empty() {
    return Err(CliError::usage("this connection has no database name; set one in DataOmni"));
  }
  let resolved = resolve_verified(service, profile)?;
  let params = vec![Value::String(database); usize::from(queries.parameter_count)];
  let timeout = Duration::from_secs(DEFAULT_TIMEOUT_SECONDS);
  let (columns, foreign_keys) = block_on_within(timeout, "the catalog", async {
    let opened = session::open(&resolved, config_dir).await.map_err(session_error)?;
    let columns = opened.select(queries.columns, params.clone()).await;
    let foreign_keys = match columns {
      Ok(_) => opened.select(queries.foreign_keys, params).await,
      Err(_) => Ok(Vec::new()),
    };
    opened.close().await;
    Ok((columns.map_err(session_error)?, foreign_keys.map_err(session_error)?))
  })?;
  let date = chrono::Local::now().format("%Y-%m-%d").to_string();
  let tables = dictionary::tables_from_rows(&columns);
  let links = dictionary::links_from_rows(&foreign_keys);
  Ok(dictionary::render(&profile.name, dictionary::dialect(profile), &date, &tables, &links))
}

fn mongo(
  rest: &[String],
  config_dir: Option<&Path>,
  log_dir: Option<&Path>,
) -> Result<Value, CliError> {
  let arguments = mongo::parse(rest)?;
  let service = open_service(config_dir)?;
  let profile = find_open(&service, &arguments.connection)?;
  let started = Instant::now();
  let outcome = run_mongo(&service, &profile, &arguments);
  let command = arguments.command();
  audit::record(log_dir, command, &profile.name, &arguments.subject, &outcome, started.elapsed());
  let body = outcome?;
  let mut output = json!({ "schema": OUTPUT_SCHEMA, "connection": profile.name });
  if let (Value::Object(output), Value::Object(body)) = (&mut output, body) {
    output.extend(body);
  }
  output["elapsed_ms"] = json!(started.elapsed().as_millis() as u64);
  Ok(output)
}

fn run_mongo(
  service: &ConnectionService,
  profile: &ConnectionProfile,
  arguments: &mongo::Arguments,
) -> Result<Value, CliError> {
  if profile.db_type != DatabaseType::MongoDB {
    return Err(CliError::usage(format!("{} is not a MongoDB connection", profile.name)));
  }
  let resolved = resolve_verified(service, profile)?;
  block_on_within(arguments.timeout, "the MongoDB request", mongo::run(&resolved, arguments))
}

fn redis(
  rest: &[String],
  config_dir: Option<&Path>,
  log_dir: Option<&Path>,
) -> Result<Value, CliError> {
  let arguments = redis::parse(rest)?;
  let service = open_service(config_dir)?;
  let profile = find_open(&service, &arguments.connection)?;
  let started = Instant::now();
  let outcome = run_redis(&service, &profile, &arguments);
  let command = arguments.command();
  audit::record(log_dir, command, &profile.name, &arguments.subject, &outcome, started.elapsed());
  let body = outcome?;
  let mut output = json!({ "schema": OUTPUT_SCHEMA, "connection": profile.name });
  if let (Value::Object(output), Value::Object(body)) = (&mut output, body) {
    output.extend(body);
  }
  output["elapsed_ms"] = json!(started.elapsed().as_millis() as u64);
  Ok(output)
}

fn run_redis(
  service: &ConnectionService,
  profile: &ConnectionProfile,
  arguments: &redis::Arguments,
) -> Result<Value, CliError> {
  if profile.db_type != DatabaseType::Redis {
    return Err(CliError::usage(format!("{} is not a Redis connection", profile.name)));
  }
  let resolved = resolve_verified(service, profile)?;
  block_on_within(arguments.timeout, "the Redis request", redis::run(&resolved, arguments))
}

fn neo4j(
  rest: &[String],
  config_dir: Option<&Path>,
  log_dir: Option<&Path>,
) -> Result<Value, CliError> {
  let arguments = neo4j::parse(rest)?;
  let service = open_service(config_dir)?;
  let profile = find_open(&service, &arguments.connection)?;
  let started = Instant::now();
  let outcome = run_neo4j(&service, &profile, &arguments);
  let command = arguments.command();
  audit::record(log_dir, command, &profile.name, &arguments.subject, &outcome, started.elapsed());
  let body = outcome?;
  let mut output = json!({ "schema": OUTPUT_SCHEMA, "connection": profile.name });
  if let (Value::Object(output), Value::Object(body)) = (&mut output, body) {
    output.extend(body);
  }
  output["elapsed_ms"] = json!(started.elapsed().as_millis() as u64);
  Ok(output)
}

fn run_neo4j(
  service: &ConnectionService,
  profile: &ConnectionProfile,
  arguments: &neo4j::Arguments,
) -> Result<Value, CliError> {
  if profile.db_type != DatabaseType::Neo4j {
    return Err(CliError::usage(format!("{} is not a Neo4j connection", profile.name)));
  }
  let resolved = resolve_verified(service, profile)?;
  block_on_within(arguments.timeout, "the Neo4j request", neo4j::run(&resolved, arguments))
}

fn es(
  rest: &[String],
  config_dir: Option<&Path>,
  log_dir: Option<&Path>,
) -> Result<Value, CliError> {
  let arguments = elasticsearch::parse(rest)?;
  let service = open_service(config_dir)?;
  let profile = find_open(&service, &arguments.connection)?;
  let started = Instant::now();
  let outcome = run_es(&service, &profile, &arguments);
  let command = arguments.command();
  audit::record(log_dir, command, &profile.name, &arguments.subject, &outcome, started.elapsed());
  let body = outcome?;
  let mut output = json!({ "schema": OUTPUT_SCHEMA, "connection": profile.name });
  if let (Value::Object(output), Value::Object(body)) = (&mut output, body) {
    output.extend(body);
  }
  output["elapsed_ms"] = json!(started.elapsed().as_millis() as u64);
  Ok(output)
}

fn run_es(
  service: &ConnectionService,
  profile: &ConnectionProfile,
  arguments: &elasticsearch::Arguments,
) -> Result<Value, CliError> {
  if profile.db_type != DatabaseType::Elasticsearch {
    return Err(CliError::usage(format!("{} is not an Elasticsearch connection", profile.name)));
  }
  let resolved = resolve_verified(service, profile)?;
  block_on_within(
    arguments.timeout,
    "the Elasticsearch request",
    elasticsearch::run(&resolved, arguments),
  )
}

/// 导出最多等多久：整表导出要几分钟，语句的默认 30 秒不够
const DEFAULT_EXPORT_TIMEOUT_SECONDS: u64 = 300;

struct ExportArguments {
  connection: String,
  sql: String,
  out: PathBuf,
  options: crate::services::export_writer::ExportOptions,
  timeout: Duration,
}

fn parse_export_arguments(rest: &[String]) -> Result<ExportArguments, CliError> {
  use crate::services::export_writer::{ExportFormat, ExportOptions};
  let usage = "usage: dataomni cli export <connection> <sql> --out FILE [--format csv|json] \
    [--delimiter C] [--no-header] [--null TEXT] [--bom] [--timeout SECONDS]";
  let mut positional = Vec::new();
  let mut out = None;
  let mut options = ExportOptions {
    format: ExportFormat::Csv,
    delimiter: ",".to_string(),
    include_header: true,
    null_text: String::new(),
    byte_order_mark: false,
    sql_table: String::new(),
    sql_dialect: None,
    sql_computed_columns: Vec::new(),
    sql_identity_columns: Vec::new(),
    sql_sequence_columns: Vec::new(),
  };
  let mut timeout_seconds = DEFAULT_EXPORT_TIMEOUT_SECONDS;
  let mut iter = rest.iter();
  while let Some(argument) = iter.next() {
    let mut value = |flag: &str| {
      iter.next().cloned().ok_or_else(|| CliError::usage(format!("{flag} takes a value")))
    };
    match argument.as_str() {
      "--out" => out = Some(PathBuf::from(value("--out")?)),
      // `sql` 要知道哪些是计算列、自增列与序列（界面另查表的元数据），这一版不做
      "--format" => {
        options.format = match value("--format")?.as_str() {
          "csv" => ExportFormat::Csv,
          "json" => ExportFormat::Json,
          other => return Err(CliError::usage(format!("--format is csv or json, got {other}"))),
        }
      }
      "--delimiter" => options.delimiter = value("--delimiter")?,
      "--null" => options.null_text = value("--null")?,
      "--no-header" => options.include_header = false,
      "--bom" => options.byte_order_mark = true,
      "--timeout" => {
        timeout_seconds = number_after("--timeout", iter.next(), 1, MAX_TIMEOUT_SECONDS)?
      }
      _ => positional.push(argument.clone()),
    }
  }
  let [connection, sql] =
    <[String; 2]>::try_from(positional).map_err(|_| CliError::usage(usage))?;
  let out = out.ok_or_else(|| CliError::usage(usage))?;
  // 不覆盖：Agent 写错一个路径就会盖掉人的文件
  if out.exists() {
    return Err(CliError::usage(format!("{} already exists; choose another path", out.display())));
  }
  Ok(ExportArguments {
    connection,
    sql: read_argument(&sql)?,
    out,
    options,
    timeout: Duration::from_secs(timeout_seconds),
  })
}

fn export(
  rest: &[String],
  config_dir: Option<&Path>,
  log_dir: Option<&Path>,
) -> Result<Value, CliError> {
  let arguments = parse_export_arguments(rest)?;
  let service = open_service(config_dir)?;
  let profile = find_open(&service, &arguments.connection)?;
  let started = Instant::now();
  let outcome = run_export(&service, &profile, &arguments, config_dir);
  audit::record(log_dir, "export", &profile.name, &arguments.sql, &outcome, started.elapsed());
  let summary = outcome?;
  Ok(json!({
    "schema": OUTPUT_SCHEMA,
    "connection": profile.name,
    "file": summary.path,
    "rows": summary.rows_written,
    "bytes": summary.bytes_written,
    "elapsed_ms": started.elapsed().as_millis() as u64,
  }))
}

fn run_export(
  service: &ConnectionService,
  profile: &ConnectionProfile,
  arguments: &ExportArguments,
  config_dir: Option<&Path>,
) -> Result<crate::services::export_writer::ExportSummary, CliError> {
  read_only_gate::check(&arguments.sql)
    .map_err(|refusal| CliError::refused(refusal.to_string()))?;
  if !session::supports(&profile.db_type) {
    return Err(unsupported(&profile.db_type));
  }
  let resolved = resolve_verified(service, profile)?;
  block_on_within(arguments.timeout, "the export", async {
    let opened = session::open(&resolved, config_dir).await.map_err(session_error)?;
    let summary = opened.export(&arguments.sql, &arguments.out, arguments.options.clone()).await;
    opened.close().await;
    summary.map_err(session_error)
  })
}

/// 本机的 CSV 文件：嗅探分隔符与编码（UTF-8，否则 gb18030），给表头、开头几行和字段数对不上的行。
/// 不碰连接，也就不留痕
fn csv_preview(rest: &[String]) -> Result<Value, CliError> {
  let usage = "usage: dataomni cli csv-preview <file> [--delimiter C] [--no-header] [--rows N]";
  let mut path = None;
  let mut delimiter = None;
  let mut has_header = true;
  let mut rows = crate::services::csv_import::PREVIEW_ROWS;
  let mut iter = rest.iter();
  while let Some(argument) = iter.next() {
    match argument.as_str() {
      "--delimiter" => match iter.next().map(|text| text.as_bytes()) {
        Some([single]) => delimiter = Some(*single),
        _ => return Err(CliError::usage("--delimiter takes one ASCII character")),
      },
      "--no-header" => has_header = false,
      "--rows" => rows = number_after("--rows", iter.next(), 1, MAX_ROW_LIMIT as u64)? as usize,
      _ if path.is_none() => path = Some(PathBuf::from(argument)),
      _ => return Err(CliError::usage(usage)),
    }
  }
  let path = path.ok_or_else(|| CliError::usage(usage))?;
  let preview = crate::services::csv_import::preview_csv(&path, delimiter, has_header, rows)
    .map_err(|error| CliError {
      exit: Exit::Usage,
      kind: "file",
      message: error.to_string(),
      diagnosis: None,
    })?;
  let mut output = json!({ "schema": OUTPUT_SCHEMA, "file": path.to_string_lossy() });
  if let (Value::Object(output), Ok(Value::Object(body))) =
    (&mut output, serde_json::to_value(preview))
  {
    output.extend(body);
  }
  Ok(output)
}

/// 在一个新的运行时里跑完 `work`，到点没完就报超时。`what` 是报错里的主语
fn block_on_within<T>(
  timeout: Duration,
  what: &str,
  work: impl std::future::Future<Output = Result<T, CliError>>,
) -> Result<T, CliError> {
  runtime()?.block_on(async { tokio::time::timeout(timeout, work).await }).map_err(|_| {
    CliError {
      exit: Exit::Database,
      kind: "timeout",
      message: format!("{what} did not finish within {} s", timeout.as_secs()),
      diagnosis: None,
    }
  })?
}

fn runtime() -> Result<tokio::runtime::Runtime, CliError> {
  tokio::runtime::Builder::new_multi_thread()
    .enable_all()
    .build()
    .map_err(|error| CliError::unavailable("runtime", error.to_string()))
}

/// 备份：PostgreSQL、MySQL / MariaDB、MongoDB 用服务端自己的工具（`pg_dump`、`mysqldump`、
/// `mongodump`，都只读），SQLite、DuckDB 在只读打开的库上用库自己的语句，同界面（`services::backup`）。
/// 不设时限：外部工具跑在阻塞线程里，到点丢掉 future 也停不下它，运行时收尾时照样要等它跑完
fn backup(
  rest: &[String],
  config_dir: Option<&Path>,
  log_dir: Option<&Path>,
) -> Result<Value, CliError> {
  let usage = "usage: dataomni cli backup <connection> --out PATH [--database D]";
  let mut positional = Vec::new();
  let mut out = None;
  let mut database = None;
  let mut iter = rest.iter();
  while let Some(argument) = iter.next() {
    let mut value = |flag: &str| {
      iter.next().cloned().ok_or_else(|| CliError::usage(format!("{flag} takes a value")))
    };
    match argument.as_str() {
      "--out" => out = Some(PathBuf::from(value("--out")?)),
      "--database" => database = Some(value("--database")?),
      _ => positional.push(argument.clone()),
    }
  }
  let [connection] = <[String; 1]>::try_from(positional).map_err(|_| CliError::usage(usage))?;
  let out = out.ok_or_else(|| CliError::usage(usage))?;
  if out.exists() {
    return Err(CliError::usage(format!("{} already exists; choose another path", out.display())));
  }
  let service = open_service(config_dir)?;
  let profile = find_open(&service, &connection)?;
  if database.is_some() && profile.db_type != DatabaseType::MongoDB {
    return Err(CliError::usage("--database is for MongoDB: the database to back up"));
  }
  let started = Instant::now();
  let outcome = run_backup(&service, &profile, &out, database.as_deref(), config_dir);
  audit::record(log_dir, "backup", &profile.name, "", &outcome, started.elapsed());
  let kind = outcome?;
  Ok(json!({
    "schema": OUTPUT_SCHEMA,
    "connection": profile.name,
    "file": out.to_string_lossy(),
    "kind": kind,
    "elapsed_ms": started.elapsed().as_millis() as u64,
  }))
}

fn run_backup(
  service: &ConnectionService,
  profile: &ConnectionProfile,
  out: &Path,
  database: Option<&str>,
  config_dir: Option<&Path>,
) -> Result<crate::services::backup::BackupKind, CliError> {
  use crate::services::backup::{backup_with_tool, BACKUP_NO_DATABASE, BACKUP_TOOL_MISSING};
  let backup_error = |error: crate::services::QueryError| {
    let message = error.to_string();
    if message.starts_with(BACKUP_TOOL_MISSING) {
      CliError::unavailable("tool", message)
    } else if message.starts_with(BACKUP_NO_DATABASE) {
      CliError::usage(message)
    } else {
      CliError { exit: Exit::Database, kind: "backup", message, diagnosis: None }
    }
  };
  match profile.db_type {
    DatabaseType::PostgreSQL | DatabaseType::MySQL | DatabaseType::MongoDB => {
      let resolved = resolve_verified(service, profile)?;
      runtime()?.block_on(async {
        let (_tunnels, port) = session::tunnel(&resolved)
          .await
          .map_err(|error| CliError::unavailable("connect", error))?;
        backup_with_tool(&resolved, port, out, database).await.map_err(backup_error)
      })
    }
    DatabaseType::SQLite | DatabaseType::DuckDB => {
      let resolved = resolve_verified(service, profile)?;
      runtime()?.block_on(async {
        session::backup_embedded(&resolved, config_dir, out).await.map_err(
          |failure| match failure {
            session::Failure::Database(error) => backup_error(error),
            other => session_error(other),
          },
        )
      })
    }
    _ => Err(unsupported(&profile.db_type)),
  }
}

struct SchemaArguments {
  connection: String,
  table: Option<String>,
  schema: Option<String>,
}

fn parse_schema_arguments(rest: &[String]) -> Result<SchemaArguments, CliError> {
  let mut positional = Vec::new();
  let mut schema = None;
  let mut iter = rest.iter();
  while let Some(argument) = iter.next() {
    match argument.as_str() {
      "--schema" => {
        schema = Some(iter.next().cloned().ok_or_else(|| CliError::usage("--schema takes a name"))?)
      }
      _ => positional.push(argument.clone()),
    }
  }
  let usage = || CliError::usage("usage: dataomni cli schema <connection> [<table> [--schema S]]");
  let mut positional = positional.into_iter();
  let connection = positional.next().ok_or_else(usage)?;
  let table = positional.next();
  if positional.next().is_some() || (schema.is_some() && table.is_none()) {
    return Err(usage());
  }
  Ok(SchemaArguments { connection, table, schema })
}

/// 表或视图的定义原文，同界面结构页的「对象定义」：**数据库自己给的**（`SHOW CREATE TABLE`、
/// `sqlite_master`、`DBMS_METADATA`……），不从目录重建——重建出来的看着权威、照着建却不等价
fn ddl(
  rest: &[String],
  config_dir: Option<&Path>,
  log_dir: Option<&Path>,
) -> Result<Value, CliError> {
  let arguments = parse_schema_arguments(rest)?;
  let Some(table) = arguments.table.clone() else {
    return Err(CliError::usage("usage: dataomni cli ddl <connection> <table> [--schema S]"));
  };
  let service = open_service(config_dir)?;
  let profile = find_open(&service, &arguments.connection)?;
  let started = Instant::now();
  let outcome = run_ddl(&service, &profile, &table, arguments.schema.as_deref(), config_dir);
  audit::record(log_dir, "ddl", &profile.name, &table, &outcome, started.elapsed());
  let statements = outcome?;
  let ddl: Vec<String> = statements
    .iter()
    .map(
      |statement| {
        if statement.ends_with(';') {
          statement.clone()
        } else {
          format!("{statement};")
        }
      },
    )
    .collect();
  Ok(
    json!({ "schema": OUTPUT_SCHEMA, "connection": profile.name, "table": table, "ddl": ddl.join("\n\n") }),
  )
}

fn run_ddl(
  service: &ConnectionService,
  profile: &ConnectionProfile,
  table: &str,
  schema: Option<&str>,
  config_dir: Option<&Path>,
) -> Result<Vec<String>, CliError> {
  if !session::supports(&profile.db_type) {
    return Err(unsupported(&profile.db_type));
  }
  let resolved = resolve_verified(service, profile)?;
  let timeout = Duration::from_secs(DEFAULT_TIMEOUT_SECONDS);
  block_on_within(timeout, "the definition", async {
    let opened = session::open(&resolved, config_dir).await.map_err(session_error)?;
    let statements = ddl_statements(&opened, &resolved.db_type, table, schema).await;
    opened.close().await;
    statements
  })
}

/// 定义原文的每一条（SQLite 连着索引与触发器）。查不到就是没有这张表或视图；PostgreSQL 的表
/// 本来就没有原文（它没有 `SHOW CREATE TABLE`），单独说
async fn ddl_statements(
  opened: &session::Opened,
  db_type: &DatabaseType,
  table: &str,
  schema: Option<&str>,
) -> Result<Vec<String>, CliError> {
  use crate::services::schema_metadata::{schema_metadata_queries, DdlQuery};
  let queries = schema_metadata_queries(db_type).ok_or_else(|| unsupported(db_type))?;
  let ddl = queries.ddl.ok_or_else(|| unsupported(db_type))?;
  let rows = match ddl {
    DdlQuery::Bound { sql } => {
      let params = if queries.parameter_count == 1 {
        vec![Value::from(table)]
      } else {
        vec![Value::from(table), schema.map_or(Value::Null, Value::from)]
      };
      opened.select(sql, params).await
    }
    // 只有 MySQL 走这一种：`SHOW CREATE TABLE` 不收占位符，表名作为引用过的标识符拼进去
    DdlQuery::Interpolated { sql } => {
      let quote = |name: &str| format!("`{}`", name.replace('`', "``"));
      let target = match schema {
        Some(schema) => format!("{}.{}", quote(schema), quote(table)),
        None => quote(table),
      };
      opened.select(&sql.replace("{table}", &target), Vec::new()).await
    }
  };
  // MySQL 对不存在的表报 1146，当作「没有」而不是数据库错误。sqlx 给的码是 SQLSTATE（42S02），不是错误号
  let rows = match rows {
    Ok(rows) => rows,
    Err(session::Failure::Database(error)) if error.code.as_deref() == Some("42S02") => Vec::new(),
    Err(failure) => return Err(session_error(failure)),
  };
  // 同 `schemaObjects.ts` 的 `extractDdlStatements`：几家把原文放在不同的列里
  let statements: Vec<String> = rows
    .iter()
    .filter_map(|row| {
      ["Create Table", "Create View", "sql"]
        .iter()
        .find_map(|column| row[*column].as_str().map(str::trim).filter(|text| !text.is_empty()))
        .map(str::to_string)
    })
    .collect();
  if statements.is_empty() {
    let message = if *db_type == DatabaseType::PostgreSQL {
      format!("no view named {table}: PostgreSQL keeps no CREATE TABLE text for tables; `schema <connection> {table}` gives the columns, indexes and foreign keys")
    } else {
      format!("no table or view named {table}")
    };
    return Err(CliError { exit: Exit::Usage, kind: "not_found", message, diagnosis: None });
  }
  Ok(statements)
}

fn schema(
  rest: &[String],
  config_dir: Option<&Path>,
  log_dir: Option<&Path>,
) -> Result<Value, CliError> {
  let arguments = parse_schema_arguments(rest)?;
  let service = open_service(config_dir)?;
  let profile = find_open(&service, &arguments.connection)?;
  let started = Instant::now();
  let outcome = run_schema(&service, &profile, &arguments, config_dir);
  let subject = arguments.table.as_deref().unwrap_or("");
  audit::record(log_dir, "schema", &profile.name, subject, &outcome, started.elapsed());
  outcome
}

fn run_schema(
  service: &ConnectionService,
  profile: &ConnectionProfile,
  arguments: &SchemaArguments,
  config_dir: Option<&Path>,
) -> Result<Value, CliError> {
  if !session::supports(&profile.db_type) {
    return Err(unsupported(&profile.db_type));
  }
  let resolved = resolve_verified(service, profile)?;
  let timeout = Duration::from_secs(DEFAULT_TIMEOUT_SECONDS);
  let body = block_on_within(timeout, "the catalog", async {
    let opened = session::open(&resolved, config_dir).await.map_err(session_error)?;
    let result = match &arguments.table {
      None => list_objects(&opened, &resolved).await,
      Some(table) => describe_table(&opened, &resolved, table, arguments.schema.as_deref()).await,
    };
    opened.close().await;
    result
  })?;
  let mut output = json!({ "schema": OUTPUT_SCHEMA, "connection": profile.name });
  if let (Value::Object(output), Value::Object(body)) = (&mut output, body) {
    output.extend(body);
  }
  Ok(output)
}

async fn list_objects(
  opened: &session::Opened,
  profile: &ConnectionProfile,
) -> Result<Value, CliError> {
  let queries = crate::services::object_catalog::object_catalog_queries(&profile.db_type)
    .ok_or_else(|| unsupported(&profile.db_type))?;
  let database = profile.database.clone().unwrap_or_default();
  // 没有库名时 MySQL 的目录条件恒不匹配，会安静地查出 0 行，像是库是空的（同界面）
  if queries.object_parameter_count > 0 && database.is_empty() {
    return Err(CliError::usage("this connection has no database name; set one in DataOmni"));
  }
  let params = vec![Value::String(database); usize::from(queries.object_parameter_count)];
  let rows = opened.select(queries.objects, params).await.map_err(session_error)?;
  let objects: Vec<Value> = rows
    .into_iter()
    .map(|row| json!({ "schema": row["object_schema"], "name": row["object_name"], "kind": row["object_kind"] }))
    .collect();
  Ok(json!({ "objects": objects }))
}

async fn describe_table(
  opened: &session::Opened,
  profile: &ConnectionProfile,
  table: &str,
  schema: Option<&str>,
) -> Result<Value, CliError> {
  let queries = crate::services::schema_metadata::schema_metadata_queries(&profile.db_type)
    .ok_or_else(|| unsupported(&profile.db_type))?;
  // 同 `catalogQueries.ts` 的 `catalogQueryParams`：一个参数是表名，两个是表名与 schema
  let params = if queries.parameter_count == 1 {
    vec![Value::from(table)]
  } else {
    vec![Value::from(table), schema.map_or(Value::Null, Value::from)]
  };
  let columns = opened.select(queries.columns, params.clone()).await.map_err(session_error)?;
  if columns.is_empty() {
    return Err(CliError {
      exit: Exit::Usage,
      kind: "not_found",
      message: format!("no table or view named {table}"),
      diagnosis: None,
    });
  }
  let indexes = opened.select(queries.indexes, params.clone()).await.map_err(session_error)?;
  let foreign_keys = opened.select(queries.foreign_keys, params).await.map_err(session_error)?;
  let columns: Vec<Value> = columns
    .into_iter()
    .map(|row| {
      json!({
        "name": row["column_name"],
        "type": row["data_type"],
        "nullable": truthy(&row["is_nullable"]),
        "primary_key": truthy(&row["is_primary_key"]),
        "default": row["column_default"],
        "comment": row["comment"],
      })
    })
    .collect();
  Ok(
    json!({ "table": table, "columns": columns, "indexes": indexes, "foreign_keys": foreign_keys }),
  )
}

/// 目录里的布尔：PostgreSQL 给真布尔，MySQL 与 SQLite 给 1/0（同 `tableMetadata.ts`）
fn truthy(value: &Value) -> bool {
  match value {
    Value::Bool(flag) => *flag,
    Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
    Value::String(text) => matches!(text.as_str(), "1" | "t" | "true" | "YES" | "Y"),
    _ => false,
  }
}

fn session_error(failure: session::Failure) -> CliError {
  match failure {
    session::Failure::Unsupported(db_type) => unsupported(&db_type),
    session::Failure::Connect(message) => CliError::unavailable("connect", message),
    session::Failure::Database(error) => CliError {
      exit: Exit::Database,
      kind: "database",
      message: error.to_string(),
      diagnosis: None,
    },
  }
}

fn unsupported(db_type: &crate::models::DatabaseType) -> CliError {
  match db_type {
    DatabaseType::MongoDB => {
      return CliError::refused("MongoDB connections take `dataomni cli mongo`, not SQL")
    }
    DatabaseType::Redis => {
      return CliError::refused("Redis connections take `dataomni cli redis`, not SQL")
    }
    DatabaseType::Neo4j => {
      return CliError::refused("Neo4j connections take `dataomni cli neo4j`, not SQL")
    }
    DatabaseType::Elasticsearch => {
      return CliError::refused("Elasticsearch connections take `dataomni cli es`, not SQL")
    }
    _ => {}
  }
  let name =
    serde_json::to_value(db_type).ok().and_then(|value| value.as_str().map(str::to_string));
  CliError::refused(format!(
    "{} connections are not supported on the command line yet",
    name.unwrap_or_else(|| format!("{db_type:?}"))
  ))
}

/// 读口令可能卡在钥匙串的授权框上。到点还没回来就直接退出并说清楚，框留给人去点——
/// 卡着不动的命令会让 Agent 一直等下去
fn with_keychain_deadline<T>(work: impl FnOnce() -> T) -> T {
  let done = Arc::new(AtomicBool::new(false));
  let watched = Arc::clone(&done);
  std::thread::spawn(move || {
    std::thread::sleep(KEYCHAIN_DEADLINE);
    if !watched.load(Ordering::SeqCst) {
      let body = json!({
        "schema": OUTPUT_SCHEMA,
        "error": {
          "kind": "keychain",
          "message": "the system keychain is waiting for approval: choose \"Always Allow\" in the prompt, then run the command again",
        },
      });
      eprintln!("{body}");
      std::process::exit(Exit::Unavailable as i32);
    }
  });
  let result = work();
  done.store(true, Ordering::SeqCst);
  result
}

/// 按 id 或名字找文件里标着开放的连接。还没验凭证：那一步要读钥匙串，放在语句门之后
fn find_open(service: &ConnectionService, name: &str) -> Result<ConnectionProfile, CliError> {
  let open: Vec<ConnectionProfile> =
    service.get_connections().into_iter().filter(ConnectionProfile::open_to_agents).collect();
  if let Some(profile) = open.iter().find(|profile| profile.id == name) {
    return Ok(profile.clone());
  }
  let mut named = open.into_iter().filter(|profile| profile.name == name);
  match (named.next(), named.next()) {
    (Some(profile), None) => Ok(profile),
    (Some(_), Some(_)) => {
      Err(CliError::usage(format!("several connections are named {name}; use the id instead")))
    }
    (None, _) => Err(CliError::not_found(name)),
  }
}

/// 验过开放凭证、补好凭据的连接。凭证对不上的和不存在的一样，报「找不到」
fn resolve_verified(
  service: &ConnectionService,
  profile: &ConnectionProfile,
) -> Result<ConnectionProfile, CliError> {
  match with_keychain_deadline(|| service.resolve_for_agents(profile)) {
    Ok(Some(resolved)) => Ok(resolved),
    Ok(None) => Err(CliError::not_found(&profile.name)),
    Err(error) => Err(CliError::unavailable("credentials", error)),
  }
}

fn query_output(
  profile: &ConnectionProfile,
  result: QueryExecutionResult,
  elapsed: Duration,
) -> Value {
  let elapsed_ms = elapsed.as_millis() as u64;
  match result {
    QueryExecutionResult::Rows { columns, rows, truncated, row_limit, .. } => {
      let rows: Vec<Value> = rows
        .into_iter()
        .map(|row| {
          Value::Array(columns.iter().map(|column| plain(row.get(column).cloned())).collect())
        })
        .collect();
      json!({
        "schema": OUTPUT_SCHEMA,
        "connection": profile.name,
        "columns": columns,
        "rows": rows,
        "row_count": rows.len(),
        "truncated": truncated,
        "row_limit": row_limit,
        "elapsed_ms": elapsed_ms,
      })
    }
    // 语句门只放读语句，走到这里的只会是没有结果集的读（极少见），照实说
    QueryExecutionResult::Affected { rows_affected } => json!({
      "schema": OUTPUT_SCHEMA,
      "connection": profile.name,
      "rows_affected": rows_affected,
      "elapsed_ms": elapsed_ms,
    }),
  }
}

/// 界面用的带类型的值（`{"type": "decimal", "value": "1.50"}`）摊平成值本身：类型是给网格
/// 选编辑器用的，Agent 只要值。整数在 JSON 数字放得下的范围内给数字，超出的仍是字符串——
/// 界面打标签就是为了不丢精度；`json` 列给解析后的值
fn plain(value: Option<Value>) -> Value {
  const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;
  let Some(value) = value else { return Value::Null };
  let Value::Object(object) = &value else { return value };
  let (Some(Value::String(kind)), Some(Value::String(text)), 2) =
    (object.get("type"), object.get("value"), object.len())
  else {
    return value;
  };
  match kind.as_str() {
    "bigint" => match text.parse::<i64>() {
      Ok(number) if number.abs() <= MAX_SAFE_INTEGER => Value::from(number),
      _ => Value::String(text.clone()),
    },
    "json" => serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.clone())),
    _ => Value::String(text.clone()),
  }
}

fn no_arguments(command: &str, rest: &[String]) -> Result<(), CliError> {
  match rest.first() {
    None => Ok(()),
    Some(extra) => Err(CliError::usage(format!("{command} takes no arguments, got {extra}"))),
  }
}

fn open_service(config_dir: Option<&Path>) -> Result<ConnectionService, CliError> {
  let config_dir = config_dir.ok_or_else(|| {
    CliError::unavailable("config", "cannot locate the DataOmni configuration directory")
  })?;
  #[cfg(not(test))]
  let service = ConnectionService::open_read_only(config_dir);
  #[cfg(test)]
  let service = ConnectionService::open_read_only_without_keychain(config_dir);
  service.map_err(|error| CliError::unavailable("config", error.to_string()))
}

/// 开放给命令行、并且凭证对得上的连接。不带口令、钥匙串引用、私钥和证书的路径：
/// Agent 要的只是「有哪些库、叫什么、是什么类型」。开放了却用不了的（比如口令只在会话里输）
/// 单独列在 `unavailable` 里，说明原因，而不是悄悄少一个
fn list_open(service: &ConnectionService) -> Value {
  let mut open: Vec<ConnectionProfile> =
    service.get_connections().into_iter().filter(ConnectionProfile::open_to_agents).collect();
  open.sort_by(|left, right| left.name.cmp(&right.name));
  let mut usable = Vec::new();
  let mut unavailable = Vec::new();
  with_keychain_deadline(|| {
    for connection in open {
      match service.resolve_for_agents(&connection) {
        Ok(Some(_)) => usable.push(connection),
        Ok(None) => {}
        Err(error) => unavailable.push(json!({ "name": connection.name, "reason": error })),
      }
    }
  });
  let connections: Vec<Value> = usable
    .into_iter()
    .map(|connection| {
      json!({
        "id": connection.id,
        "name": connection.name,
        "type": connection.db_type,
        "environment": connection.environment,
        "host": connection.host,
        "port": connection.port,
        "database": connection.database,
        "ssh_tunnel": connection.ssh_tunnel.is_some(),
      })
    })
    .collect();
  json!({ "schema": OUTPUT_SCHEMA, "connections": connections, "unavailable": unavailable })
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  const SECRET: &str = "cli-test-secret-7f3a";

  /// 免密的库：不需要开放凭证（`ConnectionService::resolve_for_agents`），测试碰不到钥匙串
  fn profile(id: &str, name: &str, environment: &str, agent_access: &str) -> Value {
    json!({
      "id": id, "name": name, "db_type": "postgresql", "host": "db.internal", "port": 5432,
      "database": "app", "username": "reader", "password": "", "ssl": false,
      "options": {}, "tags": [], "environment": environment, "agent_access": agent_access,
    })
  }

  /// 旧版留在文件里的明文口令：有口令，就要凭证
  fn profile_with_secret(id: &str, name: &str) -> Value {
    let mut value = profile(id, name, "development", "read");
    value["password"] = json!(SECRET);
    value
  }

  struct ConfigDir(PathBuf);

  impl ConfigDir {
    fn with(connections: &[Value]) -> Self {
      let dir = std::env::temp_dir().join(format!("dataomni-cli-{}", uuid::Uuid::new_v4()));
      if let Err(error) = std::fs::create_dir_all(&dir) {
        panic!("{error}");
      }
      if let Err(error) =
        std::fs::write(dir.join("connections.json"), Value::from(connections.to_vec()).to_string())
      {
        panic!("{error}");
      }
      Self(dir)
    }

    fn config_file(&self) -> Vec<u8> {
      std::fs::read(self.0.join("connections.json")).unwrap_or_default()
    }
  }

  impl Drop for ConfigDir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  fn run_in(dir: &ConfigDir, args: &[&str]) -> (i32, String, String) {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let mut out = Vec::new();
    let mut err = Vec::new();
    let dirs = Dirs { config: Some(dir.0.clone()), log: Some(dir.0.join("logs")) };
    let code = run_with(&args, &dirs, &mut out, &mut err);
    (code, String::from_utf8_lossy(&out).into_owned(), String::from_utf8_lossy(&err).into_owned())
  }

  fn names(stdout: &str) -> Vec<String> {
    let value: Value = serde_json::from_str(stdout).unwrap_or_default();
    value["connections"]
      .as_array()
      .map(|list| {
        list.iter().filter_map(|item| item["name"].as_str().map(str::to_string)).collect()
      })
      .unwrap_or_default()
  }

  /// §8 第 3、4 条：生产连接即使字段被改成只读也看不见；没开放的看不见
  #[test]
  fn lists_only_connections_open_to_agents() {
    let dir = ConfigDir::with(&[
      profile("a", "open-dev", "development", "read"),
      profile("b", "prod-marked-read", "production", "read"),
      profile("c", "closed", "development", "off"),
      profile("d", "open-staging", "staging", "read"),
    ]);
    let (code, stdout, stderr) = run_in(&dir, &["connections"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(names(&stdout), vec!["open-dev", "open-staging"]);
  }

  /// §8 第 8 条：手写进文件的「开放」，没有凭证就不算——有口令的连接这里看不见
  #[test]
  fn a_connection_marked_open_only_in_the_file_is_hidden() {
    let dir = ConfigDir::with(&[
      profile_with_secret("a", "forged"),
      profile("b", "open", "development", "read"),
    ]);
    let (code, stdout, stderr) = run_in(&dir, &["connections"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(names(&stdout), vec!["open"]);
    let (code, _, stderr) = run_in(&dir, &["query", "forged", "SELECT 1"]);
    assert_eq!(code, Exit::Usage as i32);
    assert_eq!(json_of(&stderr)["error"]["kind"], "not_found");
  }

  /// §8 第 6、7 条：输出里没有口令；跑完配置文件一个字节都不变（旧版的明文口令也不迁移）
  #[test]
  fn never_prints_secrets_or_rewrites_the_config() {
    let dir = ConfigDir::with(&[profile_with_secret("a", "open-dev")]);
    let before = dir.config_file();
    for args in [&["connections"][..], &["version"], &["help"], &["nope"]] {
      let (_, stdout, stderr) = run_in(&dir, args);
      assert!(!stdout.contains(SECRET) && !stderr.contains(SECRET), "{args:?}: {stdout}{stderr}");
    }
    assert_eq!(dir.config_file(), before);
  }

  #[test]
  fn errors_are_json_on_stderr_with_their_exit_code() {
    let dir = ConfigDir::with(&[]);
    let (code, stdout, stderr) = run_in(&dir, &["nope"]);
    assert_eq!((code, stdout.as_str()), (Exit::Usage as i32, ""));
    let error: Value = serde_json::from_str(&stderr).unwrap_or_default();
    assert_eq!(error["error"]["kind"], "usage");
    assert_eq!(run_in(&dir, &["connections", "extra"]).0, Exit::Usage as i32);
  }

  #[test]
  fn version_and_help() {
    let dir = ConfigDir::with(&[]);
    let (code, stdout, _) = run_in(&dir, &["version"]);
    let value: Value = serde_json::from_str(&stdout).unwrap_or_default();
    assert_eq!((code, value["version"].as_str()), (0, Some(env!("CARGO_PKG_VERSION"))));
    let (code, stdout, _) = run_in(&dir, &[]);
    assert_eq!(code, 0);
    assert!(stdout.contains("Usage: dataomni cli"));
  }

  fn file_profile(id: &str, name: &str, db_type: &str, path: &Path, environment: &str) -> Value {
    json!({
      "id": id, "name": name, "db_type": db_type, "host": "", "port": 0,
      "database": path.to_string_lossy(), "username": "", "ssl": false,
      "options": {}, "tags": [], "environment": environment, "agent_access": "read",
    })
  }

  /// 临时目录里一个 1000 行的 SQLite 库
  fn seeded_sqlite(dir: &Path) -> PathBuf {
    let path = dir.join("app.db");
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    runtime.block_on(async {
      let options =
        sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(true);
      let pool = sqlx::SqlitePool::connect_with(options).await.expect("create sqlite");
      sqlx::raw_sql(
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
         INSERT INTO items SELECT i, 'item ' || i FROM n;",
      )
      .execute(&pool)
      .await
      .expect("seed");
      pool.close().await;
    });
    path
  }

  fn sqlite_count(path: &Path) -> i64 {
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    runtime.block_on(async {
      let pool =
        sqlx::SqlitePool::connect(&format!("sqlite:{}", path.display())).await.expect("open");
      let count: (i64,) =
        sqlx::query_as("SELECT count(*) FROM items").fetch_one(&pool).await.expect("count");
      pool.close().await;
      count.0
    })
  }

  fn json_of(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_default()
  }

  #[test]
  fn query_reads_rows_with_a_default_limit() {
    let dir = ConfigDir::with(&[]);
    let db = seeded_sqlite(&dir.0);
    std::fs::write(
      dir.0.join("connections.json"),
      Value::from(vec![file_profile("s", "local", "sqlite", &db, "development")]).to_string(),
    )
    .expect("config");

    let (code, stdout, stderr) =
      run_in(&dir, &["query", "local", "SELECT id, name FROM items WHERE id <= 2 ORDER BY id"]);
    assert_eq!(code, 0, "{stderr}");
    let output = json_of(&stdout);
    assert_eq!(output["columns"], json!(["id", "name"]));
    assert_eq!(output["rows"], json!([[1, "item 1"], [2, "item 2"]]));
    assert_eq!(output["truncated"], json!(false));

    // §8 第 5 条：1000 行默认只回 200，并且说了被截断
    let (code, stdout, _) = run_in(&dir, &["query", "s", "SELECT * FROM items"]);
    let output = json_of(&stdout);
    assert_eq!((code, output["row_count"].as_u64()), (0, Some(200)));
    assert_eq!(output["truncated"], json!(true));
    let (_, stdout, _) = run_in(&dir, &["query", "s", "SELECT * FROM items", "--limit", "5"]);
    assert_eq!(json_of(&stdout)["row_count"].as_u64(), Some(5));
  }

  /// §8 第 1、2 条：写、多条语句、`ATTACH` 新文件都被拒，退出码 3；库里的行数不变，
  /// 目录里没有多出文件
  #[test]
  fn query_refuses_writes_and_escapes() {
    let dir = ConfigDir::with(&[]);
    let db = seeded_sqlite(&dir.0);
    std::fs::write(
      dir.0.join("connections.json"),
      Value::from(vec![file_profile("s", "local", "sqlite", &db, "development")]).to_string(),
    )
    .expect("config");
    let escaped = dir.0.join("escaped.db");
    let attach = format!("ATTACH '{}' AS x", escaped.display());
    let vacuum = format!("VACUUM INTO '{}'", escaped.display());
    for sql in [
      "DELETE FROM items",
      "DROP TABLE items",
      "INSERT INTO items SELECT * FROM items",
      "WITH x AS (SELECT 1) DELETE FROM items",
      "SELECT 1; DELETE FROM items",
      attach.as_str(),
      vacuum.as_str(),
    ] {
      let (code, stdout, stderr) = run_in(&dir, &["query", "local", sql]);
      assert_eq!(code, Exit::Refused as i32, "{sql}: {stdout}{stderr}");
      assert_eq!(json_of(&stderr)["error"]["kind"], "refused", "{sql}");
    }
    assert_eq!(sqlite_count(&db), 1000);
    assert!(!escaped.exists());
  }

  /// §8 第 3、4 条：生产的、没开放的连接，`query` 也报「找不到」，不是「被拒」
  #[test]
  fn query_cannot_reach_hidden_connections() {
    let dir = ConfigDir::with(&[]);
    let db = seeded_sqlite(&dir.0);
    let mut closed = file_profile("c", "closed", "sqlite", &db, "development");
    closed["agent_access"] = json!("off");
    std::fs::write(
      dir.0.join("connections.json"),
      Value::from(vec![file_profile("p", "prod", "sqlite", &db, "production"), closed]).to_string(),
    )
    .expect("config");
    for name in ["prod", "p", "closed", "c", "missing"] {
      let (code, _, stderr) = run_in(&dir, &["query", name, "SELECT 1"]);
      assert_eq!(code, Exit::Usage as i32, "{name}");
      assert_eq!(json_of(&stderr)["error"]["kind"], "not_found", "{name}");
    }
  }

  /// DuckDB 以只读、关掉外部访问的方式打开；读照常
  #[test]
  fn query_reads_duckdb_files() {
    let dir = ConfigDir::with(&[]);
    let file = dir.0.join("warehouse.duckdb");
    {
      let connection = ::duckdb::Connection::open(&file).expect("create duckdb");
      connection
        .execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2);")
        .expect("seed");
    }
    std::fs::write(
      dir.0.join("connections.json"),
      Value::from(vec![file_profile("d", "duck", "duckdb", &file, "testing")]).to_string(),
    )
    .expect("config");
    let (code, stdout, stderr) = run_in(&dir, &["query", "duck", "SELECT sum(x) AS total FROM t"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(json_of(&stdout)["columns"], json!(["total"]));
    let (code, _, _) = run_in(&dir, &["query", "duck", "COPY t TO 'out.csv'"]);
    assert_eq!(code, Exit::Refused as i32);
    let (code, stdout, stderr) = run_in(&dir, &["schema", "duck", "t"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(json_of(&stdout)["columns"][0]["name"], json!("x"), "{stdout}");

    let backup = dir.0.join("warehouse-backup");
    let (code, stdout, stderr) =
      run_in(&dir, &["backup", "duck", "--out", &backup.to_string_lossy()]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(json_of(&stdout)["kind"], json!("duckdb-directory"), "{stdout}");
    assert!(backup.join("schema.sql").exists());
  }

  /// 留痕里有这次调用，但没有语句原文（字面量里可能有个人数据）
  #[test]
  fn query_is_recorded_without_the_statement_text() {
    let dir = ConfigDir::with(&[]);
    let db = seeded_sqlite(&dir.0);
    std::fs::write(
      dir.0.join("connections.json"),
      Value::from(vec![file_profile("s", "local", "sqlite", &db, "development")]).to_string(),
    )
    .expect("config");
    run_in(&dir, &["query", "local", "SELECT * FROM items WHERE name = 'alice@example.com'"]);
    run_in(&dir, &["query", "local", "DELETE FROM items"]);
    let log =
      std::fs::read_to_string(dir.0.join("logs").join(audit::AUDIT_FILE)).unwrap_or_default();
    let lines: Vec<&str> = log.lines().collect();
    assert_eq!(lines.len(), 2, "{log}");
    assert!(lines[0].contains("first=SELECT") && lines[0].contains("result=ok"), "{log}");
    assert!(lines[1].contains("first=DELETE") && lines[1].contains("result=refused"), "{log}");
    assert!(!log.contains("alice@example.com"), "{log}");
  }

  #[test]
  fn typed_values_are_flattened_without_losing_precision() {
    let tagged = |kind: &str, value: &str| Some(json!({ "type": kind, "value": value }));
    assert_eq!(plain(tagged("bigint", "42")), json!(42));
    assert_eq!(plain(tagged("bigint", "-9007199254740991")), json!(-9007199254740991_i64));
    assert_eq!(plain(tagged("bigint", "9007199254740993")), json!("9007199254740993"));
    assert_eq!(plain(tagged("decimal", "1.50")), json!("1.50"));
    assert_eq!(plain(tagged("json", r#"{"a":[1]}"#)), json!({ "a": [1] }));
    assert_eq!(
      plain(Some(json!({ "type": "x", "value": "v", "extra": 1 }))),
      json!({ "type": "x", "value": "v", "extra": 1 })
    );
    assert_eq!(plain(Some(json!("text"))), json!("text"));
    assert_eq!(plain(None), Value::Null);
  }

  #[test]
  fn schema_lists_objects_and_describes_a_table() {
    let dir = ConfigDir::with(&[]);
    let db = seeded_sqlite(&dir.0);
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    runtime.block_on(async {
      let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}", db.display())).await.expect("open");
      sqlx::raw_sql(
        "CREATE TABLE orders (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), note TEXT);
         CREATE INDEX orders_item ON orders(item_id);
         CREATE VIEW recent AS SELECT * FROM orders;",
      )
      .execute(&pool)
      .await
      .expect("schema");
      pool.close().await;
    });
    std::fs::write(
      dir.0.join("connections.json"),
      Value::from(vec![file_profile("s", "local", "sqlite", &db, "development")]).to_string(),
    )
    .expect("config");

    let (code, stdout, stderr) = run_in(&dir, &["schema", "local"]);
    assert_eq!(code, 0, "{stderr}");
    let objects = json_of(&stdout)["objects"].clone();
    assert_eq!(
      objects,
      json!([
        { "schema": null, "name": "items", "kind": "table" },
        { "schema": null, "name": "orders", "kind": "table" },
        { "schema": null, "name": "recent", "kind": "view" },
      ])
    );

    let (code, stdout, stderr) = run_in(&dir, &["schema", "local", "orders"]);
    assert_eq!(code, 0, "{stderr}");
    let table = json_of(&stdout);
    let columns: Vec<(Value, bool, bool)> = table["columns"]
      .as_array()
      .map(|columns| {
        columns
          .iter()
          .map(|column| {
            (
              column["name"].clone(),
              column["nullable"].as_bool().unwrap_or(true),
              column["primary_key"].as_bool().unwrap_or(false),
            )
          })
          .collect()
      })
      .unwrap_or_default();
    assert_eq!(
      columns,
      vec![
        (json!("id"), true, true),
        (json!("item_id"), false, false),
        (json!("note"), true, false)
      ]
    );
    assert_eq!(table["foreign_keys"][0]["referenced_table"], json!("items"), "{stdout}");
    assert!(stdout.contains("orders_item"), "{stdout}");

    let (code, _, stderr) = run_in(&dir, &["schema", "local", "missing"]);
    assert_eq!(
      (code, json_of(&stderr)["error"]["kind"].clone()),
      (Exit::Usage as i32, json!("not_found"))
    );
  }

  /// 只取计划不执行：SQLite 给的是「按主键查」这一步；写语句照样被语句门拒掉，不会被包进 EXPLAIN
  #[test]
  fn explain_returns_the_plan_without_running_the_statement() {
    let dir = ConfigDir::with(&[]);
    let db = seeded_sqlite(&dir.0);
    std::fs::write(
      dir.0.join("connections.json"),
      Value::from(vec![file_profile("s", "local", "sqlite", &db, "development")]).to_string(),
    )
    .expect("config");

    let (code, stdout, stderr) =
      run_in(&dir, &["explain", "local", "SELECT name FROM items WHERE id = 3"]);
    assert_eq!(code, 0, "{stderr}");
    let output = json_of(&stdout);
    assert_eq!(output["plan"]["analyzed"], json!(false));
    let operation = output["plan"]["roots"][0]["operation"].as_str().unwrap_or_default();
    assert!(operation.contains("items"), "{stdout}");

    for sql in ["DELETE FROM items", "EXPLAIN ANALYZE SELECT 1", "SELECT 1; DELETE FROM items"] {
      let (code, _, stderr) = run_in(&dir, &["explain", "local", sql]);
      assert_eq!(code, Exit::Refused as i32, "{sql}: {stderr}");
    }
    assert_eq!(sqlite_count(&db), 1000);
  }

  /// 整库一次拿到：每张表一节，外键两头都写上；输出是 Markdown 不是 JSON
  #[test]
  fn dictionary_describes_every_table_and_its_foreign_keys() {
    let dir = ConfigDir::with(&[]);
    let db = seeded_sqlite(&dir.0);
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    runtime.block_on(async {
      let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}", db.display())).await.expect("open");
      sqlx::raw_sql("CREATE TABLE orders (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id))")
        .execute(&pool)
        .await
        .expect("orders");
      pool.close().await;
    });
    std::fs::write(
      dir.0.join("connections.json"),
      Value::from(vec![file_profile("s", "local", "sqlite", &db, "development")]).to_string(),
    )
    .expect("config");

    let (code, stdout, stderr) = run_in(&dir, &["dictionary", "local"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
      stdout.starts_with("# local\n\nSQLite · tables: 2 · foreign-key links: 1 · "),
      "{stdout}"
    );
    assert!(stdout.contains("## items\n"), "{stdout}");
    assert!(stdout.contains("| `id` | INTEGER | no | ✓ |  |"), "{stdout}");
    assert!(stdout.contains("| `item_id` | INTEGER | no |  | `items.id` |"), "{stdout}");
    assert!(stdout.contains("Referenced by: `orders.item_id`"), "{stdout}");

    assert_eq!(run_in(&dir, &["dictionary"]).0, Exit::Usage as i32);
    assert_eq!(run_in(&dir, &["dictionary", "nope"]).0, Exit::Usage as i32);
  }

  /// 连得上就是 `ok`；文件不在就是「连不上」，原因在报错里
  #[test]
  fn test_opens_the_connection_read_only() {
    let dir = ConfigDir::with(&[]);
    let db = seeded_sqlite(&dir.0);
    let missing = dir.0.join("missing.db");
    std::fs::write(
      dir.0.join("connections.json"),
      Value::from(vec![
        file_profile("s", "local", "sqlite", &db, "development"),
        file_profile("m", "gone", "sqlite", &missing, "development"),
      ])
      .to_string(),
    )
    .expect("config");

    let (code, stdout, stderr) = run_in(&dir, &["test", "local"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(json_of(&stdout)["ok"], json!(true));

    let (code, _, stderr) = run_in(&dir, &["test", "gone"]);
    assert_eq!(code, Exit::Unavailable as i32, "{stderr}");
    assert_eq!(json_of(&stderr)["error"]["kind"], "connect");
    assert!(!missing.exists(), "testing must not create the database file");
  }

  /// 网络库连不上时附上诊断：断在哪一段，Agent 才知道下一步是改地址还是去看服务
  #[test]
  fn a_failed_test_says_where_it_broke() {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
      .and_then(|listener| listener.local_addr())
      .map(|address| address.port())
      .expect("a free port");
    let mut closed = profile("p", "down", "development", "read");
    closed["host"] = json!("127.0.0.1");
    closed["port"] = json!(port);
    let dir = ConfigDir::with(&[closed]);

    let (code, _, stderr) = run_in(&dir, &["test", "down"]);
    assert_eq!(code, Exit::Unavailable as i32, "{stderr}");
    let error = &json_of(&stderr)["error"];
    let steps: Vec<(Value, Value)> = error["diagnosis"]
      .as_array()
      .map(|steps| steps.iter().map(|step| (step["name"].clone(), step["ok"].clone())).collect())
      .unwrap_or_default();
    assert_eq!(
      steps,
      vec![(json!("resolve"), json!(true)), (json!("tcp"), json!(false))],
      "{stderr}"
    );

    // 库没起来是「连不上」（4），不是语句超时（1）：Agent 据此决定是重试还是换语句
    let (code, _, stderr) = run_in(&dir, &["query", "down", "SELECT 1"]);
    assert_eq!(code, Exit::Unavailable as i32, "{stderr}");
    assert_eq!(json_of(&stderr)["error"]["kind"], "connect");

    // 备份交给 pg_dump：它在就报它自己的错，不在就说缺工具；两种都不留文件
    let out = std::env::temp_dir().join(format!("dataomni-cli-backup-{port}.dump"));
    let (code, _, stderr) = run_in(&dir, &["backup", "down", "--out", &out.to_string_lossy()]);
    let expected = match crate::services::backup::find_tool("pg_dump") {
      Some(_) => (Exit::Database as i32, "backup"),
      None => (Exit::Unavailable as i32, "tool"),
    };
    assert_eq!(
      (code, json_of(&stderr)["error"]["kind"].as_str().unwrap_or_default()),
      expected,
      "{stderr}"
    );
    assert!(!out.exists());
  }

  /// Mongo 连接走 `mongo`：SQL 命令指过去；`mongo` 用在别的连接上是参数错；连不上是 4
  #[test]
  fn mongo_connections_take_the_mongo_command() {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
      .and_then(|listener| listener.local_addr())
      .map(|address| address.port())
      .expect("a free port");
    let mut mongo = profile("m", "docs", "development", "read");
    mongo["db_type"] = json!("mongodb");
    mongo["host"] = json!("127.0.0.1");
    mongo["port"] = json!(port);
    mongo["username"] = json!("");
    let dir = ConfigDir::with(&[mongo, profile("p", "sql", "development", "read")]);

    let (code, _, stderr) = run_in(&dir, &["query", "docs", "SELECT 1"]);
    assert_eq!(code, Exit::Refused as i32, "{stderr}");
    assert!(stderr.contains("dataomni cli mongo"), "{stderr}");
    let (code, _, stderr) = run_in(&dir, &["mongo", "sql", "collections"]);
    assert_eq!(code, Exit::Usage as i32, "{stderr}");
    let (code, _, stderr) =
      run_in(&dir, &["mongo", "docs", "aggregate", "db.c", "[{ $out: 'x' }]"]);
    assert_eq!(code, Exit::Refused as i32, "{stderr}");

    let (code, _, stderr) = run_in(&dir, &["mongo", "docs", "collections"]);
    assert_eq!(code, Exit::Unavailable as i32, "{stderr}");
    assert_eq!(json_of(&stderr)["error"]["kind"], "connect");
  }

  /// 分隔符是嗅探出来的（要求开头几行字段数一致）；字段数不对的行单独列出；文件不在是参数错
  #[test]
  fn csv_preview_sniffs_the_delimiter_and_lists_ragged_rows() {
    let dir = ConfigDir::with(&[]);
    let file = dir.0.join("people.csv");
    std::fs::write(&file, "id;name\n1;ada\n2;bob\n3;cy\n").expect("csv");
    let path = file.to_string_lossy().into_owned();
    let (code, stdout, stderr) = run_in(&dir, &["csv-preview", &path]);
    assert_eq!(code, 0, "{stderr}");
    let output = json_of(&stdout);
    assert_eq!(output["delimiter"], json!(";"), "{stdout}");
    assert_eq!(output["headers"], json!(["id", "name"]));
    assert_eq!(output["rows"].as_array().map(Vec::len), Some(3));

    let (code, stdout, _) = run_in(&dir, &["csv-preview", &path, "--no-header", "--rows", "1"]);
    assert_eq!(code, 0);
    assert_eq!(json_of(&stdout)["rows"], json!([["id", "name"]]));

    let ragged = dir.0.join("ragged.csv");
    std::fs::write(&ragged, "id;name\n1;ada\n2;bob;extra\n").expect("csv");
    let ragged = ragged.to_string_lossy().into_owned();
    let (code, stdout, _) = run_in(&dir, &["csv-preview", &ragged, "--delimiter", ";"]);
    assert_eq!(code, 0);
    assert_eq!(json_of(&stdout)["ragged"][0]["fields"], json!(3), "{stdout}");

    let missing = dir.0.join("missing.csv").to_string_lossy().into_owned();
    assert_eq!(run_in(&dir, &["csv-preview", &missing]).0, Exit::Usage as i32);
    assert_eq!(run_in(&dir, &["csv-preview", &path, "--delimiter", "ab"]).0, Exit::Usage as i32);
  }

  /// 整份结果写进新文件，字节与界面导出相同；写语句被拒、不留文件；已有的文件不覆盖
  #[test]
  fn export_writes_every_row_to_a_new_file() {
    let dir = ConfigDir::with(&[]);
    let db = seeded_sqlite(&dir.0);
    std::fs::write(
      dir.0.join("connections.json"),
      Value::from(vec![file_profile("s", "local", "sqlite", &db, "development")]).to_string(),
    )
    .expect("config");
    let csv = dir.0.join("items.csv");
    let csv_path = csv.to_string_lossy().into_owned();
    let (code, stdout, stderr) = run_in(
      &dir,
      &["export", "local", "SELECT id, name FROM items ORDER BY id", "--out", &csv_path],
    );
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(json_of(&stdout)["rows"], json!(1000), "{stdout}");
    let written = std::fs::read_to_string(&csv).unwrap_or_default();
    assert!(written.starts_with("id,name\n1,item 1\n2,item 2\n"), "{written:.40}");
    assert_eq!(written.lines().count(), 1001);

    let json_path = dir.0.join("items.json").to_string_lossy().into_owned();
    let (code, _, stderr) = run_in(
      &dir,
      &[
        "export",
        "local",
        "SELECT id FROM items WHERE id <= 2",
        "--out",
        &json_path,
        "--format",
        "json",
      ],
    );
    assert_eq!(code, 0, "{stderr}");
    let rows: Value =
      serde_json::from_str(&std::fs::read_to_string(&json_path).unwrap_or_default())
        .unwrap_or_default();
    // 64 位整数写成字符串，同界面导出（`export_writer::json_field`：JSON 的数到了消费方是双精度）
    assert_eq!(rows, json!([{ "id": "1" }, { "id": "2" }]));

    let refused = dir.0.join("refused.csv");
    let refused_path = refused.to_string_lossy().into_owned();
    let (code, _, _) =
      run_in(&dir, &["export", "local", "DELETE FROM items", "--out", &refused_path]);
    assert_eq!(code, Exit::Refused as i32);
    assert!(!refused.exists());
    assert_eq!(sqlite_count(&db), 1000);
    let (code, _, stderr) = run_in(&dir, &["export", "local", "SELECT 1", "--out", &csv_path]);
    assert_eq!(code, Exit::Usage as i32, "{stderr}");
    assert!(stderr.contains("already exists"), "{stderr}");
    for bad in [
      &["export", "local", "SELECT 1"][..],
      &["export", "local", "SELECT 1", "--out", "x", "--format", "sql"],
    ] {
      assert_eq!(run_in(&dir, bad).0, Exit::Usage as i32, "{bad:?}");
    }
  }

  /// 数据库自己的原文：SQLite 连着索引一起给；不存在的表是「找不到」
  #[test]
  fn ddl_gives_the_definition_the_database_keeps() {
    let dir = ConfigDir::with(&[]);
    let db = seeded_sqlite(&dir.0);
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    runtime.block_on(async {
      let pool =
        sqlx::SqlitePool::connect(&format!("sqlite:{}", db.display())).await.expect("open");
      sqlx::raw_sql("CREATE INDEX items_name ON items(name)").execute(&pool).await.expect("index");
      pool.close().await;
    });
    std::fs::write(
      dir.0.join("connections.json"),
      Value::from(vec![file_profile("s", "local", "sqlite", &db, "development")]).to_string(),
    )
    .expect("config");
    let (code, stdout, stderr) = run_in(&dir, &["ddl", "local", "items"]);
    assert_eq!(code, 0, "{stderr}");
    let ddl = json_of(&stdout)["ddl"].as_str().unwrap_or_default().to_string();
    assert!(ddl.starts_with("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);"), "{ddl}");
    assert!(ddl.ends_with("CREATE INDEX items_name ON items(name);"), "{ddl}");
    let (code, _, stderr) = run_in(&dir, &["ddl", "local", "nope"]);
    assert_eq!(code, Exit::Usage as i32);
    assert_eq!(json_of(&stderr)["error"]["kind"], "not_found");
    assert_eq!(run_in(&dir, &["ddl", "local"]).0, Exit::Usage as i32);
  }

  /// SQLite 的备份在只读打开的库上做（`VACUUM INTO`），得到一份能直接打开的库；不覆盖已有的
  #[test]
  fn backup_copies_a_sqlite_database_without_writing_to_it() {
    let dir = ConfigDir::with(&[]);
    let db = seeded_sqlite(&dir.0);
    std::fs::write(
      dir.0.join("connections.json"),
      Value::from(vec![file_profile("s", "local", "sqlite", &db, "development")]).to_string(),
    )
    .expect("config");
    let before = std::fs::read(&db).unwrap_or_default();
    let copy = dir.0.join("copy.db");
    let copy_path = copy.to_string_lossy().into_owned();
    let (code, stdout, stderr) = run_in(&dir, &["backup", "local", "--out", &copy_path]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(json_of(&stdout)["kind"], json!("sqlite-file"), "{stdout}");
    assert_eq!(sqlite_count(&copy), 1000);
    assert_eq!(std::fs::read(&db).unwrap_or_default(), before, "the source is untouched");

    let (code, _, stderr) = run_in(&dir, &["backup", "local", "--out", &copy_path]);
    assert_eq!(code, Exit::Usage as i32);
    assert!(stderr.contains("already exists"), "{stderr}");
    let other = dir.0.join("other.db").to_string_lossy().into_owned();
    for bad in [&["backup", "local"][..], &["backup", "local", "--out", &other, "--database", "x"]]
    {
      assert_eq!(run_in(&dir, bad).0, Exit::Usage as i32, "{bad:?}");
    }
  }

  #[test]
  fn query_arguments_are_checked() {
    let dir = ConfigDir::with(&[]);
    for args in [
      &["query"][..],
      &["query", "x"],
      &["query", "x", "SELECT 1", "extra"],
      &["query", "x", "SELECT 1", "--limit", "0"],
      &["query", "x", "SELECT 1", "--limit", "10001"],
      &["query", "x", "SELECT 1", "--timeout"],
      &["schema"],
      &["schema", "x", "t", "extra"],
      &["schema", "x", "--schema", "public"],
      &["explain"],
      &["explain", "x"],
      &["explain", "x", "SELECT 1", "--limit", "5"],
      &["test"],
      &["dictionary", "x", "y"],
      &["test", "x", "extra"],
    ] {
      assert_eq!(run_in(&dir, args).0, Exit::Usage as i32, "{args:?}");
    }
  }

  /// 没有配置文件（从没打开过应用）就是一个连接都没有，不是错误
  #[test]
  fn a_missing_config_lists_nothing() {
    let dir = ConfigDir::with(&[]);
    let _ = std::fs::remove_file(dir.0.join("connections.json"));
    let (code, stdout, _) = run_in(&dir, &["connections"]);
    assert_eq!((code, names(&stdout).len()), (0, 0));
  }
}
