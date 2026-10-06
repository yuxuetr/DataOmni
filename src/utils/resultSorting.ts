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
    const leftRank = specialRank(leftNumeric);
    const rightRank = specialRank(rightNumeric);
    if (leftRank !== 0 || rightRank !== 0) {
      return leftRank - rightRank;
    }
    return compareDecimalStrings(leftNumeric, rightNumeric);
  }

  const calendar = compareCalendar(left, right);
  if (calendar !== null) {
    return calendar;
  }

  // 其余按显示文本比较；localeCompare 让中文按拼音而不是码点排
  return formatResultValue(left).localeCompare(formatResultValue(right), 'zh-Hans-CN');
}

/**
 * 无穷与 NaN。JSON 里没有这几个数，浮点列里它们是字符串，各家拼法不同：PostgreSQL 的 `Infinity` / `NaN`，
 * SQLite 与 Oracle 的 `Inf` / `Nan`，ClickHouse 与 DuckDB 的 `inf` / `nan`。
 * NaN 排在正无穷后面，与 PostgreSQL 的排序一致
 */
const SPECIAL_NUMBER = /^([+-]?)(?:(inf(?:inity)?)|nan)$/i;

/** 负无穷 -1、有限数 0、正无穷 1、NaN 2 */
function specialRank(text: string): number {
  const match = SPECIAL_NUMBER.exec(text);
  if (!match) {
    return 0;
  }
  if (match[2] === undefined) {
    return 2;
  }
  return match[1] === '-' ? -1 : 1;
}

function numericText(value: SerializedResultValue): string | null {
  if (typeof value === 'number') {
    return plainDecimal(value);
  }
  if (typeof value === 'string' && SPECIAL_NUMBER.test(value)) {
    return value;
  }
  if (isTaggedResultValue(value) && (value.type === 'bigint' || value.type === 'decimal')) {
    return value.value;
  }
  if (isTaggedResultValue(value) && value.type === 'time') {
    return durationSeconds(value.value);
  }
  return null;
}

/**
 * 不带指数的十进制写法。小于 1e-6 或不小于 1e21 的数 JS 写成 `5e-7` / `1e+21`，
 * 和 bigint 比时 `compareDecimalStrings` 解析不了——SQLite 的 NUMERIC 列里整数是 bigint、实数是 JSON 数
 */
function plainDecimal(value: number): string {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) {
    return text;
  }
  const [, sign, integer, fraction = '', exponent] = match;
  const digits = integer + fraction;
  const point = integer.length + Number(exponent);
  if (point <= 0) {
    return `${sign}0.${'0'.repeat(-point)}${digits}`;
  }
  if (point >= digits.length) {
    return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  }
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * `[-]H:MM:SS[.f]` 换成秒数。MySQL 的 TIME 是带符号的时长（-838:59:59 ~ 838:59:59），
 * 按文本排 -01:00:00 在 -05:00:00 前面、100:00:00 在 99:00:00 前面。
 * 别的写法（PostgreSQL 的 `1 day 02:00:00`）不认，照旧按文本
 */
function durationSeconds(text: string): string | null {
  const match = /^(-?)(\d+):(\d{2}):(\d{2})(\.\d+)?$/.exec(text);
  if (!match) {
    return null;
  }
  const [, sign, hours, minutes, seconds, fraction = ''] = match;
  const whole = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return `${sign}${whole}${fraction}`;
}

/**
 * 日期与时间戳。年份之后的部分按文本比就对（月、日、时刻都补足了位），年份本身不行：
 * PostgreSQL 照 psql 写公元前（`0044-03-15 BC`，年份越大越早），也存得下五位数的年份，
 * 两端是 `-infinity` / `infinity`；DuckDB 的年份带符号。两边都认得出才比，否则交回调用方按文本比
 */
function compareCalendar(left: SerializedResultValue, right: SerializedResultValue): number | null {
  const leftKey = calendarKey(left);
  const rightKey = calendarKey(right);
  if (!leftKey || !rightKey) {
    return null;
  }
  if (leftKey.year !== rightKey.year) {
    return leftKey.year < rightKey.year ? -1 : 1;
  }
  return leftKey.rest < rightKey.rest ? -1 : leftKey.rest > rightKey.rest ? 1 : 0;
}

/** 天文纪年的年份（公元前 1 年是 0）与年份之后的部分 */
function calendarKey(value: SerializedResultValue): { year: number; rest: string } | null {
  if (!isTaggedResultValue(value) || (value.type !== 'date' && value.type !== 'datetime')) {
    return null;
  }
  if (value.value === '-infinity' || value.value === 'infinity') {
    return { year: value.value === 'infinity' ? Infinity : -Infinity, rest: '' };
  }
  // DuckDB 那一路经 chrono 的 `%Y`，本来就是天文纪年：`-0043-03-15`、`+10000-01-01`
  const match = /^([+-]?\d{4,})(-.*?)( BC)?$/.exec(value.value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  return { year: match[3] ? 1 - year : year, rest: match[2] };
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
