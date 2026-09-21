import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { clsx } from 'clsx';
import type { SortDirection } from '../utils/resultSorting';
import { useLanguageStore } from '../stores/languageStore';

interface ColumnSortButtonProps {
  /** 该列当前的排序方向；未按此列排序时为 null */
  direction: SortDirection | null;
  onToggle: () => void;
  columnLabel: string;
}

/**
 * 表头上的排序指示。
 *
 * 未排序时也画一个淡箭头，否则「这列能不能点」只能靠试。悬停才显形会让
 * 触控板用户完全发现不了。
 */
export function ColumnSortButton({ direction, onToggle, columnLabel }: ColumnSortButtonProps) {
  const t = useLanguageStore((state) => state.t);
  const label = direction === 'asc'
    ? t('grid.sortAscHint', { column: columnLabel })
    : direction === 'desc'
      ? t('grid.sortDescHint', { column: columnLabel })
      : t('grid.sortNoneHint', { column: columnLabel });

  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      className={clsx(
        'shrink-0 rounded-control p-0.5 transition-colors',
        direction ? 'text-accent' : 'text-fg-subtle opacity-40 hover:opacity-100'
      )}
    >
      {direction === 'asc'
        ? <ArrowUp size={12} />
        : direction === 'desc'
          ? <ArrowDown size={12} />
          : <ChevronsUpDown size={12} />}
    </button>
  );
}
