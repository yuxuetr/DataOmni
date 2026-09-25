import { describe, expect, it } from 'vitest';
import { appendValuePage, nextPosition, redisDatabaseIndex, ttlView, type RedisBytes } from './redisKeys';

const bytes = (text: string): RedisBytes => ({ raw: btoa(text), text, binary: false });

describe('redisKeys', () => {
  it('树上的库名换成库号', () => {
    expect(redisDatabaseIndex('db0')).toBe(0);
    expect(redisDatabaseIndex('db15')).toBe(15);
    expect(redisDatabaseIndex('nope')).toBe(0);
  });

  it('-1 不过期、-2 已经没了', () => {
    expect(ttlView(-1)).toEqual({ kind: 'persistent' });
    expect(ttlView(-2)).toEqual({ kind: 'gone' });
  });

  it('最多两段，且第二段紧挨着第一段', () => {
    expect(ttlView(598_000)).toEqual({ kind: 'expiring', parts: [{ value: 9, unit: 'm' }, { value: 58, unit: 's' }] });
    expect(ttlView((3 * 86_400 + 2 * 3_600 + 5) * 1000)).toEqual({
      kind: 'expiring',
      parts: [{ value: 3, unit: 'd' }, { value: 2, unit: 'h' }]
    });
    // 小时那一级是 0：不跳到分钟去凑第二段
    expect(ttlView((86_400 + 300) * 1000)).toEqual({ kind: 'expiring', parts: [{ value: 1, unit: 'd' }] });
    expect(ttlView(42_000)).toEqual({ kind: 'expiring', parts: [{ value: 42, unit: 's' }] });
  });

  it('不足一秒按一秒算', () => {
    expect(ttlView(300)).toEqual({ kind: 'expiring', parts: [{ value: 1, unit: 's' }] });
  });

  it('再读一页接在后面，位置与总数取后一页的；列表的起点留着第一页的', () => {
    const first = { kind: 'list' as const, length: 5, offset: 0, items: [bytes('a'), bytes('b')], next: '2' };
    const second = { kind: 'list' as const, length: 6, offset: 2, items: [bytes('c')], next: null };
    expect(appendValuePage(first, second)).toEqual({
      kind: 'list', length: 6, offset: 0, items: [bytes('a'), bytes('b'), bytes('c')], next: null
    });
    expect(nextPosition(first)).toBe('2');
  });

  it('两页类型对不上时只要后一页', () => {
    const hash = { kind: 'hash' as const, length: 1, entries: [[bytes('f'), bytes('v')] as [RedisBytes, RedisBytes]], next: '9' };
    const text = { kind: 'string' as const, size: 1, value: bytes('x'), truncated: false };
    expect(appendValuePage(hash, text)).toBe(text);
    expect(nextPosition(text)).toBeNull();
  });
});
