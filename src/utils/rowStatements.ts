import type { ColumnInfo } from '../contracts';
import { isNumericColumnType, NUMERIC_LITERAL } from './columnTypes';
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

export type BoundValue = string | number | boolean | null;

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
}

/** 按方言发占位符。PostgreSQL 的 `$n` 是按出现次序编号的，不能各自为政 */
function createPlaceholderAllocator(dialect: SqlIdentifierDialect): () => string {
  let index = 0;
  return () => {
    index += 1;
    return dialect === 'postgresql' ? `$${index}` : '?';
  };
}

function tableReference(target: TableTarget): string {
  return quoteQualifiedSqlIdentifier(
    target.schema ? [target.schema, target.table] : [target.table],
    target.dialect
  );
}

/**
 * 一个值在比较里该内联还是该绑定。内联返回字面量，绑定返回 null 并由调用方发占位符。
 */
function inlineComparisonLiteral(
  column: ColumnInfo | undefined,
  value: BoundValue
): string | null {
  if (!column || !isNumericColumnType(column.data_type)) {
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
  placeholder: () => string,
  params: BoundValue[]
): string {
  if (key.columns.length === 0) {
    throw new Error(translateNow('write.noKeyColumns'));
  }

  const byName = new Map(target.columns.map((column) => [column.name, column]));

  return key.columns
    .map((name) => {
      const value = key.values[name];
      if (value === null || value === undefined) {
        throw new Error(translateNow('write.nullKeyValue', { column: name }));
      }
      const quoted = quoteSqlIdentifier(name, target.dialect);
      const literal = inlineComparisonLiteral(byName.get(name), value);
      if (literal !== null) {
        return `${quoted} = ${literal}`;
      }
      params.push(value);
      return `${quoted} = ${placeholder()}`;
    })
    .join(' AND ');
}

export function buildUpdateStatement(
  target: TableTarget,
  key: RowKey,
  assignments: Readonly<Record<string, BoundValue>>
): BoundStatement {
  const columns = Object.keys(assignments);
  if (columns.length === 0) {
    throw new Error(translateNow('write.noAssignments'));
  }

  const placeholder = createPlaceholderAllocator(target.dialect);
  const params: BoundValue[] = [];

  // SET 先拼：PostgreSQL 的 $n 按语句里出现的次序编号，先拼 WHERE 会让
  // 编号和 params 的次序对不上，而错位后的语句仍然语法正确
  const setClause = columns
    .map((name) => {
      params.push(assignments[name]);
      return `${quoteSqlIdentifier(name, target.dialect)} = ${placeholder()}`;
    })
    .join(', ');

  const where = keyCondition(target, key, placeholder, params);
  return { sql: `UPDATE ${tableReference(target)} SET ${setClause} WHERE ${where}`, params };
}

export function buildDeleteStatement(target: TableTarget, key: RowKey): BoundStatement {
  const placeholder = createPlaceholderAllocator(target.dialect);
  const params: BoundValue[] = [];
  const where = keyCondition(target, key, placeholder, params);
  return { sql: `DELETE FROM ${tableReference(target)} WHERE ${where}`, params };
}

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
  return statement.sql.replace(/\$\d+|\?/g, () => {
    const value = statement.params[index];
    index += 1;
    if (value === null || value === undefined) {
      return 'NULL';
    }
    if (typeof value === 'number') {
      return String(value);
    }
    if (typeof value === 'boolean') {
      return value ? 'TRUE' : 'FALSE';
    }
    return quoteSqlStringLiteral(value, dialect);
  });
}
