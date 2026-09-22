import { useLanguageStore } from '../stores/languageStore';
import { useContextMenu } from '../hooks/useContextMenu';
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
  const { ref: panelRef, style } = useContextMenu<HTMLDivElement>(target, onClose);

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
      style={style}
      className="fixed z-50 min-w-48 rounded-control border border-line-strong bg-surface py-1 shadow-lg"
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
