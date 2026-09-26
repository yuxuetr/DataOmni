import type { SqlDialect } from '../contracts/queryExecution';

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
  'money', 'number',
  // ClickHouse 的写法
  'int16', 'int32', 'int64', 'int128', 'int256',
  'uint8', 'uint16', 'uint32', 'uint64', 'uint128', 'uint256',
  'float32', 'float64', 'bfloat16', 'decimal32', 'decimal64', 'decimal128', 'decimal256'
]);

/**
 * `numeric(10,2)` 取 numeric，`double precision` 取 double，`bigint unsigned` 取 bigint。
 * ClickHouse 的 `Nullable(…)`、`LowCardinality(…)` 只是外壳，取里面那个
 */
export function columnTypeToken(dataType: string): string {
  const unwrapped = dataType.trim().replace(/^(?:(?:nullable|lowcardinality)\()+/i, '');
  return unwrapped.toLowerCase().split(/[\s(),]/)[0] ?? '';
}

export function isNumericColumnType(dataType: string): boolean {
  return NUMERIC_TYPE_TOKENS.has(columnTypeToken(dataType));
}

/** 能原样写进 SQL 的数字字面量。指数形式不收——它在三种方言里的类型推断不一致 */
export const NUMERIC_LITERAL = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * 能不能拿这一列的原值去做并发冲突比较。
 *
 * 用白名单而不是黑名单：拿一个类型不合的原值去比，结果不是「多报一次冲突」，
 * 而是**每次都报**——那一条永远提交不了，而错误里只说「没有恰好影响一行」。
 * 已知会这样的几类：
 *
 * - 二进制：原值到前端是一串十六进制文本，`blob = 'deadbeef'` 比的是 BLOB
 *   和文本，永远不等。
 * - 近似浮点：PostgreSQL 里 `float4 = 1.1` 会把 float4 提升成 numeric，
 *   `1.1::float4` 是 1.1000000238…，和 1.1 不等。
 * - JSON：等值比较在三种方言里的语义各不相同（有的按文本、有的按结构）。
 * - 认不出的类型（数组、几何、枚举、区间…）：`point = '(1,2)'` 这种比较
 *   要么报错要么恒假。
 */
const COMPARABLE_TYPE_TOKENS = new Set([
  'tinyint', 'smallint', 'mediumint', 'int', 'integer', 'int2', 'int4', 'int8', 'bigint',
  'serial', 'serial2', 'serial4', 'serial8', 'smallserial', 'bigserial',
  'decimal', 'dec', 'numeric', 'fixed', 'money',
  'char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext', 'character', 'bpchar', 'name',
  'bool', 'boolean',
  'date', 'time', 'timetz', 'timestamp', 'timestamptz', 'datetime', 'smalldatetime', 'year',
  'uuid'
]);

/**
 * SQL Server 与另外三家不同的几处：
 *
 * - `text` / `ntext` 根本不能拿 `=` 比（402），整条语句报错。
 * - `time` 与 `datetime2` 精确到 100 纳秒，读回来只留到微秒，比不上。
 *   `datetime` 的 1/300 秒按毫秒写出，读回来是同一个刻度，比得上。
 * - 另外三家没有的 `nvarchar` / `nchar` / `uniqueidentifier` / `bit` 比得准。
 */
const SQL_SERVER_INCOMPARABLE = new Set(['text', 'time']);
const SQL_SERVER_COMPARABLE = new Set(['nvarchar', 'nchar', 'uniqueidentifier', 'bit']);

/**
 * Oracle：文本、NUMBER、DATE 与 TIMESTAMP（带不带时区都行——会话的 NLS 格式和
 * 结果的写法一致，实验过能原样转回去）比得准；LOB 与 LONG 根本不能拿 `=` 比，
 * 近似浮点照别家一样不比。
 */
const ORACLE_COMPARABLE = new Set([
  'varchar2', 'nvarchar2', 'char', 'nchar', 'number', 'integer', 'date', 'timestamp'
]);

/**
 * ClickHouse：整数、定点小数、文本、日期时间、UUID、IP、枚举、布尔都能按显示出来的文本
 * 原样当参数传回去比（参数类型就是列的类型，25.8 上逐类试过）。浮点、数组、Map、JSON
 * 不比：它们的文本写法与存储值未必一一对应；少比几列只会让「恰好一行」的计数更容易不成立，
 * 不会改错行
 */
const CLICKHOUSE_COMPARABLE = new Set([
  'int8', 'int16', 'int32', 'int64', 'int128', 'int256',
  'uint8', 'uint16', 'uint32', 'uint64', 'uint128', 'uint256',
  'decimal', 'decimal32', 'decimal64', 'decimal128', 'decimal256',
  'string', 'fixedstring', 'uuid', 'ipv4', 'ipv6', 'enum8', 'enum16', 'bool',
  'date', 'date32', 'datetime', 'datetime64'
]);

export function isConcurrencyComparable(dataType: string, dialect?: SqlDialect): boolean {
  const token = columnTypeToken(dataType);
  if (dialect === 'clickhouse') {
    return CLICKHOUSE_COMPARABLE.has(token);
  }
  if (dialect === 'sqlserver') {
    return SQL_SERVER_COMPARABLE.has(token)
      || (COMPARABLE_TYPE_TOKENS.has(token) && !SQL_SERVER_INCOMPARABLE.has(token));
  }
  if (dialect === 'oracle') {
    return ORACLE_COMPARABLE.has(token);
  }
  return COMPARABLE_TYPE_TOKENS.has(token);
}
