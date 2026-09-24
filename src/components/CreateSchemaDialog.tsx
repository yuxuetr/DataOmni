import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, X } from 'lucide-react';
import { PLAIN_TEXT_INPUT } from './FormControls';
import { useLanguageStore } from '../stores/languageStore';
import { describeError } from '../utils/describeError';
import { createSchemaSql } from '../utils/objectDdl';
import type { SqlIdentifierDialect } from '../utils/sqlIdentifiers';

interface CreateSchemaDialogProps {
  connectionId: string;
  dialect: SqlIdentifierDialect;
  onClose: () => void;
  /** 建好之后接着做什么由调用方定——空 schema 在对象树上是看不见的 */
  onCreated: (schema: string) => void;
}

/**
 * 新建 schema。
 *
 * 语句只有一条，所以不另开预览框：它就印在输入框下面，边打边变。和建表一样
 * 不走二次确认——不碰任何已有数据。
 */
export function CreateSchemaDialog({
  connectionId,
  dialect,
  onClose,
  onCreated
}: CreateSchemaDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const [name, setName] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const sql = trimmed ? createSchemaSql(trimmed, dialect) : null;

  // 和另外几个弹窗一样：Esc 与点遮罩都关，跑着的时候都不关
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
      onCreated(trimmed);
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
      aria-labelledby="create-schema-title"
      onClick={() => !running && onClose()}
    >
      <div
        className="flex w-[480px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="create-schema-title" className="text-base font-medium text-fg">
            {t('schemaCreate.title')}
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

        <form
          className="space-y-3 px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            {t('schemaCreate.name')}
            <input
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              className="min-w-0 flex-1 rounded-control border border-line bg-surface px-2 py-1 font-mono text-xs text-fg"
              {...PLAIN_TEXT_INPUT}
            />
          </label>
          {sql && (
            <pre className="select-text whitespace-pre-wrap break-words rounded-control border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-fg">
              {sql}
            </pre>
          )}
          <p className="text-xs text-fg-subtle">{t('schemaCreate.thenTable')}</p>
          {error && <p className="select-text text-sm text-danger">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={running}
              className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={!sql || running}
              className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
            >
              {running && <Loader2 size={14} className="animate-spin" />}
              {t('schemaCreate.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
