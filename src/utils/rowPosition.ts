import type { ColumnInfo } from '../contracts/databaseMetadata';
import type { SerializedResultValue } from '../contracts/resultSet';
import { unwrapResultValue } from './resultValues';

/**
 * ClickHouse MergeTree 表里一行的物理位置：所在 part（去掉 mutation 版本号）与 part 内的偏移。
 *
 * 表格改一行按整行的值定位，先数后改再核对。没有行锁也没有通用事务，数完到执行之间别处写进来
 * 一模一样的一行会被一起改；两行本来就一模一样时分不出改哪一行。位置把这两种都挡住：新写进来
 * 的行在新的 part 里；中间合并过，part 名的前四段（分区、最小块、最大块、层级）就变了，一行也
 * 不匹配，核对报「没有执行」。mutation 只在名字末尾加版本号、不挪行（25.8 上核对过：同一个
 * part 上连着两条 `ALTER … UPDATE` 与一条轻量 `DELETE` 都按位置命中），所以版本号要去掉——
 * 否则同一次提交里第二条就对不上了
 */
export interface RowPosition {
  part: string;
  offset: string;
}

/** 读表时多选的两列。名字带前缀，不会和用户的列撞上 */
export const PART_COLUMN = '__dataomni_part';
export const OFFSET_COLUMN = '__dataomni_part_offset';

/** part 名的前四段。分区 ID 里没有下划线（数值、日期直接写，别的是哈希，元组用 `-` 连） */
export const PART_BLOCK_EXPRESSION = "arrayStringConcat(arraySlice(splitByChar('_', _part), 1, 4), '_')";

/** 只有 MergeTree 一族有 `_part`：Memory、Log 这些表点名去查报 UNKNOWN_IDENTIFIER */
export function hasRowPositions(columns: readonly ColumnInfo[]): boolean {
  return /MergeTree$/.test(columns[0]?.table_engine ?? '');
}

/** 接在 SELECT 列表后面的那一段 */
export function positionProjection(): string {
  return `${PART_BLOCK_EXPRESSION} AS \`${PART_COLUMN}\`, _part_offset AS \`${OFFSET_COLUMN}\``;
}

const positions = new WeakMap<object, RowPosition>();

/**
 * 把读回来的位置从行里摘出来，记在行对象上：网格、复制、导出、编辑框只看到表自己的列，
 * 定位一行（`rowKeyOf`）时按同一个对象取回
 */
export function takeRowPositions<T extends Record<string, unknown>>(rows: readonly T[]): T[] {
  return rows.map((row) => {
    if (!(PART_COLUMN in row) || !(OFFSET_COLUMN in row)) return row;
    const { [PART_COLUMN]: part, [OFFSET_COLUMN]: offset, ...rest } = row;
    const stripped = rest as T;
    // UInt64 可能带着包装送来（`{type: 'bigint', value}`）
    const text = (value: unknown) => String(unwrapResultValue(value as SerializedResultValue));
    positions.set(stripped, { part: text(part), offset: text(offset) });
    return stripped;
  });
}

export function rowPositionOf(row: object): RowPosition | undefined {
  return positions.get(row);
}
