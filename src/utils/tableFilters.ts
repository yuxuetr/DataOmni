import type { ColumnInfo } from '../contracts';
import { quoteSqlIdentifier, type SqlIdentifierDialect } from './sqlIdentifiers';
import { escapeLikePattern, LIKE_ESCAPE_CHAR, quoteSqlStringLiteral } from './sqlLiterals';

export type FilterOperator =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'starts-with' | 'ends-with'
  | 'is-null' | 'is-not-null';

export const FILTER_OPERATORS: readonly FilterOperator[] = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
  'contains', 'starts-with', 'ends-with',
  'is-null', 'is-not-null'
];

export interface ColumnFilter {
  /** 列表里的身份；列和算子都可能被改来改去，不能拿它们当 key */
  id: string;
  column: string;
  operator: FilterOperator;
  value: string;
}

const COMPARISON_SYMBOL: Record<string, string> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<='
};

export function operatorNeedsValue(operator: FilterOperator): boolean {
  return operator !== 'is-null' && operator !== 'is-not-null';
}

/**
 * 这条筛选填完了没有。
 *
 * 值还空着的条件要被**忽略**而不是当成 `= ''`：用户选完列、还没开始打字的
 * 那一刻，表会先空掉一次，看上去像是筛没了。要筛空字符串有专门的办法——
 * 把引号里什么都不填是「还没填」，不是「筛空值」。
 */
export function isCompleteFilter(filter: ColumnFilter): boolean {
  if (filter.column === '') {
    return false;
  }
  return !operatorNeedsValue(filter.operator) || filter.value !== '';
}

const NUMERIC_TYPE_TOKENS = new Set([
  'tinyint', 'smallint', 'mediumint', 'int', 'integer', 'int2', 'int4', 'int8', 'bigint',
  'serial', 'serial2', 'serial4', 'serial8', 'smallserial', 'bigserial',
  'decimal', 'dec', 'numeric', 'fixed', 'real', 'double', 'float', 'float4', 'float8',
  'money', 'number'
]);

/**
 * 只看类型名的第一个词。`numeric(10,2)` 取 numeric，`double precision` 取 double，
 * `bigint unsigned` 取 bigint；而 `interval` 和 `point` 不会因为含有 "int"
 * 被误判成数值——按子串匹配的写法在这两个类型上一定会错。
 */
function isNumericColumnType(dataType: string): boolean {
  const token = dataType.toLowerCase().replace(/\(.*$/, '').trim().split(/\s+/)[0] ?? '';
  return NUMERIC_TYPE_TOKENS.has(token);
}

const NUMERIC_LITERAL = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * 比较用的字面量。
 *
 * 数值列上的数字不加引号，不是为了好看：MySQL 把字符串和数字比较时会把
 * **两边**都转成 DOUBLE，超过 2^53 的 BIGINT 因此会和邻近的几个值比成相等，
 * 筛出来的行是错的而语句本身不报错。其余一律按字符串字面量交给数据库去转换。
 */
function comparisonLiteral(
  filter: ColumnFilter,
  column: ColumnInfo | undefined,
  dialect: SqlIdentifierDialect
): string {
  if (column && isNumericColumnType(column.data_type) && NUMERIC_LITERAL.test(filter.value.trim())) {
    return filter.value.trim();
  }
  return quoteSqlStringLiteral(filter.value, dialect);
}

function likeTerm(quotedColumn: string, pattern: string, dialect: SqlIdentifierDialect): string {
  const literal = quoteSqlStringLiteral(pattern, dialect);
  return `${quotedColumn} LIKE ${literal} ESCAPE ${quoteSqlStringLiteral(LIKE_ESCAPE_CHAR, dialect)}`;
}

function filterTerm(
  filter: ColumnFilter,
  column: ColumnInfo,
  dialect: SqlIdentifierDialect
): string {
  const quoted = quoteSqlIdentifier(filter.column, dialect);

  switch (filter.operator) {
    case 'is-null':
      return `${quoted} IS NULL`;
    case 'is-not-null':
      return `${quoted} IS NOT NULL`;
    case 'contains':
      return likeTerm(quoted, `%${escapeLikePattern(filter.value)}%`, dialect);
    case 'starts-with':
      return likeTerm(quoted, `${escapeLikePattern(filter.value)}%`, dialect);
    case 'ends-with':
      return likeTerm(quoted, `%${escapeLikePattern(filter.value)}`, dialect);
    default:
      return `${quoted} ${COMPARISON_SYMBOL[filter.operator]} ${comparisonLiteral(filter, column, dialect)}`;
  }
}

/**
 * 拼出 WHERE 子句；没有可用条件时返回空串。
 *
 * 多条之间只有 AND。OR 需要分组模型（括号、嵌套），而目前没有一个用户场景
 * 要求它；等真的出现「同一列的几个值取并集」这类需求时再加——那时多半也
 * 该顺带支持 IN。
 *
 * 引用不到的列会被丢掉：切换表之后旧条件还留在 state 里，拿去拼会得到一条
 * 指着不存在的列的错误，而用户看到的只是「加载失败」。
 */
export function buildFilterClause(
  filters: readonly ColumnFilter[],
  columns: readonly ColumnInfo[],
  dialect: SqlIdentifierDialect
): string {
  const byName = new Map(columns.map((column) => [column.name, column]));

  const terms = filters
    .filter(isCompleteFilter)
    .map((filter) => {
      const column = byName.get(filter.column);
      return column ? filterTerm(filter, column, dialect) : null;
    })
    .filter((term): term is string => term !== null);

  return terms.length === 0 ? '' : `WHERE ${terms.join(' AND ')}`;
}
