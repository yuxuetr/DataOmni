//! macOS 的应用菜单：照 Tauri 的默认菜单搭，只改 ⌘W 这一处。
//!
//! 默认菜单里 File 与 Window 各有一个 `close_window`，都占着 ⌘W。多标签的
//! 应用里 ⌘W 该关的是标签，而 macOS 上菜单的快捷键比 webview 先拿到按键——
//! 前端的 keydown 永远听不到这一下，只能在菜单这一层改。关窗口挪到 ⇧⌘W，
//! 和浏览器、编辑器的惯例一致。
//!
//! 只在 macOS 上装：Tauri 在另外两个平台本来就不装默认菜单，Ctrl+W 会进到
//! webview 里，由前端按同一份 `SHORTCUTS.closeTab` 处理。
//!
//! 其余各项必须原样保留，不是为了对称：WKWebView 里 ⌘C / ⌘V 靠 Edit 菜单里
//! 那几个 role 才生效，少了它们，文本框里连复制粘贴都不能用。

use tauri::menu::{
  AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// 前端 `App.tsx` 监听的事件名，改这里要一起改那边
pub const CLOSE_TAB_EVENT: &str = "menu://close-tab";
const CLOSE_TAB_ID: &str = "close-tab";
const CLOSE_WINDOW_ID: &str = "close-window";
/// `src/utils/shortcuts.test.ts` 读这两个常量，比对 `SHORTCUTS.closeTab`
const CLOSE_TAB_ACCELERATOR: &str = "CmdOrCtrl+W";
const CLOSE_WINDOW_ACCELERATOR: &str = "CmdOrCtrl+Shift+W";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
  let package = app.package_info();
  let config = app.config();
  let about = AboutMetadata {
    name: Some(package.name.clone()),
    version: Some(package.version.to_string()),
    copyright: config.bundle.copyright.clone(),
    authors: config.bundle.publisher.clone().map(|publisher| vec![publisher]),
    ..Default::default()
  };

  let close_tab =
    MenuItem::with_id(app, CLOSE_TAB_ID, "Close Tab", true, Some(CLOSE_TAB_ACCELERATOR))?;
  let close_window =
    MenuItem::with_id(app, CLOSE_WINDOW_ID, "Close Window", true, Some(CLOSE_WINDOW_ACCELERATOR))?;

  Menu::with_items(
    app,
    &[
      &Submenu::with_items(
        app,
        package.name.clone(),
        true,
        &[
          &PredefinedMenuItem::about(app, None, Some(about))?,
          &PredefinedMenuItem::separator(app)?,
          &PredefinedMenuItem::services(app, None)?,
          &PredefinedMenuItem::separator(app)?,
          &PredefinedMenuItem::hide(app, None)?,
          &PredefinedMenuItem::hide_others(app, None)?,
          &PredefinedMenuItem::separator(app)?,
          &PredefinedMenuItem::quit(app, None)?,
        ],
      )?,
      &Submenu::with_items(app, "File", true, &[&close_tab, &close_window])?,
      &Submenu::with_items(
        app,
        "Edit",
        true,
        &[
          &PredefinedMenuItem::undo(app, None)?,
          &PredefinedMenuItem::redo(app, None)?,
          &PredefinedMenuItem::separator(app)?,
          &PredefinedMenuItem::cut(app, None)?,
          &PredefinedMenuItem::copy(app, None)?,
          &PredefinedMenuItem::paste(app, None)?,
          &PredefinedMenuItem::select_all(app, None)?,
        ],
      )?,
      &Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?,
      // Window 里不再放 close_window：它自带的 ⌘W 改不掉，放着就又抢回去了。
      // 这两个 id 不是随便起的：Tauri 认出它们后交给 macOS 当「窗口菜单」和
      // 「帮助菜单」，前者自动列出打开的窗口，后者自带搜索菜单项的输入框
      &Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
      )?,
      &Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?,
    ],
  )
}

pub fn handle_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
  match id {
    // 关哪个标签、要不要先问一句草稿，全在前端：那些状态只有前端有
    CLOSE_TAB_ID => {
      if let Err(error) = app.emit(CLOSE_TAB_EVENT, ()) {
        eprintln!("发送关闭标签事件失败: {error}");
      }
    }
    CLOSE_WINDOW_ID => {
      let focused =
        app.webview_windows().into_values().find(|window| window.is_focused().unwrap_or(false));
      if let Some(window) = focused {
        if let Err(error) = window.close() {
          eprintln!("关闭窗口失败: {error}");
        }
      }
    }
    _ => {}
  }
}
