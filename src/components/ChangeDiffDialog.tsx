import { useMemo } from 'react';
import clsx from 'clsx';
import { AlertCircle, Loader2, Plus, Pencil, Trash2, Undo2, X } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';
import type { TranslationKey } from '../i18n/translate';
import type { QueryExecutionError } from '../contracts/queryExecution';
import { describeBoundValue, describeCellInput } from '../utils/cellInput';
import { renderStatementForDisplay, type TableTarget } from '../utils/rowStatements';
import { pendingStatements, type PendingChange } from '../utils/pendingChanges';

export interface CommitFailure {
  /** 出错的是第几条，与 `changes` 同序 */
  index: number;
  error: QueryExecutionError;
}

interface ChangeDiffDialogProps {
  changes: readonly PendingChange[];
  target: TableTarget;
  committing: boolean;
  failure: CommitFailure | null;
  onRevert: (id: string) => void;
  onRevertAll: () => void;
  onCommit: () => void;
  onClose: () => void;
}

const KIND_ICON = { insert: Plus, update: Pencil, delete: Trash2 };
const KIND_LABEL: Record<PendingChange['kind'], TranslationKey> = {
  insert: 'changes.kind.insert',
  update: 'changes.kind.update',
  delete: 'changes.kind.delete'
};

/**
 * 按下提交之前，这一批到底会改什么。
 *
 * 逐条给出「哪一行、哪一列、从什么改成什么」，以及真正会发出去的那条语句。
 * 渲染出来的 SQL 只是拿来看的——执行仍然走绑定参数。
 */
export function ChangeDiffDialog({
  changes,
  target,
  committing,
  failure,
  onRevert,
  onRevertAll,
  onCommit,
  onClose
}: ChangeDiffDialogProps) {
  const t = useLanguageStore((state) => state.t);

  // 拼语句可能抛错（比如 SQLite 的 UPDATE 用了 DEFAULT）。一条拼不出来不该
  // 让整个预览变成空白——那时用户既看不到问题在哪，也撤不掉那一条
  const rendered = useMemo(() => changes.map((change) => {
    try {
      const [statement] = pendingStatements([change], target);
      return { sql: renderStatementForDisplay(statement, target.dialect), error: null };
    } catch (error) {
      return { sql: null, error: error instanceof Error ? error.message : String(error) };
    }
  }), [changes, target]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-panel border border-line-strong bg-surface shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-fg">
            {t('changes.previewTitle', { count: changes.length })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-control p-1 text-fg-subtle hover:bg-surface-hover"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {changes.length === 0 ? (
            <p className="py-8 text-center text-sm text-fg-muted">{t('changes.empty')}</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {changes.map((change, index) => {
                const Icon = KIND_ICON[change.kind];
                const failed = failure?.index === index;
                return (
                  <li
                    key={change.id}
                    className={clsx(
                      'rounded-control border px-3 py-2',
                      failed ? 'border-danger-line bg-danger-soft' : 'border-line bg-surface-sunken'
                    )}
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <Icon size={14} className="shrink-0 text-fg-muted" />
                      <span className="text-xs font-medium text-fg">{t(KIND_LABEL[change.kind])}</span>
                      {change.kind !== 'insert' && (
                        <code className="min-w-0 truncate font-mono text-[11px] text-fg-muted">
                          {change.key.columns
                            .map((column) => `${column} = ${describeBoundValue(change.key.values[column] ?? null)}`)
                            .join(', ')}
                        </code>
                      )}
                      <button
                        type="button"
                        onClick={() => onRevert(change.id)}
                        disabled={committing}
                        className="ml-auto flex shrink-0 items-center gap-1 rounded-control border border-line-strong px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-surface-hover disabled:opacity-40"
                      >
                        <Undo2 size={11} />
                        {t('changes.revert')}
                      </button>
                    </div>

                    {change.kind !== 'delete' && (
                      <table className="w-full table-fixed border-collapse text-[11px]">
                        <tbody>
                          {Object.entries(change.values).map(([column, input]) => (
                            <tr key={column}>
                              <td className="w-40 truncate py-0.5 pr-2 align-top font-medium text-fg-muted">
                                {column}
                              </td>
                              {change.kind === 'update' && (
                                <td className="w-1/3 break-all py-0.5 pr-2 align-top font-mono text-fg-subtle line-through">
                                  {describeBoundValue(change.original[column] ?? null)}
                                </td>
                              )}
                              <td className="break-all py-0.5 align-top font-mono text-fg">
                                {describeCellInput(input)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}

                    {rendered[index].sql ? (
                      <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded-control bg-surface px-2 py-1 font-mono text-[11px] text-fg-muted select-text">
                        {rendered[index].sql}
                      </pre>
                    ) : (
                      <p className="mt-1.5 text-[11px] text-danger">{rendered[index].error}</p>
                    )}

                    {failed && (
                      <div className="mt-2 flex flex-col gap-1 border-t border-danger-line pt-2">
                        <div className="flex items-start gap-1.5 text-xs text-danger">
                          <AlertCircle size={13} className="mt-0.5 shrink-0" />
                          <span className="select-text">{failure.error.message}</span>
                        </div>
                        {([
                          ['detail', failure.error.detail],
                          ['hint', failure.error.hint],
                          ['constraint', failure.error.constraint],
                          ['code', failure.error.code]
                        ] as const).map(([label, text]) => text && (
                          <div key={label} className="flex gap-2 pl-5">
                            <span className="w-20 shrink-0 text-[11px] text-danger/70">{label}</span>
                            <span className="min-w-0 flex-1 break-words font-mono text-[11px] text-danger select-text">
                              {text}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
          {/* 整批一个事务：失败时数据库里什么都没变，这几条原样还在 */}
          <p className="min-w-0 flex-1 text-xs text-fg-subtle">{t('changes.atomicNote')}</p>
          <button
            type="button"
            onClick={onRevertAll}
            disabled={committing || changes.length === 0}
            className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-hover disabled:opacity-40"
          >
            {t('changes.revertAll')}
          </button>
          <button
            type="button"
            onClick={onCommit}
            disabled={committing || changes.length === 0}
            className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:bg-accent-hover disabled:opacity-40"
          >
            {committing && <Loader2 size={14} className="animate-spin" />}
            {t('changes.commit', { count: changes.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
