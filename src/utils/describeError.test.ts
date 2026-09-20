import { describe, expect, it } from 'vitest';
import { describeError } from './describeError';

describe('错误描述', () => {
  it('字符串原样返回——Tauri 的 Err(String) 就是这一种', () => {
    // 这是最关键的一条：之前它会被换成兜底文案，后端说什么全丢了
    expect(describeError("missing field `id`", '兜底')).toBe('missing field `id`');
  });

  it('Error 取 message', () => {
    expect(describeError(new Error('连接被拒绝'), '兜底')).toBe('连接被拒绝');
  });

  it('带 message 的对象取 message', () => {
    expect(describeError({ message: '权限不足' }, '兜底')).toBe('权限不足');
  });

  it('空字符串和空 message 落到兜底', () => {
    expect(describeError('', '兜底')).toBe('兜底');
    expect(describeError('   ', '兜底')).toBe('兜底');
    expect(describeError(new Error(''), '兜底')).toBe('兜底');
    expect(describeError({ message: '  ' }, '兜底')).toBe('兜底');
  });

  it('没有 message 的对象序列化出来，不变成 [object Object]', () => {
    expect(describeError({ code: 'ECONNREFUSED' }, '兜底')).toBe('{"code":"ECONNREFUSED"}');
  });

  it('空对象落到兜底，不返回 "{}"', () => {
    expect(describeError({}, '兜底')).toBe('兜底');
  });

  it('循环引用不抛，落到兜底', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => describeError(cyclic, '兜底')).not.toThrow();
    expect(describeError(cyclic, '兜底')).toBe('兜底');
  });

  it('null 和 undefined 落到兜底', () => {
    expect(describeError(null, '兜底')).toBe('兜底');
    expect(describeError(undefined, '兜底')).toBe('兜底');
  });

  it('数字和布尔转成字符串', () => {
    expect(describeError(500, '兜底')).toBe('500');
    expect(describeError(false, '兜底')).toBe('false');
  });
});
