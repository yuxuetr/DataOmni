import type { ColumnInfo } from '../contracts';
import { columnTypeToken, isConcurrencyComparable, isNumericColumnType, NUMERIC_LITERAL } from './columnTypes';
import type { BoundValue, CellInput } from './cellInput';
import { binaryLiteral, isCompleteHex } from './columnEditors';
import { translateNow } from '../stores/languageStore';
import {
  quoteQualifiedSqlIdentifier,
  quoteSqlIdentifier,
  type SqlIdentifierDialect
} from './sqlIdentifiers';
import { quoteSqlStringLiteral } from './sqlLiterals';

/**
 * 由一行的键与改动拼出 UPDATE / DELETE。
 *
 * 全部键列都进 WHERE。只拼第一列是这一段此前真实存在的做法，它在复合键上
 * 拼出的 `WHERE k1 = ?` 会命中所有 k1 相同的行——语法正确、执行成功、
 * 事后才发现改了一批。
 *
 * 值默认走绑定参数，只有一个例外：**数值列上的比较**内联成不带引号的字面量。
 * MySQL 把字符串和数字比较时会把两边都转成 DOUBLE，一个超过 2^53 的 BIGINT
 * 主键因此会和邻近的几个值比成相等，于是定位到的是错的那一行。赋值
 * （SET / VALUES）没有这个问题——那是转换不是比较，字符串转整数是精确的。
 */

export interface BoundStatement {
  sql: string;
  params: BoundValue[];
}

export interface TableTarget {
  schema: string | null;
  table: string;
  /** 全表的列元数据，用来查类型；不是「要写的列」 */
  columns: readonly ColumnInfo[];
  dialect: SqlIdentifierDialect;
}

export interface RowKey {
  /** 键列，按键内次序 */
  columns: readonly string[];
  values: Readonly<Record<string, BoundValue>>;
  /**
   * 值是二进制的那几列（读回来带着 `binary` 包装，拆出来是十六进制文本）。
   *
   * 这串文本绑回去比的是那些字符的字节，永远不等：`BINARY(16)` 存 UUID 的表一行也改不了、删不了。
   * 按值认而不按列类型认：MySQL 的二进制列内容可打印时按原文送来，那时绑原文正好比得上
   */
  binary?: readonly string[];
}

/**
 * 按方言发占位符。PostgreSQL 的 `$n` 是按出现次序编号的，不能各自为政；
 * SQL Server 的 `@Pn` 是 tiberius 给参数起的名字，同样按次序编号。
 *
 * ClickHouse 的服务端参数要写类型：`{p1:UInt64}`。类型就用列的声明类型（`LowCardinality(String)`、
 * `DateTime64(3, 'UTC')`、`Nullable(…)` 都收，25.8 上试过），值按文本传、由服务端按类型解析——
 * 和显示出来的写法是同一种，原样传回去就是原值
 */
type PlaceholderAllocator = (column?: ColumnInfo) => string;

function createPlaceholderAllocator(dialect: SqlIdentifierDialect): PlaceholderAllocator {
  let index = 0;
  return (column) => {
    index += 1;
    if (dialect === 'clickhouse') {
      return `{p${index}:${column?.data_type || 'String'}}`;
    }
    if (dialect === 'postgresql') {
      return `$${index}`;
    }
    // Oracle 按位置绑 `:1`、`:2`
    if (dialect === 'oracle') {
      return `:${index}`;
    }
    return dialect === 'sqlserver' ? `@P${index}` : '?';
  };
}

/**
 * 占位符带上按列类型的转换。
 *
 * PostgreSQL：字符串参数绑成 text，而 PostgreSQL 不会在赋值和比较里把 text 隐式转成
 * jsonb、timestamptz、uuid、数组、枚举……——表格里改一个 jsonb 格子会报
 * 「column "doc" is of type jsonb but expression is of type text」。
 * 按列的声明类型显式转过去；`data_type` 来自 `format_type()`，本身就是
 * 可以直接写在 `::` 后面的类型名（带长度、精度、数组、需要时带引号和 schema）。
 *
 * MySQL 的 BIT：网格里显示成十进制数，原样绑回去是一串字符——`bit(8)` 上写 6 存进去的是
 * `'6'` 的字节 54、不报错，`bit(1)` 上写 1 报 Data too long。转成数才是那几位（导入同样，
 * 见 `csv_import`）；非数字报 1292、超出位宽报 1406，不会悄悄变成 0。
 * 另外几家的参数不需要这层转换。
 */
function typedParameter(
  placeholder: string,
  column: ColumnInfo | undefined,
  dialect: SqlIdentifierDialect
): string {
  if (dialect === 'mysql' && column && columnTypeToken(column.data_type) === 'bit') {
    return `CAST(${placeholder} AS UNSIGNED)`;
  }
  if (dialect !== 'postgresql' || !column?.data_type || TEXT_FAMILY.test(column.data_type)) {
    return placeholder;
  }
  // char(n) 读回来补满了空格，而 `bpchar = text` 是把列这边去掉尾随空格再按 text 比，
  // 'ab   ' 永远等不上。转成不带长度的 bpchar：比较按补空格的语义，赋值超长照样报错（带长度的显式转换会悄悄截断）
  if (CHAR_FAMILY.test(column.data_type)) {
    return `${placeholder}::bpchar`;
  }
  return `${placeholder}::${column.data_type}`;
}

/** 这几种收 text 参数不用转；带上 `::varchar(32)` 只会让预览里的语句更难读 */
const TEXT_FAMILY = /^(text|citext|name|character varying(\(\d+\))?|varchar(\(\d+\))?)$/i;
const CHAR_FAMILY = /^(character(\(\d+\))?|char(\(\d+\))?|bpchar)$/i;

function tableReference(target: TableTarget): string {
  return quoteQualifiedSqlIdentifier(
    target.schema ? [target.schema, target.table] : [target.table],
    target.dialect
  );
}

/**
 * 一个值在比较里该内联还是该绑定。内联返回字面量，绑定返回 null 并由调用方发占位符。
 *
 * ClickHouse 不内联：它的参数带着列类型，本来就按列类型比；而它把带小数点的字面量和超过 64 位的
 * 整数都读成 Float64，和 Decimal / Int128 列比不准（改不了那一行，还会连相邻的值一起比中）
 */
function inlineComparisonLiteral(
  column: ColumnInfo | undefined,
  value: BoundValue,
  dialect: SqlIdentifierDialect
): string | null {
  if (!column || dialect === 'clickhouse' || !isNumericColumnType(column.data_type)) {
    return null;
  }
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return NUMERIC_LITERAL.test(text) ? text : null;
}

/**
 * 拼出锁定一行的条件。
 *
 * 键值为 null 会抛错而不是拼成 `IS NULL`：主键列在 SQL 里不可能是 NULL，
 * 出现 NULL 只可能是键值没取到（列名对不上、值还没拆包）或者 SQLite 那个
 * 历史遗留——非 INTEGER 的 PRIMARY KEY 列允许存 NULL。无论哪种，那一行都
 * **定位不到**，拼一条匹配不中或匹配一批的条件比报错糟得多。
 */
function keyCondition(
  target: TableTarget,
  key: RowKey,
  placeholder: PlaceholderAllocator,
  params: BoundValue[]
): string {
  if (key.columns.length === 0) {
    throw new Error(translateNow('write.noKeyColumns'));
  }

  const byName = new Map(target.columns.map((column) => [column.name, column]));

  return key.columns
    .map((name) => {
      const value = key.values[name];
      const quoted = quoteSqlIdentifier(name, target.dialect);
      if (value === null || value === undefined) {
        // ClickHouse 按整行定位（`wholeRowIdentity`），整行里的 NULL 是真实的值
        if (target.dialect === 'clickhouse') {
          return `${quoted} IS NULL`;
        }
        throw new Error(translateNow('write.nullKeyValue', { column: name }));
      }
      // 写成二进制字面量；只含十六进制数字，内联不会带进别的东西
      if (key.binary?.includes(name) && typeof value === 'string' && isCompleteHex(value)) {
        return `${quoted} = ${binaryLiteral(value, target.dialect)}`;
      }
      const literal = inlineComparisonLiteral(byName.get(name), value, target.dialect);
      if (literal !== null) {
        return `${quoted} = ${literal}`;
      }
      params.push(value);
      return `${quoted} = ${typedParameter(placeholder(byName.get(name)), byName.get(name), target.dialect)}`;
    })
    .join(' AND ');
}

/**
 * 一项赋值的右手边。
 *
 * `default` 在 SQLite 的 UPDATE 里不存在——`SET col = DEFAULT` 是语法错误，
 * 而且 SQLite 也没有别的写法能在更新时套用列默认值。这里点名报错而不是
 * 拼一条跑不通的语句；界面上那一档在 SQLite 下本来就不给选。
 */
function assignmentTerm(
  input: CellInput,
  dialect: SqlIdentifierDialect,
  /** 占位符，已按列类型转好（`typedParameter`） */
  placeholder: () => string,
  params: BoundValue[]
): string {
  switch (input.kind) {
    case 'default':
      if (dialect === 'sqlite') {
        throw new Error(translateNow('write.sqliteNoUpdateDefault'));
      }
      // `ALTER TABLE … UPDATE` 的右手边是表达式，没有 DEFAULT 这个写法
      if (dialect === 'clickhouse') {
        throw new Error(translateNow('write.clickhouseNoUpdateDefault'));
      }
      return 'DEFAULT';
    case 'expression':
      // 用户明确选择「表达式」时才走到这里，原样写进语句正是它的意思
      return input.sql;
    case 'null':
      // SQL Server 的空参数也带类型（绑成 nvarchar），而 nvarchar 不能隐式
      // 转成 varbinary：把二进制列置空会报 257。字面的 NULL 没有类型
      // ClickHouse 同样：字面的 NULL 不用管参数类型写不写 Nullable
      if (dialect === 'sqlserver' || dialect === 'clickhouse') {
        return 'NULL';
      }
      params.push(null);
      return placeholder();
    case 'value':
      params.push(input.value);
      return placeholder();
    default:
      // 调用方已经把 unset 滤掉了；走到这里说明过滤和这里的分支漂开了
      throw new Error(translateNow('write.noAssignments'));
  }
}

/**
 * 并发冲突的守卫：这几列在我们读到它之后有没有被别人改过。
 *
 * 条件拼进同一条 WHERE 里，配合后端「必须恰好影响一行」的核对，一次往返就
 * 既定位了行又验证了前提。分两步做（先 SELECT 回来比一遍再 UPDATE）之间
 * 仍然有窗口，而且多一次往返。
 *
 * 只比**认得出且比得准**的列，见 `isConcurrencyComparable`。
 */
export interface RowGuard {
  /** 列 → 这一行加载时的值 */
  values: Readonly<Record<string, BoundValue>>;
  /** 只比这几列；不给就比 `values` 里所有比得准的列 */
  columns?: readonly string[];
}

function guardConditions(
  target: TableTarget,
  key: RowKey,
  guard: RowGuard | undefined,
  placeholder: PlaceholderAllocator,
  params: BoundValue[]
): string[] {
  // ClickHouse 的键已经是整行，再比一遍只是重复
  if (!guard || target.dialect === 'clickhouse') {
    return [];
  }
  const byName = new Map(target.columns.map((column) => [column.name, column]));
  const keyColumns = new Set(key.columns);
  const candidates = guard.columns ?? Object.keys(guard.values);

  return candidates.flatMap((name) => {
    // 键列已经在前面的条件里了，再比一遍只是把语句拉长
    if (keyColumns.has(name)) {
      return [];
    }
    const column = byName.get(name);
    if (!column || !isConcurrencyComparable(column.data_type, target.dialect)) {
      return [];
    }
    const quoted = quoteSqlIdentifier(name, target.dialect);
    const value = guard.values[name];
    if (value === null || value === undefined) {
      // `= NULL` 恒为未知，一行也匹配不上
      return [`${quoted} IS NULL`];
    }
    const literal = inlineComparisonLiteral(column, value, target.dialect);
    if (literal !== null) {
      return [`${quoted} = ${literal}`];
    }
    params.push(value);
    return [`${quoted} = ${typedParameter(placeholder(column), column, target.dialect)}`];
  });
}

/**
 * SQLite 里没声明类型的列，值按绑进去的样子存；输入框给的总是文本。原来是数、新写的又是
 * 一个数的规范写法时，经 `CAST(? AS NUMERIC)` 存回数（整数在 int64 内精确，否则成实数）。
 * 声明了类型的列不用管：INTEGER / REAL / NUMERIC 亲和性自己会转。前导零不算：那是编号的写法
 */
function keepsSqliteNumber(
  column: ColumnInfo | undefined,
  input: CellInput,
  original: BoundValue | undefined,
  dialect: SqlIdentifierDialect
): boolean {
  return dialect === 'sqlite'
    && column !== undefined
    && column.data_type.trim() === ''
    && typeof original === 'number'
    && input.kind === 'value'
    && typeof input.value === 'string'
    && /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(input.value);
}

export function buildUpdateStatement(
  target: TableTarget,
  key: RowKey,
  assignments: Readonly<Record<string, CellInput>>,
  guard?: RowGuard
): BoundStatement {
  const columns = Object.keys(assignments).filter((name) => assignments[name].kind !== 'unset');
  if (columns.length === 0) {
    throw new Error(translateNow('write.noAssignments'));
  }

  const placeholder = createPlaceholderAllocator(target.dialect);
  const params: BoundValue[] = [];

  // SET 先拼：PostgreSQL 的 $n 按语句里出现的次序编号，先拼 WHERE 会让
  // 编号和 params 的次序对不上，而错位后的语句仍然语法正确
  const byName = new Map(target.columns.map((column) => [column.name, column]));
  const setClause = columns
    .map((name) => {
      const keepsNumber = keepsSqliteNumber(byName.get(name), assignments[name], guard?.values[name], target.dialect);
      const right = assignmentTerm(
        assignments[name],
        target.dialect,
        () => {
          const parameter = typedParameter(placeholder(byName.get(name)), byName.get(name), target.dialect);
          return keepsNumber ? `CAST(${parameter} AS NUMERIC)` : parameter;
        },
        params
      );
      return `${quoteSqlIdentifier(name, target.dialect)} = ${right}`;
    })
    .join(', ');

  // 只比**正在写的那几列**：另一个人改了同一行的别的列（比如某个
  // last_seen 时间戳）不该让这次保存失败，而「我正要覆盖的值已经不是我读到
  // 的那个」正是丢失更新
  const conditions = [
    keyCondition(target, key, placeholder, params),
    ...guardConditions(target, key, guard && { ...guard, columns }, placeholder, params)
  ];
  // ClickHouse 的改是 mutation：`ALTER TABLE … UPDATE`，没有 `SET`
  const sql = target.dialect === 'clickhouse'
    ? `ALTER TABLE ${tableReference(target)} UPDATE ${setClause} WHERE ${conditions.join(' AND ')}`
    : `UPDATE ${tableReference(target)} SET ${setClause} WHERE ${conditions.join(' AND ')}`;
  return { sql, params };
}

/**
 * 拼出 INSERT。
 *
 * `unset`（没填）与 `default`（明确要默认值）的列都**整列省掉**，让数据库
 * 套用它自己的默认值。不写成 `VALUES (DEFAULT, ...)`：SQLite 不认这个关键字。
 * 两者在 SQL 上同形，在界面上是两件事——「还没填」要提醒，「用默认值」不用。
 */
export function buildInsertStatement(
  target: TableTarget,
  values: Readonly<Record<string, CellInput>>
): BoundStatement {
  const columns = Object.keys(values)
    .filter((name) => values[name].kind !== 'unset' && values[name].kind !== 'default');
  if (columns.length === 0) {
    const generated = new Set(target.columns.filter((column) => column.is_generated).map((column) => column.name));
    const defaults = Object.keys(values).filter((name) => values[name].kind === 'default');
    // Oracle 要点名一列：虚拟列不收 DEFAULT，能避开就避开
    const defaulted = defaults.find((name) => !generated.has(name)) ?? defaults[0];
    // 每列都交给默认值（只有自增主键和 created_at 的表），仍是合法的一行；
    // 省掉全部列之后的写法各家不同。ClickHouse 没有对应写法
    if (defaulted === undefined || target.dialect === 'clickhouse') {
      throw new Error(translateNow('table.noInsertableColumns'));
    }
    const table = tableReference(target);
    if (target.dialect === 'mysql') {
      return { sql: `INSERT INTO ${table} () VALUES ()`, params: [] };
    }
    if (target.dialect === 'oracle') {
      return { sql: `INSERT INTO ${table} (${quoteSqlIdentifier(defaulted, target.dialect)}) VALUES (DEFAULT)`, params: [] };
    }
    return { sql: `INSERT INTO ${table} DEFAULT VALUES`, params: [] };
  }

  const placeholder = createPlaceholderAllocator(target.dialect);
  const params: BoundValue[] = [];
  const byName = new Map(target.columns.map((column) => [column.name, column]));
  const terms = columns.map((name) =>
    assignmentTerm(
      values[name],
      target.dialect,
      () => typedParameter(placeholder(byName.get(name)), byName.get(name), target.dialect),
      params
    )
  );

  return {
    sql: `INSERT INTO ${tableReference(target)} (`
      + columns.map((name) => quoteSqlIdentifier(name, target.dialect)).join(', ')
      + `) VALUES (${terms.join(', ')})`,
    params
  };
}

/**
 * 删除比整行。
 *
 * 与更新不对称，是有意的：更新只承诺「我覆盖的那个值还是我读到的那个」，
 * 而删除是不可逆的，它承诺的是「我要删掉的这一行还是我看到的那一行」——
 * 别的列被改过，说明我看到的已经不是现在这一行了。
 */
export function buildDeleteStatement(
  target: TableTarget,
  key: RowKey,
  guard?: RowGuard
): BoundStatement {
  const placeholder = createPlaceholderAllocator(target.dialect);
  const params: BoundValue[] = [];
  const conditions = [
    keyCondition(target, key, placeholder, params),
    ...guardConditions(target, key, guard, placeholder, params)
  ];
  return {
    sql: `DELETE FROM ${tableReference(target)} WHERE ${conditions.join(' AND ')}`,
    params
  };
}

/**
 * 数一数有几行是这一行：`SELECT count() FROM t WHERE <整行>`。
 *
 * ClickHouse 没有事务、写语句也报不出影响行数，「恰好一行」只能在执行前后各数一次
 * （见 `pendingChanges`）。`atLeastOne` 时问的是「至少有一行」，回答 1 或 0：改完之后
 * 新值那一行可能恰好和另一行一模一样，那不算没改成
 */
export function buildRowCountStatement(target: TableTarget, key: RowKey, atLeastOne = false): BoundStatement {
  const placeholder = createPlaceholderAllocator(target.dialect);
  const params: BoundValue[] = [];
  const condition = keyCondition(target, key, placeholder, params);
  const projection = atLeastOne ? 'toUInt64(count() >= 1)' : 'count()';
  return { sql: `SELECT ${projection} FROM ${tableReference(target)} WHERE ${condition}`, params };
}

/** 字符串与各家的引号标识符；成对的引号是转义 */
const QUOTED_SEGMENT = String.raw`'(?:[^']|'')*'|"(?:[^"]|"")*"|\`(?:[^\`]|\`\`)*\`|\[(?:[^\]]|\]\])*\]`;

/**
 * 把绑定参数填回语句，得到一条可以直接读、直接跑的 SQL。
 *
 * 只用于**展示**（差异预览、错误信息里的原句）。执行仍然走绑定参数——
 * 这里的转义够用来看，不够用来当唯一的防线。
 */
export function renderStatementForDisplay(
  statement: BoundStatement,
  dialect: SqlIdentifierDialect
): string {
  let index = 0;
  const placeholder = dialect === 'oracle'
    ? ':\\d+'
    : dialect === 'clickhouse'
      ? '\\{p\\d+:[^}]*\\}'
      : '\\$\\d+|@P\\d+|\\?';
  // 引号里的原样跳过：列名 `ok?`、表达式里的 '?' 不是占位符，当成占位符填进值，后面的参数就全错位了
  const pattern = new RegExp(`${QUOTED_SEGMENT}|${placeholder}`, 'g');
  return statement.sql.replace(pattern, (match) => {
    if (/^["'`[]/.test(match)) {
      return match;
    }
    const value = statement.params[index];
    index += 1;
    if (value === null || value === undefined) {
      return 'NULL';
    }
    if (typeof value === 'number') {
      return String(value);
    }
    if (typeof value === 'boolean') {
      // T-SQL 没有布尔字面量，bit 列写 1 / 0
      if (dialect === 'sqlserver') {
        return value ? '1' : '0';
      }
      return value ? 'TRUE' : 'FALSE';
    }
    return quoteSqlStringLiteral(value, dialect);
  });
}
