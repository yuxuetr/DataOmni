import { useEffect, useRef } from 'react';
import { Copy, Pin, PinOff, X } from 'lucide-react';
import type { WorkspaceTab } from '../contracts/workspace';

interface WorkspaceTabMenuProps {
  tab: WorkspaceTab;
  position: { x: number; y: number };
  onTogglePinned: () => void;
  /** 只有 SQL 标签可复制，其它类型不传 */
  onDuplicate?: () => void;
  onClose: () => void;
  onDismiss: () => void;
}

export function WorkspaceTabMenu({
  tab,
  position,
  onTogglePinned,
  onDuplicate,
  onClose,
  onDismiss
}: WorkspaceTabMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onDismiss();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDismiss();
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onDismiss]);

  const itemClass = 'flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left text-fg hover:bg-surface-hover';

  return (
    <div
      ref={menuRef}
      role="menu"
      // 贴着鼠标位置显示；宽度固定，靠右边界时由 max 限制避免溢出窗口
      style={{
        left: Math.min(position.x, window.innerWidth - 180),
        top: Math.min(position.y, window.innerHeight - 120)
      }}
      className="fixed z-50 w-44 py-1 bg-surface border border-line rounded-control shadow-lg"
    >
      <button type="button" role="menuitem" className={itemClass} onClick={onTogglePinned}>
        {tab.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        <span>{tab.pinned ? '取消固定' : '固定标签'}</span>
      </button>

      {onDuplicate && (
        <button type="button" role="menuitem" className={itemClass} onClick={onDuplicate}>
          <Copy size={14} />
          <span>复制标签</span>
        </button>
      )}

      <div className="my-1 border-t border-line" />

      <button type="button" role="menuitem" className={itemClass} onClick={onClose}>
        <X size={14} />
        <span>关闭标签</span>
      </button>
    </div>
  );
}
