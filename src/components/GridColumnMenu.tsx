import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { Check, Columns3, Pin } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';
import type { TranslationKey } from '../i18n/translate';
import { GRID_DENSITIES, type GridDensity } from '../utils/gridColumns';

interface GridColumnMenuProps {
  columns: readonly string[];
  hidden: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onShowAll: () => void;
  density: GridDensity;
  onDensityChange: (density: GridDensity) => void;
  frozenCount: number;
  onFrozenCountChange: (count: number) => void;
  onClose: () => void;
}

export function GridColumnMenu({
  columns,
  hidden,
  onToggle,
  onShowAll,
  density,
  onDensityChange,
  frozenCount,
  onFrozenCountChange,
  onClose
}: GridColumnMenuProps) {
  const t = useLanguageStore((state) => state.t);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const visibleCount = columns.filter((name) => !hidden.has(name)).length;
  // 最多冻结到「留一列能滚」为止；冻满了横向滚动就彻底失效
  const freezeChoices = Array.from({ length: Math.max(0, visibleCount - 1) }, (_, index) => index + 1);

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full z-40 mt-1 flex max-h-96 w-72 flex-col rounded-control border border-line-strong bg-surface shadow-lg"
    >
      <div className="shrink-0 border-b border-line px-3 py-2">
        <p className="mb-1.5 text-xs font-medium text-fg-muted">{t('columns.density')}</p>
        <div className="flex gap-1">
          {GRID_DENSITIES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onDensityChange(option)}
              className={clsx(
                'flex-1 rounded-control border px-2 py-1 text-xs',
                option === density
                  ? 'border-accent-line bg-accent-soft text-accent'
                  : 'border-line-strong text-fg hover:bg-surface-hover'
              )}
            >
              {t(`columns.density.${option}` as TranslationKey)}
            </button>
          ))}
        </div>

        <p className="mb-1.5 mt-3 flex items-center gap-1 text-xs font-medium text-fg-muted">
          <Pin size={12} />
          {t('columns.freeze')}
        </p>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => onFrozenCountChange(0)}
            className={clsx(
              'rounded-control border px-2 py-1 text-xs',
              frozenCount === 0
                ? 'border-accent-line bg-accent-soft text-accent'
                : 'border-line-strong text-fg hover:bg-surface-hover'
            )}
          >
            {t('columns.freezeNone')}
          </button>
          {freezeChoices.map((count) => (
            <button
              key={count}
              type="button"
              onClick={() => onFrozenCountChange(count)}
              className={clsx(
                'rounded-control border px-2 py-1 text-xs',
                frozenCount === count
                  ? 'border-accent-line bg-accent-soft text-accent'
                  : 'border-line-strong text-fg hover:bg-surface-hover'
              )}
            >
              {t('columns.freezeCount', { count })}
            </button>
          ))}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-1.5">
        <span className="flex items-center gap-1 text-xs font-medium text-fg-muted">
          <Columns3 size={12} />
          {t('columns.title')}
        </span>
        <button
          type="button"
          onClick={onShowAll}
          disabled={hidden.size === 0}
          className="rounded-control px-1.5 py-0.5 text-xs text-accent hover:bg-accent-soft disabled:opacity-40"
        >
          {t('columns.showAll')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {columns.map((name) => {
          const isVisible = !hidden.has(name);
          // 最后一列不能再藏。禁用而不是让它点了没反应——点了没反应看上去像是坏了
          const isLast = isVisible && visibleCount <= 1;
          return (
            <button
              key={name}
              type="button"
              onClick={() => onToggle(name)}
              disabled={isLast}
              title={isLast ? t('columns.lastVisible') : name}
              className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-fg hover:bg-surface-hover disabled:opacity-40"
            >
              <span className={clsx('flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
                isVisible ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong')}
              >
                {isVisible && <Check size={10} />}
              </span>
              <span className="truncate">{name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
