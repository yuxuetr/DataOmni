import { describe, expect, it } from 'vitest';
import { diagnosticsReport } from './diagnostics';

describe('diagnosticsReport', () => {
  it('写成贴进 issue 的几行；不带日志路径——里面有本机用户名', () => {
    const report = diagnosticsReport(
      {
        app_version: '0.6.0',
        os: 'macos',
        arch: 'aarch64',
        webview_version: '621.1.15',
        ai: true,
        log_file: '/Users/someone/Library/Logs/com.dataomni.app/dataomni.log'
      },
      'zh'
    );
    expect(report).toBe([
      'DataOmni 0.6.0',
      'OS: macos (aarch64)',
      'WebView: 621.1.15',
      'AI: built in',
      'UI language: zh'
    ].join('\n'));
  });

  it('取不到 WebView 版本、没编进 AI 时照实写', () => {
    const report = diagnosticsReport(
      { app_version: '0.6.0', os: 'linux', arch: 'x86_64', webview_version: null, ai: false, log_file: null },
      'en'
    );
    expect(report).toContain('WebView: unknown');
    expect(report).toContain('AI: not in this build');
  });
});
