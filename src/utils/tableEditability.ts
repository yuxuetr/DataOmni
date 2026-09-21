import type { ColumnInfo } from '../contracts';

/**
 * 表数据视图为什么不能改。
 *
 * - `no-unique-key`：没有主键。任何 UPDATE / DELETE 的 WHERE 都无法锁定到唯一一行。
 * - `composite-primary-key`：有复合主键，但写入路径目前只会取第一列
 *   （`tableSchema.columns.find(col => col.is_primary_key)`），拼出的
 *   `WHERE pk1 = ?` 会命中所有 pk1 相同的行。
 */
export type TableReadOnlyReason = 'no-unique-key' | 'composite-primary-key';

export interface TableEditability {
  editable: boolean;
  reason: TableReadOnlyReason | null;
  /** 主键列，按主键内的次序；没有主键时为空 */
  keyColumns: string[];
}

/**
 * 判断这张表能不能在网格里改。
 *
 * 复合主键之所以也算不可改，不是因为做不到，而是因为**现在**的写入路径做错了：
 * 它只拿第一列拼 WHERE。让按钮亮着，用户点一下就会静默改掉一批同前缀的行，
 * 事后 `assertSingleRowAffected` 抛出的那句话已经救不回数据了。
 * 等 2.5 的 ChangeSet 用全部主键列拼条件之后，这一支就可以去掉。
 */
export function describeTableEditability(columns: readonly ColumnInfo[]): TableEditability {
  const keyColumns = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => column.is_primary_key)
    .sort((left, right) => (
      (left.column.primary_key_ordinal ?? left.index + 1)
      - (right.column.primary_key_ordinal ?? right.index + 1)
    ))
    .map(({ column }) => column.name);

  if (keyColumns.length === 0) {
    return { editable: false, reason: 'no-unique-key', keyColumns };
  }
  if (keyColumns.length > 1) {
    return { editable: false, reason: 'composite-primary-key', keyColumns };
  }
  return { editable: true, reason: null, keyColumns };
}
