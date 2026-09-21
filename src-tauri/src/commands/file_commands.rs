use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::path::{Path, PathBuf};

/// 把导出内容写到用户在保存对话框里选定的路径。
///
/// 没有引入 `tauri-plugin-fs`：保存对话框返回的是任意路径，用插件就得把
/// 写权限的 scope 开到整个主目录，而这里真正需要的只有「写一个文件」。
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<u64, String> {
  let target = PathBuf::from(&path);

  // 目录不存在时 `fs::write` 报的是 "No such file or directory (os error 2)"，
  // 指向的却是文件本身，看的人会以为路径拼错了。先点名说是父目录。
  if let Some(parent) = target.parent() {
    if !parent.as_os_str().is_empty() && !parent.exists() {
      return Err(format!("目录不存在: {}", parent.display()));
    }
  }

  std::fs::write(&target, contents.as_bytes())
    .map_err(|e| format!("写入 {} 失败: {}", target.display(), e))?;

  file_size(&target)
}

fn file_size(path: &Path) -> Result<u64, String> {
  std::fs::metadata(path)
    .map(|metadata| metadata.len())
    .map_err(|e| format!("读取 {} 大小失败: {}", path.display(), e))
}

/// 把 base64 编码的二进制内容写到用户选定的路径。
///
/// 位图（ER 图导出的 PNG）没法走 `write_text_file`。走 base64 而不是
/// JS 数字数组：后者经 IPC 序列化成 JSON 会把体积撑到四倍左右。
#[tauri::command]
pub async fn write_binary_file(path: String, contents_base64: String) -> Result<u64, String> {
  let bytes = STANDARD
    .decode(contents_base64.as_bytes())
    .map_err(|e| format!("内容不是合法的 base64: {}", e))?;

  let target = PathBuf::from(&path);
  if let Some(parent) = target.parent() {
    if !parent.as_os_str().is_empty() && !parent.exists() {
      return Err(format!("目录不存在: {}", parent.display()));
    }
  }

  std::fs::write(&target, &bytes).map_err(|e| format!("写入 {} 失败: {}", target.display(), e))?;

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
pub async fn read_text_file(path: String) -> Result<String, String> {
  let target = PathBuf::from(&path);

  let size = file_size(&target)?;
  if size > MAX_TEXT_FILE_BYTES {
    return Err(format!(
      "{} 有 {:.1} MB，超过了 {} MB 的上限",
      target.display(),
      size as f64 / (1024.0 * 1024.0),
      MAX_TEXT_FILE_BYTES / (1024 * 1024)
    ));
  }

  // 不是 UTF-8 时点名说是编码问题。`read_to_string` 的原话是
  // "stream did not contain valid UTF-8"，看的人会以为文件坏了
  std::fs::read(&target).map_err(|e| format!("读取 {} 失败: {}", target.display(), e)).and_then(
    |bytes| {
      String::from_utf8(bytes).map_err(|_| format!("{} 不是 UTF-8 编码的文本", target.display()))
    },
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn writes_utf8_contents_and_reports_byte_length() {
    let dir = std::env::temp_dir().join(format!("dataomni-export-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let target = dir.join("export.csv");

    // BOM 由前端拼在字符串最前面，这里验证它确实落成 EF BB BF 三个字节
    let written =
      write_text_file(target.to_string_lossy().to_string(), "\u{feff}名,值\n中文,1".to_string())
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
    assert!(error.contains("base64"), "错误要说清是编码的问题: {}", error);
    assert!(!target.exists(), "解码失败时不该留下半个文件");
  }

  #[tokio::test]
  async fn reads_utf8_text_back() {
    let dir = std::env::temp_dir().join(format!("dataomni-read-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let target = dir.join("script.sql");
    std::fs::write(&target, "SELECT '中文' FROM t;\n").expect("write");

    let contents = read_text_file(target.to_string_lossy().to_string()).await.expect("read");
    assert_eq!(contents, "SELECT '中文' FROM t;\n");

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
    assert!(error.contains("上限"), "错误要说清是大小的问题并给出限额: {}", error);

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
    assert!(error.contains("UTF-8"), "错误要点名编码而不是说文件坏了: {}", error);

    std::fs::remove_dir_all(&dir).ok();
  }

  #[tokio::test]
  async fn missing_directory_is_named_in_the_error() {
    let target =
      std::env::temp_dir().join("dataomni-no-such-dir").join("nested").join("export.csv");

    let error = write_text_file(target.to_string_lossy().to_string(), "x".to_string())
      .await
      .expect_err("should fail");

    assert!(error.contains("目录不存在"), "错误里要点名目录: {}", error);
  }
}
