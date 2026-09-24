import { Copy, CopyX, Pin, PinOff, X } from 'lucide-react';
import type { WorkspaceTab } from '../contracts/workspace';
import { useLanguageStore } from '../stores/languageStore';
import { useContextMenu } from '../hooks/useContextMenu';

interface WorkspaceTabMenuProps {
  tab: WorkspaceTab;
  position: { x: number; y: number };
  onTogglePinned: () => void;
  /** 只有 SQL 标签可复制，其它类型不传 */
  onDuplicate?: () => void;
  onClose: () => void;
  /** 没有别的标签可关时不传 */
  onCloseOthers?: () => void;
  onDismiss: () => void;
}

export function WorkspaceTabMenu({
  tab,
  position,
  onTogglePinned,
  onDuplicate,
  onClose,
  onCloseOthers,
  onDismiss
}: WorkspaceTabMenuProps) {
  const t = useLanguageStore((state) => state.t);
  const { ref: menuRef, style } = useContextMenu<HTMLDivElement>(position, onDismiss);

  const itemClass = 'flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left text-fg hover:bg-surface-hover';

  return (
    <div
      ref={menuRef}
      role="menu"
      style={style}
      className="fixed z-50 w-44 py-1 bg-surface border border-line rounded-control shadow-lg"
    >
      <button type="button" role="menuitem" className={itemClass} onClick={onTogglePinned}>
        {tab.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        <span>{tab.pinned ? t('tab.unpin') : t('tab.pin')}</span>
      </button>

      {onDuplicate && (
        <button type="button" role="menuitem" className={itemClass} onClick={onDuplicate}>
          <Copy size={14} />
          <span>{t('tab.duplicateAction')}</span>
        </button>
      )}

      <div className="my-1 border-t border-line" />

      <button type="button" role="menuitem" className={itemClass} onClick={onClose}>
        <X size={14} />
        <span>{t('tab.closeAction')}</span>
      </button>

      {onCloseOthers && (
        <button type="button" role="menuitem" className={itemClass} onClick={onCloseOthers}>
          <CopyX size={14} />
          <span>{t('tab.closeOthers')}</span>
        </button>
      )}
    </div>
  );
}
