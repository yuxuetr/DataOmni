import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, X } from 'lucide-react';
import { PLAIN_TEXT_INPUT } from './FormControls';
import { useLanguageStore } from '../stores/languageStore';
import { describeError } from '../utils/describeError';

interface MongoCreateIndexDialogProps {
  connectionString: string;
  database: string;
  collection: string;
  timeoutMs: number;
  onClose: () => void;
  onCreated: () => void;
}

/**
 * MongoDB 新建索引：键与选项各一格，就是 mongosh 里 `createIndex(keys, options)` 的两个参数。
 *
 * 不做成勾选框：MongoDB 的键不只是「升序 / 降序」（还有 text、2dsphere、hashed、通配），
 * 选项也是一个开放的文档（部分索引的条件、TTL、排序规则）。结构页上显示的正是这种写法，
 * 照着抄一个已有的索引就能用。
 */
export function MongoCreateIndexDialog({
  connectionString,
  database,
  collection,
  timeoutMs,
  onClose,
  onCreated
}: MongoCreateIndexDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const [keys, setKeys] = useState('');
  const [options, setOptions] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keysRef = useRef<HTMLInputElement>(null);

  // 只在打开时聚焦一次：放进下面那个 effect 会在每次「新建」前后（`running` 变了）把
  // 焦点从正在改的选项框抢回键那一格
  useEffect(() => {
    keysRef.current?.focus();
  }, []);

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

  const collectionLiteral = `'${collection.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const command = keys.trim()
    ? `db.getCollection(${collectionLiteral}).createIndex(${keys.trim()}${options.trim() ? `, ${options.trim()}` : ''})`
    : null;

  const run = async () => {
    if (!command || running) {
      return;
    }
    setRunning(true);
    setError(null);
    try {
      await invoke<string>('mongodb_create_index', {
        connectionString,
        database,
        collection,
        keys,
        options,
        timeoutMs
      });
      onCreated();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setRunning(false);
    }
  };

  const submitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void run();
    }
  };

  const inputClass = 'w-full rounded-control border border-line bg-surface px-2 py-1.5 font-mono text-[13px] text-fg placeholder:text-fg-subtle';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mongo-create-index-title"
      onClick={() => !running && onClose()}
    >
      <div
        className="flex max-h-[80vh] w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="mongo-create-index-title" className="text-base font-medium text-fg">
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
          <label className="block space-y-1">
            <span className="text-xs text-fg-muted">{t('mongo.index.keys')}</span>
            <input
              ref={keysRef}
              value={keys}
              onChange={(event) => setKeys(event.target.value)}
              onKeyDown={submitOnEnter}
              placeholder="{ email: 1, createdAt: -1 }"
              className={inputClass}
              {...PLAIN_TEXT_INPUT}
            />
            <span className="block text-xs text-fg-subtle">{t('mongo.index.keysHint')}</span>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-fg-muted">{t('mongo.index.options')}</span>
            <input
              value={options}
              onChange={(event) => setOptions(event.target.value)}
              onKeyDown={submitOnEnter}
              placeholder="{ unique: true }"
              className={inputClass}
              {...PLAIN_TEXT_INPUT}
            />
            <span className="block text-xs text-fg-subtle">{t('mongo.index.optionsHint')}</span>
          </label>

          {command && (
            <pre className="select-text whitespace-pre-wrap break-words rounded-control border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-fg">
              {command}
            </pre>
          )}
          <p className="text-xs text-fg-subtle">{t('mongo.index.buildNote')}</p>
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
            disabled={!command || running}
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
