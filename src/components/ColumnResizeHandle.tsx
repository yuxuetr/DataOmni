import { clsx } from 'clsx';
import { useLanguageStore } from '../stores/languageStore';

interface ColumnResizeHandleProps {
  active: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onDoubleClick: () => void;
}

/**
 * 列边界上的拖动把手。
 *
 * 命中区域比看得见的分隔线宽（8px vs 1px）：1px 的目标用鼠标几乎抓不住。
 */
export function ColumnResizeHandle({
  active,
  onPointerDown,
  onDoubleClick
}: ColumnResizeHandleProps) {
  const t = useLanguageStore((state) => state.t);
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={t('grid.resizeColumn')}
      title={t('grid.resizeColumnTitle')}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onClick={(event) => event.stopPropagation()}
      className={clsx(
        'absolute right-0 top-0 z-10 h-full w-2 translate-x-1/2 cursor-col-resize select-none',
        // 竖线本身画在命中区中间，占 1px
        'after:absolute after:left-1/2 after:top-0 after:h-full after:w-px',
        active ? 'after:bg-accent' : 'after:bg-transparent hover:after:bg-line-strong'
      )}
    />
  );
}
