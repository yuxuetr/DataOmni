import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import { createTablePaginationOrder } from './tablePagination';

const column = (
  name: string,
  isPrimaryKey = false,
  primaryKeyOrdinal?: number
): ColumnInfo => ({
  name,
  data_type: 'text',
  is_nullable: false,
  is_primary_key: isPrimaryKey,
  primary_key_ordinal: primaryKeyOrdinal
});

describe('createTablePaginationOrder', () => {
  it('orders by every primary key column in key order', () => {
    const order = createTablePaginationOrder([
      column('tenant_id', true, 2),
      column('record_id', true, 1),
      column('payload')
    ], 'postgresql');

    expect(order).toEqual({
      clause: 'ORDER BY "record_id", "tenant_id"',
      strategy: 'primary-key',
      columns: ['record_id', 'tenant_id'],
      stableAcrossChanges: true
    });
  });

  it('uses physical row identifiers for SQLite and PostgreSQL tables without keys', () => {
    expect(createTablePaginationOrder([column('value')], 'sqlite').clause)
      .toBe('ORDER BY rowid');
    expect(createTablePaginationOrder([column('rowid'), column('value')], 'sqlite').clause)
      .toBe('ORDER BY _rowid_');
    expect(createTablePaginationOrder([column('value')], 'postgresql').clause)
      .toBe('ORDER BY ctid');
  });

  it('uses all MySQL columns as a deterministic fallback', () => {
    expect(createTablePaginationOrder([
      column('group'),
      column('created_at')
    ], 'mysql')).toMatchObject({
      clause: 'ORDER BY `group`, `created_at`',
      strategy: 'all-columns',
      stableAcrossChanges: false
    });
  });
});
