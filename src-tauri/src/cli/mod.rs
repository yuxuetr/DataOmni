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
mod session;

use crate::models::ConnectionProfile;
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
}

impl CliError {
  fn usage(message: impl Into<String>) -> Self {
    Self { exit: Exit::Usage, kind: "usage", message: message.into() }
  }

  fn unavailable(kind: &'static str, message: impl Into<String>) -> Self {
    Self { exit: Exit::Unavailable, kind, message: message.into() }
  }

  fn refused(message: impl Into<String>) -> Self {
    Self { exit: Exit::Refused, kind: "refused", message: message.into() }
  }

  /// 没开放的、生产的、不存在的连接都是这一句：不让调用方分辨出「有，但不给你」
  fn not_found(name: &str) -> Self {
    Self {
      exit: Exit::Usage,
      kind: "not_found",
      message: format!("no connection named {name} is open to the command line"),
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
  version            Print the DataOmni version
  help               Print this help

Output is JSON on stdout; errors are JSON on stderr.
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
      let body = json!({
        "schema": OUTPUT_SCHEMA,
        "error": { "kind": error.kind, "message": error.message },
      });
      let _ = writeln!(err, "{body}");
      error.exit as i32
    }
  }
}

enum Output {
  Json(Value),
  Text(&'static str),
}

fn dispatch(args: &[String], dirs: &Dirs) -> Result<Output, CliError> {
  let config_dir = dirs.config.as_deref();
  let Some((command, rest)) = args.split_first() else {
    return Ok(Output::Text(HELP));
  };
  match command.as_str() {
    "help" | "--help" | "-h" => Ok(Output::Text(HELP)),
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
    other => Err(CliError::usage(format!("unknown command {other}; run `dataomni cli help`"))),
  }
}

struct QueryArguments {
  connection: String,
  sql: String,
  row_limit: usize,
  timeout: Duration,
}

fn parse_query_arguments(rest: &[String]) -> Result<QueryArguments, CliError> {
  let mut positional = Vec::new();
  let mut row_limit = DEFAULT_ROW_LIMIT;
  let mut timeout_seconds = DEFAULT_TIMEOUT_SECONDS;
  let mut iter = rest.iter();
  while let Some(argument) = iter.next() {
    match argument.as_str() {
      "--limit" => {
        row_limit = number_after("--limit", iter.next(), 1, MAX_ROW_LIMIT as u64)? as usize
      }
      "--timeout" => {
        timeout_seconds = number_after("--timeout", iter.next(), 1, MAX_TIMEOUT_SECONDS)?
      }
      _ => positional.push(argument.clone()),
    }
  }
  let [connection, sql] = <[String; 2]>::try_from(positional).map_err(|_| {
    CliError::usage("usage: dataomni cli query <connection> <sql> [--limit N] [--timeout SECONDS]")
  })?;
  let sql = if sql == "-" {
    let mut text = String::new();
    std::io::stdin()
      .read_to_string(&mut text)
      .map_err(|error| CliError::usage(format!("cannot read the statement from stdin: {error}")))?;
    text
  } else {
    sql
  };
  Ok(QueryArguments { connection, sql, row_limit, timeout: Duration::from_secs(timeout_seconds) })
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
  let arguments = parse_query_arguments(rest)?;
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

  let runtime = tokio::runtime::Builder::new_multi_thread()
    .enable_all()
    .build()
    .map_err(|error| CliError::unavailable("runtime", error.to_string()))?;
  let run = session::run_read_only(&resolved, &arguments.sql, arguments.row_limit, config_dir);
  match runtime.block_on(async { tokio::time::timeout(arguments.timeout, run).await }) {
    Err(_) => Err(CliError {
      exit: Exit::Database,
      kind: "timeout",
      message: format!("the statement did not finish within {} s", arguments.timeout.as_secs()),
    }),
    Ok(result) => result.map_err(session_error),
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
  let runtime = tokio::runtime::Builder::new_multi_thread()
    .enable_all()
    .build()
    .map_err(|error| CliError::unavailable("runtime", error.to_string()))?;
  let timeout = Duration::from_secs(DEFAULT_TIMEOUT_SECONDS);
  let work = async {
    let opened = session::open(&resolved, config_dir).await.map_err(session_error)?;
    let result = match &arguments.table {
      None => list_objects(&opened, &resolved).await,
      Some(table) => describe_table(&opened, &resolved, table, arguments.schema.as_deref()).await,
    };
    opened.close().await;
    result
  };
  let body =
    runtime.block_on(async { tokio::time::timeout(timeout, work).await }).map_err(|_| {
      CliError {
        exit: Exit::Database,
        kind: "timeout",
        message: format!("the catalog did not answer within {} s", timeout.as_secs()),
      }
    })??;
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
    session::Failure::Database(error) => {
      CliError { exit: Exit::Database, kind: "database", message: error.to_string() }
    }
  }
}

fn unsupported(db_type: &crate::models::DatabaseType) -> CliError {
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
  ConnectionService::open_read_only(config_dir)
    .map_err(|error| CliError::unavailable("config", error.to_string()))
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
