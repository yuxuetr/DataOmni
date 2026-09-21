import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import { describeTableEditability } from './tableEditability';

function column(name: string, overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    data_type: 'text',
    is_nullable: true,
    is_primary_key: false,
    ...overrides
  };
}

describe('describeTableEditability', () => {
  it('单列主键可以改', () => {
    const result = describeTableEditability([
      column('id', { is_primary_key: true }),
      column('name')
    ]);

    expect(result).toEqual({ editable: true, reason: null, keyColumns: ['id'] });
  });

  it('没有主键时不可改，并说出是哪一种原因', () => {
    const result = describeTableEditability([column('a'), column('b')]);

    expect(result.editable).toBe(false);
    expect(result.reason).toBe('no-unique-key');
    expect(result.keyColumns).toEqual([]);
  });

  it('复合主键暂时不可改', () => {
    // 写入路径只取第一列拼 WHERE pk1 = ?，复合主键下会命中一批行。
    // 在 2.5 用全部主键列拼条件之前，让按钮亮着等于放任静默改错数据
    const result = describeTableEditability([
      column('order_id', { is_primary_key: true, primary_key_ordinal: 1 }),
      column('line_no', { is_primary_key: true, primary_key_ordinal: 2 }),
      column('qty')
    ]);

    expect(result.editable).toBe(false);
    expect(result.reason).toBe('composite-primary-key');
    expect(result.keyColumns).toEqual(['order_id', 'line_no']);
  });

  it('主键列按主键内的次序列出，不按表里的列序', () => {
    // 提示里要把键列念给用户听，念反了他会以为自己记错了表结构
    const result = describeTableEditability([
      column('line_no', { is_primary_key: true, primary_key_ordinal: 2 }),
      column('order_id', { is_primary_key: true, primary_key_ordinal: 1 })
    ]);

    expect(result.keyColumns).toEqual(['order_id', 'line_no']);
  });

  it('没有 ordinal 时退回表里的列序', () => {
    // 某些驱动的元数据查询不给序号；此时至少要稳定，不能随 sort 实现漂移
    const result = describeTableEditability([
      column('a', { is_primary_key: true }),
      column('b', { is_primary_key: true })
    ]);

    expect(result.keyColumns).toEqual(['a', 'b']);
  });
});
