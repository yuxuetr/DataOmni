import { RotateCcw, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useLanguageStore } from '../stores/languageStore';
import type { ColumnDraft } from '../utils/tableDdl';

interface ColumnDraftTableProps {
  drafts: readonly ColumnDraft[];
  /** false 时整张表只读，输入框换成展示用的标签 */
  editing: boolean;
  /**
   * 主键那一格能不能改。
   *
   * 新建表时能勾：一张没有主键的表在这个程序里不可编辑，这是建表时唯一
   * 需要当场决定的约束。改结构时只读——改主键要先验证现有数据的唯一性，
   * 还要考虑外键引用，不是改一格能算出来的事。
   */
  primaryKeyEditable: boolean;
  onChange: (index: number, patch: Partial<ColumnDraft>) => void;
  onRemove: (index: number) => void;
}

const HEADER_KEYS = [
  'table.column.name',
  'table.column.type',
  'table.column.nullable',
  'table.column.primaryKey',
  'table.column.default'
] as const;

/**
 * 列的清单，读和改用同一张表。
 *
 * 建表和改结构的六格里有五格一模一样，只有主键那一格不同——一个能勾，
 * 一个只能看。两份几乎一样的表格会各自演化，而它们本来就该一起变。
 */
export function ColumnDraftTable({
  drafts,
  editing,
  primaryKeyEditable,
  onChange,
  onRemove
}: ColumnDraftTableProps) {
  const t = useLanguageStore((state) => state.t);

  return (
    <table className="w-full">
      <thead className="sticky top-0 bg-surface-sunken">
        <tr>
          {HEADER_KEYS.map((key) => (
            <th
              key={key}
              className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-fg-muted"
            >
              {t(key)}
            </th>
          ))}
          {editing && <th className="w-12 px-4 py-3" />}
        </tr>
      </thead>
      <tbody className="divide-y divide-line bg-surface">
        {drafts.map((draft, index) => (
          <tr
            key={draft.origin ? `origin:${draft.origin.name}` : `new:${index}`}
            className={clsx('hover:bg-surface-hover', draft.dropped && 'opacity-50')}
          >
            <td className="px-4 py-2 text-sm font-medium text-fg">
              {editing ? (
                <input
                  value={draft.name}
                  onChange={(event) => onChange(index, { name: event.target.value })}
                  disabled={draft.dropped}
                  className={clsx(
                    'w-full rounded-control border border-line bg-surface px-2 py-1 font-mono text-sm text-fg',
                    draft.dropped && 'line-through'
                  )}
                />
              ) : (
                <>
                  {draft.name}
                  {draft.origin?.is_generated && (
                    <span className="ml-1 text-xs font-normal text-success">
                      {t('table.generatedTag')}
                    </span>
                  )}
                </>
              )}
            </td>
            <td className="px-4 py-2 text-sm text-fg-muted">
              {editing ? (
                <input
                  value={draft.dataType}
                  onChange={(event) => onChange(index, { dataType: event.target.value })}
                  disabled={draft.dropped}
                  className="w-full rounded-control border border-line bg-surface px-2 py-1 font-mono text-sm text-fg"
                />
              ) : (
                <span className="inline-flex items-center rounded-control bg-accent-soft px-2 py-1 text-xs font-medium text-accent">
                  {draft.dataType}
                </span>
              )}
            </td>
            <td className="px-4 py-2 text-sm text-fg-muted">
              {editing ? (
                <input
                  type="checkbox"
                  checked={draft.nullable && !draft.primaryKey}
                  // 主键列不可空，勾了也没用——直接禁掉，而不是让它显示一个
                  // 不会生效的勾
                  disabled={draft.dropped || draft.primaryKey}
                  onChange={(event) => onChange(index, { nullable: event.target.checked })}
                />
              ) : draft.nullable ? (
                <span className="inline-flex items-center rounded-control bg-success-soft px-2 py-1 text-xs font-medium text-success">
                  {t('table.yes')}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-control bg-danger-soft px-2 py-1 text-xs font-medium text-danger">
                  {t('table.no')}
                </span>
              )}
            </td>
            <td className="px-4 py-2 text-sm text-fg-muted">
              {primaryKeyEditable ? (
                <input
                  type="checkbox"
                  checked={draft.primaryKey}
                  disabled={draft.dropped}
                  onChange={(event) => onChange(index, { primaryKey: event.target.checked })}
                />
              ) : draft.primaryKey ? (
                <span className="inline-flex items-center rounded-control bg-accent-soft px-2 py-1 text-xs font-medium text-accent">
                  {t('table.column.primaryKey')}
                </span>
              ) : draft.origin ? (
                <span className="text-fg-subtle">-</span>
              ) : (
                <span className="text-fg-subtle">{t('ddl.newColumn')}</span>
              )}
            </td>
            <td className="px-4 py-2 text-sm text-fg-muted">
              {editing ? (
                <input
                  value={draft.defaultValue ?? ''}
                  placeholder="NULL"
                  disabled={draft.dropped}
                  onChange={(event) => onChange(index, {
                    defaultValue: event.target.value === '' ? null : event.target.value
                  })}
                  className="w-full rounded-control border border-line bg-surface px-2 py-1 font-mono text-sm text-fg"
                />
              ) : draft.defaultValue ? (
                <code className="rounded-control bg-surface-hover px-2 py-1 text-xs">
                  {draft.defaultValue}
                </code>
              ) : (
                <span className="text-fg-subtle">-</span>
              )}
            </td>
            {editing && (
              <td className="px-4 py-2">
                <button
                  type="button"
                  onClick={() => onRemove(index)}
                  title={draft.dropped ? t('ddl.undoDrop') : t('ddl.dropColumn')}
                  className="rounded-control p-1 text-fg-muted hover:bg-surface-hover hover:text-danger"
                >
                  {draft.dropped ? <RotateCcw size={14} /> : <Trash2 size={14} />}
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
