import { describe, expect, it } from 'vitest';
import { formatResultValue, resultValueTypeLabel } from './resultValues';

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
