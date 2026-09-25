import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, X } from 'lucide-react';
import { PLAIN_TEXT_INPUT } from './FormControls';
import { useLanguageStore } from '../stores/languageStore';
import { describeError } from '../utils/describeError';
import { createCollectionCommand } from '../utils/mongoCommandText';

interface MongoCreateCollectionDialogProps {
  connectionString: string;
  /** 对象树里已有的库，给库名那一格做候选；也可以填一个新名字 */
  databases: readonly string[];
  timeoutMs: number;
  onClose: () => void;
  onCreated: () => void;
}

/**
 * MongoDB 新建集合：库、名字、选项三格，就是 mongosh 里
 * `db.getSiblingDB(库).createCollection(名字, 选项)`。
 *
 * 选项和建索引一样是一格文档而不是一排勾选框：上限、校验规则、时序、排序规则、
 * 视图（`viewOn` + `pipeline`）都是同一个参数，结构页上显示的也正是这种写法。
 * 库名可以填一个还没有的——MongoDB 建库就是往里建第一个集合
 */
export function MongoCreateCollectionDialog({
  connectionString,
  databases,
  timeoutMs,
  onClose,
  onCreated
}: MongoCreateCollectionDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const [database, setDatabase] = useState(databases[0] ?? '');
  const [name, setName] = useState('');
  const [options, setOptions] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
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

  const ready = database.trim() !== '' && name.trim() !== '';
  const command = ready ? createCollectionCommand(database.trim(), name.trim(), options) : null;
  const newDatabase = ready && !databases.includes(database.trim());

  const run = async () => {
    if (!ready || running) {
      return;
    }
    setRunning(true);
    setError(null);
    try {
      await invoke('mongodb_create_collection', {
        connectionString,
        database: database.trim(),
        collection: name.trim(),
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
      aria-labelledby="mongo-create-collection-title"
      onClick={() => !running && onClose()}
    >
      <div
        className="flex max-h-[80vh] w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="mongo-create-collection-title" className="text-base font-medium text-fg">
            {t('mongo.collection.createTitle')}
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
            <span className="text-xs text-fg-muted">{t('mongo.collection.database')}</span>
            <input
              value={database}
              onChange={(event) => setDatabase(event.target.value)}
              onKeyDown={submitOnEnter}
              list="mongo-create-collection-databases"
              className={inputClass}
              {...PLAIN_TEXT_INPUT}
            />
            <datalist id="mongo-create-collection-databases">
              {databases.map((candidate) => <option key={candidate} value={candidate} />)}
            </datalist>
            {newDatabase && (
              <span className="block text-xs text-fg-subtle">{t('mongo.collection.newDatabase')}</span>
            )}
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-fg-muted">{t('mongo.collection.name')}</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={submitOnEnter}
              placeholder="orders"
              className={inputClass}
              {...PLAIN_TEXT_INPUT}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-fg-muted">{t('mongo.collection.options')}</span>
            <input
              value={options}
              onChange={(event) => setOptions(event.target.value)}
              onKeyDown={submitOnEnter}
              placeholder="{ capped: true, size: 1048576 }"
              className={inputClass}
              {...PLAIN_TEXT_INPUT}
            />
            <span className="block text-xs text-fg-subtle">{t('mongo.collection.optionsHint')}</span>
          </label>

          {command && (
            <pre className="select-text whitespace-pre-wrap break-words rounded-control border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-fg">
              {command}
            </pre>
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
            disabled={!ready || running}
            className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
          >
            {running && <Loader2 size={14} className="animate-spin" />}
            {t('mongo.collection.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
