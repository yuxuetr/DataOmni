//! 碰库的每次调用写一行（`rfcs/agent-cli.md` §5.3）。
//!
//! **不记语句原文**：字面量里可能有个人数据，而日志里本来就不许出现敏感字段。记第一个
//! 关键字、长度和 SHA-256，够和 Agent 那一侧的记录对上。单独一个文件：应用开着时
//! `dataomni.log` 归 `tauri-plugin-log` 轮转，两个进程一起写同一个文件说不清谁先谁后。

use super::CliError;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;
use std::time::Duration;

pub(super) const AUDIT_FILE: &str = "dataomni-cli.log";
/// 和应用日志同一个上限。超过就把旧的挪成 `.1`，只留一份
const MAX_BYTES: u64 = 2 * 1024 * 1024;

pub(super) fn record<T>(
  log_dir: Option<&Path>,
  command: &str,
  connection: &str,
  sql: &str,
  outcome: &Result<T, CliError>,
  elapsed: Duration,
) {
  let Some(log_dir) = log_dir else { return };
  let digest = Sha256::digest(sql.as_bytes());
  let hash: String = digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect();
  let first = sql.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
  let first: String = first.chars().filter(char::is_ascii_alphabetic).take(16).collect();
  let result = match outcome {
    Ok(_) => "ok".to_string(),
    Err(error) => error.kind.to_string(),
  };
  let line = format!(
    "{} {command} connection={connection:?} first={first} length={} sha256={hash} result={result} ms={}\n",
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
    sql.len(),
    elapsed.as_millis(),
  );
  // 写不进日志不该让查询失败：留痕是给人事后看的，不是这次调用的一部分
  let _ = append(log_dir, &line);
}

fn append(log_dir: &Path, line: &str) -> std::io::Result<()> {
  std::fs::create_dir_all(log_dir)?;
  let path = log_dir.join(AUDIT_FILE);
  if std::fs::metadata(&path).map(|meta| meta.len() > MAX_BYTES).unwrap_or(false) {
    std::fs::rename(&path, log_dir.join(format!("{AUDIT_FILE}.1")))?;
  }
  let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
  file.write_all(line.as_bytes())
}
