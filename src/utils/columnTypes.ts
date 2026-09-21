/**
 * 列的声明类型能告诉我们的那一点点事。
 *
 * 只按类型名的第一个词判断，不做子串匹配：`interval` 和 `point` 都含有 "int"，
 * 按子串匹配的写法在这两个类型上一定会错，而错法是把一个时间间隔当成数值。
 */

const NUMERIC_TYPE_TOKENS = new Set([
  'tinyint', 'smallint', 'mediumint', 'int', 'integer', 'int2', 'int4', 'int8', 'bigint',
  'serial', 'serial2', 'serial4', 'serial8', 'smallserial', 'bigserial',
  'decimal', 'dec', 'numeric', 'fixed', 'real', 'double', 'float', 'float4', 'float8',
  'money', 'number'
]);

/** `numeric(10,2)` 取 numeric，`double precision` 取 double，`bigint unsigned` 取 bigint */
export function columnTypeToken(dataType: string): string {
  return dataType.toLowerCase().replace(/\(.*$/, '').trim().split(/\s+/)[0] ?? '';
}

export function isNumericColumnType(dataType: string): boolean {
  return NUMERIC_TYPE_TOKENS.has(columnTypeToken(dataType));
}

/** 能原样写进 SQL 的数字字面量。指数形式不收——它在三种方言里的类型推断不一致 */
export const NUMERIC_LITERAL = /^[+-]?\d+(?:\.\d+)?$/;
