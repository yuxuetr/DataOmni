import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { PLAIN_TEXT_INPUT } from './FormControls';
import { useLanguageStore } from '../stores/languageStore';
import { describeError } from '../utils/describeError';
import { shellString } from '../utils/mongoCommandText';

export type MongoBulkWriteMode = 'update' | 'delete';

interface MongoBulkWriteDialogProps {
  mode: MongoBulkWriteMode;
  connectionString: string;
  database: string;
  collection: string;
  /** 正在生效的条件：网格里看到的就是它选中的那些 */
  filter: string;
  /** 符合条件的文档数；还没数出来是 null */
  total: number | null;
  timeoutMs: number;
  onClose: () => void;
  /** 写成功了，集合页该重读 */
  onWritten: () => void;
}

/**
 * 按当前条件批量改或删：`updateMany(filter, update)` / `deleteMany(filter)`。
 *
 * 这个对话框本身就是确认：条件、个数、真正会发的那条命令都摆在按钮上面。
 * 条件为空时单独用危险色写一句「整个集合」——那是最容易手滑的一种。
 * 做完不自动关：改了几个、删了几个要让人看见，服务端报的数就是结论。
 */
export function MongoBulkWriteDialog({
  mode,
  connectionString,
  database,
  collection,
  filter,
  total: totalWhenOpened,
  timeoutMs,
  onClose,
  onWritten
}: MongoBulkWriteDialogProps) {
  const t = useLanguageStore((state) => state.t);
  // 打开时的个数：做完之后集合页重读，总数会变成写完的样子，而这里要的是「当时要动的是多少」
  const [total] = useState(totalWhenOpened);
  const [update, setUpdate] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const updateRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 改：光标直接进「怎么改」那一格；删：焦点在取消上，回车不会误删
    (mode === 'update' ? updateRef.current : cancelRef.current)?.focus();
  }, [mode]);

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

  const scope = filter.trim();
  const collectionLiteral = shellString(collection);
  const command = mode === 'delete'
    ? `db.getCollection(${collectionLiteral}).deleteMany(${scope || '{}'})`
    : update.trim()
      ? `db.getCollection(${collectionLiteral}).updateMany(${scope || '{}'}, ${update.trim()})`
      : null;

  const run = async () => {
    if (!command || running || outcome) {
      return;
    }
    setRunning(true);
    setError(null);
    try {
      if (mode === 'delete') {
        const deleted = await invoke<number>('mongodb_delete_many', {
          connectionString, database, collection, filter, timeoutMs
        });
        setOutcome(t('mongo.bulk.deleted', { count: deleted }));
      } else {
        const result = await invoke<{ matched: number; modified: number }>('mongodb_update_many', {
          connectionString, database, collection, filter, update, timeoutMs
        });
        const unchanged = result.matched - result.modified;
        setOutcome(unchanged > 0
          ? `${t('mongo.bulk.updated', { matched: result.matched, modified: result.modified })} ${t('mongo.bulk.unchanged', { count: unchanged })}`
          : t('mongo.bulk.updated', { matched: result.matched, modified: result.modified }));
      }
      onWritten();
    } catch (caught) {
      setError(describeError(caught));
      // 被中途挡住时前面的可能已经写进去了，网格要跟上
      onWritten();
    } finally {
      setRunning(false);
    }
  };

  const title = mode === 'delete' ? t('mongo.bulk.deleteTitle') : t('mongo.bulk.updateTitle');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mongo-bulk-title"
      onClick={() => !running && onClose()}
    >
      <div
        className="flex max-h-[80vh] w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="mongo-bulk-title" className="truncate text-base font-medium text-fg" title={`${database}.${collection}`}>
            {title} · {database}.{collection}
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
          <div className="text-sm text-fg">
            {scope ? (
              <p className="break-all">
                {t('mongo.export.scopeFiltered')}
                <code className="ml-1 font-mono text-[13px]">{scope}</code>
              </p>
            ) : (
              <p className="flex items-start gap-1.5 text-danger">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                {t('mongo.bulk.wholeCollection')}
              </p>
            )}
            {total !== null && <p className="mt-1 text-xs text-fg-muted">{t('mongo.count', { count: total })}</p>}
          </div>

          {mode === 'update' && (
            <label className="block space-y-1">
              <span className="text-xs text-fg-muted">{t('mongo.bulk.update')}</span>
              <input
                ref={updateRef}
                value={update}
                onChange={(event) => setUpdate(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void run();
                  }
                }}
                disabled={outcome !== null}
                placeholder="{ $set: { status: 'archived' } }"
                className="w-full rounded-control border border-line bg-surface px-2 py-1.5 font-mono text-[13px] text-fg placeholder:text-fg-subtle"
                {...PLAIN_TEXT_INPUT}
              />
              <span className="block text-xs text-fg-subtle">{t('mongo.bulk.updateHint')}</span>
            </label>
          )}

          {command && (
            <pre className="select-text whitespace-pre-wrap break-words rounded-control border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-fg">
              {command}
            </pre>
          )}
          <p className="text-xs text-fg-subtle">
            {mode === 'delete' ? t('mongo.bulk.noTransactionDelete') : t('mongo.bulk.noTransaction')}
          </p>
          {outcome && <p className="text-sm text-success">{outcome}</p>}
          {error && <p className="select-text text-sm text-danger">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-sunken px-5 py-3">
          <button
            type="button"
            ref={cancelRef}
            onClick={onClose}
            disabled={running}
            className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
          >
            {outcome ? t('common.close') : t('common.cancel')}
          </button>
          {!outcome && (
            <button
              type="button"
              onClick={() => void run()}
              disabled={!command || running}
              className={clsx(
                'flex items-center gap-1.5 rounded-control px-3 py-1.5 text-sm hover:opacity-90 disabled:opacity-50',
                mode === 'delete' ? 'bg-danger-solid text-fg-on-solid' : 'bg-accent text-fg-on-accent'
              )}
            >
              {running && <Loader2 size={14} className="animate-spin" />}
              {mode === 'delete' ? t('mongo.bulk.deleteRun') : t('mongo.bulk.updateRun')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
