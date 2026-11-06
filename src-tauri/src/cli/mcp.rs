//! `dataomni mcp`：stdio 上的 MCP 服务（`rfcs/mcp-server.md`）。
//!
//! 这一层**不碰权限**：每个工具调用拼成命令行的参数，交给同一个 `dispatch`，结果原样包进
//! MCP 的回包。权限门（开放凭证、生产不可见、语句白名单、只读事务、留痕）只有命令行那一份。
//!
//! 协议手写（§3.2）：用到的只有 `initialize`、`ping`、`tools/list`、`tools/call` 和通知。
//! 每行一条 JSON-RPC 消息，按顺序一条一条处理。

use super::{dispatch, error_body, CliError, Dirs, Output};
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};

/// 认得的协议版本，新的在前。客户端要的版本在这里就照回，否则回第一个，由客户端决定还连不连。
/// 这几版之间我们用到的部分（工具、文本内容、`isError`）没有变化
const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

/// 给 Agent 的说明，放进 `initialize` 的 `instructions`。不直接用 `guide.md`：那份写的是命令行
/// 的调用方式，还提到 MCP 不给的 `export`、`backup` 与从标准输入读
const INSTRUCTIONS: &str = "\
DataOmni reads the databases the user configured in the DataOmni desktop app. It never writes to them.

Only connections the user set to \"Command line & agent access: read-only\" in DataOmni are visible; \
production connections never are. When a tool says a connection is not found, ask the user to open \
it in DataOmni instead of looking for another way in. Credentials come from the user's keychain: \
never ask for a password.

How to work: call `connections` first and use a name or id from it. Read the structure before \
writing SQL (`dictionary` for the whole database, `schema` for tables or one table, `ddl` for the \
database's own definition). `query` runs one read-only statement, 200 rows by default \
(`truncated: true` means there were more); prefer aggregating in SQL. `explain` shows the plan \
without running the statement. MongoDB, Redis, Neo4j and Elasticsearch connections take the \
`mongo`, `redis`, `neo4j` and `es` tools instead of SQL.

Errors come back as tool errors whose text is JSON with error.kind: `refused` means the access \
rules do not allow it (write statements, several statements, write endpoints) and rewording will \
not help; `not_found` means the connection is not open to agents; `usage` means an argument is \
wrong; `database` is the database's own error; `connect`, `credentials` and `timeout` mean it \
could not be reached.";

/// 一直读到标准输入结束。返回进程退出码
pub(super) fn serve(input: &mut dyn BufRead, out: &mut dyn Write, dirs: &Dirs) -> i32 {
  let mut line = Vec::new();
  loop {
    line.clear();
    match input.read_until(b'\n', &mut line) {
      Ok(0) => return 0,
      Ok(_) => {}
      Err(_) => return 1,
    }
    let reply = match std::str::from_utf8(&line) {
      Ok(text) if text.trim().is_empty() => continue,
      Ok(text) => handle(text, dirs),
      Err(_) => Some(error_reply(Value::Null, PARSE_ERROR, "the message is not UTF-8")),
    };
    if let Some(reply) = reply {
      // 写不出去说明客户端走了，没有别人可回
      if writeln!(out, "{reply}").and_then(|()| out.flush()).is_err() {
        return 1;
      }
    }
  }
}

/// 一条消息的回包；通知（没有 `id`）和客户端发来的回包不回
fn handle(text: &str, dirs: &Dirs) -> Option<Value> {
  let message: Value = match serde_json::from_str(text) {
    Ok(message) => message,
    Err(error) => return Some(error_reply(Value::Null, PARSE_ERROR, &error.to_string())),
  };
  let Value::Object(message) = message else {
    return Some(error_reply(
      Value::Null,
      INVALID_REQUEST,
      "expected one JSON-RPC object per line",
    ));
  };
  let id = message.get("id").cloned();
  let Some(method) = message.get("method").and_then(Value::as_str) else {
    // 带 result / error 的是客户端对我们的回包，我们从不发请求，不理
    if message.contains_key("result") || message.contains_key("error") {
      return None;
    }
    return Some(error_reply(id.unwrap_or(Value::Null), INVALID_REQUEST, "no method"));
  };
  let id = id?;
  let params = message.get("params").cloned().unwrap_or(Value::Null);
  let result = match method {
    "initialize" => Ok(initialize(&params)),
    "ping" => Ok(json!({})),
    "tools/list" => Ok(json!({ "tools": tools() })),
    "tools/call" => call(&params, dirs),
    other => Err((METHOD_NOT_FOUND, format!("method not found: {other}"))),
  };
  Some(match result {
    Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
    Err((code, message)) => error_reply(id, code, &message),
  })
}

fn error_reply(id: Value, code: i64, message: &str) -> Value {
  json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn initialize(params: &Value) -> Value {
  let asked = params.get("protocolVersion").and_then(Value::as_str);
  let version = PROTOCOL_VERSIONS.iter().find(|version| Some(**version) == asked);
  json!({
    "protocolVersion": version.unwrap_or(&PROTOCOL_VERSIONS[0]),
    "capabilities": { "tools": { "listChanged": false } },
    "serverInfo": { "name": "dataomni", "version": env!("CARGO_PKG_VERSION") },
    "instructions": INSTRUCTIONS,
  })
}

/// 工具自己的错误（参数不对、被拒、库报错）放进结果的 `isError`，好让模型看到并改正；
/// 只有不认得的工具算协议错误
fn call(params: &Value, dirs: &Dirs) -> Result<Value, (i64, String)> {
  let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
  if !TOOLS.iter().any(|tool| tool.name == name) {
    return Err((INVALID_PARAMS, format!("unknown tool: {name}")));
  }
  let empty = Map::new();
  let outcome = match params.get("arguments") {
    None | Some(Value::Null) => arguments_for(name, &empty),
    Some(Value::Object(arguments)) => arguments_for(name, arguments),
    Some(_) => Err(CliError::usage("arguments must be an object")),
  }
  .and_then(|args| dispatch(&args, dirs));
  Ok(match outcome {
    Ok(Output::Json(value)) => tool_result(value.to_string(), false),
    Ok(Output::Text(text)) => tool_result(text, false),
    Err(error) => tool_result(error_body(&error).to_string(), true),
  })
}

fn tool_result(text: String, is_error: bool) -> Value {
  json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

struct Tool {
  name: &'static str,
  description: &'static str,
}

/// 只读的命令一个对一个。`export`、`backup`、`csv-preview` 不在这里：它们会在用户磁盘上写新文件
/// 或读任意本机文件，不能跑 shell 的 Agent 原本碰不到（§3.3）
const TOOLS: &[Tool] = &[
  Tool {
    name: "connections",
    description: "List the connections the user opened to agents in DataOmni: id, name, type, environment, host, database. Connections that are open but unusable (for example no saved password) are listed under `unavailable` with the reason.",
  },
  Tool {
    name: "test",
    description: "Connect the way `query` does and run nothing. When a network connection fails, error.diagnosis says whether the name resolved and the port answered.",
  },
  Tool {
    name: "query",
    description: "Run one read-only SQL statement (SELECT, WITH, SHOW, ...) in a read-only transaction that is rolled back. Write statements and several statements at once are refused. Returns columns and rows; at most `limit` rows (200 by default).",
  },
  Tool {
    name: "explain",
    description: "The execution plan of one read-only SQL statement, as a tree (plan.roots) plus the database's own text (plan.raw). Never ANALYZE: the statement itself does not run.",
  },
  Tool {
    name: "schema",
    description: "Without `table`: the tables and views. With `table`: its columns, indexes (one row per index column) and foreign keys.",
  },
  Tool {
    name: "ddl",
    description: "The definition the database itself keeps for a table or view (SHOW CREATE TABLE, sqlite_master, DBMS_METADATA, ...). PostgreSQL has it for views only; use `schema` for its tables.",
  },
  Tool {
    name: "dictionary",
    description: "A Markdown data dictionary of the whole database: every table's columns, types, nullability, primary and foreign keys. Read it before writing SQL.",
  },
  Tool {
    name: "mongo",
    description: "MongoDB, read only. `collections`; or `find`, `count`, `aggregate`, `explain`, `structure` on `namespace` (database.collection). Filters, sorts and pipelines are mongosh syntax or JSON. Pipelines with $out or $merge are refused. Documents come back as relaxed Extended JSON.",
  },
  Tool {
    name: "redis",
    description: "Redis, read only. `keyspaces`; `scan` keys matching `pattern`; `get` one key's value; or `command`, which runs only commands the server itself flags readonly (asked with COMMAND INFO).",
  },
  Tool {
    name: "neo4j",
    description: "Neo4j, read only. `labels` lists labels and relationship types; `run` runs one Cypher query only if the server classifies it as a read, then in a read-mode transaction.",
  },
  Tool {
    name: "es",
    description: "Elasticsearch / OpenSearch, read only. `indices` lists indices, aliases and data streams; `request` sends one REST request: GET and HEAD pass (except _refresh, _flush, _forcemerge, _cache), POST only to search endpoints (_search, _count, _msearch, _mget, ...), PUT and DELETE never.",
  },
];

fn tools() -> Vec<Value> {
  TOOLS
    .iter()
    .map(|tool| {
      json!({
        "name": tool.name,
        "description": tool.description,
        "inputSchema": input_schema(tool.name),
        "annotations": { "readOnlyHint": true },
      })
    })
    .collect()
}

fn string(description: &str) -> Value {
  json!({ "type": "string", "description": description })
}

fn integer(description: &str, minimum: u64, maximum: u64) -> Value {
  json!({ "type": "integer", "description": description, "minimum": minimum, "maximum": maximum })
}

/// mongosh 写法的文字，或者直接给 JSON
fn document(description: &str) -> Value {
  json!({ "type": ["string", "object", "array"], "description": description })
}

fn object(properties: Value, required: &[&str]) -> Value {
  json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false })
}

fn input_schema(name: &str) -> Value {
  let connection = string("A connection name or id from `connections`");
  let timeout = integer("Seconds before giving up (30 by default)", 1, super::MAX_TIMEOUT_SECONDS);
  let limit = |default: &str| {
    integer(
      &format!("At most this many rows ({default} by default)"),
      1,
      super::MAX_ROW_LIMIT as u64,
    )
  };
  match name {
    "test" | "dictionary" => object(json!({ "connection": connection }), &["connection"]),
    "query" => object(
      json!({
        "connection": connection,
        "sql": string("One read-only statement"),
        "limit": limit("200"),
        "timeout_seconds": timeout,
      }),
      &["connection", "sql"],
    ),
    "explain" => object(
      json!({ "connection": connection, "sql": string("One read-only statement"), "timeout_seconds": timeout }),
      &["connection", "sql"],
    ),
    "schema" => object(
      json!({
        "connection": connection,
        "table": string("A table or view; leave out to list them all"),
        "schema": string("The schema the table is in, when it is not the default one"),
      }),
      &["connection"],
    ),
    "ddl" => object(
      json!({
        "connection": connection,
        "table": string("A table or view"),
        "schema": string("The schema the table is in, when it is not the default one"),
      }),
      &["connection", "table"],
    ),
    "mongo" => object(
      json!({
        "connection": connection,
        "action": { "type": "string", "enum": ["collections", "find", "count", "aggregate", "explain", "structure"] },
        "namespace": string("database.collection; every action but collections takes it"),
        "filter": document("find, count, explain: the filter"),
        "sort": document("find, explain: the sort"),
        "skip": integer("find: documents to skip", 0, i64::MAX as u64),
        "limit": limit("200"),
        "pipeline": document("aggregate: the pipeline (required); explain: explain this pipeline instead of a find"),
        "timeout_seconds": timeout,
      }),
      &["connection", "action"],
    ),
    "redis" => object(
      json!({
        "connection": connection,
        "action": { "type": "string", "enum": ["keyspaces", "scan", "get", "command"] },
        "db": integer("The logical database", 0, 65_535),
        "pattern": string("scan: a glob pattern (* by default)"),
        "type": string("scan: only keys of this type"),
        "cursor": string("scan: the cursor from the previous page"),
        "key": string("get: the key"),
        "position": string("get: where to continue in a large value, from the previous page"),
        "limit": limit("200"),
        "command": {
          "type": "array", "items": { "type": "string" }, "minItems": 1,
          "description": "command: the command name and its arguments, for example [\"HGETALL\", \"user:1\"]",
        },
        "timeout_seconds": timeout,
      }),
      &["connection", "action"],
    ),
    "neo4j" => object(
      json!({
        "connection": connection,
        "action": { "type": "string", "enum": ["labels", "run"] },
        "cypher": string("run: one read-only Cypher query"),
        "limit": limit("200"),
        "database": string("The database, when it is not the default one"),
        "timeout_seconds": timeout,
      }),
      &["connection", "action"],
    ),
    "es" => object(
      json!({
        "connection": connection,
        "action": { "type": "string", "enum": ["indices", "request"] },
        "method": string("request: GET, HEAD or POST"),
        "path": string("request: the path, starting with /"),
        "body": document("request: the body, as JSON or text"),
        "timeout_seconds": timeout,
      }),
      &["connection", "action"],
    ),
    _ => object(json!({}), &[]),
  }
}

/// 工具入参 → 命令行参数。读完还有没认的键就报错，同命令行「给了不认的选项就报错」
fn arguments_for(name: &str, arguments: &Map<String, Value>) -> Result<Vec<String>, CliError> {
  let mut input = Input { map: arguments, seen: Vec::new() };
  let mut args = vec![name.to_string()];
  match name {
    "connections" => {}
    "test" | "dictionary" => args.push(input.positional("connection")?),
    "query" | "explain" => {
      args.push(input.positional("connection")?);
      args.push(input.positional("sql")?);
      if name == "query" {
        input.flag(&mut args, "limit", "--limit")?;
      }
      input.flag(&mut args, "timeout_seconds", "--timeout")?;
    }
    "schema" => {
      args.push(input.positional("connection")?);
      if let Some(table) = input.optional_positional("table")? {
        args.push(table);
      }
      input.flag(&mut args, "schema", "--schema")?;
    }
    "ddl" => {
      args.push(input.positional("connection")?);
      args.push(input.positional("table")?);
      input.flag(&mut args, "schema", "--schema")?;
    }
    "mongo" => mongo_arguments(&mut input, &mut args)?,
    "redis" => {
      args.push(input.positional("connection")?);
      // 选项放在操作前面：`command` 之后的一律原样交给服务器
      input.flag(&mut args, "db", "--db")?;
      input.flag(&mut args, "timeout_seconds", "--timeout")?;
      input.flag(&mut args, "type", "--type")?;
      input.flag(&mut args, "cursor", "--cursor")?;
      input.flag(&mut args, "position", "--position")?;
      input.flag(&mut args, "limit", "--limit")?;
      let action = input.positional("action")?;
      args.push(action.clone());
      match action.as_str() {
        "scan" => args.extend(input.optional_positional("pattern")?),
        "get" => args.push(input.positional("key")?),
        "command" => args.extend(input.raw_list("command")?),
        _ => {}
      }
    }
    "neo4j" => {
      args.push(input.positional("connection")?);
      let action = input.positional("action")?;
      args.push(action.clone());
      if action == "run" {
        args.push(input.positional("cypher")?);
      }
      input.flag(&mut args, "limit", "--limit")?;
      input.flag(&mut args, "database", "--db")?;
      input.flag(&mut args, "timeout_seconds", "--timeout")?;
    }
    "es" => {
      args.push(input.positional("connection")?);
      let action = input.positional("action")?;
      args.push(action.clone());
      if action == "request" {
        args.push(input.positional("method")?);
        args.push(input.positional("path")?);
        args.extend(input.optional_positional("body")?);
      }
      input.flag(&mut args, "timeout_seconds", "--timeout")?;
    }
    other => return Err(CliError::usage(format!("unknown tool {other}"))),
  }
  input.finish()?;
  Ok(args)
}

fn mongo_arguments(input: &mut Input, args: &mut Vec<String>) -> Result<(), CliError> {
  args.push(input.positional("connection")?);
  let action = input.positional("action")?;
  args.push(action.clone());
  if action != "collections" {
    args.push(input.positional("namespace")?);
  }
  match action.as_str() {
    "find" | "count" | "explain" => args.extend(input.optional_positional("filter")?),
    // 命令行里 aggregate 的管道是位置参数，explain 的是 --pipeline
    "aggregate" => args.push(input.positional("pipeline")?),
    _ => {}
  }
  input.flag(args, "sort", "--sort")?;
  input.flag(args, "skip", "--skip")?;
  input.flag(args, "limit", "--limit")?;
  if action != "aggregate" {
    input.flag(args, "pipeline", "--pipeline")?;
  }
  input.flag(args, "timeout_seconds", "--timeout")
}

struct Input<'a> {
  map: &'a Map<String, Value>,
  seen: Vec<&'static str>,
}

impl Input<'_> {
  /// 字符串照用，数字写成十进制，对象与数组写成 JSON（Mongo 的条件、ES 的请求体）。
  /// `"-"` 在命令行里是「从标准输入读」，而这里的标准输入是协议本身，一律不收
  fn text(&mut self, key: &'static str) -> Result<Option<String>, CliError> {
    self.seen.push(key);
    let text = match self.map.get(key) {
      None | Some(Value::Null) => return Ok(None),
      Some(Value::String(text)) => text.clone(),
      Some(Value::Number(number)) if number.is_i64() || number.is_u64() => number.to_string(),
      Some(value @ (Value::Object(_) | Value::Array(_))) => value.to_string(),
      Some(_) => return Err(CliError::usage(format!("{key} has the wrong type"))),
    };
    if text == "-" {
      return Err(CliError::usage(format!(
        "{key}: \"-\" (read from stdin) is not available here; pass the text itself"
      )));
    }
    Ok(Some(text))
  }

  /// 位置参数。命令行的解析器把恰好等于某个选项名的参数当成选项，这种值在这里先拒掉，
  /// 免得 `"--limit"` 这样的值被当成选项吃掉（SQL 注释 `-- …` 带空格，不受影响）
  fn optional_positional(&mut self, key: &'static str) -> Result<Option<String>, CliError> {
    let text = self.text(key)?;
    if let Some(text) = &text {
      if text.starts_with("--") && !text.contains(char::is_whitespace) {
        return Err(CliError::usage(format!("{key} cannot be {text}")));
      }
    }
    Ok(text)
  }

  fn positional(&mut self, key: &'static str) -> Result<String, CliError> {
    self.optional_positional(key)?.ok_or_else(|| CliError::usage(format!("{key} is required")))
  }

  /// 给了才加上 `flag value`。值紧跟在选项名后面，解析器原样收下，不会被当成别的选项
  fn flag(
    &mut self,
    args: &mut Vec<String>,
    key: &'static str,
    flag: &str,
  ) -> Result<(), CliError> {
    if let Some(value) = self.text(key)? {
      args.push(flag.to_string());
      args.push(value);
    }
    Ok(())
  }

  /// Redis 的命令与参数：原样交给服务器，命令行不再解析，所以不查选项名与 `-`
  fn raw_list(&mut self, key: &'static str) -> Result<Vec<String>, CliError> {
    self.seen.push(key);
    let Some(Value::Array(items)) = self.map.get(key) else {
      return Err(CliError::usage(format!("{key} is required: a list of strings")));
    };
    items
      .iter()
      .map(|item| {
        item
          .as_str()
          .map(str::to_string)
          .ok_or_else(|| CliError::usage(format!("{key} takes strings")))
      })
      .collect()
  }

  fn finish(self) -> Result<(), CliError> {
    let mut unknown = self.map.keys().filter(|key| !self.seen.contains(&key.as_str()));
    match unknown.next() {
      Some(key) => Err(CliError::usage(format!("{key} is not an argument of this tool or action"))),
      None => Ok(()),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::super::tests::{
    file_profile, json_of, profile, seeded_sqlite, sqlite_count, ConfigDir,
  };
  use super::*;

  fn dirs_of(dir: &ConfigDir) -> Dirs {
    Dirs { config: Some(dir.0.clone()), log: Some(dir.0.join("logs")) }
  }

  /// 整段会话：每行一条请求，回包按行拆开
  fn session(dir: &ConfigDir, requests: &[Value]) -> Vec<Value> {
    let input: String = requests.iter().map(|request| format!("{request}\n")).collect();
    session_raw(dir, &input)
  }

  fn session_raw(dir: &ConfigDir, input: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let code = serve(&mut input.as_bytes(), &mut out, &dirs_of(dir));
    assert_eq!(code, 0);
    String::from_utf8_lossy(&out).lines().map(json_of).collect()
  }

  fn call_request(id: i64, tool: &str, arguments: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": { "name": tool, "arguments": arguments } })
  }

  /// 一次工具调用：(isError, 文本解析成的 JSON；不是 JSON 时是字符串)
  fn call_tool(dir: &ConfigDir, tool: &str, arguments: Value) -> (bool, Value) {
    let replies = session(dir, &[call_request(1, tool, arguments)]);
    assert_eq!(replies.len(), 1, "{replies:?}");
    let result = &replies[0]["result"];
    let text = result["content"][0]["text"].as_str().unwrap_or_default().to_string();
    let body = serde_json::from_str(&text).unwrap_or(Value::String(text));
    (result["isError"] == json!(true), body)
  }

  fn sqlite_dir() -> (ConfigDir, std::path::PathBuf) {
    let dir = ConfigDir::with(&[]);
    let db = seeded_sqlite(&dir.0);
    std::fs::write(
      dir.0.join("connections.json"),
      Value::from(vec![
        file_profile("s", "local", "sqlite", &db, "development"),
        // 生产连接：字段被手工改成了只读，也不能看见（§4 第 2 条）
        file_profile("p", "prod", "sqlite", &db, "production"),
      ])
      .to_string(),
    )
    .expect("config");
    (dir, db)
  }

  /// §4 第 1 条：写语句被拒，表里的行数不变
  #[test]
  fn write_statements_are_refused() {
    let (dir, db) = sqlite_dir();
    let attached = dir.0.join("attached.db");
    for sql in [
      "DELETE FROM items".to_string(),
      "DROP TABLE items".to_string(),
      format!("ATTACH DATABASE '{}' AS other", attached.display()),
      "SELECT 1; DELETE FROM items".to_string(),
    ] {
      let (is_error, body) = call_tool(&dir, "query", json!({ "connection": "local", "sql": sql }));
      assert!(is_error, "{sql}: {body}");
      assert_eq!(body["error"]["kind"], "refused", "{sql}: {body}");
    }
    assert_eq!(sqlite_count(&db), 1000);
    assert!(!attached.exists());
  }

  /// §4 第 2 条：生产连接列不出来，查它报「找不到」而不是「被拒」
  #[test]
  fn production_connections_are_invisible() {
    let (dir, _) = sqlite_dir();
    let (is_error, body) = call_tool(&dir, "connections", json!({}));
    assert!(!is_error, "{body}");
    let names: Vec<&str> = body["connections"]
      .as_array()
      .map(|list| list.iter().filter_map(|item| item["name"].as_str()).collect())
      .unwrap_or_default();
    assert_eq!(names, vec!["local"]);
    let (is_error, body) =
      call_tool(&dir, "query", json!({ "connection": "prod", "sql": "SELECT 1" }));
    assert!(is_error, "{body}");
    assert_eq!(body["error"]["kind"], "not_found");
    let (is_error, body) =
      call_tool(&dir, "query", json!({ "connection": "p", "sql": "SELECT 1" }));
    assert!(is_error, "{body}");
    assert_eq!(body["error"]["kind"], "not_found");
  }

  #[test]
  fn reads_go_through_and_come_back_as_the_cli_json() {
    let (dir, _) = sqlite_dir();
    let (is_error, body) = call_tool(
      &dir,
      "query",
      json!({ "connection": "local", "sql": "SELECT id FROM items ORDER BY id", "limit": 3 }),
    );
    assert!(!is_error, "{body}");
    assert_eq!(body["rows"], json!([[1], [2], [3]]));
    assert_eq!(body["truncated"], true);
    let (is_error, body) =
      call_tool(&dir, "schema", json!({ "connection": "local", "table": "items" }));
    assert!(!is_error, "{body}");
    let (is_error, body) = call_tool(&dir, "dictionary", json!({ "connection": "local" }));
    assert!(!is_error, "{body}");
    assert!(body.as_str().is_some_and(|text| text.contains("items")), "{body}");
  }

  /// 「-」在命令行里读标准输入，这里的标准输入是协议本身：读了就把后面的请求吃掉
  #[test]
  fn stdin_and_option_lookalikes_are_refused_as_usage() {
    let (dir, _) = sqlite_dir();
    for arguments in [
      json!({ "connection": "local", "sql": "-" }),
      json!({ "connection": "local", "sql": "--limit" }),
      json!({ "connection": "local", "sql": "SELECT 1", "limit": "-" }),
      json!({ "connection": "local", "sql": "SELECT 1", "extra": 1 }),
      json!({ "connection": "local" }),
      json!({ "connection": "local", "sql": true }),
    ] {
      let (is_error, body) = call_tool(&dir, "query", arguments.clone());
      assert!(is_error, "{arguments}: {body}");
      assert_eq!(body["error"]["kind"], "usage", "{arguments}: {body}");
    }
    // SQL 注释开头的语句照常
    let (is_error, body) = call_tool(
      &dir,
      "query",
      json!({ "connection": "local", "sql": "-- count\nSELECT count(*) AS n FROM items" }),
    );
    assert!(!is_error, "{body}");
  }

  /// §4 第 3 条
  #[test]
  fn tools_have_schemas_and_no_file_access() {
    let dir = ConfigDir::with(&[]);
    let replies = session(&dir, &[json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })]);
    let tools = replies[0]["result"]["tools"].as_array().cloned().unwrap_or_default();
    let names: Vec<&str> = tools.iter().filter_map(|tool| tool["name"].as_str()).collect();
    assert_eq!(
      names,
      vec![
        "connections",
        "test",
        "query",
        "explain",
        "schema",
        "ddl",
        "dictionary",
        "mongo",
        "redis",
        "neo4j",
        "es"
      ]
    );
    for tool in &tools {
      let schema = &tool["inputSchema"];
      assert_eq!(schema["type"], "object", "{tool}");
      assert!(!tool["description"].as_str().unwrap_or_default().is_empty(), "{tool}");
      for required in schema["required"].as_array().cloned().unwrap_or_default() {
        let key = required.as_str().unwrap_or_default();
        assert!(schema["properties"].get(key).is_some(), "{tool}: {key}");
      }
    }
    for hidden in ["export", "backup", "csv-preview", "help", "guide", "version"] {
      assert!(!names.contains(&hidden), "{hidden}");
    }
  }

  #[test]
  fn arguments_become_the_command_line() {
    let map = |value: Value| value.as_object().cloned().unwrap_or_default();
    let cases = [
      (
        "query",
        json!({ "connection": "c", "sql": "SELECT 1", "limit": 5, "timeout_seconds": 9 }),
        vec!["query", "c", "SELECT 1", "--limit", "5", "--timeout", "9"],
      ),
      (
        "schema",
        json!({ "connection": "c", "table": "t", "schema": "s" }),
        vec!["schema", "c", "t", "--schema", "s"],
      ),
      (
        "mongo",
        json!({ "connection": "c", "action": "find", "namespace": "db.coll",
                        "filter": { "a": 1 }, "sort": "{a: -1}", "limit": 2 }),
        vec!["mongo", "c", "find", "db.coll", "{\"a\":1}", "--sort", "{a: -1}", "--limit", "2"],
      ),
      (
        "mongo",
        json!({ "connection": "c", "action": "aggregate", "namespace": "db.coll",
                        "pipeline": [{ "$match": {} }] }),
        vec!["mongo", "c", "aggregate", "db.coll", "[{\"$match\":{}}]"],
      ),
      (
        "mongo",
        json!({ "connection": "c", "action": "explain", "namespace": "db.coll", "pipeline": "[]" }),
        vec!["mongo", "c", "explain", "db.coll", "--pipeline", "[]"],
      ),
      (
        "redis",
        json!({ "connection": "c", "action": "command", "db": 2, "command": ["GET", "--db"] }),
        vec!["redis", "c", "--db", "2", "command", "GET", "--db"],
      ),
      (
        "redis",
        json!({ "connection": "c", "action": "scan", "pattern": "user:*", "limit": 10 }),
        vec!["redis", "c", "--limit", "10", "scan", "user:*"],
      ),
      (
        "neo4j",
        json!({ "connection": "c", "action": "run", "cypher": "MATCH (n) RETURN n", "database": "g" }),
        vec!["neo4j", "c", "run", "MATCH (n) RETURN n", "--db", "g"],
      ),
      (
        "es",
        json!({ "connection": "c", "action": "request", "method": "POST", "path": "/i/_search",
                     "body": { "size": 1 } }),
        vec!["es", "c", "request", "POST", "/i/_search", "{\"size\":1}"],
      ),
    ];
    for (tool, arguments, expected) in cases {
      let args = arguments_for(tool, &map(arguments.clone()));
      assert_eq!(
        args.map_err(|error| error.message),
        Ok(expected.iter().map(|s| s.to_string()).collect::<Vec<_>>()),
        "{arguments}"
      );
    }
  }

  /// §4 第 4 条
  #[test]
  fn protocol_basics() {
    let dir = ConfigDir::with(&[]);
    let input = [
      json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
              "params": { "protocolVersion": "2025-06-18", "capabilities": {},
                          "clientInfo": { "name": "t", "version": "0" } } })
      .to_string(),
      json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string(),
      json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }).to_string(),
      json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/list" }).to_string(),
      "{not json".to_string(),
      json!({ "jsonrpc": "2.0", "id": 4, "method": "initialize",
              "params": { "protocolVersion": "1999-01-01" } })
      .to_string(),
      json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call",
              "params": { "name": "export", "arguments": {} } })
      .to_string(),
      String::new(),
    ]
    .join("\n");
    let replies = session_raw(&dir, &input);
    assert_eq!(replies.len(), 6, "{replies:?}");
    assert_eq!(replies[0]["id"], 1);
    assert_eq!(replies[0]["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(replies[0]["result"]["serverInfo"]["name"], "dataomni");
    assert!(replies[0]["result"]["capabilities"]["tools"].is_object());
    assert_eq!(replies[1], json!({ "jsonrpc": "2.0", "id": 2, "result": {} }));
    assert_eq!(replies[2]["error"]["code"], METHOD_NOT_FOUND);
    assert_eq!(
      (replies[3]["id"].clone(), replies[3]["error"]["code"].clone()),
      (Value::Null, json!(PARSE_ERROR))
    );
    assert_eq!(replies[4]["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
    assert_eq!(replies[5]["error"]["code"], INVALID_PARAMS);
  }

  /// §4 第 5 条：一整轮调用下来配置文件逐字节不变
  #[test]
  fn never_rewrites_the_config() {
    let dir = ConfigDir::with(&[
      profile("a", "open-dev", "development", "read"),
      profile("b", "closed", "development", "off"),
    ]);
    let before = dir.config_file();
    session(
      &dir,
      &[
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }),
        call_request(2, "connections", json!({})),
        call_request(3, "query", json!({ "connection": "closed", "sql": "SELECT 1" })),
        call_request(4, "query", json!({ "connection": "open-dev", "sql": "DELETE FROM t" })),
      ],
    );
    assert_eq!(dir.config_file(), before);
  }
}
