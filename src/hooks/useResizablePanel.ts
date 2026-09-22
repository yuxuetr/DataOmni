import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clampPanelSize,
  loadPanelCollapsed,
  loadPanelSize,
  savePanelCollapsed,
  savePanelSize
} from '../utils/panelLayout';

export interface ResizablePanelOptions {
  /** localStorage 里的标识，每个分栏一个 */
  storageKey: string;
  defaultSize: number;
  minSize: number;
  maxSize: number;
  /** 'x' 拖宽度，'y' 拖高度 */
  axis: 'x' | 'y';
}

export interface ResizablePanel {
  size: number;
  startResize: (event: React.PointerEvent) => void;
  isResizing: boolean;
  /** 双击分隔条恢复默认尺寸 */
  resetSize: () => void;
  /** 折叠中。`size` 不受影响，展开时拿回的就是折叠前那个宽度 */
  collapsed: boolean;
  toggleCollapsed: () => void;
}

export function useResizablePanel({
  storageKey,
  defaultSize,
  minSize,
  maxSize,
  axis
}: ResizablePanelOptions): ResizablePanel {
  const [size, setSize] = useState(
    () => loadPanelSize(storageKey, defaultSize, minSize, maxSize)
  );
  const [isResizing, setIsResizing] = useState(false);
  const [collapsed, setCollapsed] = useState(() => loadPanelCollapsed(storageKey));

  const dragRef = useRef<{ start: number; startSize: number } | null>(null);
  const detachRef = useRef<(() => void) | null>(null);

  const startResize = useCallback((event: React.PointerEvent) => {
    event.preventDefault();

    dragRef.current = {
      start: axis === 'x' ? event.clientX : event.clientY,
      startSize: size
    };

    const handleMove = (moveEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }

      const position = axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
      setSize(clampPanelSize(drag.startSize + (position - drag.start), minSize, maxSize));
    };

    const detach = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      detachRef.current = null;
      dragRef.current = null;
      setIsResizing(false);
    };

    function handleUp() {
      detach();
    }

    // 就地挂监听而不是靠依赖 isResizing 的 effect：那样监听要等下一次渲染才
    // 挂上，按下之后、重渲染之前的移动会被丢掉（列宽那边踩过这个坑）
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    detachRef.current = detach;

    setIsResizing(true);
  }, [axis, size, minSize, maxSize]);

  // 拖动中卸载时不留下悬空的窗口监听
  useEffect(() => () => detachRef.current?.(), []);

  // 拖动结束后才落盘，不是每移动一像素写一次
  useEffect(() => {
    if (isResizing) {
      return;
    }
    savePanelSize(storageKey, size);
  }, [isResizing, size, storageKey]);

  useEffect(() => {
    savePanelCollapsed(storageKey, collapsed);
  }, [collapsed, storageKey]);

  const toggleCollapsed = useCallback(() => {
    // 展开时再夹一次：折叠期间窗口可能被拖小了，记着的那个宽度会超出上限
    if (collapsed) {
      setSize((remembered) => clampPanelSize(remembered, minSize, maxSize));
    }
    setCollapsed(!collapsed);
  }, [collapsed, minSize, maxSize]);

  return {
    size,
    startResize,
    isResizing,
    resetSize: useCallback(
      () => setSize(clampPanelSize(defaultSize, minSize, maxSize)),
      [defaultSize, minSize, maxSize]
    ),
    collapsed,
    toggleCollapsed
  };
}
