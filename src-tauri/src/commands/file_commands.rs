use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::path::{Path, PathBuf};

/// 要写进去的目录不存在。数据里带的是目录路径
pub const DIRECTORY_MISSING: &str = "DATAOMNI_DIRECTORY_MISSING";
/// 写文件失败。数据是 `路径 · 操作系统给的原因`
pub const FILE_WRITE_FAILED: &str = "DATAOMNI_FILE_WRITE_FAILED";
pub const FILE_READ_FAILED: &str = "DATAOMNI_FILE_READ_FAILED";
pub const FILE_SIZE_FAILED: &str = "DATAOMNI_FILE_SIZE_FAILED";
pub const BASE64_INVALID: &str = "DATAOMNI_BASE64_INVALID";
/// 打开的 SQL 文件不是 UTF-8。数据里带的是路径
pub const FILE_NOT_UTF8: &str = "DATAOMNI_FILE_NOT_UTF8";
/// 文件超过读取上限。数据是 `路径 · 实际大小 · 上限`
pub const FILE_TOO_LARGE: &str = "DATAOMNI_FILE_TOO_LARGE";
/// 要写的文件已经有了，一个都没写。数据是已有的那些路径，用 `, ` 隔开
pub const FILES_EXIST: &str = "DATAOMNI_FILES_EXIST";
/// 相对路径不合规矩（绝对路径、带 `..`、空的）。数据里带的是那条路径
pub const RELATIVE_PATH_INVALID: &str = "DATAOMNI_RELATIVE_PATH_INVALID";
/// 路径落在应用自己的配置目录里。数据里带的是那条路径
pub const PATH_RESERVED: &str = "DATAOMNI_PATH_RESERVED";

/// 下面三个命令收前端给的任意路径（不引入 `tauri-plugin-fs` 的取舍见 `write_text_file`）。
/// CSP 挡住了外来脚本，这一道是万一没挡住时的第二层：前端脚本不能借它们读改
/// `connections.json`（连接配置与 Agent 授权）以及同目录下的 CLI 审计记录
fn refuse_reserved_path(target: &Path) -> Result<(), String> {
  match crate::services::connection_service::app_config_dir() {
    Some(reserved) => refuse_inside(target, &reserved),
    None => Ok(()),
  }
}

fn refuse_inside(target: &Path, reserved: &Path) -> Result<(), String> {
  let reserved = reserved.canonicalize().unwrap_or_else(|_| reserved.to_path_buf());
  if resolve_for_comparison(target).starts_with(&reserved) {
    return Err(format!("{PATH_RESERVED}: {}", target.display()));
  }
  Ok(())
}

/// 解开符号链接与 `..` 再比。文件可能还不存在（另存为），那就规范化父目录再接上文件名
fn resolve_for_comparison(target: &Path) -> PathBuf {
  if let Ok(resolved) = target.canonicalize() {
    return resolved;
  }
  match (target.parent(), target.file_name()) {
    (Some(parent), Some(name)) => {
      parent.canonicalize().map(|dir| dir.join(name)).unwrap_or_else(|_| target.to_path_buf())
    }
    _ => target.to_path_buf(),
  }
}

/// 把导出内容写到用户在保存对话框里选定的路径。
///
/// 没有引入 `tauri-plugin-fs`：保存对话框返回的是任意路径，用插件就得把
/// 写权限的 scope 开到整个主目录，而这里真正需要的只有「写一个文件」。
/// 文本文件的编码。只认得出 UTF-8 与带 BOM 的 UTF-16——后者是 SSMS「生成脚本」默认的
/// 「Unicode 文本」与 Windows PowerShell `Out-File` 的输出；不带 BOM 的单字节编码猜不准，不猜
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TextEncoding {
  #[serde(rename = "utf-8")]
  Utf8,
  #[serde(rename = "utf-16le")]
  Utf16Le,
  #[serde(rename = "utf-16be")]
  Utf16Be,
}

#[derive(Debug, serde::Serialize)]
pub struct TextFile {
  /// 解码后的文本。BOM 留在开头（U+FEFF），由前端记下、存回去时补上
  pub contents: String,
  pub encoding: TextEncoding,
}

fn encode_text(contents: &str, encoding: TextEncoding) -> Vec<u8> {
  match encoding {
    TextEncoding::Utf8 => contents.as_bytes().to_vec(),
    TextEncoding::Utf16Le => contents.encode_utf16().flat_map(u16::to_le_bytes).collect(),
    TextEncoding::Utf16Be => contents.encode_utf16().flat_map(u16::to_be_bytes).collect(),
  }
}

#[tauri::command]
pub async fn write_text_file(
  path: String,
  contents: String,
  encoding: Option<TextEncoding>,
) -> Result<u64, String> {
  let target = PathBuf::from(&path);
  refuse_reserved_path(&target)?;

  // 目录不存在时 `fs::write` 报的是 "No such file or directory (os error 2)"，
  // 指向的却是文件本身，看的人会以为路径拼错了。先点名说是父目录。
  if let Some(parent) = target.parent() {
    if !parent.as_os_str().is_empty() && !parent.exists() {
      return Err(format!("{DIRECTORY_MISSING}: {}", parent.display()));
    }
  }

  std::fs::write(&target, encode_text(&contents, encoding.unwrap_or(TextEncoding::Utf8)))
    .map_err(|e| format!("{FILE_WRITE_FAILED}: {} · {e}", target.display()))?;

  file_size(&target)
}

fn file_size(path: &Path) -> Result<u64, String> {
  std::fs::metadata(path)
    .map(|metadata| metadata.len())
    .map_err(|e| format!("{FILE_SIZE_FAILED}: {} · {e}", path.display()))
}

/// 把 base64 编码的二进制内容写到用户选定的路径。
///
/// 位图（ER 图导出的 PNG）没法走 `write_text_file`。走 base64 而不是
/// JS 数字数组：后者经 IPC 序列化成 JSON 会把体积撑到四倍左右。
#[tauri::command]
pub async fn write_binary_file(path: String, contents_base64: String) -> Result<u64, String> {
  let bytes =
    STANDARD.decode(contents_base64.as_bytes()).map_err(|e| format!("{BASE64_INVALID}: {e}"))?;

  let target = PathBuf::from(&path);
  refuse_reserved_path(&target)?;
  if let Some(parent) = target.parent() {
    if !parent.as_os_str().is_empty() && !parent.exists() {
      return Err(format!("{DIRECTORY_MISSING}: {}", parent.display()));
    }
  }

  std::fs::write(&target, &bytes)
    .map_err(|e| format!("{FILE_WRITE_FAILED}: {} · {e}", target.display()))?;

  file_size(&target)
}

/// 一次读进来的文本上限。
///
/// SQL 脚本动辄是几百 MB 的整库转储，整份读进 JS 字符串再灌进编辑器会让
/// 窗口直接卡死，而用户看到的只是「点了没反应」。宁可在这里干净地拒绝，
/// 并把限额说出来。
const MAX_TEXT_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// 读用户在打开对话框里选中的文本文件（`.sql` 脚本）。
///
/// 同样没有引入 `tauri-plugin-fs`：这里真正需要的只有「读一个用户刚刚亲自
/// 选中的文件」，用插件就得把读权限的 scope 开到整个主目录。
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<TextFile, String> {
  let target = PathBuf::from(&path);
  refuse_reserved_path(&target)?;

  let size = file_size(&target)?;
  if size > MAX_TEXT_FILE_BYTES {
    return Err(format!(
      "{FILE_TOO_LARGE}: {} · {:.1} MB · {} MB",
      target.display(),
      size as f64 / (1024.0 * 1024.0),
      MAX_TEXT_FILE_BYTES / (1024 * 1024)
    ));
  }

  // 不是 UTF-8 时点名说是编码问题。`read_to_string` 的原话是
  // "stream did not contain valid UTF-8"，看的人会以为文件坏了
  let bytes = std::fs::read(&target)
    .map_err(|e| format!("{FILE_READ_FAILED}: {} · {e}", target.display()))?;
  let not_text = || format!("{FILE_NOT_UTF8}: {}", target.display());
  let encoding = match encoding_rs::Encoding::for_bom(&bytes) {
    Some((found, _)) if found == encoding_rs::UTF_16LE => TextEncoding::Utf16Le,
    Some((found, _)) if found == encoding_rs::UTF_16BE => TextEncoding::Utf16Be,
    _ => {
      let contents = String::from_utf8(bytes).map_err(|_| not_text())?;
      return Ok(TextFile { contents, encoding: TextEncoding::Utf8 });
    }
  };
  // 奇数个字节就不是 UTF-16。BOM 本身也解码出来（U+FEFF），和 UTF-8 的 BOM 一样交给前端
  if bytes.len() % 2 != 0 {
    return Err(not_text());
  }
  let (pairs, _) = bytes.as_chunks::<2>();
  let units = pairs.iter().map(|&pair| match encoding {
    TextEncoding::Utf16Be => u16::from_be_bytes(pair),
    _ => u16::from_le_bytes(pair),
  });
  let contents =
    char::decode_utf16(units).collect::<Result<String, _>>().map_err(|_| not_text())?;
  Ok(TextFile { contents, encoding })
}

#[derive(Debug, serde::Deserialize)]
pub struct NewTextFile {
  /// 相对 `directory` 的路径，`/` 分隔，可以带子目录
  pub path: String,
  pub contents: String,
}

/// 把一组生成的文件（代码生成的实体，一张表一个）写进用户选的目录。
///
/// **只写新文件**：有任何一个已经存在就一个都不写，报出是哪几个。生成的实体常常被人改过，
/// 悄悄盖掉就丢了改动；写一半停下又会留下一套对不上的文件。先全部查过再动手。
/// 路径只收相对的、不带 `..` 的：文件名来自表名，表名是库里的数据，不能让它把文件写到目录外面去。
#[tauri::command]
pub async fn write_new_text_files(
  directory: String,
  files: Vec<NewTextFile>,
) -> Result<Vec<String>, String> {
  let root = PathBuf::from(&directory);
  refuse_reserved_path(&root)?;
  if !root.is_dir() {
    return Err(format!("{DIRECTORY_MISSING}: {}", root.display()));
  }
  let mut targets = Vec::with_capacity(files.len());
  for file in &files {
    let relative = Path::new(&file.path);
    let safe = !file.path.is_empty()
      && relative.components().all(|part| matches!(part, std::path::Component::Normal(_)));
    if !safe {
      return Err(format!("{RELATIVE_PATH_INVALID}: {}", file.path));
    }
    targets.push(root.join(relative));
  }
  let existing: Vec<String> = targets
    .iter()
    .filter(|target| target.exists())
    .map(|target| target.display().to_string())
    .collect();
  if !existing.is_empty() {
    return Err(format!("{FILES_EXIST}: {}", existing.join(", ")));
  }
  for (target, file) in targets.iter().zip(&files) {
    if let Some(parent) = target.parent() {
      std::fs::create_dir_all(parent)
        .map_err(|e| format!("{FILE_WRITE_FAILED}: {} · {e}", parent.display()))?;
    }
    std::fs::write(target, file.contents.as_bytes())
      .map_err(|e| format!("{FILE_WRITE_FAILED}: {} · {e}", target.display()))?;
  }
  Ok(targets.iter().map(|target| target.display().to_string()).collect())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn refuses_paths_inside_the_reserved_directory_even_through_dot_dot_and_symlinks() {
    let root = std::env::temp_dir().join(format!("dataomni-reserved-{}", std::process::id()));
    let reserved = root.join("config");
    let elsewhere = root.join("exports");
    std::fs::create_dir_all(&reserved).expect("reserved dir");
    std::fs::create_dir_all(&elsewhere).expect("other dir");
    std::fs::write(reserved.join("connections.json"), "{}").expect("seed");

    // 已有的文件、要新建的文件、绕一圈 `..` 回来的，都拒
    assert!(refuse_inside(&reserved.join("connections.json"), &reserved)
      .is_err_and(|error| error.starts_with(PATH_RESERVED)));
    assert!(refuse_inside(&reserved.join("new.sql"), &reserved).is_err());
    assert!(refuse_inside(&elsewhere.join("../config/connections.json"), &reserved).is_err());
    #[cfg(unix)]
    {
      let link = elsewhere.join("innocent.json");
      std::os::unix::fs::symlink(reserved.join("connections.json"), &link).expect("symlink");
      assert!(refuse_inside(&link, &reserved).is_err(), "符号链接指进去的也要拒");
    }

    // 旁边的目录、名字以它开头的兄弟目录照常放行
    assert!(refuse_inside(&elsewhere.join("report.csv"), &reserved).is_ok());
    let sibling = root.join("config-backup");
    std::fs::create_dir_all(&sibling).expect("sibling");
    assert!(refuse_inside(&sibling.join("a.sql"), &reserved).is_ok());

    std::fs::remove_dir_all(&root).ok();
  }

  fn new_file(path: &str, contents: &str) -> NewTextFile {
    NewTextFile { path: path.to_string(), contents: contents.to_string() }
  }

  #[tokio::test]
  async fn writes_new_files_into_subdirectories() {
    let dir = std::env::temp_dir().join(format!("dataomni-new-files-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let written = write_new_text_files(
      dir.to_string_lossy().to_string(),
      vec![new_file("users.entity.ts", "a"), new_file("entities/mod.rs", "b")],
    )
    .await
    .expect("write");
    assert_eq!(written.len(), 2);
    assert_eq!(std::fs::read_to_string(dir.join("entities/mod.rs")).expect("read"), "b");
    std::fs::remove_dir_all(&dir).ok();
  }

  #[tokio::test]
  async fn writes_nothing_when_any_file_already_exists() {
    let dir = std::env::temp_dir().join(format!("dataomni-existing-files-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    std::fs::write(dir.join("b.ts"), "edited by hand").expect("seed");
    let error = write_new_text_files(
      dir.to_string_lossy().to_string(),
      vec![new_file("a.ts", "new"), new_file("b.ts", "new")],
    )
    .await
    .expect_err("must refuse");
    assert!(error.starts_with(FILES_EXIST), "{error}");
    assert!(!dir.join("a.ts").exists(), "前面那个也不能写：写一半会留下一套对不上的文件");
    assert_eq!(std::fs::read_to_string(dir.join("b.ts")).expect("read"), "edited by hand");
    std::fs::remove_dir_all(&dir).ok();
  }

  #[tokio::test]
  async fn refuses_paths_that_leave_the_directory() {
    let dir = std::env::temp_dir().join(format!("dataomni-escape-files-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    for path in ["../x.ts", "/tmp/x.ts", "", "a/../../x.ts"] {
      let error =
        write_new_text_files(dir.to_string_lossy().to_string(), vec![new_file(path, "x")])
          .await
          .expect_err("must refuse");
      assert!(error.starts_with(RELATIVE_PATH_INVALID), "{path}: {error}");
    }
    std::fs::remove_dir_all(&dir).ok();
  }

  #[tokio::test]
  async fn writes_utf8_contents_and_reports_byte_length() {
    let dir = std::env::temp_dir().join(format!("dataomni-export-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let target = dir.join("export.csv");

    // BOM 由前端拼在字符串最前面，这里验证它确实落成 EF BB BF 三个字节
    let written = write_text_file(
      target.to_string_lossy().to_string(),
      "\u{feff}名,值\n中文,1".to_string(),
      None,
    )
    .await
    .expect("write");

    let bytes = std::fs::read(&target).expect("read back");
    assert_eq!(&bytes[..3], &[0xef, 0xbb, 0xbf]);
    assert_eq!(written, bytes.len() as u64);

    std::fs::remove_dir_all(&dir).ok();
  }

  #[tokio::test]
  async fn writes_decoded_bytes_not_the_base64_text() {
    let dir = std::env::temp_dir().join(format!("dataomni-bin-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let target = dir.join("out.png");

    // PNG 的魔数；存成 base64 原文的话头四个字节会是 "iVBO"
    let png_header = [0x89u8, 0x50, 0x4e, 0x47];
    let encoded = STANDARD.encode(png_header);

    let written =
      write_binary_file(target.to_string_lossy().to_string(), encoded).await.expect("write");

    let bytes = std::fs::read(&target).expect("read back");
    assert_eq!(bytes, png_header);
    assert_eq!(written, 4);

    std::fs::remove_dir_all(&dir).ok();
  }

  #[tokio::test]
  async fn rejects_content_that_is_not_base64() {
    let target = std::env::temp_dir().join("dataomni-bad-base64.bin");
    let error = write_binary_file(target.to_string_lossy().to_string(), "not base64!!".into())
      .await
      .expect_err("should fail");
    assert!(error.starts_with(BASE64_INVALID), "错误要说清是编码的问题: {error}");
    assert!(!target.exists(), "解码失败时不该留下半个文件");
  }

  #[tokio::test]
  async fn reads_utf8_text_back() {
    let dir = std::env::temp_dir().join(format!("dataomni-read-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let target = dir.join("script.sql");
    std::fs::write(&target, "SELECT '中文' FROM t;\n").expect("write");

    let file = read_text_file(target.to_string_lossy().to_string()).await.expect("read");
    assert_eq!(file.contents, "SELECT '中文' FROM t;\n");
    assert_eq!(file.encoding, TextEncoding::Utf8);

    std::fs::remove_dir_all(&dir).ok();
  }

  /// SSMS「生成脚本」默认存成「Unicode 文本」，即带 BOM 的 UTF-16LE。原先一律报「不是 UTF-8」，
  /// SQL Server 用户手里最常见的那种脚本打不开
  #[tokio::test]
  async fn reads_utf16_with_a_bom_and_writes_it_back_the_same_way() {
    let dir = std::env::temp_dir().join(format!("dataomni-utf16-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let text = "\u{feff}SELECT N'中文😀' FROM t;\r\nGO\r\n";

    for (name, encoding) in [("le.sql", TextEncoding::Utf16Le), ("be.sql", TextEncoding::Utf16Be)] {
      let target = dir.join(name);
      std::fs::write(&target, encode_text(text, encoding)).expect("write");
      let path = target.to_string_lossy().to_string();

      let file = read_text_file(path.clone()).await.expect("read");
      assert_eq!(file.contents, text);
      assert_eq!(file.encoding, encoding);

      write_text_file(path, file.contents, Some(file.encoding)).await.expect("write back");
      assert_eq!(std::fs::read(&target).expect("read back"), encode_text(text, encoding));
    }
    // 小端的 BOM 是 FF FE
    assert_eq!(&encode_text("\u{feff}", TextEncoding::Utf16Le), &[0xff, 0xfe]);

    std::fs::remove_dir_all(&dir).ok();
  }

  #[tokio::test]
  async fn refuses_a_file_over_the_size_limit() {
    let dir = std::env::temp_dir().join(format!("dataomni-big-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let target = dir.join("dump.sql");
    // 比上限多一个字节就该被拒，而不是「差不多就放过」
    std::fs::write(&target, vec![b'-'; (MAX_TEXT_FILE_BYTES + 1) as usize]).expect("write");

    let error =
      read_text_file(target.to_string_lossy().to_string()).await.expect_err("should refuse");
    assert!(error.starts_with(FILE_TOO_LARGE), "要带错误码: {error}");
    // 码后面要带上实际大小和限额，否则用户不知道差多少
    assert!(error.contains("MB"), "错误里要给出大小和限额: {error}");

    std::fs::remove_dir_all(&dir).ok();
  }

  #[tokio::test]
  async fn names_encoding_as_the_problem_for_non_utf8() {
    let dir = std::env::temp_dir().join(format!("dataomni-gbk-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let target = dir.join("gbk.sql");
    // GBK 的「中文」两个字，在 UTF-8 下不是合法序列
    std::fs::write(&target, [0xd6u8, 0xd0, 0xce, 0xc4]).expect("write");

    let error =
      read_text_file(target.to_string_lossy().to_string()).await.expect_err("should refuse");
    assert!(error.starts_with(FILE_NOT_UTF8), "错误要点名编码而不是说文件坏了: {error}");

    std::fs::remove_dir_all(&dir).ok();
  }

  #[tokio::test]
  async fn missing_directory_is_named_in_the_error() {
    let target =
      std::env::temp_dir().join("dataomni-no-such-dir").join("nested").join("export.csv");

    let error = write_text_file(target.to_string_lossy().to_string(), "x".to_string(), None)
      .await
      .expect_err("should fail");

    assert!(error.starts_with(DIRECTORY_MISSING), "要带错误码: {error}");
    // 码后面必须跟上是哪个目录，否则用户只知道「有个目录不存在」
    assert!(error.contains("dataomni-no-such-dir"), "错误里要点名目录: {error}");
  }
}
