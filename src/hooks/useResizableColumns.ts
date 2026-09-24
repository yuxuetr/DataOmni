import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SerializedResultValue } from '../contracts/resultSet';
import {
  clampColumnWidth,
  measureColumnAlignments,
  measureColumnWidths,
  type ColumnAlignment
} from '../utils/columnWidths';

/** 拖动时允许比自动估算的上限更宽：用户明确要看宽一列 */
const DRAG_MAX_WIDTH = 1200;
const DRAG_MIN_WIDTH = 48;
const NO_BADGES: readonly number[] = [];

export interface ResizableColumns {
  /** 与 columns 一一对应的像素宽度 */
  widths: number[];
  /** 与 columns 一一对应的对齐方式；数值列右对齐 */
  alignments: ColumnAlignment[];
  totalWidth: number;
  /** 按下列边界时调用，接管后续的指针移动 */
  startResize: (index: number, event: React.PointerEvent) => void;
  /** 双击列边界：丢弃手动宽度，回到按内容估算 */
  autoFitColumn: (index: number) => void;
  /** 正在拖动的列下标，用于高亮那根分隔线 */
  resizingIndex: number | null;
}

/**
 * 列宽：默认按内容估算，允许拖动覆盖。
 *
 * 手动宽度按列名记录而不是按下标——同一张表翻页、重新查询后列名不变，用户调好的
 * 宽度不该被重置；而整组列名变了（换了一条 SQL）就说明是另一份结果，旧宽度不再适用。
 */
export function useResizableColumns(
  columns: readonly string[],
  rows: readonly (readonly SerializedResultValue[])[],
  /** 各列表头徽标的宽度，见 `headerBadgeWidth`；查询结果的表头没有徽标 */
  headerBadges: readonly number[] = NO_BADGES
): ResizableColumns {
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [resizingIndex, setResizingIndex] = useState<number | null>(null);

  const columnsKey = columns.join('\u0000');
  const alignments = useMemo(
    () => measureColumnAlignments(columns, rows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columnsKey, rows]
  );
  const badgesKey = headerBadges.join(',');
  const measured = useMemo(
    () => measureColumnWidths(columns, rows, { headerBadges }),
    // columnsKey 而不是 columns：数组每次渲染都是新引用，直接依赖会每帧重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columnsKey, badgesKey, rows]
  );

  // 换了一组列就是另一份结果，手动宽度不再适用
  useEffect(() => {
    setOverrides({});
  }, [columnsKey]);

  const widths = columns.map(
    (column, index) => overrides[column] ?? measured[index] ?? DRAG_MIN_WIDTH
  );

  // 拖动过程中不经 React 状态，避免每次指针移动都重渲染整张表
  const dragRef = useRef<{ column: string; startX: number; startWidth: number } | null>(null);
  const detachRef = useRef<(() => void) | null>(null);

  const startResize = useCallback((index: number, event: React.PointerEvent) => {
    const column = columns[index];
    if (column === undefined) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    dragRef.current = {
      column,
      startX: event.clientX,
      startWidth: widths[index]
    };

    const handleMove = (moveEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }

      setOverrides((previous) => ({
        ...previous,
        [drag.column]: clampColumnWidth(drag.startWidth + (moveEvent.clientX - drag.startX), {
          minWidth: DRAG_MIN_WIDTH,
          maxWidth: DRAG_MAX_WIDTH
        })
      }));
    };

    const detach = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      detachRef.current = null;
      dragRef.current = null;
      setResizingIndex(null);
    };

    function handleUp() {
      detach();
    }

    // 就地挂监听，而不是交给一个依赖 resizingIndex 的 effect：那样监听要等
    // 下一次渲染才挂上，pointerdown 之后、重渲染之前的移动会被整个丢掉。
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    detachRef.current = detach;

    setResizingIndex(index);
  }, [columns, widths]);

  // 拖动中卸载（比如切走标签）时不留下悬空的窗口监听
  useEffect(() => () => detachRef.current?.(), []);

  const autoFitColumn = useCallback((index: number) => {
    const column = columns[index];
    if (column === undefined) {
      return;
    }

    setOverrides((previous) => {
      if (!(column in previous)) {
        return previous;
      }

      const next = { ...previous };
      delete next[column];
      return next;
    });
  }, [columns]);

  return {
    widths,
    alignments,
    totalWidth: widths.reduce((sum, width) => sum + width, 0),
    startResize,
    autoFitColumn,
    resizingIndex
  };
}
