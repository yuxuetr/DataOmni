import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { installConsoleRedaction } from "./utils/logRedaction";
import { restoreWorkspaceFromSnapshot } from "./utils/workspacePersistence";

installConsoleRedaction();
// 必须在首次渲染前恢复，否则 App 的保存 effect 会先写出一份空快照
restoreWorkspaceFromSnapshot();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
