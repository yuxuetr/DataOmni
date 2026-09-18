import type { ColumnInfo } from '../contracts';
import type { SqlIdentifierDialect } from './sqlIdentifiers';
import { quoteSqlIdentifier } from './sqlIdentifiers';

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
    throw new Error('无法为没有列的表生成分页排序');
  }

  return {
    clause: `ORDER BY ${columns.map(column => quoteSqlIdentifier(column, dialect)).join(', ')}`,
    strategy,
    columns,
    stableAcrossChanges
  };
}
