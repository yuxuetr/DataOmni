import type { SerializedResultValue } from '../contracts/resultSet';
import { formatResultValue } from './resultValues';

export interface CellPosition {
  row: number;
  column: number;
}

/**
 * 选区由锚点和焦点两端决定，矩形是两者的包围盒。
 * 保留两端而不是直接存矩形：Shift + 方向键要从锚点出发反向收缩，只有矩形的话
 * 分不清该动哪条边。
 */
export interface CellSelection {
  anchor: CellPosition;
  focus: CellPosition;
}

export interface GridBounds {
  rowCount: number;
  columnCount: number;
}

export interface SelectionRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export function selectionRect(selection: CellSelection): SelectionRect {
  return {
    top: Math.min(selection.anchor.row, selection.focus.row),
    bottom: Math.max(selection.anchor.row, selection.focus.row),
    left: Math.min(selection.anchor.column, selection.focus.column),
    right: Math.max(selection.anchor.column, selection.focus.column)
  };
}

export function isWithinSelection(selection: CellSelection, row: number, column: number): boolean {
  const rect = selectionRect(selection);
  return row >= rect.top && row <= rect.bottom && column >= rect.left && column <= rect.right;
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), Math.max(max, 0));
}

/** 键盘能识别的移动指令；其余按键交还给调用方 */
export type CellMoveKey =
  | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
  | 'Home' | 'End' | 'PageUp' | 'PageDown';

export function isCellMoveKey(key: string): key is CellMoveKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight'
    || key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown';
}

export interface MoveOptions {
  /** Shift：从锚点延伸选区而不是整体移动 */
  extend?: boolean;
  /** ⌘ / Ctrl：跳到整行或整列的尽头 */
  toEdge?: boolean;
  /** PageUp / PageDown 一次跨多少行 */
  pageSize?: number;
}

/**
 * 移动焦点。返回新的选区；没有选区时从左上角开始。
 */
export function moveSelection(
  selection: CellSelection | null,
  key: CellMoveKey,
  bounds: GridBounds,
  options: MoveOptions = {}
): CellSelection | null {
  if (bounds.rowCount <= 0 || bounds.columnCount <= 0) {
    return null;
  }

  const origin: CellSelection = selection ?? {
    anchor: { row: 0, column: 0 },
    focus: { row: 0, column: 0 }
  };

  // 还没有选区时，任何移动键都只是把光标落在左上角
  if (!selection) {
    return origin;
  }

  const { extend = false, toEdge = false, pageSize = 10 } = options;
  const lastRow = bounds.rowCount - 1;
  const lastColumn = bounds.columnCount - 1;
  const { row, column } = origin.focus;

  let next: CellPosition;
  switch (key) {
    case 'ArrowUp':
      next = { row: toEdge ? 0 : row - 1, column };
      break;
    case 'ArrowDown':
      next = { row: toEdge ? lastRow : row + 1, column };
      break;
    case 'ArrowLeft':
      next = { row, column: toEdge ? 0 : column - 1 };
      break;
    case 'ArrowRight':
      next = { row, column: toEdge ? lastColumn : column + 1 };
      break;
    case 'Home':
      next = toEdge ? { row: 0, column: 0 } : { row, column: 0 };
      break;
    case 'End':
      next = toEdge ? { row: lastRow, column: lastColumn } : { row, column: lastColumn };
      break;
    case 'PageUp':
      next = { row: row - pageSize, column };
      break;
    case 'PageDown':
      next = { row: row + pageSize, column };
      break;
  }

  const clamped: CellPosition = {
    row: clamp(next.row, lastRow),
    column: clamp(next.column, lastColumn)
  };

  return {
    anchor: extend ? origin.anchor : clamped,
    focus: clamped
  };
}

/**
 * 整行 / 整列选区。
 *
 * 靠框选去选一整行，在几十列的表上要横拖过整个屏幕；而用户想做的事——
 * 「把这一行复制出去」——本身是一次点击的量。
 */
export function rowSelection(row: number, bounds: GridBounds): CellSelection | null {
  if (bounds.rowCount <= 0 || bounds.columnCount <= 0 || row < 0 || row >= bounds.rowCount) {
    return null;
  }
  return { anchor: { row, column: 0 }, focus: { row, column: bounds.columnCount - 1 } };
}

export function columnSelection(column: number, bounds: GridBounds): CellSelection | null {
  if (bounds.rowCount <= 0 || bounds.columnCount <= 0 || column < 0 || column >= bounds.columnCount) {
    return null;
  }
  return { anchor: { row: 0, column }, focus: { row: bounds.rowCount - 1, column } };
}

/**
 * 数据换过之后，这个选区还留不留。
 *
 * 分两种情况，而它们看起来一模一样——都是「rows 这个数组换了」：
 *
 * - **刷新**：同一份数据集重新取了一遍。用户按刷新就是想看这几行的最新值，
 *   把选区清掉等于每刷一次就要重新框一遍。
 * - **换了数据集**：翻页、改排序、改筛选、换表。此时同一个坐标指的是完全
 *   不同的一行，留着选区会让人以为自己还选着刚才那个值。
 *
 * 两者的区别只有调用方知道，所以由调用方给出 `sameDataset`。
 *
 * 另外，即使是刷新，行也可能变少（别人删了几行）。越界的选区要丢掉——
 * 复制出来会是一段空白，而屏幕上什么都没提示。
 */
export function retainSelection(
  selection: CellSelection | null,
  bounds: GridBounds,
  sameDataset: boolean
): CellSelection | null {
  if (!selection || !sameDataset) {
    return null;
  }

  const rect = selectionRect(selection);
  if (rect.bottom >= bounds.rowCount || rect.right >= bounds.columnCount) {
    return null;
  }

  return selection;
}

export function selectAllCells(bounds: GridBounds): CellSelection | null {
  if (bounds.rowCount <= 0 || bounds.columnCount <= 0) {
    return null;
  }

  return {
    anchor: { row: 0, column: 0 },
    focus: { row: bounds.rowCount - 1, column: bounds.columnCount - 1 }
  };
}

/**
 * TSV 里含有制表符、换行或引号的字段要加引号，否则粘进表格软件会串列。
 * 规则跟 CSV 一致：整段用双引号包住，内部的双引号写两遍。
 */
function escapeForTsv(text: string): string {
  if (!/[\t\n\r"]/.test(text)) {
    return text;
  }
  return `"${text.split('"').join('""')}"`;
}

/**
 * 选区转成可粘贴的文本。
 *
 * 单格和多格的规则不同，这是刻意的：
 * - 单格复制通常是为了把这个值贴进 SQL 或别处，要的是原样，加引号反而破坏它。
 * - 多格复制通常是为了贴进表格软件，那就必须守 TSV 的转义规则。
 *
 * NULL 一律写成 `NULL` 而不是空串：空串和「空字符串」这个真实值分不开。
 */
export interface ClipboardOptions {
  /**
   * 列名。给了就在最前面加一行表头。
   *
   * 整列复制出来只有一串值，贴到别处已经认不出是哪一列了——表头是复制
   * 一整列时唯一能保住语义的东西。
   */
  headers?: readonly string[];
}

export function selectionToClipboardText(
  rows: readonly (readonly SerializedResultValue[])[],
  selection: CellSelection,
  options: ClipboardOptions = {}
): string {
  const rect = selectionRect(selection);
  // 带上表头之后这一段就是一张表了，单格那条「原样复制」的规矩不再适用
  const singleCell = rect.top === rect.bottom && rect.left === rect.right && !options.headers;

  const lines: string[] = [];
  if (options.headers) {
    const cells: string[] = [];
    for (let column = rect.left; column <= rect.right; column += 1) {
      cells.push(escapeForTsv(options.headers[column] ?? ''));
    }
    lines.push(cells.join('\t'));
  }
  for (let row = rect.top; row <= rect.bottom; row += 1) {
    const cells: string[] = [];
    for (let column = rect.left; column <= rect.right; column += 1) {
      // 复制的是完整值，不是单元格里被截断的那一行
      const text = formatResultValue(rows[row]?.[column] ?? null);
      cells.push(singleCell ? text : escapeForTsv(text));
    }
    lines.push(cells.join('\t'));
  }

  return lines.join('\n');
}

/**
 * 选区里的那一块数据，连同对应的列名。
 *
 * 选区是个矩形，所以导出选中部分导出的是**这个矩形**，不是「这些行的全部列」。
 * 两者在整行选择时一样，在框选几列时不一样——而后者按整行导出会把用户没选的
 * 列也写进文件，那正是导出对话框里最该说清楚的事。
 */
export function selectionSubset(
  rows: readonly (readonly SerializedResultValue[])[],
  columns: readonly string[],
  selection: CellSelection
): { columns: string[]; rows: SerializedResultValue[][] } {
  const rect = selectionRect(selection);
  const picked: string[] = [];
  for (let column = rect.left; column <= rect.right; column += 1) {
    picked.push(columns[column] ?? '');
  }

  const picks: SerializedResultValue[][] = [];
  for (let row = rect.top; row <= rect.bottom; row += 1) {
    const source = rows[row];
    // 越界的行整行丢掉，而不是补一排 null——后者会在文件里留下看不出来的空行
    if (!source) {
      continue;
    }
    const cells: SerializedResultValue[] = [];
    for (let column = rect.left; column <= rect.right; column += 1) {
      cells.push(source[column] ?? null);
    }
    picks.push(cells);
  }

  return { columns: picked, rows: picks };
}
