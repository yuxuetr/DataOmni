import type { SerializedResultValue } from '../contracts/resultSet';
import { formatResultValue, isTaggedResultValue } from './resultValues';

export type SortDirection = 'asc' | 'desc';

export interface ColumnSort {
  column: string;
  direction: SortDirection;
}

/**
 * 按十进制字符串比较大小。
 *
 * 不走 Number()：后端把 BIGINT / DECIMAL 包成 tagged value 就是为了保住精度，
 * 排序时转成双精度浮点等于把那份努力丢掉——9223372036854775807 和
 * ...806 转成 Number 后完全相等，排序会认为它们一样大。
 */
export function compareDecimalStrings(left: string, right: string): number {
  const leftParts = parseDecimal(left);
  const rightParts = parseDecimal(right);

  if (leftParts === null || rightParts === null) {
    // 解析不了就退回字符串比较，至少是稳定的
    return left < right ? -1 : left > right ? 1 : 0;
  }

  if (leftParts.negative !== rightParts.negative) {
    return leftParts.negative ? -1 : 1;
  }

  const magnitude = compareMagnitude(leftParts, rightParts);
  return leftParts.negative ? -magnitude : magnitude;
}

interface DecimalParts {
  negative: boolean;
  integer: string;
  fraction: string;
}

function parseDecimal(text: string): DecimalParts | null {
  const match = /^\s*([+-]?)(\d*)(?:\.(\d*))?\s*$/.exec(text);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    return null;
  }

  return {
    negative: match[1] === '-',
    // 去掉前导零，让「整数位数」可以直接比长度
    integer: match[2].replace(/^0+(?=\d)/, '') || '0',
    fraction: match[3] ?? ''
  };
}

function compareMagnitude(left: DecimalParts, right: DecimalParts): number {
  if (left.integer.length !== right.integer.length) {
    return left.integer.length < right.integer.length ? -1 : 1;
  }
  if (left.integer !== right.integer) {
    return left.integer < right.integer ? -1 : 1;
  }

  const width = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(width, '0');
  const rightFraction = right.fraction.padEnd(width, '0');

  return leftFraction < rightFraction ? -1 : leftFraction > rightFraction ? 1 : 0;
}

/**
 * 单元格比较。NULL 恒排在最后，不随升降序翻转——这是多数图形化客户端的做法，
 * 「空值总在末尾」比「降序时空值忽然跑到最前」更符合直觉。
 *
 * 注意：这条规则只适用于客户端排序。表数据视图的排序交给数据库执行，
 * 空值位置由各家默认行为决定（PostgreSQL 升序 NULLS LAST、MySQL 升序 NULL 在前）。
 */
export function compareResultValues(
  left: SerializedResultValue,
  right: SerializedResultValue
): number {
  const leftNull = left === null;
  const rightNull = right === null;
  if (leftNull || rightNull) {
    return leftNull && rightNull ? 0 : leftNull ? 1 : -1;
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right);
  }

  const leftNumeric = numericText(left);
  const rightNumeric = numericText(right);
  if (leftNumeric !== null && rightNumeric !== null) {
    return compareDecimalStrings(leftNumeric, rightNumeric);
  }

  // 其余按显示文本比较；localeCompare 让中文按拼音而不是码点排
  return formatResultValue(left).localeCompare(formatResultValue(right), 'zh-Hans-CN');
}

function numericText(value: SerializedResultValue): string | null {
  if (typeof value === 'number') {
    return String(value);
  }
  if (isTaggedResultValue(value) && (value.type === 'bigint' || value.type === 'decimal')) {
    return value.value;
  }
  return null;
}

/**
 * 按某一列排序。返回新数组，不改原数组——调用方常把原始结果留作「未排序」态。
 * 排序是稳定的：同值行保持原有相对顺序。
 */
export function sortRowsByColumn(
  columns: readonly string[],
  rows: readonly (readonly SerializedResultValue[])[],
  sort: ColumnSort | null
): (readonly SerializedResultValue[])[] {
  if (!sort) {
    return [...rows];
  }

  const index = columns.indexOf(sort.column);
  if (index < 0) {
    return [...rows];
  }

  const sign = sort.direction === 'asc' ? 1 : -1;

  return [...rows]
    .map((row, position) => ({ row, position }))
    .sort((left, right) => {
      const order = compareResultValues(left.row[index] ?? null, right.row[index] ?? null);
      // NULL 永远在末尾，所以它的次序不参与升降序翻转
      const leftNull = (left.row[index] ?? null) === null;
      const rightNull = (right.row[index] ?? null) === null;
      if (leftNull !== rightNull) {
        return order;
      }
      return order !== 0 ? order * sign : left.position - right.position;
    })
    .map((entry) => entry.row);
}

/** 点击表头时的三态循环：升序 → 降序 → 取消排序 */
export function nextColumnSort(current: ColumnSort | null, column: string): ColumnSort | null {
  if (current?.column !== column) {
    return { column, direction: 'asc' };
  }
  return current.direction === 'asc' ? { column, direction: 'desc' } : null;
}
