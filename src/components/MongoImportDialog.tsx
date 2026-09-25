import { useEffect, useRef, useState } from 'react';
import { FileUp, Upload } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { describeError } from '../utils/describeError';
import { useLanguageStore } from '../stores/languageStore';
import { useTaskStore, type MongoImportTaskPayload } from '../stores/taskStore';
import { Field, SegmentedControl } from './FormControls';

type ImportMode = MongoImportTaskPayload['mongo']['mode'];

interface MongoImportDialogProps {
  connectionString: string;
  database: string;
  collection: string;
  onClose: () => void;
}

/**
 * 把一个 mongoexport 格式的文件（每行一个文档）导入集合，交给后台任务。
 *
 * 没有预览和字段映射：文档自己带着字段名，读法只有一种。要人决定的只有
 * `_id` 撞上了怎么办。
 */
export function MongoImportDialog({ connectionString, database, collection, onClose }: MongoImportDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const startTask = useTaskStore((state) => state.start);
  const [path, setPath] = useState<string | null>(null);
  const [mode, setMode] = useState<ImportMode>('insert');
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const name = `${database}.${collection}`;

  useEffect(() => {
    cancelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const chooseFile = async () => {
    setError(null);
    const chosen = await open({
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json', 'jsonl', 'ndjson'] }]
    }).catch((cause) => {
      setError(describeError(cause, t('import.failed')));
      return null;
    });
    if (typeof chosen === 'string') {
      setPath(chosen);
    }
  };

  const handleImport = () => {
    if (!path) {
      return;
    }
    startTask({
      kind: 'import',
      title: t('task.title.import', { table: name }),
      payload: { mongo: { connectionString, database, collection, mode }, path }
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mongo-import-title"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[calc(100vw-2rem)] rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <Upload size={16} className="shrink-0 text-fg-muted" />
          <h2 id="mongo-import-title" className="truncate text-sm font-medium text-fg" title={name}>
            {t('task.title.import', { table: name })}
          </h2>
        </div>

        <div className="space-y-3 px-5 py-4">
          <Field label={t('mongo.import.file')}>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void chooseFile()}
                className="flex shrink-0 items-center gap-1 rounded-control border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
              >
                <FileUp size={14} />
                <span>{t('mongo.import.chooseFile')}</span>
              </button>
              {/* 只写文件名：路径从头截断时被截掉的正好是文件名；完整路径在提示里 */}
              <span className="min-w-0 truncate font-mono text-[13px] text-fg-muted" title={path ?? undefined}>
                {path ? path.split(/[\\/]/).pop() : t('mongo.import.noFile')}
              </span>
            </div>
            <p className="mt-2 text-xs text-fg-subtle">{t('mongo.import.fileHint')}</p>
          </Field>
          <Field label={t('mongo.import.mode')}>
            <SegmentedControl
              value={mode}
              options={[
                { value: 'insert', label: t('mongo.import.insert') },
                { value: 'upsert', label: t('mongo.import.upsert') }
              ]}
              onChange={setMode}
            />
            <p className="mt-2 text-xs text-fg-muted">
              {mode === 'insert' ? t('mongo.import.insertHint') : t('mongo.import.upsertHint')}
            </p>
          </Field>
          <p className="text-xs text-fg-subtle">{t('mongo.import.noTransaction')}</p>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 rounded-b-control-panel border-t border-line bg-surface-sunken px-5 py-3">
          <button
            type="button"
            ref={cancelRef}
            onClick={onClose}
            className="rounded-control border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={!path}
            className="flex items-center gap-1 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            <Upload size={14} />
            <span>{t('mongo.import.start')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
