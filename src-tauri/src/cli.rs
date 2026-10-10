//! `dataomni cli …`：给 Agent 与终端用的命令行（`rfcs/agent-cli.md`）。
//!
//! 和应用是同一个二进制：macOS 的钥匙串按代码身份授权，同一个二进制读得到界面存的口令，
//! 另编一个程序每次升级都要多弹一次框（§3.1 E1）。`main` 在起 Tauri 之前分流到这里，
//! 不建窗口。
//!
//! 输出给程序读：结果是 stdout 上的一个 JSON，错误是 stderr 上的一个 JSON，退出码区分
//! 「数据库报错 / 参数错 / 被权限门拒绝 / 连不上」（§7）。文字用英文：命令行的读者多半是
//! Agent，界面的语言设置在 WebView 里，这里读不到。

use crate::models::ConnectionProfile;
use crate::services::connection_service::{app_config_dir, ConnectionService};
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;

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
}

const HELP: &str = "\
DataOmni command line: read-only access to connections you opened to agents in DataOmni.

Usage: dataomni cli <command> [arguments]

Commands:
  connections        List the connections open to the command line
  version            Print the DataOmni version
  help               Print this help

Output is JSON on stdout; errors are JSON on stderr.
Exit codes: 0 ok, 1 database error, 2 usage error, 3 refused by the access rules,
4 unavailable (cannot connect, missing credentials, keychain waiting for approval).

A connection is visible here only if \"Command line & agent access\" is set to
read-only in its DataOmni settings. Production connections are never visible.
Nothing on this command line can widen that.
";

/// 入口：`args` 是 `cli` 之后的参数。返回进程退出码
pub fn run(args: &[String]) -> i32 {
  let stdout = std::io::stdout();
  let stderr = std::io::stderr();
  run_with(args, app_config_dir().as_deref(), &mut stdout.lock(), &mut stderr.lock())
}

fn run_with(
  args: &[String],
  config_dir: Option<&Path>,
  out: &mut dyn Write,
  err: &mut dyn Write,
) -> i32 {
  let result = dispatch(args, config_dir);
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

fn dispatch(args: &[String], config_dir: Option<&Path>) -> Result<Output, CliError> {
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
      Ok(Output::Json(json!({ "schema": OUTPUT_SCHEMA, "connections": list_open(&service) })))
    }
    other => Err(CliError::usage(format!("unknown command {other}; run `dataomni cli help`"))),
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

/// 开放给命令行的连接。不带口令、钥匙串引用、私钥和证书的路径：Agent 要的只是
/// 「有哪些库、叫什么、是什么类型」
fn list_open(service: &ConnectionService) -> Vec<Value> {
  let mut open: Vec<ConnectionProfile> =
    service.get_connections().into_iter().filter(ConnectionProfile::open_to_agents).collect();
  open.sort_by(|left, right| left.name.cmp(&right.name));
  open
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
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  const SECRET: &str = "cli-test-secret-7f3a";

  fn profile(id: &str, name: &str, environment: &str, agent_access: &str) -> Value {
    json!({
      "id": id, "name": name, "db_type": "postgresql", "host": "db.internal", "port": 5432,
      "database": "app", "username": "reader", "password": SECRET, "ssl": false,
      "options": {}, "tags": [], "environment": environment, "agent_access": agent_access,
    })
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
    let code = run_with(&args, Some(&dir.0), &mut out, &mut err);
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

  /// §8 第 6、7 条：输出里没有口令；跑完配置文件一个字节都不变（旧版的明文口令也不迁移）
  #[test]
  fn never_prints_secrets_or_rewrites_the_config() {
    let dir = ConfigDir::with(&[profile("a", "open-dev", "development", "read")]);
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

  /// 没有配置文件（从没打开过应用）就是一个连接都没有，不是错误
  #[test]
  fn a_missing_config_lists_nothing() {
    let dir = ConfigDir::with(&[]);
    let _ = std::fs::remove_file(dir.0.join("connections.json"));
    let (code, stdout, _) = run_in(&dir, &["connections"]);
    assert_eq!((code, names(&stdout).len()), (0, 0));
  }
}
