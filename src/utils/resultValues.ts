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

export function resultValueTypeLabel(value: SerializedResultValue): string | null {
  return isTaggedResultValue(value) ? value.type : null;
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
