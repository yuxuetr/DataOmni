//! 应用自身的信息：报缺陷时要带上的诊断信息，和日志文件在哪。

use tauri::{AppHandle, Manager};

/// 日志文件名（不带扩展名）。`tauri-plugin-log` 写到系统的应用日志目录下，加上 `.log`
pub const LOG_FILE_NAME: &str = "dataomni";
/// 日志所在的文件夹打不开：系统没有文件管理器可调，或者日志目录取不到
pub const LOG_REVEAL_FAILED: &str = "DATAOMNI_LOG_REVEAL_FAILED";
/// 没问到最新版本：离线、被墙、GitHub 限流，或者回答的形状不对。启动时的检查不显示它，只进日志
pub const UPDATE_CHECK_FAILED: &str = "DATAOMNI_UPDATE_CHECK_FAILED";

const LATEST_RELEASE_API: &str = "https://api.github.com/repos/yuxuetr/DataOmni/releases/latest";
const RELEASE_PAGE: &str = "https://github.com/yuxuetr/DataOmni/releases/tag/v";
const UPDATE_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Debug, serde::Serialize)]
pub struct Diagnostics {
  pub app_version: String,
  pub os: &'static str,
  pub arch: &'static str,
  /// WebView 的版本：WKWebView、WebView2、WebKitGTK。界面上的怪事多半跟它走
  pub webview_version: Option<String>,
  pub ai: bool,
  pub log_file: Option<String>,
}

fn log_file(app: &AppHandle) -> Option<std::path::PathBuf> {
  app.path().app_log_dir().ok().map(|dir| dir.join(format!("{LOG_FILE_NAME}.log")))
}

#[tauri::command]
pub fn diagnostics(app: AppHandle) -> Diagnostics {
  Diagnostics {
    app_version: app.package_info().version.to_string(),
    os: std::env::consts::OS,
    arch: std::env::consts::ARCH,
    webview_version: tauri::webview_version().ok(),
    ai: cfg!(feature = "ai"),
    log_file: log_file(&app).map(|path| path.display().to_string()),
  }
}

/// 在文件管理器里选中日志文件。还没写过日志时文件不存在，就打开它所在的目录
#[tauri::command]
pub fn reveal_log_file(app: AppHandle) -> Result<(), String> {
  let path = log_file(&app).ok_or_else(|| LOG_REVEAL_FAILED.to_string())?;
  let target =
    if path.exists() { path } else { path.parent().map(|dir| dir.to_path_buf()).unwrap_or(path) };
  tauri_plugin_opener::reveal_item_in_dir(&target)
    .map_err(|error| format!("{LOG_REVEAL_FAILED}: {error}"))
}

/// GitHub 的 latest release 回答里取版本号，去掉开头的 `v`。
/// 草稿和预发布不会出现在 `/releases/latest` 里，所以 `v1.0.0-rc.1` 不会被提示给用户
fn latest_version(body: &str) -> Option<String> {
  let value: serde_json::Value = serde_json::from_str(body).ok()?;
  let tag = value.get("tag_name")?.as_str()?;
  let version = tag.strip_prefix('v').unwrap_or(tag);
  is_version(version).then(|| version.to_string())
}

/// 只认版本号会用到的字符：它要拼进打开的网址里
fn is_version(text: &str) -> bool {
  !text.is_empty()
    && text
      .chars()
      .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
}

/// 问 GitHub 最新发布的版本号。走系统代理（不加 `no_proxy`）：要翻出去的人本来就配着代理
#[tauri::command]
pub async fn latest_release() -> Result<String, String> {
  let failed = |error: &dyn std::fmt::Display| format!("{UPDATE_CHECK_FAILED}: {error}");
  let client = reqwest::Client::builder()
    .timeout(UPDATE_CHECK_TIMEOUT)
    // GitHub API 不带 User-Agent 直接 403
    .user_agent(concat!("DataOmni/", env!("CARGO_PKG_VERSION")))
    .build()
    .map_err(|error| failed(&error))?;
  let response = client
    .get(LATEST_RELEASE_API)
    .header("Accept", "application/vnd.github+json")
    .send()
    .await
    .map_err(|error| failed(&error))?;
  let status = response.status();
  let body = response.text().await.map_err(|error| failed(&error))?;
  if !status.is_success() {
    return Err(failed(&status));
  }
  let version = latest_version(&body).ok_or_else(|| failed(&"tag_name"))?;
  log::info!("最新发布的版本: {version}");
  Ok(version)
}

/// 在浏览器里打开某个版本的发布页。网址在这里拼，前端只给版本号——不给前端开一个「打开任意网址」的口子
#[tauri::command]
pub fn open_release_page(version: String) -> Result<(), String> {
  if !is_version(&version) {
    return Err(format!("{UPDATE_CHECK_FAILED}: {version}"));
  }
  tauri_plugin_opener::open_url(format!("{RELEASE_PAGE}{version}"), None::<&str>)
    .map_err(|error| format!("{UPDATE_CHECK_FAILED}: {error}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn takes_the_version_from_the_latest_release() {
    let body = r#"{"tag_name":"v0.6.0","name":"DataOmni v0.6.0","draft":false,"prerelease":false}"#;
    assert_eq!(latest_version(body), Some("0.6.0".to_string()));
    assert_eq!(latest_version(r#"{"tag_name":"1.0.0-rc.1"}"#), Some("1.0.0-rc.1".to_string()));
  }

  #[test]
  fn rejects_answers_that_are_not_a_release() {
    // 限流时的回答：没有 tag_name
    assert_eq!(latest_version(r#"{"message":"API rate limit exceeded"}"#), None);
    assert_eq!(latest_version("<html>"), None);
    // 拼进网址的字符只能是版本号的字符
    assert_eq!(latest_version(r#"{"tag_name":"v1.0/../../evil"}"#), None);
    assert!(open_release_page("1.0.0?x=1".to_string()).is_err());
  }
}
