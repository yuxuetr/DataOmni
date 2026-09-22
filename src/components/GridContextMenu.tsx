import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLanguageStore } from '../stores/languageStore';
import { SHORTCUTS, formatShortcut } from '../utils/shortcuts';

export interface GridContextTarget {
  row: number;
  column: number;
  x: number;
  y: number;
}

interface GridContextMenuProps {
  target: GridContextTarget;
  onCopy: (withHeaders: boolean) => void;
  onCopyRow: (row: number) => void;
  onCopyColumn: (column: number) => void;
  onClose: () => void;
}

/**
 * 网格的右键菜单。
 *
 * 键盘上 ⌘C / ⇧Space / ⌃Space 已经够用，但没有任何地方写着它们存在——
 * 「复制这一列」是个每天都要做的动作，不该只有读过快捷键表的人才会。
 */
export function GridContextMenu({
  target,
  onCopy,
  onCopyRow,
  onCopyColumn,
  onClose
}: GridContextMenuProps) {
  const t = useLanguageStore((state) => state.t);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: target.x, top: target.y });

  // 贴着视口边缘右击时，菜单会有一半在屏幕外而且滚不到
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const { width, height } = panel.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(target.x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(target.y, window.innerHeight - height - 4))
    });
  }, [target.x, target.y]);

  useEffect(() => {
    const dismiss = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', onKeyDown);
    // 滚动会让菜单留在原地而目标格跑掉，指向的东西就不对了
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [onClose]);

  const hint = formatShortcut;
  const items: Array<{ label: string; hint?: string; run: () => void }> = [
    { label: t('grid.copySelection'), hint: hint(SHORTCUTS.copySelection), run: () => onCopy(false) },
    { label: t('grid.copyWithHeaders'), hint: hint(SHORTCUTS.copyWithHeaders), run: () => onCopy(true) },
    { label: t('grid.copyRow'), hint: hint(SHORTCUTS.copyRow), run: () => onCopyRow(target.row) },
    { label: t('grid.copyColumn'), hint: hint(SHORTCUTS.copyColumn), run: () => onCopyColumn(target.column) }
  ];

  return (
    <div
      ref={panelRef}
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      className="fixed z-50 min-w-48 rounded-control border border-line-strong bg-surface py-1 shadow-lg"
      onMouseDown={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={() => {
            item.run();
            onClose();
          }}
          className="flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-xs text-fg hover:bg-surface-hover"
        >
          <span>{item.label}</span>
          {item.hint && <span className="text-fg-subtle">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}
