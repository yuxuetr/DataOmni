import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { PLAIN_TEXT_INPUT } from './FormControls';
import { useLanguageStore } from '../stores/languageStore';
import { describeError } from '../utils/describeError';
import { createIndexSql, suggestIndexName } from '../utils/objectDdl';
import type { SqlIdentifierDialect } from '../utils/sqlIdentifiers';

interface CreateIndexDialogProps {
  connectionId: string;
  dialect: SqlIdentifierDialect;
  schema: string | null;
  table: string;
  /** 表的列，按表里的顺序 */
  columns: readonly string[];
  onClose: () => void;
  onCreated: () => void;
}

/**
 * 新建索引：选哪几列、什么顺序、是否唯一。
 *
 * 列的次序就是勾选的次序，每列旁边印着它是第几个——复合索引 (a, b) 与 (b, a)
 * 能加速的查询不一样，而一排复选框本身表达不出次序。
 *
 * 名字在用户动手改之前跟着列走；改过一次就不再替他改。
 */
export function CreateIndexDialog({
  connectionId,
  dialect,
  schema,
  table,
  columns,
  onClose,
  onCreated
}: CreateIndexDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const [picked, setPicked] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const [typedName, setTypedName] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = typedName ?? (picked.length > 0 ? suggestIndexName(table, picked, unique, dialect) : '');
  const sql = picked.length > 0 && name.trim()
    ? createIndexSql({ schema, table, name: name.trim(), columns: picked, unique }, dialect)
    : null;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [running, onClose]);

  const toggle = (column: string) => {
    setPicked((current) => current.includes(column)
      ? current.filter((candidate) => candidate !== column)
      : [...current, column]);
  };

  const run = async () => {
    if (!sql || running) {
      return;
    }
    setRunning(true);
    setError(null);
    try {
      await invoke<number[]>('execute_write_batch', {
        connectionId,
        statements: [{ sql, params: [], expectRows: null }]
      });
      onCreated();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-index-title"
      onClick={() => !running && onClose()}
    >
      <div
        className="flex max-h-[80vh] w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="create-index-title" className="text-base font-medium text-fg">
            {t('indexCreate.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded-control p-1 text-fg-muted hover:bg-surface-hover hover:text-fg"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <p className="text-xs text-fg-muted">{t('indexCreate.pickColumns')}</p>
          <ul className="divide-y divide-line rounded-control border border-line">
            {columns.map((column) => {
              const position = picked.indexOf(column);
              return (
                <li key={column}>
                  <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-surface-hover">
                    <input
                      type="checkbox"
                      checked={position !== -1}
                      onChange={() => toggle(column)}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{column}</span>
                    <span
                      className={clsx(
                        'w-5 text-right font-mono text-xs',
                        position === -1 ? 'text-transparent' : 'text-accent'
                      )}
                    >
                      {position === -1 ? '-' : position + 1}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={unique} onChange={(event) => setUnique(event.target.checked)} />
            {t('indexCreate.unique')}
          </label>

          <label className="flex items-center gap-2 text-xs text-fg-muted">
            {t('indexCreate.name')}
            <input
              value={name}
              onChange={(event) => setTypedName(event.target.value)}
              className="min-w-0 flex-1 rounded-control border border-line bg-surface px-2 py-1 font-mono text-xs text-fg"
              {...PLAIN_TEXT_INPUT}
            />
          </label>

          {sql && (
            <pre className="select-text whitespace-pre-wrap break-words rounded-control border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-fg">
              {sql}
            </pre>
          )}
          {dialect === 'postgresql' && (
            <p className="text-xs text-fg-subtle">{t('indexCreate.postgresLocks')}</p>
          )}
          {error && <p className="select-text text-sm text-danger">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-sunken px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void run()}
            disabled={!sql || running}
            className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
          >
            {running && <Loader2 size={14} className="animate-spin" />}
            {t('indexCreate.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
