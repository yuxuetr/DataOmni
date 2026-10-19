//! SQLite 库文件的路径怎么交给驱动。
//!
//! Windows 上没开 `LongPathsEnabled` 时，超过 260 字符的路径 SQLite 打不开（`(code: 14) unable to open
//! database file`）：Rust 标准库自己会加 `\\?\`，SQLite 的 C 库不加。路径写成 `\\?\C:\…` 就过——
//! 打开、写、`VACUUM INTO` 在 Windows 上实测都行。DuckDB 会把这个前缀规范化掉，加了也没用，所以只用在 SQLite。
//!
//! sqlx 的 `sqlite:` 连接串会对路径做百分号解码，并在第一个 `?` 处切出参数：`\\?\` 得写成 `\\%3F\`，
//! 路径里本来就有的 `%` 也要写成 `%25`，否则文件夹叫 `a%20b` 时会被解成 `a b`。

use std::borrow::Cow;

/// 路径到这个长度就改写：SQLite 还要在旁边建 `-journal`、`-wal`，比 259 留出余量
const LONG_PATH_THRESHOLD: usize = 248;

/// Windows 上过长的绝对路径改写成 `\\?\` 形式（UNC 写成 `\\?\UNC\…`）；其余原样返回
pub fn sqlite_file_path(path: &str) -> Cow<'_, str> {
  if cfg!(windows) {
    windows_verbatim(path)
  } else {
    Cow::Borrowed(path)
  }
}

fn windows_verbatim(path: &str) -> Cow<'_, str> {
  if path.chars().count() < LONG_PATH_THRESHOLD
    || path.starts_with("\\\\?\\")
    || path.starts_with("\\\\.\\")
  {
    return Cow::Borrowed(path);
  }
  let normalized = path.replace('/', "\\");
  let bytes = normalized.as_bytes();
  let is_drive =
    bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\';
  // `\\?\` 关掉了 Windows 的路径规范化：`.`、`..` 不再被解释，这种路径不改写
  let has_dot_segment =
    normalized.split('\\').skip(1).any(|segment| segment == "." || segment == "..");
  if has_dot_segment {
    return Cow::Borrowed(path);
  }
  if is_drive {
    Cow::Owned(format!("\\\\?\\{normalized}"))
  } else if let Some(unc) = normalized.strip_prefix("\\\\") {
    Cow::Owned(format!("\\\\?\\UNC\\{unc}"))
  } else {
    Cow::Borrowed(path)
  }
}

/// `sqlite:` 连接串：`:memory:` 原样，文件路径先按 [`sqlite_file_path`] 改写，再把 `%` 与 `?` 编码
pub fn sqlite_connection_string(database: &str) -> String {
  if database == ":memory:" {
    return "sqlite::memory:".to_string();
  }
  let path = sqlite_file_path(database);
  format!("sqlite:{}", path.replace('%', "%25").replace('?', "%3F"))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn long_drive_path() -> String {
    format!(r"C:\{}\a.db", ["abcdefghijklmnopqrstuvwxyz"; 12].join(r"\"))
  }

  #[test]
  fn short_paths_and_memory_are_unchanged_apart_from_percent_and_question_mark() {
    assert_eq!(sqlite_connection_string(":memory:"), "sqlite::memory:");
    assert_eq!(sqlite_connection_string("/tmp/a.db"), "sqlite:/tmp/a.db");
    assert_eq!(sqlite_connection_string(r"D:\测试 数据\a.db"), r"sqlite:D:\测试 数据\a.db");
    // sqlx 会解码 `%`：不编码的话 `a%20b` 会变成 `a b`
    assert_eq!(sqlite_connection_string("/data/a%20b/x.db"), "sqlite:/data/a%2520b/x.db");
  }

  #[test]
  fn long_windows_paths_become_verbatim() {
    let drive = long_drive_path();
    assert_eq!(windows_verbatim(&drive), format!(r"\\?\{drive}"));
    let unc = format!(r"\\server\share\{}", &drive[3..]);
    assert_eq!(windows_verbatim(&unc), format!(r"\\?\UNC\server\share\{}", &drive[3..]));
    assert_eq!(windows_verbatim(&drive.replace('\\', "/")), format!(r"\\?\{drive}"));
  }

  // 反向：已经是 `\\?\` 的、相对路径、带 `..` 的、短路径，都不改写
  #[test]
  fn verbatim_leaves_what_it_cannot_safely_rewrite() {
    let drive = long_drive_path();
    let verbatim = format!(r"\\?\{drive}");
    assert_eq!(windows_verbatim(&verbatim), verbatim);
    let relative = drive[3..].to_string();
    assert_eq!(windows_verbatim(&relative), relative);
    let dotted = drive.replacen(r"\abc", r"\..\abc", 1);
    assert_eq!(windows_verbatim(&dotted), dotted);
    assert_eq!(windows_verbatim(r"C:\a.db"), r"C:\a.db");
  }

  #[cfg(windows)]
  #[test]
  fn long_windows_path_reaches_sqlx_as_verbatim() {
    use std::str::FromStr;
    let drive = long_drive_path();
    let options =
      sqlx::sqlite::SqliteConnectOptions::from_str(&sqlite_connection_string(&drive)).unwrap();
    assert_eq!(options.get_filename(), std::path::Path::new(&format!(r"\\?\{drive}")));
  }
}
