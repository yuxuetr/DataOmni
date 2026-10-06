import { invoke } from '@tauri-apps/api/core';

/** 后端 `diagnostics` 命令的回答 */
export interface Diagnostics {
  app_version: string;
  os: string;
  arch: string;
  webview_version: string | null;
  ai: boolean;
  log_file: string | null;
}

export function loadDiagnostics(): Promise<Diagnostics> {
  return invoke<Diagnostics>('diagnostics');
}

/**
 * 「复制诊断信息」复制出去的文字，是要贴进 issue 的。
 *
 * 固定写英文：不管报告的人用什么语言界面，看的人都按同一套字段读。日志路径不放进去，
 * 因为路径里有本机用户名；路径只在界面上显示，「在文件夹中显示」按钮直接定位到它
 */
export function diagnosticsReport(info: Diagnostics, language: string): string {
  return [
    `DataOmni ${info.app_version}`,
    `OS: ${info.os} (${info.arch})`,
    `WebView: ${info.webview_version ?? 'unknown'}`,
    `AI: ${info.ai ? 'built in' : 'not in this build'}`,
    `UI language: ${language}`
  ].join('\n');
}
