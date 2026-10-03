import { describe, expect, it } from 'vitest';
import type { SerializedResultValue } from '../contracts/resultSet';
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

  it('无穷与 NaN 按数值排：负无穷最小，NaN 比正无穷还大（同 PostgreSQL）', () => {
    // 浮点列里它们是字符串（JSON 没有这几个数），各家拼法不同
    const sorted = (values: SerializedResultValue[]) => [...values].sort(compareResultValues);
    expect(sorted([3.5, '-Infinity', -2, 'NaN', 'Infinity', -100])).toEqual(
      ['-Infinity', -100, -2, 3.5, 'Infinity', 'NaN']
    );
    expect(sorted([1, '-Inf', 'Nan', 'Inf', -1])).toEqual(['-Inf', -1, 1, 'Inf', 'Nan']);
    expect(sorted([0, 'inf', '-inf', 'nan'])).toEqual(['-inf', 0, 'inf', 'nan']);
    const decimal = (value: string) => ({ type: 'decimal' as const, value });
    expect(sorted([decimal('-2'), decimal('-Infinity'), decimal('5')])).toEqual(
      [decimal('-Infinity'), decimal('-2'), decimal('5')]
    );
  });

  it('MySQL 的 TIME 是带符号的时长，按时长排而不是按文本', () => {
    // 文本序里 -01:00:00 在 -05:00:00 前面、100:00:00 在 99:00:00 前面
    const time = (value: string) => ({ type: 'time' as const, value });
    const sorted = [
      time('100:00:00'), time('-01:00:00'), time('99:00:00'), time('00:00:00.5'),
      time('-05:00:00'), time('00:00:00'), time('-00:00:01.25')
    ].sort(compareResultValues);
    expect(sorted.map((value) => value.value)).toEqual(
      ['-05:00:00', '-01:00:00', '-00:00:01.25', '00:00:00', '00:00:00.5', '99:00:00', '100:00:00']
    );
    // PostgreSQL 的 interval 不是这个写法，照旧按文本
    expect(compareResultValues(time('1 day 02:00:00'), time('2 days'))).toBeLessThan(0);
  });

  it('日期按年份的数值排：公元前在公元前面，五位数的年份在四位数后面', () => {
    // PostgreSQL 照 psql 写公元前（`0044-03-15 BC`），也存得下 294276 年；两端是 ±infinity
    const date = (value: string) => ({ type: 'date' as const, value });
    const sorted = [
      date('0010-01-01'), date('infinity'), date('0044-03-15 BC'), date('10000-01-01'),
      date('0100-06-01 BC'), date('2026-10-03'), date('-infinity'), date('0044-01-01 BC')
    ].sort(compareResultValues);
    expect(sorted.map((value) => value.value)).toEqual([
      '-infinity', '0100-06-01 BC', '0044-01-01 BC', '0044-03-15 BC',
      '0010-01-01', '2026-10-03', '10000-01-01', 'infinity'
    ]);
    const datetime = (value: string) => ({ type: 'datetime' as const, value });
    expect(compareResultValues(
      datetime('0001-01-01 00:00:00 BC'), datetime('0001-01-01 00:00:00')
    )).toBeLessThan(0);
    expect(compareResultValues(
      datetime('2026-10-03 04:05:06.5'), datetime('2026-10-03 04:05:06')
    )).toBeGreaterThan(0);
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
