//! `redis`：Redis 的只读命令（`rfcs/agent-cli.md` §5.2、§6 第二批）。
//!
//! Redis 没有只读会话。`keyspaces`、`scan`、`get` 只用读的命令；`command` 照原样发一条，
//! 但先问**服务器自己**这条命令带不带 `readonly` 旗标（`COMMAND INFO`），不带的一律拒。
//! 名单不写在这里：服务器的版本与装的模块决定有哪些命令，它自己最清楚。
//! 会阻塞的与改连接状态的另由 `services::redis::execute` 拒（同界面的命令行）

use super::{session, CliError, Exit, DEFAULT_ROW_LIMIT, DEFAULT_TIMEOUT_SECONDS};
use super::{MAX_ROW_LIMIT, MAX_TIMEOUT_SECONDS};
use crate::models::ConnectionProfile;
use crate::services::redis::{
  self, RedisPool, RedisReply, RedisTarget, ScanRequest, ValueRequest, REDIS_TIMEOUT,
};
use serde_json::{json, Value};
use std::time::Duration;

pub(super) const USAGE: &str = "usage: dataomni cli redis <connection> <operation> ...
  keyspaces
  scan [<pattern>] [--type T] [--cursor C] [--limit N]
  get <key> [--position P] [--limit N]
  command <name> [<argument>...]   (only commands the server flags readonly)
every operation also takes [--db N] [--timeout SECONDS], placed before the operation";

pub(super) struct Arguments {
  pub(super) connection: String,
  pub(super) timeout: Duration,
  database: Option<i64>,
  request: Request,
  /// 留痕里记摘要的那段文字
  pub(super) subject: String,
}

enum Request {
  Keyspaces,
  Scan { pattern: String, kind: Option<String>, cursor: String, limit: usize },
  Get { key: String, position: Option<String>, limit: usize },
  Command { arguments: Vec<String> },
}

impl Arguments {
  pub(super) fn command(&self) -> &'static str {
    match self.request {
      Request::Keyspaces => "redis keyspaces",
      Request::Scan { .. } => "redis scan",
      Request::Get { .. } => "redis get",
      Request::Command { .. } => "redis command",
    }
  }
}

#[derive(Default)]
struct Flags {
  database: Option<i64>,
  timeout: Option<u64>,
  kind: Option<String>,
  cursor: Option<String>,
  position: Option<String>,
  limit: Option<usize>,
}

/// `command` 之后的一律原样交给服务器（`command GET --db` 里的 `--db` 是键名），
/// 所以选项要写在操作前面或者其余操作的参数之间
pub(super) fn parse(rest: &[String]) -> Result<Arguments, CliError> {
  let mut positional: Vec<String> = Vec::new();
  let mut flags = Flags::default();
  let mut raw: Option<Vec<String>> = None;
  let mut iter = rest.iter();
  while let Some(argument) = iter.next() {
    let value = |flag: &str, value: Option<&String>| {
      value.cloned().ok_or_else(|| CliError::usage(format!("{flag} takes a value")))
    };
    match argument.as_str() {
      "--db" => flags.database = Some(super::number_after("--db", iter.next(), 0, 65_535)? as i64),
      "--timeout" => {
        flags.timeout = Some(super::number_after("--timeout", iter.next(), 1, MAX_TIMEOUT_SECONDS)?)
      }
      "--type" => flags.kind = Some(value("--type", iter.next())?),
      "--cursor" => flags.cursor = Some(value("--cursor", iter.next())?),
      "--position" => flags.position = Some(value("--position", iter.next())?),
      "--limit" => {
        flags.limit =
          Some(super::number_after("--limit", iter.next(), 1, MAX_ROW_LIMIT as u64)? as usize)
      }
      "command" if positional.len() == 1 => {
        raw = Some(iter.by_ref().cloned().collect());
      }
      _ => positional.push(argument.clone()),
    }
  }
  let timeout = Duration::from_secs(flags.timeout.take().unwrap_or(DEFAULT_TIMEOUT_SECONDS));
  let database = flags.database.take();
  let Some((connection, rest)) = positional.split_first() else {
    return Err(CliError::usage(USAGE));
  };
  let (request, subject) = match (raw, rest) {
    (Some(arguments), []) if !arguments.is_empty() => {
      let subject = arguments.join(" ");
      (Request::Command { arguments }, subject)
    }
    (None, [operation]) if operation == "keyspaces" => (Request::Keyspaces, String::new()),
    (None, [operation, pattern @ ..]) if operation == "scan" && pattern.len() <= 1 => {
      let pattern = pattern.first().cloned().unwrap_or_else(|| "*".to_string());
      let request = Request::Scan {
        pattern: pattern.clone(),
        kind: flags.kind.take(),
        cursor: flags.cursor.take().unwrap_or_else(|| "0".to_string()),
        limit: flags.limit.take().unwrap_or(DEFAULT_ROW_LIMIT),
      };
      (request, pattern)
    }
    (None, [operation, key]) if operation == "get" => {
      let request = Request::Get {
        key: key.clone(),
        position: flags.position.take(),
        limit: flags.limit.take().unwrap_or(DEFAULT_ROW_LIMIT),
      };
      (request, key.clone())
    }
    _ => return Err(CliError::usage(USAGE)),
  };
  let unused = [
    flags.kind.map(|_| "--type"),
    flags.cursor.map(|_| "--cursor"),
    flags.position.map(|_| "--position"),
    flags.limit.map(|_| "--limit"),
  ];
  if let Some(flag) = unused.into_iter().flatten().next() {
    return Err(CliError::usage(format!("this redis operation does not take {flag}")));
  }
  Ok(Arguments { connection: connection.clone(), timeout, database, request, subject })
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
    let pool = redis::connect(RedisTarget::from_profile(&reachable)?).await?;
    Ok::<_, String>((tunnels, pool))
  };
  let deadline = session::CONNECT_DEADLINE;
  let (_tunnels, pool) = tokio::time::timeout(deadline, connect)
    .await
    .map_err(|_| {
      CliError::unavailable("connect", format!("could not connect within {} s", deadline.as_secs()))
    })?
    .map_err(|error| CliError::unavailable("connect", error))?;
  let database = arguments.database.unwrap_or_else(|| pool.default_database());
  let timeout = arguments.timeout;
  let body = match &arguments.request {
    Request::Keyspaces => {
      let entries = redis::list_keyspaces(&pool).await.map_err(database_error)?;
      let keyspaces: Vec<Value> = entries
        .into_iter()
        .map(|entry| {
          let index =
            entry.object_name.strip_prefix("db").and_then(|index| index.parse::<i64>().ok());
          json!({ "database": index, "keys": entry.keys })
        })
        .collect();
      json!({ "keyspaces": keyspaces })
    }
    Request::Scan { pattern, kind, cursor, limit } => {
      let request = ScanRequest {
        database,
        pattern: pattern.clone(),
        cursor: cursor.clone(),
        kind: kind.clone(),
        page: *limit,
        timeout,
      };
      let page = redis::scan(&pool, request).await.map_err(database_error)?;
      json!({ "database": database, "keys": page.keys, "cursor": page.cursor })
    }
    Request::Get { key, position, limit } => {
      let request = ValueRequest {
        database,
        key: key.as_bytes().to_vec(),
        position: position.clone(),
        page: *limit as u64,
        timeout,
      };
      let value = redis::read_value(&pool, request).await.map_err(database_error)?;
      json!({ "database": database, "key": key, "value": value })
    }
    Request::Command { arguments } => {
      require_read_only(&pool, database, arguments, timeout).await?;
      let bytes = arguments.iter().map(|argument| argument.as_bytes().to_vec()).collect();
      let reply = redis::execute(&pool, database, bytes, timeout).await.map_err(|error| {
        // 会阻塞、改连接状态的：同界面的命令行一样拒，这里是权限门的一部分
        if error.starts_with(redis::REDIS_COMMAND_BLOCKING)
          || error.starts_with(redis::REDIS_COMMAND_CONNECTION_STATE)
        {
          CliError::refused(error)
        } else {
          database_error(error)
        }
      })?;
      json!({ "database": database, "reply": reply })
    }
  };
  Ok(body)
}

/// 问服务器这条命令带不带 `readonly`。有子命令的（`OBJECT ENCODING`、`XINFO STREAM`）
/// Redis 7 起按 `名字|子命令` 各有旗标；查不到子命令（更早的版本没有）就看命令本身
async fn require_read_only(
  pool: &RedisPool,
  database: i64,
  arguments: &[String],
  timeout: Duration,
) -> Result<(), CliError> {
  let Some((name, rest)) = arguments.split_first() else {
    return Err(CliError::usage(USAGE));
  };
  let mut query = vec![b"COMMAND".to_vec(), b"INFO".to_vec(), name.as_bytes().to_vec()];
  if let Some(sub) = rest.first() {
    query.push(format!("{name}|{sub}").to_ascii_lowercase().into_bytes());
  }
  let reply = redis::execute(pool, database, query, timeout).await.map_err(database_error)?;
  let entries = match reply {
    RedisReply::Array { items } => items,
    RedisReply::Error { message } => {
      return Err(CliError::refused(format!(
        "cannot ask the server whether {name} is read-only ({message}); the account needs COMMAND INFO"
      )))
    }
    other => return Err(database_error(format!("unexpected COMMAND INFO reply: {other:?}"))),
  };
  let flags = entries.iter().rev().find_map(command_flags);
  match flags {
    Some(flags) if flags.iter().any(|flag| flag == "readonly") => Ok(()),
    Some(_) => Err(CliError::refused(format!(
      "{} is not flagged readonly by the server; the command line only reads",
      arguments.iter().take(2).cloned().collect::<Vec<_>>().join(" ")
    ))),
    None => Err(CliError::usage(format!("the server does not know the command {name}"))),
  }
}

/// `COMMAND INFO` 的一项：`[名字, 参数个数, 旗标, …]`；不认识的命令是 nil
fn command_flags(entry: &RedisReply) -> Option<Vec<String>> {
  let RedisReply::Array { items } = entry else { return None };
  let RedisReply::Array { items: flags } = items.get(2)? else { return None };
  Some(
    flags
      .iter()
      .filter_map(|flag| match flag {
        RedisReply::Status { value } => Some(value.to_ascii_lowercase()),
        RedisReply::Bulk { value } => Some(value.text.to_ascii_lowercase()),
        _ => None,
      })
      .collect(),
  )
}

fn database_error(message: String) -> CliError {
  let kind = if message.starts_with(REDIS_TIMEOUT) { "timeout" } else { "database" };
  CliError { exit: Exit::Database, kind, message, diagnosis: None }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::models::ConnectionProfile;

  fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|item| item.to_string()).collect()
  }

  #[test]
  fn arguments_are_checked() {
    assert!(parse(&args(&["r", "keyspaces"])).is_ok());
    assert!(parse(&args(&["r", "scan", "user:*", "--type", "hash", "--limit", "5"])).is_ok());
    assert!(parse(&args(&["r", "--db", "3", "get", "k", "--limit", "10"])).is_ok());
    // `command` 之后原样：`--db` 是键名，不是选项
    match parse(&args(&["r", "--db", "2", "command", "GET", "--db"])) {
      Ok(Arguments { database, request: Request::Command { arguments }, .. }) => {
        assert_eq!(database, Some(2));
        assert_eq!(arguments, args(&["GET", "--db"]));
      }
      _ => panic!("command arguments are passed through"),
    }
    for bad in [
      &["r"][..],
      &["r", "command"],
      &["r", "keyspaces", "extra"],
      &["r", "get"],
      &["r", "get", "a", "b"],
      &["r", "scan", "a", "b"],
      &["r", "flushdb"],
      &["r", "keyspaces", "--limit", "5"],
      &["r", "get", "k", "--type", "hash"],
      &["r", "--db", "x", "keyspaces"],
    ] {
      assert!(matches!(parse(&args(bad)), Err(CliError { exit: Exit::Usage, .. })), "{bad:?}");
    }
  }

  /// 真库：`DATAOMNI_REDIS_TEST_URL`（`redis://user:password@host:port`），只在 shell 里传。
  /// 探针键放在 13 号库（`redis_smoke.rs` 用的 9–14 号之一），只碰 `om_cli:` 前缀，用完删掉
  #[tokio::test]
  async fn redis_operations_read_and_writes_are_refused_by_the_server_flags() {
    let Ok(raw) = std::env::var("DATAOMNI_REDIS_TEST_URL") else {
      eprintln!("skipping: DATAOMNI_REDIS_TEST_URL is not set");
      return;
    };
    let url = url::Url::parse(&raw).expect("a valid test URL");
    let decode =
      |text: &str| urlencoding::decode(text).map(|text| text.into_owned()).unwrap_or_default();
    let profile: ConnectionProfile = serde_json::from_value(json!({
      "id": "cli-redis", "name": "cli-redis", "db_type": "redis",
      "host": url.host_str().unwrap_or_default(), "port": url.port().unwrap_or(6379),
      "database": "0", "username": decode(url.username()),
      "password": decode(url.password().unwrap_or_default()), "ssl": false,
      "options": {}, "tags": [],
    }))
    .expect("a profile");
    let admin =
      redis::connect(RedisTarget::from_profile(&profile).expect("target")).await.expect("admin");
    let send = |list: &[&str]| {
      let bytes: Vec<Vec<u8>> = list.iter().map(|item| item.as_bytes().to_vec()).collect();
      redis::execute(&admin, 13, bytes, Duration::from_secs(5))
    };
    send(&["DEL", "om_cli:s", "om_cli:h"]).await.expect("clean");
    send(&["SET", "om_cli:s", "hello"]).await.expect("seed string");
    send(&["HSET", "om_cli:h", "f", "v"]).await.expect("seed hash");

    let call = |list: &[&str]| {
      let parsed = parse(&args(list));
      let profile = profile.clone();
      async move {
        let arguments = parsed.unwrap_or_else(|error| panic!("{}", error.message));
        run(&profile, &arguments).await
      }
    };
    let ok = |outcome: Result<Value, CliError>| {
      outcome.unwrap_or_else(|error| panic!("{}", error.message))
    };
    let keyspaces = ok(call(&["r", "keyspaces"]).await);
    assert!(keyspaces["keyspaces"].to_string().contains("\"database\":13"), "{keyspaces}");
    let scanned = ok(call(&["r", "--db", "13", "scan", "om_cli:*", "--limit", "10"]).await);
    assert_eq!(scanned["keys"].as_array().map(Vec::len), Some(2), "{scanned}");
    let hash = ok(call(&["r", "--db", "13", "get", "om_cli:h"]).await);
    assert_eq!(hash["value"]["kind"], json!("hash"), "{hash}");
    let got = ok(call(&["r", "--db", "13", "command", "GET", "om_cli:s"]).await);
    assert_eq!(got["reply"]["value"]["text"], json!("hello"), "{got}");
    let encoding =
      ok(call(&["r", "--db", "13", "command", "OBJECT", "ENCODING", "om_cli:s"]).await);
    assert_eq!(encoding["reply"]["kind"], json!("bulk"), "{encoding}");

    for write in [
      &["r", "--db", "13", "command", "SET", "om_cli:s", "changed"][..],
      &["r", "--db", "13", "command", "del", "om_cli:s"],
      &["r", "--db", "13", "command", "FLUSHDB"],
      &["r", "--db", "13", "command", "CONFIG", "SET", "maxmemory", "1"],
      &[
        "r",
        "--db",
        "13",
        "command",
        "EVAL",
        "return redis.call('SET', KEYS[1], 'changed')",
        "1",
        "om_cli:s",
      ],
      &["r", "--db", "13", "command", "SELECT", "0"],
      &["r", "--db", "13", "command", "BLPOP", "om_cli:l", "1"],
    ] {
      match call(write).await {
        Err(CliError { exit: Exit::Refused, .. }) => {}
        other => panic!("{write:?} was not refused: {:?}", other.map(|value| value.to_string())),
      }
    }
    assert!(matches!(
      call(&["r", "command", "NO_SUCH_COMMAND"]).await,
      Err(CliError { exit: Exit::Usage, .. })
    ));
    let after = ok(call(&["r", "--db", "13", "command", "GET", "om_cli:s"]).await);
    assert_eq!(after["reply"]["value"]["text"], json!("hello"));
    send(&["DEL", "om_cli:s", "om_cli:h"]).await.expect("clean up");
  }

  #[test]
  fn flags_come_from_the_command_info_entry() {
    let status = |value: &str| RedisReply::Status { value: value.to_string() };
    let entry = RedisReply::Array {
      items: vec![
        status("get"),
        RedisReply::Integer { value: "2".to_string() },
        RedisReply::Array { items: vec![status("readonly"), status("fast")] },
      ],
    };
    assert_eq!(command_flags(&entry), Some(vec!["readonly".to_string(), "fast".to_string()]));
    assert_eq!(command_flags(&RedisReply::Nil), None);
  }
}
