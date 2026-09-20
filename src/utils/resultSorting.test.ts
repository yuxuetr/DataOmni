import { describe, expect, it } from 'vitest';
import {
  compareDecimalStrings,
  compareResultValues,
  nextColumnSort,
  sortRowsByColumn
} from './resultSorting';

const bigint = (value: string) => ({ type: 'bigint' as const, value });
const decimal = (value: string) => ({ type: 'decimal' as const, value });

describe('十进制字符串比较', () => {
  it('位数不同时按位数定大小', () => {
    expect(compareDecimalStrings('100', '99')).toBe(1);
  });

  it('位数相同时逐位比较', () => {
    expect(compareDecimalStrings('123', '124')).toBe(-1);
  });

  it('保住超出双精度范围的精度', () => {
    // 这两个数转成 Number 后完全相等，排序会认为一样大
    expect(Number('9223372036854775807')).toBe(Number('9223372036854775806'));
    expect(compareDecimalStrings('9223372036854775807', '9223372036854775806')).toBe(1);
  });

  it('小数部分按补齐后的位比较', () => {
    expect(compareDecimalStrings('1.5', '1.45')).toBe(1);
    expect(compareDecimalStrings('1.5', '1.50')).toBe(0);
  });

  it('负数比正数小', () => {
    expect(compareDecimalStrings('-1', '0')).toBe(-1);
  });

  it('两个负数比较时大小关系反转', () => {
    expect(compareDecimalStrings('-100', '-99')).toBe(-1);
  });

  it('前导零不影响大小', () => {
    expect(compareDecimalStrings('007', '7')).toBe(0);
  });

  it('解析不了的内容退回字符串比较，不抛', () => {
    expect(() => compareDecimalStrings('abc', 'abd')).not.toThrow();
    expect(compareDecimalStrings('abc', 'abd')).toBe(-1);
  });
});

describe('单元格比较', () => {
  it('NULL 恒排最后', () => {
    expect(compareResultValues(null, 1)).toBe(1);
    expect(compareResultValues(1, null)).toBe(-1);
    expect(compareResultValues(null, null)).toBe(0);
  });

  it('bigint 按数值而不是字典序比较', () => {
    // 字典序会认为 '9' > '10'
    expect(compareResultValues(bigint('10'), bigint('9'))).toBe(1);
  });

  it('decimal 按数值比较', () => {
    expect(compareResultValues(decimal('2.10'), decimal('2.9'))).toBe(-1);
  });

  it('数字与 bigint 混排也按数值比较', () => {
    expect(compareResultValues(5, bigint('10'))).toBe(-1);
  });

  it('文本按中文语序而不是码点比较', () => {
    // 码点序里「张」(0x5F20) 在「李」(0x674E) 之前，拼音序相反
    expect(compareResultValues('李四', '张三')).toBeLessThan(0);
  });

  it('布尔 false 小于 true', () => {
    expect(compareResultValues(false, true)).toBe(-1);
  });
});

describe('按列排序', () => {
  const columns = ['id', 'name'];
  const rows = [
    [bigint('10'), 'carol'],
    [bigint('9'), 'alice'],
    [null, 'bob']
  ];

  it('不传排序时原样返回副本', () => {
    const result = sortRowsByColumn(columns, rows, null);
    expect(result).toEqual(rows);
    expect(result).not.toBe(rows);
  });

  it('升序按数值排，NULL 在最后', () => {
    const result = sortRowsByColumn(columns, rows, { column: 'id', direction: 'asc' });
    expect(result.map((row) => row[1])).toEqual(['alice', 'carol', 'bob']);
  });

  it('降序翻转次序，但 NULL 仍在最后', () => {
    const result = sortRowsByColumn(columns, rows, { column: 'id', direction: 'desc' });
    expect(result.map((row) => row[1])).toEqual(['carol', 'alice', 'bob']);
  });

  it('不改动原数组', () => {
    const original = [...rows];
    sortRowsByColumn(columns, rows, { column: 'id', direction: 'desc' });
    expect(rows).toEqual(original);
  });

  it('同值行保持原有相对顺序', () => {
    const tied = [['x', 'first'], ['x', 'second'], ['x', 'third']];
    const result = sortRowsByColumn(['k', 'v'], tied, { column: 'k', direction: 'asc' });
    expect(result.map((row) => row[1])).toEqual(['first', 'second', 'third']);
  });

  it('列名不存在时原样返回，不抛', () => {
    expect(sortRowsByColumn(columns, rows, { column: '不存在', direction: 'asc' })).toEqual(rows);
  });
});

describe('表头点击三态', () => {
  it('首次点击某列得到升序', () => {
    expect(nextColumnSort(null, 'id')).toEqual({ column: 'id', direction: 'asc' });
  });

  it('再点同一列变降序', () => {
    expect(nextColumnSort({ column: 'id', direction: 'asc' }, 'id'))
      .toEqual({ column: 'id', direction: 'desc' });
  });

  it('第三次点击取消排序', () => {
    expect(nextColumnSort({ column: 'id', direction: 'desc' }, 'id')).toBeNull();
  });

  it('点击另一列从该列的升序重新开始', () => {
    expect(nextColumnSort({ column: 'id', direction: 'desc' }, 'name'))
      .toEqual({ column: 'name', direction: 'asc' });
  });
});
