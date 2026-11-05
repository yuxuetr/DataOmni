import type { SqlDialect } from '../contracts/queryExecution';
import { sqlParameters } from './sqlStatements';

/**
 * 编辑器里的绑定参数（rfcs/bind-parameters.md）：`:name` 换成本方言的占位符，值按出现次序排好。
 */

/** 用户在弹框里给一个参数填的东西 */
export interface ParameterInput {
  value: string;
  /** 文本还是数字。PostgreSQL 上不问：驱动按 describe 出来的类型转 */
  kind: 'text' | 'number';
  isNull: boolean;
}

/** 发给 `execute_query` 的一个值 */
export type BoundValue = string | number | null;

export type BindResult =
  | { ok: true; sql: string; params: BoundValue[] }
  | { ok: false; reason: 'not-a-number' | 'out-of-range'; name: string }
  | { ok: false; reason: 'unsupported-dialect' };

/** 这几条语句里的参数名，去重，按第一次出现的次序 */
export function parameterNames(statements: string[], dialect: SqlDialect): string[] {
  const names = statements.flatMap((sql) => sqlParameters(sql, dialect).map((parameter) => parameter.name));
  return [...new Set(names)];
}

/** PostgreSQL 的值一律按文本送，类型由后端按 describe 定 */
export const dialectTypesParameters = (dialect: SqlDialect): boolean => dialect === 'postgresql';

function placeholder(dialect: SqlDialect, position: number): string | null {
  switch (dialect) {
    case 'mysql':
    case 'sqlite':
    case 'duckdb':
      return '?';
    case 'postgresql':
      return `$${position}`;
    case 'sqlserver':
      return `@P${position}`;
    case 'oracle':
      return `:${position}`;
    // 服务端参数要在 SQL 里写类型（`{name:UInt64}`），对不上 `:name`
    case 'clickhouse':
      return null;
  }
}

const INTEGER = /^[-+]?\d+$/;
const DECIMAL = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/**
 * 一条语句里的 `:name` 换成占位符。同名出现两次就是两个占位符、两个值：
 * 各家都能这样绑，不用管谁认得「同一个名字绑一次」。没有参数的语句原样返回
 */
export function bindParameters(
  sql: string,
  dialect: SqlDialect,
  inputs: Record<string, ParameterInput>
): BindResult {
  const found = sqlParameters(sql, dialect);
  if (found.length === 0) {
    return { ok: true, sql, params: [] };
  }

  const params: BoundValue[] = [];
  let rewritten = '';
  let copied = 0;
  for (const parameter of found) {
    const marker = placeholder(dialect, params.length + 1);
    if (marker === null) {
      return { ok: false, reason: 'unsupported-dialect' };
    }
    const input = inputs[parameter.name] ?? { value: '', kind: 'text', isNull: false };
    const value = boundValue(input, dialect);
    if (typeof value === 'object' && value !== null) {
      return { ok: false, reason: value.reason, name: parameter.name };
    }
    params.push(value);
    rewritten += sql.slice(copied, parameter.from) + marker;
    copied = parameter.to;
  }
  return { ok: true, sql: rewritten + sql.slice(copied), params };
}

function boundValue(
  input: ParameterInput,
  dialect: SqlDialect
): BoundValue | { reason: 'not-a-number' | 'out-of-range' } {
  if (input.isNull) {
    return null;
  }
  if (input.kind === 'text' || dialectTypesParameters(dialect)) {
    return input.value;
  }
  const text = input.value.trim();
  if (INTEGER.test(text)) {
    const value = Number(text);
    // 超过 2^53 的整数到 JSON 里就不是原来那个数了。按文本绑，库自己会转
    return Number.isSafeInteger(value) ? value : { reason: 'out-of-range' };
  }
  return DECIMAL.test(text) ? Number(text) : { reason: 'not-a-number' };
}
