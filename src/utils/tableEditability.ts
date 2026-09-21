import type { RowIdentityAbsence, RowIdentityResult } from './rowIdentity';

/**
 * 表数据视图能不能在网格里改。
 *
 * 「能定位到唯一一行」（`rowIdentity`）是关于表的事实；这里加的是一条关于
 * **我们自己代码**的限制：当前的写入路径只会把键的第一列拼进 WHERE，所以
 * 复合键暂时也归入只读。让按钮亮着，用户点一下就会静默改掉一批同前缀的行，
 * 事后抛出的那句话已经救不回数据了。
 *
 * 写入路径改成用全部键列拼条件之后，`composite-key` 这一支连同本模块一起删掉。
 */
export type TableReadOnlyReason = RowIdentityAbsence | 'composite-key';

export interface TableEditability {
  editable: boolean;
  reason: TableReadOnlyReason | null;
  /** 键列，按键内次序；没有行标识时为空 */
  keyColumns: string[];
}

export function describeTableEditability(identity: RowIdentityResult): TableEditability {
  if (!identity.identity) {
    return { editable: false, reason: identity.absence, keyColumns: [] };
  }

  const keyColumns = identity.identity.columns;
  if (keyColumns.length > 1) {
    return { editable: false, reason: 'composite-key', keyColumns };
  }
  return { editable: true, reason: null, keyColumns };
}
