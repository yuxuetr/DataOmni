import type { ColumnInfo } from '../contracts';
import type { ColumnSort } from './resultSorting';
import type { SqlIdentifierDialect } from './sqlIdentifiers';
import { quoteQualifiedSqlIdentifier, quoteSqlIdentifier } from './sqlIdentifiers';
import { translateNow } from '../stores/languageStore';
import { primaryKeyColumns } from './rowIdentity';

export type TablePaginationOrderStrategy =
  | 'primary-key'
  | 'sqlite-rowid'
  | 'postgres-ctid'
  | 'all-columns';

export interface TablePaginationOrder {
  clause: string;
  strategy: TablePaginationOrderStrategy;
  columns: string[];
  stableAcrossChanges: boolean;
}

export function createTablePaginationOrder(
  columns: ColumnInfo[],
  dialect: SqlIdentifierDialect
): TablePaginationOrder {
  const keyColumns = primaryKeyColumns(columns);
  if (keyColumns.length > 0) {
    return createOrder(keyColumns, dialect, 'primary-key', true);
  }

  if (dialect === 'sqlite') {
    const columnNames = new Set(columns.map(column => column.name.toLowerCase()));
    const rowIdentifier = ['rowid', '_rowid_', 'oid']
      .find(candidate => !columnNames.has(candidate));
    if (!rowIdentifier) {
      return createOrder(
        columns.map(column => column.name),
        dialect,
        'all-columns',
        false
      );
    }
    return {
      clause: `ORDER BY ${rowIdentifier}`,
      strategy: 'sqlite-rowid',
      columns: [rowIdentifier],
      stableAcrossChanges: false
    };
  }

  if (dialect === 'postgresql') {
    return {
      clause: 'ORDER BY ctid',
      strategy: 'postgres-ctid',
      columns: ['ctid'],
      stableAcrossChanges: false
    };
  }

  return createOrder(
    columns.map(column => column.name),
    dialect,
    'all-columns',
    false
  );
}

function createOrder(
  columns: string[],
  dialect: SqlIdentifierDialect,
  strategy: TablePaginationOrderStrategy,
  stableAcrossChanges: boolean
): TablePaginationOrder {
  if (columns.length === 0) {
    throw new Error(translateNow('error.paginationNoColumns'));
  }

  return {
    clause: `ORDER BY ${columns.map(column => quoteSqlIdentifier(column, dialect)).join(', ')}`,
    strategy,
    columns,
    stableAcrossChanges
  };
}

/**
 * 把用户选的排序列拼进分页排序。
 *
 * 关键在于末尾必须保留分页排序的列作为决胜条件：按一个不唯一的列排序时，
 * 数据库对同值行的返回次序是不保证的，翻页时同一行可能重复出现或整行消失。
 * 追加主键（或 rowid / ctid）之后每一行都有唯一次序，分页才是确定的。
 *
 * 空值位置交给数据库的默认行为，不额外拼 NULLS LAST——MySQL 不支持这个语法，
 * 为它做方言分支不值得。客户端排序（resultSorting）的约定是空值恒在末尾，
 * 两者在空值位置上可能不同，已在那边注明。
 */
export function createSortedOrderClause(
  paginationOrder: TablePaginationOrder,
  sort: ColumnSort | null,
  dialect: SqlIdentifierDialect
): string {
  if (!sort) {
    return paginationOrder.clause;
  }

  const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
  const terms = [`${quoteSqlIdentifier(sort.column, dialect)} ${direction}`];

  for (const column of paginationOrder.columns) {
    // 排序列已经在最前面了，不重复追加
    if (column === sort.column) {
      continue;
    }
    // rowid / ctid 是伪列，createTablePaginationOrder 生成时就没加引号
    const isPseudoColumn = paginationOrder.strategy === 'sqlite-rowid'
      || paginationOrder.strategy === 'postgres-ctid';
    terms.push(isPseudoColumn ? column : quoteSqlIdentifier(column, dialect));
  }

  return `ORDER BY ${terms.join(', ')}`;
}

/**
 * 排序子句之后的那一段：取第几页。
 *
 * SQL Server 没有 `LIMIT`，要写 `OFFSET … ROWS FETCH NEXT … ROWS ONLY`，而且
 * **必须**跟在 `ORDER BY` 后面。分页排序总是给得出列，这里仍然兜一句
 * `ORDER BY (SELECT NULL)`：少了它是一条语法错误，而不是一页顺序不稳的数据。
 */
export function pageClause(
  orderClause: string,
  limit: number,
  offset: number,
  dialect: SqlIdentifierDialect
): string {
  if (dialect === 'sqlserver') {
    const order = orderClause.trim() || 'ORDER BY (SELECT NULL)';
    return `${order} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }
  // Oracle 12c 起有同样的写法，而且不要求 ORDER BY；没有 LIMIT
  if (dialect === 'oracle') {
    return `${orderClause} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`.trim();
  }
  return `${orderClause} LIMIT ${limit} OFFSET ${offset}`;
}

/** 「先看前几行」的那条查询。名字要引用：带空格或保留字的表名此前直接语法错误 */
export function firstRowsQuery(
  table: string,
  schema: string | undefined,
  count: number,
  dialect: SqlIdentifierDialect
): string {
  const name = quoteQualifiedSqlIdentifier(schema ? [schema, table] : [table], dialect);
  if (dialect === 'sqlserver') {
    return `SELECT TOP ${count} * FROM ${name};`;
  }
  return dialect === 'oracle'
    ? `SELECT * FROM ${name} FETCH FIRST ${count} ROWS ONLY;`
    : `SELECT * FROM ${name} LIMIT ${count};`;
}
