//! 应用自身的信息：报缺陷时要带上的诊断信息，和日志文件在哪。

use tauri::{AppHandle, Manager};

/// 日志文件名（不带扩展名）。`tauri-plugin-log` 写到系统的应用日志目录下，加上 `.log`
pub const LOG_FILE_NAME: &str = "dataomni";
/// 日志所在的文件夹打不开：系统没有文件管理器可调，或者日志目录取不到
pub const LOG_REVEAL_FAILED: &str = "DATAOMNI_LOG_REVEAL_FAILED";

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
