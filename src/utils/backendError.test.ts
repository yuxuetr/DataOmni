import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { zh } from '../i18n/zh';
import { parseBackendError } from './backendError';

describe('backendError', () => {
  it('带数据的码拆成文案键和数据两半', () => {
    const parsed = parseBackendError('DATAOMNI_UNSUPPORTED_DATABASE: MongoDB');
    expect(parsed).toEqual({ key: 'error.backend.unsupportedDatabase', detail: 'MongoDB' });
  });

  it('不带数据的码也认，数据是空串', () => {
    expect(parseBackendError('DATAOMNI_SSH_AUTH_REJECTED')).toEqual({
      key: 'error.backend.sshAuthRejected',
      detail: ''
    });
  });

  it('指纹里的冒号不会被当成分隔符', () => {
    // 只在**第一个**冒号处切开：指纹本身就长成 `SHA256:xxx`
    const parsed = parseBackendError(
      'DATAOMNI_SSH_HOST_KEY_CHANGED: SHA256:aaa → SHA256:bbb'
    );
    expect(parsed?.detail).toBe('SHA256:aaa → SHA256:bbb');
  });

  it('认不出的码返回 null，让调用方原样显示', () => {
    // 后端加了新错误而这里忘了配时走这条路——看到的是原串，不是空白
    expect(parseBackendError('DATAOMNI_SOMETHING_NEW: 细节')).toBeNull();
  });

  it('句子中间撞上大写词不算', () => {
    // 驱动的报错里有大写下划线的词是常事。把它当成码会换掉整句话，
    // 那比不翻译更糟
    expect(parseBackendError('error returned: DATAOMNI_HOST_REQUIRED')).toBeNull();
    expect(parseBackendError('connection refused')).toBeNull();
  });

  it('已有的 SESSION_PASSWORD_REQUIRED 不在表里，不能被改写', () => {
    // `useProfileConnector` 靠 `message.includes('SESSION_PASSWORD_REQUIRED')`
    // 认它。翻译掉就等于把未保存密码的连接流程拆了
    expect(parseBackendError('SESSION_PASSWORD_REQUIRED: 此连接未保存密码')).toBeNull();
  });

  it('后端定义的每个码，前端都有文案', () => {
    // 手写一份码的清单会过期，而过期的样子是界面上突然印出
    // `DATAOMNI_SSH_FAILED: ...`——所以清单直接从 Rust 源码里取
    const sources = ['../../src-tauri/src/services/connection_service.rs',
      '../../src-tauri/src/services/ssh_tunnel.rs']
      .map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'))
      .join('\n');

    const codes = [...sources.matchAll(/pub const \w+: &str = "(DATAOMNI_[A-Z0-9_]+)";/g)].map(
      ([, code]) => code
    );
    expect(codes.length, '一个都没匹配到说明后端的写法变了，这道门已经失效').toBeGreaterThan(10);

    for (const code of codes) {
      const parsed = parseBackendError(code);
      expect(parsed, `后端的 ${code} 在前端没有文案`).not.toBeNull();
      expect(zh).toHaveProperty(parsed?.key as string);
    }
  });

});
