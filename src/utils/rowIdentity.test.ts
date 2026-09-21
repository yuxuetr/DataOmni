import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import type { IndexInfo } from './schemaObjects';
import { describeRowIdentity, primaryKeyColumns, type IndexMetadata } from './rowIdentity';

function column(name: string, overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    data_type: 'text',
    is_nullable: false,
    is_primary_key: false,
    ...overrides
  };
}

function index(name: string, columns: string[], overrides: Partial<IndexInfo> = {}): IndexInfo {
  return {
    name,
    columns,
    isUnique: true,
    isPrimary: false,
    isPartial: false,
    isValid: true,
    method: 'btree',
    ...overrides
  };
}

const LOADED = (indexes: IndexInfo[]): IndexMetadata => ({ status: 'loaded', indexes });
const NONE = LOADED([]);

describe('primaryKeyColumns', () => {
  it('按主键内的次序，不按列在表里的次序', () => {
    const columns = [
      column('a', { is_primary_key: true, primary_key_ordinal: 2 }),
      column('b'),
      column('c', { is_primary_key: true, primary_key_ordinal: 1 })
    ];
    expect(primaryKeyColumns(columns)).toEqual(['c', 'a']);
  });

  it('没有 ordinal 时退回列位置', () => {
    // SQLite 的 pragma 在单列主键上给不出键内次序
    const columns = [
      column('a', { is_primary_key: true }),
      column('b', { is_primary_key: true })
    ];
    expect(primaryKeyColumns(columns)).toEqual(['a', 'b']);
  });
});

describe('describeRowIdentity', () => {
  it('有主键就用主键，不等索引读回来', () => {
    // SQLite 的 INTEGER PRIMARY KEY 根本不在 pragma_index_list 里，等也等不到
    const result = describeRowIdentity([column('id', { is_primary_key: true })], { status: 'pending' });
    expect(result.identity).toEqual({ columns: ['id'], source: 'primary-key', indexName: null });
  });

  it('复合主键给出全部键列', () => {
    const columns = [
      column('tenant', { is_primary_key: true, primary_key_ordinal: 1 }),
      column('sku', { is_primary_key: true, primary_key_ordinal: 2 })
    ];
    expect(describeRowIdentity(columns, NONE).identity?.columns).toEqual(['tenant', 'sku']);
  });

  it('没有主键时退到非空的唯一索引', () => {
    const result = describeRowIdentity(
      [column('email'), column('note')],
      LOADED([index('uq_email', ['email'])])
    );
    expect(result.identity).toEqual({
      columns: ['email'],
      source: 'unique-index',
      indexName: 'uq_email'
    });
  });

  it('可空的唯一列不算行标识', () => {
    // 唯一索引把 NULL 之间看作互不相等：可空唯一列上可以有任意多行是 NULL
    const result = describeRowIdentity(
      [column('email', { is_nullable: true })],
      LOADED([index('uq_email', ['email'])])
    );
    expect(result).toEqual({ identity: null, absence: 'no-unique-key' });
  });

  it('部分索引不算行标识', () => {
    // CREATE UNIQUE INDEX ... WHERE deleted = false 只在谓词成立的行上唯一
    const result = describeRowIdentity(
      [column('email')],
      LOADED([index('uq_live_email', ['email'], { isPartial: true })])
    );
    expect(result.absence).toBe('no-unique-key');
  });

  it('未验证的索引不算行标识', () => {
    // CREATE INDEX CONCURRENTLY 建失败留下的残骸，唯一性从没在存量数据上查过
    const result = describeRowIdentity(
      [column('email')],
      LOADED([index('uq_email', ['email'], { isValid: false })])
    );
    expect(result.absence).toBe('no-unique-key');
  });

  it('表达式索引不算行标识', () => {
    // PostgreSQL 返回的是 `lower(email)`，它唯一的是表达式的值，不是某一列的值
    const result = describeRowIdentity(
      [column('email')],
      LOADED([index('uq_lower_email', ['lower(email)'])])
    );
    expect(result.absence).toBe('no-unique-key');
  });

  it('非唯一索引不算行标识', () => {
    const result = describeRowIdentity(
      [column('email')],
      LOADED([index('ix_email', ['email'], { isUnique: false })])
    );
    expect(result.absence).toBe('no-unique-key');
  });

  it('多个候选时选列最少的那个', () => {
    const result = describeRowIdentity(
      [column('a'), column('b'), column('c')],
      LOADED([index('uq_ab', ['a', 'b']), index('uq_c', ['c'])])
    );
    expect(result.identity?.indexName).toBe('uq_c');
  });

  it('同样长的候选按名字选，保证每次选出同一个', () => {
    const result = describeRowIdentity(
      [column('a'), column('b')],
      LOADED([index('uq_b', ['b']), index('uq_a', ['a'])])
    );
    expect(result.identity?.indexName).toBe('uq_a');
  });

  it('索引还没读回来时说「还不知道」，不说「没有」', () => {
    // 列先到、索引后到。这中间说「这张表没有唯一键」会被随后推翻
    const result = describeRowIdentity([column('email')], { status: 'pending' });
    expect(result).toEqual({ identity: null, absence: 'metadata-pending' });
  });

  it('目录查询失败和「确实没有唯一键」是两回事', () => {
    const result = describeRowIdentity([column('email')], { status: 'unavailable' });
    expect(result).toEqual({ identity: null, absence: 'metadata-unavailable' });
  });

  it('表结构本身还没到时也是「还不知道」', () => {
    expect(describeRowIdentity([], NONE).absence).toBe('metadata-pending');
  });
});
