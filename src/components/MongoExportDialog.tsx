import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { describeError } from '../utils/describeError';
import { suggestExportFileName } from '../utils/exportResult';
import { useLanguageStore } from '../stores/languageStore';
import { useTaskStore, type MongoExportTaskPayload } from '../stores/taskStore';
import { Field, SegmentedControl } from './FormControls';

type ExtendedJsonFormat = MongoExportTaskPayload['mongo']['format'];

interface MongoExportDialogProps {
  connectionString: string;
  database: string;
  collection: string;
  /** 正在生效的条件与排序，不是输入框里还没按「查询」的草稿 */
  filter: string;
  sort: string;
  /** 符合条件的文档数；还没数出来是 null */
  total: number | null;
  onClose: () => void;
}

/**
 * 把集合按当前条件导出成文件，交给后台任务（进度、取消在任务面板上）。
 *
 * 只有一种文件格式：每行一个文档的 Extended JSON，即 `mongoexport` 的默认输出，
 * `mongoimport` 直接读得回去。可选的只是 JSON 写法——好读还是类型完整。
 */
export function MongoExportDialog({
  connectionString,
  database,
  collection,
  filter,
  sort,
  total,
  onClose
}: MongoExportDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const startTask = useTaskStore((state) => state.start);
  const [format, setFormat] = useState<ExtendedJsonFormat>('relaxed');
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

  const handleExport = async () => {
    setError(null);
    const path = await save({
      defaultPath: suggestExportFileName(name, 'json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }).catch((cause) => {
      setError(describeError(cause, t('export.failed')));
      return null;
    });
    // 取消保存对话框不是错误
    if (!path) {
      return;
    }
    startTask({
      kind: 'export',
      title: t('task.title.export', { name }),
      payload: { mongo: { connectionString, database, collection, filter, sort, format }, path }
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mongo-export-title"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[calc(100vw-2rem)] rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <Download size={16} className="shrink-0 text-fg-muted" />
          <h2 id="mongo-export-title" className="truncate text-sm font-medium text-fg" title={name}>
            {t('task.title.export', { name })}
          </h2>
          {total !== null && (
            <span className="ml-auto shrink-0 text-xs text-fg-subtle">
              {t('mongo.count', { count: total })}
            </span>
          )}
        </div>

        <div className="space-y-3 px-5 py-4">
          <Field label={t('export.scope')}>
            <p className="break-all pt-1 text-sm text-fg">
              {filter.trim() ? t('mongo.export.scopeFiltered') : t('mongo.export.scopeAll')}
              {filter.trim() && <code className="ml-1 font-mono text-[13px]">{filter.trim()}</code>}
            </p>
            {sort.trim() && (
              <p className="mt-1 break-all text-sm text-fg-muted">
                {t('mongo.export.sorted')}
                <code className="ml-1 font-mono text-[13px]">{sort.trim()}</code>
              </p>
            )}
          </Field>
          <Field label={t('mongo.export.format')}>
            <SegmentedControl
              value={format}
              options={[
                { value: 'relaxed', label: t('mongo.export.relaxed') },
                { value: 'canonical', label: t('mongo.export.canonical') }
              ]}
              onChange={setFormat}
            />
            <p className="mt-2 text-xs text-fg-muted">
              {format === 'relaxed' ? t('mongo.export.relaxedHint') : t('mongo.export.canonicalHint')}
            </p>
          </Field>
          <p className="text-xs text-fg-subtle">{t('mongo.export.fileHint')}</p>
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
            onClick={() => void handleExport()}
            className="flex items-center gap-1 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:bg-accent-hover"
          >
            <Download size={14} />
            <span>{t('mongo.export.choosePath')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
