import type { ColumnInfo } from '../contracts';
import type { ColumnSort } from './resultSorting';
import type { SqlIdentifierDialect } from './sqlIdentifiers';
import { quoteSqlIdentifier } from './sqlIdentifiers';
import { translateNow } from '../stores/languageStore';

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
  const primaryKeyColumns = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => column.is_primary_key)
    .sort((left, right) => (
      (left.column.primary_key_ordinal ?? left.index + 1)
      - (right.column.primary_key_ordinal ?? right.index + 1)
    ))
    .map(({ column }) => column.name);

  if (primaryKeyColumns.length > 0) {
    return createOrder(primaryKeyColumns, dialect, 'primary-key', true);
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
