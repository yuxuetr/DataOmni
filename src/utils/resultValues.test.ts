import { describe, expect, it } from 'vitest';
import { formatResultValue, resultValueTypeLabel, unwrapResultValue } from './resultValues';

describe('result value formatting', () => {
  it('preserves bigint and decimal text exactly', () => {
    expect(formatResultValue({
      type: 'bigint',
      value: '9007199254740993'
    })).toBe('9007199254740993');
    expect(formatResultValue({
      type: 'decimal',
      value: '12345678901234567890.12345678'
    })).toBe('12345678901234567890.12345678');
  });

  it('distinguishes binary and JSON values', () => {
    expect(formatResultValue({ type: 'binary', value: '00ff10' })).toBe('0x00ff10');
    expect(formatResultValue({
      type: 'json',
      value: '{"enabled":true}'
    })).toContain('"enabled": true');
    expect(resultValueTypeLabel({ type: 'datetime', value: '2026-09-18 10:00:00+08:00' }))
      .toBe('datetime');
  });
});

describe('unwrapResultValue', () => {
  it('拆出 tagged 值的字面量，保持 BigInt 与 Decimal 的精度', () => {
    expect(unwrapResultValue({ type: 'bigint', value: '18446744073709551615' }))
      .toBe('18446744073709551615');
    expect(unwrapResultValue({ type: 'decimal', value: '12345678901234.5678' }))
      .toBe('12345678901234.5678');
  });

  it('原始类型原样返回', () => {
    expect(unwrapResultValue('text')).toBe('text');
    expect(unwrapResultValue(42)).toBe(42);
    expect(unwrapResultValue(true)).toBe(true);
    expect(unwrapResultValue(null)).toBeNull();
  });

  it('拆包后的值可直接用于比较，不会因包装而永远判定为已修改', () => {
    const original = unwrapResultValue({ type: 'bigint', value: '7' });
    expect(original === '7').toBe(true);
  });
});
