import { describe, expect, it } from 'vitest';
import {
  formatResultValue,
  formatResultValueOneLine,
  isNumericResultValue,
  unwrapResultValue
} from './resultValues';

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

describe('单元格单行形态', () => {
  it('把展开的 JSON 折成一行', () => {
    const value = { type: 'json' as const, value: '{"a":1,"b":2}' };
    expect(formatResultValue(value)).toContain('\n');
    expect(formatResultValueOneLine(value)).toBe('{ "a": 1, "b": 2 }');
  });

  it('文本里的换行和连续空白也折成单个空格', () => {
    expect(formatResultValueOneLine('第一行\n  第二行')).toBe('第一行 第二行');
  });

  it('NULL 仍然是 NULL', () => {
    expect(formatResultValueOneLine(null)).toBe('NULL');
  });

  it('普通短值原样返回', () => {
    expect(formatResultValueOneLine('alice')).toBe('alice');
  });
});

describe('数值判定', () => {
  it('普通数字是数值', () => {
    expect(isNumericResultValue(42)).toBe(true);
  });

  it('bigint 和 decimal 是数值，尽管它们由字符串承载', () => {
    expect(isNumericResultValue({ type: 'bigint', value: '9223372036854775807' })).toBe(true);
    expect(isNumericResultValue({ type: 'decimal', value: '1.5' })).toBe(true);
  });

  it('看起来像数字的字符串不是数值', () => {
    // 文本列里的 "123" 右对齐会让整列跟着串位
    expect(isNumericResultValue('123')).toBe(false);
  });

  it('日期、二进制、JSON 都不是数值', () => {
    expect(isNumericResultValue({ type: 'datetime', value: '2026-09-20 00:00:00' })).toBe(false);
    expect(isNumericResultValue({ type: 'binary', value: 'ff' })).toBe(false);
    expect(isNumericResultValue({ type: 'json', value: '1' })).toBe(false);
  });

  it('NULL 和布尔不是数值', () => {
    expect(isNumericResultValue(null)).toBe(false);
    expect(isNumericResultValue(true)).toBe(false);
  });
});
