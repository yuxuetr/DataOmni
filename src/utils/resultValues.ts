import type { SerializedResultValue } from '../contracts/resultSet';

export function isTaggedResultValue(
  value: SerializedResultValue
): value is Exclude<SerializedResultValue, null | boolean | number | string> {
  return value !== null
    && typeof value === 'object'
    && typeof value.type === 'string'
    && typeof value.value === 'string';
}

export function formatResultValue(value: SerializedResultValue): string {
  if (value === null) {
    return 'NULL';
  }
  if (!isTaggedResultValue(value)) {
    return String(value);
  }

  if (value.type === 'json') {
    try {
      return JSON.stringify(JSON.parse(value.value), null, 2);
    } catch {
      return value.value;
    }
  }
  if (value.type === 'binary') {
    return `0x${value.value}`;
  }
  return value.value;
}

/**
 * 把 tagged value 还原成可用于参数绑定的原始值。
 *
 * tagged 包装只服务于展示与精度保持；一旦这个值要回到 SQL 里（比如用主键
 * 原值拼 WHERE，或判断某列是否被改过），就必须先拆回字面量，否则绑定的是
 * 一个对象，条件永远匹配不上。
 */
export function unwrapResultValue(value: SerializedResultValue): string | number | boolean | null {
  if (value === null) {
    return null;
  }
  return isTaggedResultValue(value) ? value.value : value;
}

/**
 * 单元格用的单行形态。
 *
 * `formatResultValue` 会把 JSON 展开成带缩进的多行——那适合详情查看，放进网格
 * 里会把那一行撑高，整张表的行高变得参差不齐。这里把所有空白折成单个空格。
 */
export function formatResultValueOneLine(value: SerializedResultValue): string {
  return formatResultValue(value).replace(/\s+/g, ' ').trim();
}

/**
 * 是否是数值。数值列右对齐后小数点才会对齐，这是表格可读性最直接的一项。
 * bigint / decimal 是字符串承载的，不能靠 typeof 判断。
 */
export function isNumericResultValue(value: SerializedResultValue): boolean {
  if (typeof value === 'number') {
    return true;
  }
  if (!isTaggedResultValue(value)) {
    return false;
  }
  return value.type === 'bigint' || value.type === 'decimal';
}
