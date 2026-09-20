import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import { createSortedOrderClause, createTablePaginationOrder } from './tablePagination';

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

describe('用户排序与分页排序的合并', () => {
  const columns: ColumnInfo[] = [
    { name: 'id', data_type: 'int', is_nullable: false, is_primary_key: true },
    { name: 'city', data_type: 'text', is_nullable: true, is_primary_key: false }
  ] as ColumnInfo[];

  it('没有用户排序时就是分页排序本身', () => {
    const order = createTablePaginationOrder(columns, 'postgresql');
    expect(createSortedOrderClause(order, null, 'postgresql')).toBe(order.clause);
  });

  it('用户排序在前，主键追加在后作为决胜条件', () => {
    // 少了决胜条件，按不唯一的 city 排序时翻页会重复或漏行
    const order = createTablePaginationOrder(columns, 'postgresql');
    expect(createSortedOrderClause(order, { column: 'city', direction: 'asc' }, 'postgresql'))
      .toBe('ORDER BY "city" ASC, "id"');
  });

  it('降序同样保留决胜条件', () => {
    const order = createTablePaginationOrder(columns, 'postgresql');
    expect(createSortedOrderClause(order, { column: 'city', direction: 'desc' }, 'postgresql'))
      .toBe('ORDER BY "city" DESC, "id"');
  });

  it('排序列本身就是主键时不重复追加', () => {
    const order = createTablePaginationOrder(columns, 'postgresql');
    expect(createSortedOrderClause(order, { column: 'id', direction: 'desc' }, 'postgresql'))
      .toBe('ORDER BY "id" DESC');
  });

  it('MySQL 用反引号', () => {
    const order = createTablePaginationOrder(columns, 'mysql');
    expect(createSortedOrderClause(order, { column: 'city', direction: 'asc' }, 'mysql'))
      .toBe('ORDER BY `city` ASC, `id`');
  });

  it('没有主键时 PostgreSQL 用 ctid 决胜，且不加引号', () => {
    const noPrimaryKey = [
      { name: 'city', data_type: 'text', is_nullable: true, is_primary_key: false }
    ] as ColumnInfo[];
    const order = createTablePaginationOrder(noPrimaryKey, 'postgresql');
    expect(createSortedOrderClause(order, { column: 'city', direction: 'asc' }, 'postgresql'))
      .toBe('ORDER BY "city" ASC, ctid');
  });

  it('没有主键时 SQLite 用 rowid 决胜，且不加引号', () => {
    const noPrimaryKey = [
      { name: 'city', data_type: 'text', is_nullable: true, is_primary_key: false }
    ] as ColumnInfo[];
    const order = createTablePaginationOrder(noPrimaryKey, 'sqlite');
    expect(createSortedOrderClause(order, { column: 'city', direction: 'asc' }, 'sqlite'))
      .toBe('ORDER BY "city" ASC, rowid');
  });

  it('列名里的引号被转义，不会拼出越界的 SQL', () => {
    const order = createTablePaginationOrder(columns, 'postgresql');
    expect(createSortedOrderClause(order, { column: 'we"ird', direction: 'asc' }, 'postgresql'))
      .toBe('ORDER BY "we""ird" ASC, "id"');
  });
});
