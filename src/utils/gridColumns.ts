/**
 * 网格的列显示控制：藏列、冻结、密度。
 *
 * 列宽不在这里——它由 `useResizableColumns` 按内容量出来，是个测量问题；
 * 这三项都是用户的偏好，纯粹由输入决定输出。
 */

export type GridDensity = 'compact' | 'default' | 'comfortable';

export const GRID_DENSITIES: readonly GridDensity[] = ['compact', 'default', 'comfortable'];

/** 单元格内边距。行高跟着内容走，只调 padding 就够，不去钉死 height */
export const DENSITY_CELL_CLASS: Record<GridDensity, string> = {
  compact: 'px-2 py-0',
  default: 'px-2 py-1',
  comfortable: 'px-3 py-2'
};

/**
 * 可见列在原始列表里的下标。
 *
 * 返回下标而不是列名：行数据是按位置排的数组，选区、列宽、对齐全都按下标索引，
 * 换成名字就得在每个调用点再映射一次，而那正是错位的来源。
 */
export function visibleColumnIndexes(
  columns: readonly string[],
  hidden: ReadonlySet<string>
): number[] {
  return columns
    .map((_, index) => index)
    .filter((index) => !hidden.has(columns[index] ?? ''));
}

/**
 * 切换一列的显示。
 *
 * 藏掉最后一列会得到一张空表，而「把列找回来」的入口也在那张空表的工具栏上——
 * 用户未必想得到去那里找。直接拒绝比事后解释便宜。
 */
export function toggleHiddenColumn(
  hidden: ReadonlySet<string>,
  columns: readonly string[],
  name: string
): Set<string> {
  const next = new Set(hidden);
  if (next.has(name)) {
    next.delete(name);
    return next;
  }

  if (visibleColumnIndexes(columns, next).length <= 1) {
    return next;
  }

  next.add(name);
  return next;
}

/**
 * 冻结列的左偏移，按**可见**列宽累计。
 *
 * 必须按可见列算：藏掉第一列之后，「冻结 1 列」冻的是当时看得见的第一列，
 * 若还按原列宽算偏移，冻住的那列会悬在一段空白之后。
 *
 * 返回的数组只覆盖冻结的那几列，其余为 null——调用方据此判断这一列要不要
 * 挂 sticky，不必再记一遍数量。
 */
export function frozenLeftOffsets(
  visibleWidths: readonly number[],
  frozenCount: number
): Array<number | null> {
  // 全冻等于没冻，还会让横向滚动彻底失效：留一列能动
  const effective = Math.max(0, Math.min(frozenCount, visibleWidths.length - 1));

  let left = 0;
  return visibleWidths.map((width, index) => {
    if (index >= effective) {
      return null;
    }
    const offset = left;
    left += width;
    return offset;
  });
}
