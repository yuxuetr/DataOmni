import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { RenderErrorBoundary } from "./components/RenderErrorBoundary";
import "./index.css";
import { warn as logWarn, error as logError } from "@tauri-apps/plugin-log";
import { forwardLogs, installConsoleRedaction } from "./utils/logRedaction";
import { restoreWorkspaceFromSnapshot } from "./utils/workspacePersistence";
import { initializeTheme } from "./utils/theme";
import { initializeLanguage } from "./i18n/language";
import { installNativeContextMenuGuard } from "./utils/nativeContextMenu";
import { applyFontSettings, applyUiZoom, loadFontSettings } from "./utils/fontSettings";

installConsoleRedaction();
// 打包版没有开发者工具：warn / error 与没接住的异常进日志文件（设置 → 关于与诊断）
forwardLogs((level, message) => {
  void (level === "error" ? logError(message) : logWarn(message)).catch(() => undefined);
});
if (import.meta.env.PROD) {
  installNativeContextMenuGuard();
}
// 在首次渲染前落地主题，否则深色偏好下会先闪一帧浅色
initializeTheme();
// 同理：先把 <html lang> 写好，字体回落与断行规则从第一帧就对
initializeLanguage();
// 字体与字号同样首帧前落地；缩放是 WebView 的，只有不是 100% 时才去设
const fontSettings = loadFontSettings();
applyFontSettings(fontSettings);
if (fontSettings.uiZoom !== 1) {
  void applyUiZoom(fontSettings.uiZoom);
}
// 必须在首次渲染前恢复，否则 App 的保存 effect 会先写出一份空快照
restoreWorkspaceFromSnapshot();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RenderErrorBoundary scope="app">
      <App />
    </RenderErrorBoundary>
  </React.StrictMode>,
);
