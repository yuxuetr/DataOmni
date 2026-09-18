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
