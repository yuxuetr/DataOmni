/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { forwardLogs, type LogSink } from './logRedaction';

describe('前端转进日志文件的输出', () => {
  let uninstall: (() => void) | null = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  function capture(): { level: string; message: string }[] {
    const received: { level: string; message: string }[] = [];
    const sink: LogSink = (level, message) => received.push({ level, message });
    uninstall = forwardLogs(sink);
    return received;
  }

  it('warn 与 error 转过去，并且先脱敏', () => {
    const received = capture();
    console.error('连接失败', 'postgres://app:hunter2@db:5432/app', { password: 'hunter2', port: 5432 });
    console.warn('慢', new Error('token=abc123 过期'));

    expect(received).toHaveLength(2);
    expect(received[0]?.level).toBe('error');
    expect(received[0]?.message).toContain('postgres://app:***@db:5432/app');
    expect(received[0]?.message).toContain('"port":5432');
    expect(received.map((entry) => entry.message).join('\n')).not.toMatch(/hunter2|abc123/);
    expect(received[1]?.level).toBe('warn');
    expect(received[1]?.message).toContain('token=***');
  });

  it('没接住的异常与被拒的 Promise 也进日志', () => {
    const received = capture();
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('渲染外抛的'), message: '渲染外抛的' }));
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = new Error('mysql://root:pw@h 拒绝');
    window.dispatchEvent(rejection);

    expect(received.map((entry) => entry.level)).toEqual(['error', 'error']);
    expect(received[0]?.message).toContain('渲染外抛的');
    expect(received[1]?.message).toContain('mysql://root:***@h');
  });

  it('log 与 info 不转：那是开发时看的，进文件只是噪音', () => {
    const received = capture();
    console.log('render');
    console.info('ready');
    expect(received).toEqual([]);
  });
});
