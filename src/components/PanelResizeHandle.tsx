import { clsx } from 'clsx';
import { useLanguageStore } from '../stores/languageStore';

interface PanelResizeHandleProps {
  axis: 'x' | 'y';
  active: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onDoubleClick: () => void;
  label: string;
}

/**
 * 分栏之间的拖动条。
 *
 * 看得见的只有 1px 的分隔线，命中区做到 5px——1px 的目标抓不住。
 */
export function PanelResizeHandle({
  axis,
  active,
  onPointerDown,
  onDoubleClick,
  label
}: PanelResizeHandleProps) {
  const t = useLanguageStore((state) => state.t);
  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={t('panel.resetHint', { label })}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      className={clsx(
        'group relative shrink-0 bg-line',
        axis === 'x' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
        active && 'bg-accent'
      )}
    >
      {/* 命中区盖在分隔线两侧，不占布局空间 */}
      <span
        className={clsx(
          'absolute',
          axis === 'x'
            ? '-left-1 top-0 h-full w-2'
            : 'left-0 -top-1 h-2 w-full'
        )}
      />
      <span
        className={clsx(
          'absolute bg-accent opacity-0 transition-opacity group-hover:opacity-100',
          active && 'opacity-100',
          axis === 'x' ? 'left-0 top-0 h-full w-px' : 'left-0 top-0 h-px w-full'
        )}
      />
    </div>
  );
}
