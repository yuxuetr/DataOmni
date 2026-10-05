import type { ColumnInfo } from '../contracts';
import { quoteSqlIdentifier, type SqlIdentifierDialect } from './sqlIdentifiers';
import {
  escapeClickHouseLikePattern,
  escapeLikePattern,
  LIKE_ESCAPE_CHAR,
  quoteSqlStringLiteral
} from './sqlLiterals';
import { binaryLiteral, columnEditorKind } from './columnEditors';
import { columnTypeToken, isNumericColumnType, NUMERIC_LITERAL } from './columnTypes';
import { ORACLE_ZONED_TIMESTAMP, oracleTimestampText } from './tablePagination';

/** `0x` 加偶数位十六进制：网格里二进制值的写法 */
const HEX_BYTES = /^0x(?:[0-9a-f]{2})*$/i;

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

const POSTGRES_QUOTED_NUMERIC = new Set(['real', 'float4', 'money']);

/**
 * 比较用的字面量。
 *
 * 数值列上的数字不加引号，不是为了好看：MySQL 把字符串和数字比较时会把
 * **两边**都转成 DOUBLE，超过 2^53 的 BIGINT 因此会和邻近的几个值比成相等，
 * 筛出来的行是错的而语句本身不报错。其余一律按字符串字面量交给数据库去转换。
 *
 * ClickHouse 反过来：它把带小数点的字面量和超过 64 位的整数读成 Float64，Decimal、Int128 比不准；
 * 字符串字面量它按列类型转，反而是准的。
 *
 * 单精度浮点不能拿数字字面量比：PostgreSQL 的 `real = 1.1` 把列提升成 double，1.1::real 是 1.10000002…，
 * 一行也中不了；MySQL 的 FLOAT 不论 `1.1` 还是 `'1.1'` 都按 double 比，`> 1.1` 反而把存的 1.1 筛进来。
 * PostgreSQL 的 money 与数字之间根本没有比较运算符。PostgreSQL 写成字符串字面量由它按列类型转，
 * MySQL 写成 `CAST(… AS FLOAT)`（PG 16、MySQL 8.4 上都核过）。
 *
 * 二进制列上 `0x` 加偶数位十六进制按字节比：网格里就是这么显示的，照抄进来拼成字符串，比的是那串字符的
 * 字节，一行也筛不中。别的文本照旧（MySQL 的二进制列内容可打印时显示原文），与导入的约定相同。
 */
function comparisonLiteral(
  filter: ColumnFilter,
  column: ColumnInfo | undefined,
  dialect: SqlIdentifierDialect
): string {
  if (column && dialect !== 'clickhouse' && isNumericColumnType(column.data_type) && NUMERIC_LITERAL.test(filter.value.trim())) {
    const token = columnTypeToken(column.data_type);
    if (dialect === 'postgresql' && POSTGRES_QUOTED_NUMERIC.has(token)) {
      return quoteSqlStringLiteral(filter.value.trim(), dialect);
    }
    if (dialect === 'mysql' && token === 'float') {
      return `CAST(${filter.value.trim()} AS FLOAT)`;
    }
    return filter.value.trim();
  }
  if (column && columnEditorKind(column.data_type, dialect) === 'binary' && HEX_BYTES.test(filter.value.trim())) {
    return binaryLiteral(filter.value.trim(), dialect);
  }
  return quoteSqlStringLiteral(filter.value, dialect);
}

/** `pattern` 里 `{}` 是用户的文字要放的位置，其余是通配符 */
function likeTerm(
  quotedColumn: string,
  pattern: string,
  text: string,
  dialect: SqlIdentifierDialect
): string {
  if (dialect === 'clickhouse') {
    const literal = quoteSqlStringLiteral(pattern.replace('{}', escapeClickHouseLikePattern(text)), dialect);
    return `${quotedColumn} LIKE ${literal}`;
  }
  const literal = quoteSqlStringLiteral(pattern.replace('{}', escapeLikePattern(text, dialect)), dialect);
  return `${quotedColumn} LIKE ${literal} ESCAPE ${quoteSqlStringLiteral(LIKE_ESCAPE_CHAR, dialect)}`;
}

/**
 * 这几家的 LIKE 收得下的类型；`text[]` 的词是 `text[]`，不在里面，照样转。ClickHouse 的 FixedString 也收，
 * 但比的是补齐长度的 `\0`：存 'ab' 的 FixedString(4) 网格里是 ab，原列「结尾是 ab」中不了，交给 toString 去掉
 */
const LIKE_STRING_TYPE_TOKENS = new Set([
  'text', 'character', 'varchar', 'char', 'bpchar', 'citext', 'name', 'string'
]);

/**
 * LIKE 左边的那一侧。
 *
 * PostgreSQL、DuckDB、ClickHouse 的 LIKE 只收字符串，在整数、uuid、日期列上选「包含」直接报错
 * （MySQL、SQLite、SQL Server、Oracle 自己会转）。只转非字符串列：citext 转成 text 就区分大小写了。
 *
 * SQL Server 自己转的有两处不对：datetime、smalldatetime 隐式转成 `Jan  2 2024  3:04AM`，照网格里的
 * `2024-01-02` 搜一行也中不了（样式 121 就是网格的写法）；xml 根本不收，报 8116。
 * MySQL 的 BIT 网格里显示成十进制数，LIKE 却比那几位的字节，转成数才对得上。
 *
 * ClickHouse 的 toString 去掉 Decimal 末尾的 0（12.50 写成 `12.5`），网格补齐了小数位，按网格搜要用 toDecimalString。
 * Oracle 同病，还更多：隐式转换写成 `12.5`、`.5`、`03:04:05.000000`，网格是 `12.50`、`0.5`、`03:04:05`。
 * BINARY_DOUBLE 不在里面：服务端最少给 17 位（`.10000000000000001`），网格是最短写法 `0.1`，SQL 里拼不出来
 */
function likeOperand(quotedColumn: string, column: ColumnInfo, dialect: SqlIdentifierDialect): string {
  if (LIKE_STRING_TYPE_TOKENS.has(columnTypeToken(column.data_type))) {
    return quotedColumn;
  }
  switch (dialect) {
    case 'postgresql':
      return `CAST(${quotedColumn} AS text)`;
    case 'duckdb':
      return `CAST(${quotedColumn} AS VARCHAR)`;
    case 'clickhouse': {
      // 目录里一律是 `Decimal(P, S)`（Decimal32(4) 记成 Decimal(9, 4)），S 取最后一个数，与后端补零同一条规则
      const scale = columnTypeToken(column.data_type) === 'decimal'
        ? Number(/(\d+)\s*\)+\s*$/.exec(column.data_type)?.[1] ?? 0)
        : 0;
      return scale > 0 ? `toDecimalString(${quotedColumn}, ${scale})` : `toString(${quotedColumn})`;
    }
    case 'oracle':
      return oracleLikeOperand(quotedColumn, column.data_type);
    case 'mysql':
      return columnTypeToken(column.data_type) === 'bit' ? `CAST(${quotedColumn} AS UNSIGNED)` : quotedColumn;
    case 'sqlserver':
      switch (columnTypeToken(column.data_type)) {
        case 'datetime':
        case 'smalldatetime':
          return `CONVERT(nvarchar(30), ${quotedColumn}, 121)`;
        case 'xml':
          return `CAST(${quotedColumn} AS nvarchar(max))`;
        default:
          return quotedColumn;
      }
    default:
      return quotedColumn;
  }
}

/** 网格里的写法见 `oracle.rs` 的 `decode`：NUMBER(p,s) 补齐 s 位，其余的数补上小数点前的 0 */
function oracleLikeOperand(quotedColumn: string, dataType: string): string {
  const scaled = /^NUMBER\((\d+),(\d+)\)$/i.exec(dataType.trim());
  if (scaled) {
    const scale = Number(scaled[2]);
    const integerDigits = Math.max(Number(scaled[1]) - scale, 1);
    return `TO_CHAR(${quotedColumn}, 'FM${'9'.repeat(integerDigits - 1)}0.${'0'.repeat(scale)}')`;
  }
  switch (columnTypeToken(dataType)) {
    case 'number':
    case 'float':
      return `REGEXP_REPLACE(TO_CHAR(${quotedColumn}), '^(-?)\\.', '\\10.')`;
    case 'timestamp':
      return oracleTimestampText(quotedColumn, ORACLE_ZONED_TIMESTAMP.test(dataType.trim()));
    default:
      return quotedColumn;
  }
}

/**
 * `=`、`<` 这类比较。SQL Server 的 text / ntext / image 原样比报 402，转成 max 类型就能比；
 * Oracle 的 LOB 报 ORA-22848，`DBMS_LOB.COMPARE` 相等得 0、小于得 -1、大于得 1（23 Free 上试过），
 * 拿它和 0 比，算子照原样
 */
function comparisonTerm(
  quotedColumn: string,
  symbol: string,
  literal: string,
  column: ColumnInfo,
  dialect: SqlIdentifierDialect
): string {
  const token = columnTypeToken(column.data_type);
  if (dialect === 'sqlserver' && (token === 'text' || token === 'ntext')) {
    return `CAST(${quotedColumn} AS nvarchar(max)) ${symbol} ${literal}`;
  }
  if (dialect === 'sqlserver' && token === 'image') {
    return `CAST(${quotedColumn} AS varbinary(max)) ${symbol} ${literal}`;
  }
  if (dialect === 'oracle' && (token === 'clob' || token === 'nclob' || token === 'blob')) {
    return `DBMS_LOB.COMPARE(${quotedColumn}, ${literal}) ${symbol} 0`;
  }
  return `${quotedColumn} ${symbol} ${literal}`;
}

function filterTerm(
  filter: ColumnFilter,
  column: ColumnInfo,
  dialect: SqlIdentifierDialect
): string {
  const quoted = quoteSqlIdentifier(filter.column, dialect);
  const likeLeft = likeOperand(quoted, column, dialect);

  switch (filter.operator) {
    case 'is-null':
      return `${quoted} IS NULL`;
    case 'is-not-null':
      return `${quoted} IS NOT NULL`;
    case 'contains':
      return likeTerm(likeLeft, '%{}%', filter.value, dialect);
    case 'starts-with':
      return likeTerm(likeLeft, '{}%', filter.value, dialect);
    case 'ends-with':
      return likeTerm(likeLeft, '%{}', filter.value, dialect);
    default:
      return comparisonTerm(quoted, COMPARISON_SYMBOL[filter.operator], comparisonLiteral(filter, column, dialect), column, dialect);
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
