import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts/databaseMetadata';
import { OFFSET_COLUMN, PART_COLUMN, hasRowPositions, rowPositionOf, takeRowPositions } from './rowPosition';
import { rowKeyOf } from './rowIdentity';

const column = (table_engine: string | null): ColumnInfo => ({
  name: 'id',
  data_type: 'UInt32',
  is_nullable: false,
  is_primary_key: true,
  table_engine
});

describe('ClickHouse 行的物理位置', () => {
  it('只有 MergeTree 一族的表带位置', () => {
    expect(hasRowPositions([column('MergeTree')])).toBe(true);
    expect(hasRowPositions([column('ReplicatedReplacingMergeTree')])).toBe(true);
    expect(hasRowPositions([column('Memory')])).toBe(false);
    expect(hasRowPositions([column(null)])).toBe(false);
    expect(hasRowPositions([])).toBe(false);
  });

  // 网格、复制、导出、编辑框只该看到表自己的列
  it('读回来的位置从行里摘掉，按同一个行对象取回', () => {
    const [row, plain] = takeRowPositions([
      { id: 1, name: 'a', [PART_COLUMN]: 'all_1_1_0', [OFFSET_COLUMN]: 7 },
      { id: 2, name: 'b' }
    ]);
    const [tagged] = takeRowPositions([{ id: 3, [PART_COLUMN]: 'all_2_2_0', [OFFSET_COLUMN]: { type: 'bigint', value: '18446744073709551615' } }]);
    expect(rowPositionOf(tagged)).toEqual({ part: 'all_2_2_0', offset: '18446744073709551615' });
    expect(Object.keys(row)).toEqual(['id', 'name']);
    expect(rowPositionOf(row)).toEqual({ part: 'all_1_1_0', offset: '7' });
    expect(rowPositionOf(plain)).toBeUndefined();
    expect(rowPositionOf({ ...row })).toBeUndefined();
  });

  it('整行定位的键带上位置，按主键定位的不带', () => {
    const [row] = takeRowPositions([{ id: 1, name: 'a', [PART_COLUMN]: 'all_1_1_0', [OFFSET_COLUMN]: '7' }]);
    const whole = rowKeyOf({ columns: ['id', 'name'], source: 'whole-row', indexName: null }, row);
    expect(whole.position).toEqual({ part: 'all_1_1_0', offset: '7' });
    const primary = rowKeyOf({ columns: ['id'], source: 'primary-key', indexName: null }, row);
    expect(primary.position).toBeUndefined();
  });
});
