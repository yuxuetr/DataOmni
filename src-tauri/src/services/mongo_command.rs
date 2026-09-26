//! MongoDB 命令台：一条 `db.runCommand({...})`。
//!
//! 写法就是筛选框那一种 mongosh 字面量（`mongo_shell`），不嵌 JS 引擎——`db.coll.find()`
//! 那种写法要的是一整个 JavaScript 运行时，而服务端真正收的只有命令文档。
//!
//! 该不该先问由前端按「设置 → 危险语句确认」定，这里只按命令名给出风险等级，名字与前端的
//! `StatementRisk` 一一对应。

use crate::services::mongo_shell::{self, Layout};
use crate::services::mongodb::{describe_error, with_deadline};
use mongodb::bson::{doc, Bson, Document};
use mongodb::Client;
use serde::Serialize;
use std::time::Duration;

/// 命令台是空的（或只有注释）
pub const MONGO_COMMAND_EMPTY: &str = "DATAOMNI_MONGO_COMMAND_EMPTY";
/// 这条命令改的是连接的认证状态，而连接池是各处共用的。冒号后面是命令名
pub const MONGO_COMMAND_CONNECTION_STATE: &str = "DATAOMNI_MONGO_COMMAND_CONNECTION_STATE";

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandRisk {
  Read,
  Append,
  ScopedWrite,
  BulkWrite,
  Destructive,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct CommandPlan {
  /// 命令名，即文档的第一个键
  pub name: String,
  pub risk: CommandRisk,
}

/// 只读的命令。**不在表里的一律按写算**：认不出的管理命令当成只读，比多问一次代价大
const READS: &[&str] = &[
  "aggregate",
  "buildinfo",
  "collstats",
  "connectionstatus",
  "count",
  "currentop",
  "datasize",
  "dbhash",
  "dbstats",
  "distinct",
  "explain",
  "find",
  "getcmdlineopts",
  "getlog",
  "getmore",
  "getparameter",
  "hello",
  "hostinfo",
  "ismaster",
  "listcollections",
  "listcommands",
  "listdatabases",
  "listindexes",
  "listsearchindexes",
  "ping",
  "replsetgetconfig",
  "replsetgetstatus",
  "rolesinfo",
  "serverstatus",
  "top",
  "usersinfo",
  "validate",
];

/// 删掉数据或对象、或者让服务停下的
const DESTRUCTIVE: &[&str] = &[
  "converttocapped",
  "deleteindexes",
  "drop",
  "dropallrolesfromdatabase",
  "dropallusersfromdatabase",
  "dropdatabase",
  "dropindexes",
  "droprole",
  "dropsearchindex",
  "dropuser",
  "emptycapped",
  "renamecollection",
  "shutdown",
];

/// 改连接自己的认证状态：池里那条连接之后给谁用就说不清了
const CONNECTION_STATE: &[&str] = &["authenticate", "logout", "saslcontinue", "saslstart"];

/// 解析并分级。解析错误原样带码（`DATAOMNI_MONGO_SYNTAX: …`）
pub fn plan(text: &str) -> Result<(Document, CommandPlan), String> {
  let command = mongo_shell::parse_document(text).map_err(|error| error.to_string())?;
  let name = command.keys().next().cloned().ok_or_else(|| MONGO_COMMAND_EMPTY.to_string())?;
  let lower = name.to_ascii_lowercase();
  if CONNECTION_STATE.contains(&lower.as_str()) {
    return Err(format!("{MONGO_COMMAND_CONNECTION_STATE}: {name}"));
  }
  let risk = risk_of(&lower, &command);
  Ok((command, CommandPlan { name, risk }))
}

fn risk_of(lower: &str, command: &Document) -> CommandRisk {
  if DESTRUCTIVE.contains(&lower) {
    return CommandRisk::Destructive;
  }
  match lower {
    // 管道里有 `$out` / `$merge` 就是往别的集合里写，而且会整个换掉目标
    "aggregate" if writes_out(command) => CommandRisk::BulkWrite,
    "insert" => CommandRisk::Append,
    // 每一条都带条件才算有范围；有一条是空条件，就是整个集合
    "update" => statements_risk(command, "updates", "q"),
    "delete" => statements_risk(command, "deletes", "q"),
    "findandmodify" => match command.get_document("query") {
      Ok(query) if !query.is_empty() => CommandRisk::ScopedWrite,
      _ => CommandRisk::BulkWrite,
    },
    _ if READS.contains(&lower) => CommandRisk::Read,
    _ => CommandRisk::ScopedWrite,
  }
}

fn writes_out(command: &Document) -> bool {
  command.get_array("pipeline").is_ok_and(|stages| {
    stages.iter().any(|stage| {
      matches!(stage, Bson::Document(stage) if stage.contains_key("$out") || stage.contains_key("$merge"))
    })
  })
}

fn statements_risk(command: &Document, list: &str, filter: &str) -> CommandRisk {
  let scoped = command.get_array(list).is_ok_and(|statements| {
    !statements.is_empty()
      && statements.iter().all(|statement| {
        matches!(statement, Bson::Document(statement)
          if statement.get_document(filter).is_ok_and(|filter| !filter.is_empty()))
      })
  });
  if scoped {
    CommandRisk::ScopedWrite
  } else {
    CommandRisk::BulkWrite
  }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandReply {
  /// 服务端的回答，mongosh 的缩进写法
  pub text: String,
  /// 回答里是一个没取完的游标（`find` / `aggregate` 只回第一批）。游标已经关掉：
  /// 命令台一条是一条，留着它只会在服务端挂到超时
  pub more: bool,
}

pub async fn run(
  client: &Client,
  database: &str,
  command: Document,
  timeout: Duration,
) -> Result<CommandReply, String> {
  let database = client.database(database);
  let work = async {
    let reply = database.run_command(command).await.map_err(describe_error)?;
    let cursor = reply.get_document("cursor").ok();
    let open = cursor.and_then(|cursor| {
      let id = cursor.get_i64("id").ok().filter(|id| *id != 0)?;
      let namespace = cursor.get_str("ns").ok()?;
      let collection = namespace.split_once('.').map(|(_, collection)| collection)?;
      Some((id, collection.to_string()))
    });
    if let Some((id, collection)) = &open {
      // 关不掉也不算这条命令失败：服务端十分钟后自己会收
      let _ = database.run_command(doc! { "killCursors": collection, "cursors": [*id] }).await;
    }
    Ok(CommandReply {
      text: mongo_shell::format_document(&reply, Layout::Indented),
      more: open.is_some(),
    })
  };
  with_deadline(timeout, work).await
}

#[cfg(test)]
mod tests {
  use super::*;

  fn risk(text: &str) -> CommandRisk {
    plan(text).expect(text).1.risk
  }

  #[test]
  fn the_first_key_names_the_command_and_decides_the_risk() {
    assert_eq!(
      plan("{ ping: 1 }").expect("ping").1,
      CommandPlan { name: "ping".into(), risk: CommandRisk::Read }
    );
    assert_eq!(risk("{ listCollections: 1, filter: { name: 'x' } }"), CommandRisk::Read);
    assert_eq!(risk("{ insert: 'c', documents: [{ a: 1 }] }"), CommandRisk::Append);
    assert_eq!(risk("{ dropDatabase: 1 }"), CommandRisk::Destructive);
    assert_eq!(
      risk("{ renameCollection: 'db.a', to: 'db.b', dropTarget: true }"),
      CommandRisk::Destructive
    );
    // 认不出的按写算
    assert_eq!(risk("{ someFutureAdminCommand: 1 }"), CommandRisk::ScopedWrite);
    assert_eq!(risk("{ createIndexes: 'c', indexes: [] }"), CommandRisk::ScopedWrite);
  }

  #[test]
  fn writes_without_a_filter_reach_the_whole_collection() {
    assert_eq!(
      risk("{ delete: 'c', deletes: [{ q: { a: 1 }, limit: 1 }] }"),
      CommandRisk::ScopedWrite
    );
    assert_eq!(risk("{ delete: 'c', deletes: [{ q: {}, limit: 0 }] }"), CommandRisk::BulkWrite);
    assert_eq!(
      risk("{ update: 'c', updates: [{ q: { a: 1 }, u: { $set: { b: 1 } } }, { q: {}, u: { $set: { b: 2 } }, multi: true }] }"),
      CommandRisk::BulkWrite
    );
    assert_eq!(
      risk("{ findAndModify: 'c', query: { a: 1 }, remove: true }"),
      CommandRisk::ScopedWrite
    );
    assert_eq!(risk("{ findAndModify: 'c', remove: true }"), CommandRisk::BulkWrite);
    assert_eq!(
      risk("{ aggregate: 'c', pipeline: [{ $match: {} }], cursor: {} }"),
      CommandRisk::Read
    );
    assert_eq!(
      risk("{ aggregate: 'c', pipeline: [{ $out: 'd' }], cursor: {} }"),
      CommandRisk::BulkWrite
    );
  }

  #[test]
  fn connection_state_commands_and_empty_input_are_refused() {
    assert_eq!(plan("{ logout: 1 }"), Err(format!("{MONGO_COMMAND_CONNECTION_STATE}: logout")));
    assert_eq!(plan("// 只有注释"), Err(MONGO_COMMAND_EMPTY.to_string()));
    assert!(plan("{ ping: ").is_err_and(|error| error.starts_with("DATAOMNI_MONGO_SYNTAX")));
  }
}
