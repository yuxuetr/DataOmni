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
export function selectionToClipboardText(
  rows: readonly (readonly SerializedResultValue[])[],
  selection: CellSelection
): string {
  const rect = selectionRect(selection);
  const singleCell = rect.top === rect.bottom && rect.left === rect.right;

  const lines: string[] = [];
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
