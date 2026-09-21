import { useCallback, useEffect, useRef, useState } from 'react';
import type { SerializedResultValue } from '../contracts/resultSet';
import {
  isCellMoveKey,
  isWithinSelection,
  moveSelection,
  selectAllCells,
  selectionToClipboardText,
  type CellSelection
} from '../utils/cellSelection';
import { describeError } from '../utils/describeError';
import { translateNow } from '../stores/languageStore';

export interface CellSelectionController {
  selection: CellSelection | null;
  isSelected: (row: number, column: number) => boolean;
  /** 焦点格：方向键从它出发，视觉上描一圈边框 */
  isFocused: (row: number, column: number) => boolean;
  selectCell: (row: number, column: number, extend?: boolean) => void;
  clearSelection: () => void;
  /** 挂在可滚动容器上：需要 tabIndex 才能收到键盘事件 */
  gridProps: {
    tabIndex: number;
    onKeyDown: (event: React.KeyboardEvent) => void;
  };
  /** 复制失败时的提示；成功时为 null */
  copyError: string | null;
}

/**
 * 网格的单元格选择与复制。
 *
 * `rows` 换了引用就清掉选区：留着的话焦点会指向一份已经不存在的数据，
 * 复制出来的是另一行的内容。
 *
 * 因此调用方必须传一个**稳定的**数组引用（useMemo 或 state），不能每次渲染
 * 现 slice 一个新数组——那样选区会在每次渲染时被清掉，根本选不中。
 */
export function useCellSelection(
  rows: readonly (readonly SerializedResultValue[])[],
  columnCount: number
): CellSelectionController {
  const [selection, setSelection] = useState<CellSelection | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const rowCount = rows.length;

  // 数据换了就丢掉选区
  useEffect(() => {
    setSelection(null);
  }, [rows, columnCount]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const copySelection = useCallback(async (current: CellSelection) => {
    const text = selectionToClipboardText(rowsRef.current, current);

    try {
      await navigator.clipboard.writeText(text);
      setCopyError(null);
    } catch (cause) {
      // 剪贴板可能被权限或非安全上下文拒绝；静默失败会让人以为复制成功了
      setCopyError(describeError(cause, translateNow('common.copyFailed')));
    }
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    const commandKey = event.metaKey || event.ctrlKey;

    if (commandKey && event.key.toLowerCase() === 'c') {
      if (selection) {
        event.preventDefault();
        void copySelection(selection);
      }
      return;
    }

    if (commandKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelection(selectAllCells({ rowCount, columnCount }));
      return;
    }

    if (event.key === 'Escape') {
      setSelection(null);
      return;
    }

    if (!isCellMoveKey(event.key)) {
      return;
    }

    // 方向键在可滚动容器里默认会滚动页面，交给选区之后再由浏览器滚到可视区
    event.preventDefault();
    setSelection((current) => moveSelection(current, event.key as never, { rowCount, columnCount }, {
      extend: event.shiftKey,
      toEdge: commandKey
    }));
  }, [selection, copySelection, rowCount, columnCount]);

  return {
    selection,
    isSelected: useCallback(
      (row, column) => selection !== null && isWithinSelection(selection, row, column),
      [selection]
    ),
    isFocused: useCallback(
      (row, column) => selection?.focus.row === row && selection?.focus.column === column,
      [selection]
    ),
    selectCell: useCallback((row, column, extend = false) => {
      setSelection((current) => ({
        anchor: extend && current ? current.anchor : { row, column },
        focus: { row, column }
      }));
    }, []),
    clearSelection: useCallback(() => setSelection(null), []),
    gridProps: { tabIndex: 0, onKeyDown: handleKeyDown },
    copyError
  };
}
