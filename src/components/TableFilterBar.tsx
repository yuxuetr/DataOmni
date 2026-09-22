import { Filter, Plus, X } from 'lucide-react';
import { PLAIN_TEXT_INPUT } from './FormControls';
import clsx from 'clsx';
import type { ColumnInfo } from '../contracts';
import { useLanguageStore } from '../stores/languageStore';
import {
  FILTER_OPERATORS,
  isCompleteFilter,
  operatorNeedsValue,
  type ColumnFilter,
  type FilterOperator
} from '../utils/tableFilters';
import type { TranslationKey } from '../i18n/translate';

interface TableFilterBarProps {
  columns: ColumnInfo[];
  /** 草稿。改动不会立刻查库——每敲一个字符发一次查询在大表上不可接受 */
  filters: ColumnFilter[];
  onChange: (filters: ColumnFilter[]) => void;
  onApply: () => void;
  /** 与已应用的条件不一致时提示用户还没生效 */
  pending: boolean;
  activeCount: number;
  disabled?: boolean;
}

let nextFilterId = 0;

function createFilter(column: string): ColumnFilter {
  nextFilterId += 1;
  return { id: `filter-${nextFilterId}`, column, operator: 'eq', value: '' };
}

export function TableFilterBar({
  columns,
  filters,
  onChange,
  onApply,
  pending,
  activeCount,
  disabled = false
}: TableFilterBarProps) {
  const t = useLanguageStore((state) => state.t);

  const update = (id: string, change: Partial<ColumnFilter>) => {
    onChange(filters.map((filter) => (filter.id === id ? { ...filter, ...change } : filter)));
  };

  return (
    <div className="border-b border-line bg-surface-sunken px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-xs font-medium text-fg-muted">
          <Filter size={13} />
          {t('filter.title')}
        </span>

        {activeCount > 0 && (
          <span className="rounded-control bg-accent-soft px-1.5 py-0.5 text-xs text-accent">
            {t('filter.activeCount', { count: activeCount })}
          </span>
        )}

        {pending && (
          <span className="text-xs text-warning">{t('filter.pending')}</span>
        )}

        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => onChange([...filters, createFilter(columns[0]?.name ?? '')])}
            disabled={disabled || columns.length === 0}
            className="flex items-center gap-1 rounded-control border border-line-strong px-2 py-1 text-xs text-fg hover:bg-surface-hover disabled:opacity-50"
          >
            <Plus size={12} />
            {t('filter.add')}
          </button>
          {filters.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onChange([]);
                onApply();
              }}
              disabled={disabled}
              className="rounded-control border border-line-strong px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover disabled:opacity-50"
            >
              {t('filter.clearAll')}
            </button>
          )}
          <button
            type="button"
            onClick={onApply}
            disabled={disabled}
            className="rounded-control border border-accent-line bg-accent-soft px-2 py-1 text-xs text-accent hover:bg-accent-soft disabled:opacity-50"
          >
            {t('filter.apply')}
          </button>
        </span>
      </div>

      {filters.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {filters.map((filter) => {
            const complete = isCompleteFilter(filter);
            return (
              <div key={filter.id} className="flex flex-wrap items-center gap-1.5">
                <select
                  value={filter.column}
                  onChange={(event) => update(filter.id, { column: event.target.value })}
                  disabled={disabled}
                  className="min-w-32 rounded-control border border-line-strong bg-surface px-1.5 py-1 text-xs text-fg"
                >
                  {columns.map((column) => (
                    <option key={column.name} value={column.name}>{column.name}</option>
                  ))}
                </select>

                <select
                  value={filter.operator}
                  onChange={(event) => (
                    update(filter.id, { operator: event.target.value as FilterOperator })
                  )}
                  disabled={disabled}
                  className="min-w-28 rounded-control border border-line-strong bg-surface px-1.5 py-1 text-xs text-fg"
                >
                  {FILTER_OPERATORS.map((operator) => (
                    <option key={operator} value={operator}>
                      {t(`filter.op.${operator}` as TranslationKey)}
                    </option>
                  ))}
                </select>

                {operatorNeedsValue(filter.operator) && (
                  <input
                    type="text"
                    value={filter.value}
                    onChange={(event) => update(filter.id, { value: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        onApply();
                      }
                    }}
                    disabled={disabled}
                    placeholder={t('filter.valuePlaceholder')}
                    className={clsx(
                      'min-w-40 flex-1 rounded-control border bg-surface px-1.5 py-1 text-xs text-fg',
                      complete ? 'border-line-strong' : 'border-warning-line'
                    )}
                    {...PLAIN_TEXT_INPUT}
                  />
                )}

                {!complete && (
                  <span className="text-xs text-warning">{t('filter.incomplete')}</span>
                )}

                <button
                  type="button"
                  onClick={() => onChange(filters.filter((candidate) => candidate.id !== filter.id))}
                  disabled={disabled}
                  title={t('filter.remove')}
                  className="ml-auto rounded-control p-1 text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-50"
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}

          <p className="text-xs text-fg-subtle">{t('filter.serverSideNote')}</p>
        </div>
      )}
    </div>
  );
}
