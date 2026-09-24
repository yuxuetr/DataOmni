import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { RenderErrorBoundary } from "./components/RenderErrorBoundary";
import "./index.css";
import { installConsoleRedaction } from "./utils/logRedaction";
import { restoreWorkspaceFromSnapshot } from "./utils/workspacePersistence";
import { initializeTheme } from "./utils/theme";
import { initializeLanguage } from "./i18n/language";

installConsoleRedaction();
// 在首次渲染前落地主题，否则深色偏好下会先闪一帧浅色
initializeTheme();
// 同理：先把 <html lang> 写好，字体回落与断行规则从第一帧就对
initializeLanguage();
// 必须在首次渲染前恢复，否则 App 的保存 effect 会先写出一份空快照
restoreWorkspaceFromSnapshot();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RenderErrorBoundary scope="app">
      <App />
    </RenderErrorBoundary>
  </React.StrictMode>,
);
