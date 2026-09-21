import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { save } from '@tauri-apps/plugin-dialog';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { SerializedResultValue } from '../contracts/resultSet';
import {
  DEFAULT_EXPORT_OPTIONS,
  serializeExport,
  suggestExportFileName,
  toCsv,
  type CsvDelimiter,
  type ExportFormat,
  type ExportOptions
} from '../utils/exportResult';
import { describeError } from '../utils/describeError';
import { useLanguageStore } from '../stores/languageStore';
import type { TranslationKey } from '../i18n/translate';

/**
 * 一个可选的导出范围。
 *
 * 带 `sql` 的走后端流式导出：行从数据库直接落盘，不进内存也不过 IPC，
 * 所以整表这种行数未知的范围才有可能导出。不带 `sql` 的导出下面那份已经在
 * 内存里的行——那正是用户此刻看到的、排过序、隐过列的那一份。
 */
export interface ExportScope {
  id: string;
  label: string;
  /** 范围说明：是哪一页、少了哪些列、会不会重新执行一遍查询 */
  note?: string;
  sql?: string;
  /**
   * 这个范围自己的那份数据。不给就用对话框的 `columns` / `rows`。
   *
   * 「选中的部分」需要它：选区是个矩形，行和列都可能比屏幕上那份少，
   * 而预览、行列数和最后写出去的文件都得是同一份。
   */
  columns?: readonly string[];
  rows?: ReadonlyArray<readonly SerializedResultValue[]>;
}

interface ExportResultDialogProps {
  columns: readonly string[];
  rows: ReadonlyArray<readonly SerializedResultValue[]>;
  /** 用来起默认文件名：表名，或者标签页名 */
  sourceName: string;
  /** 结果被行数/字节上限截断过——导出的是截断后的那份，必须说清楚 */
  truncated?: boolean;
  /** 服务端分页时，这里只有当前页的数据 */
  scopeNote?: string;
  /** 可选范围。留空等于只有「上面这些行」一个范围，不显示选择器。 */
  scopes?: readonly ExportScope[];
  /** 流式导出要在哪个连接上跑 */
  connectionId?: string;
  onClose: () => void;
}

interface ExportProgress {
  rowsWritten: number;
  bytesWritten: number;
}

interface ExportSummary {
  rowsWritten: number;
  bytesWritten: number;
  path: string;
}

/** 后端在取消时给的错误码，界面上不该当成失败 */
const EXPORT_CANCELLED_CODE = 'EXPORT_CANCELLED';

/** 存文案键而不是文案：模块级常量用不了 hook，而标签要跟着语言走 */
const DELIMITERS: Array<{ value: CsvDelimiter; labelKey: TranslationKey }> = [
  { value: ',', labelKey: 'export.delimiter.comma' },
  { value: ';', labelKey: 'export.delimiter.semicolon' },
  { value: '\t', labelKey: 'export.delimiter.tab' }
];

// `NULL` 与 `\N` 是写进文件里的字面量，不是界面文案，不翻译
const NULL_TEXTS: Array<{ value: string; labelKey?: TranslationKey; label?: string }> = [
  { value: '', labelKey: 'export.nullAs.empty' },
  { value: 'NULL', label: 'NULL' },
  { value: '\\N', label: '\\N' }
];

const PREVIEW_ROWS = 3;

export function ExportResultDialog({
  columns,
  rows,
  sourceName,
  truncated,
  scopeNote,
  scopes,
  connectionId,
  onClose
}: ExportResultDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [scopeId, setScopeId] = useState(scopes?.[0]?.id ?? '');
  const [writing, setWriting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 取消是用户自己按的，不是出了错——红字会让人以为哪里坏了 */
  const [cancelled, setCancelled] = useState(false);
  const [written, setWritten] = useState<ExportSummary | null>(null);
  /**
   * 上一次尝试用的路径。失败后「重试」就是拿它再跑一遍——不再弹一次保存
   * 对话框，因为用户已经选过了，让他重选一次只会让人怀疑是不是选错了。
   */
  const [lastPath, setLastPath] = useState<string | null>(null);
  const exportIdRef = useRef<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const scope = scopes?.find((candidate) => candidate.id === scopeId) ?? scopes?.[0];
  const streaming = Boolean(scope?.sql);
  // 范围自带数据时一切都跟着它走：预览、右上角的行列数、写出去的内容
  const activeColumns = scope?.columns ?? columns;
  const activeRows = scope?.rows ?? rows;

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !writing) {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, writing]);

  // 前几行的真实输出。分隔符和 NULL 写法这两个选项，光看名字判断不了对不对，
  // 看一眼结果就知道。
  const preview = useMemo(() => {
    if (options.format === 'json') {
      return serializeExport(activeColumns, activeRows.slice(0, 1), { ...options, byteOrderMark: false });
    }
    return toCsv(activeColumns, activeRows.slice(0, PREVIEW_ROWS), options);
  }, [activeColumns, activeRows, options]);

  const update = (patch: Partial<ExportOptions>) => {
    setOptions(current => ({ ...current, ...patch }));
    setWritten(null);
    setError(null);
    setCancelled(false);
  };

  const runExport = async (path: string) => {
    setError(null);
    setCancelled(false);
    setWritten(null);
    setProgress(null);
    setCancelling(false);
    setWriting(true);
    setLastPath(path);

    try {
      if (scope?.sql) {
        const exportId = crypto.randomUUID();
        exportIdRef.current = exportId;
        const onProgress = new Channel<ExportProgress>((update) => setProgress(update));
        const summary = await invoke<ExportSummary>('export_query_to_file', {
          onProgress,
          request: { connectionId, exportId, sql: scope.sql, path, options }
        });
        setWritten(summary);
      } else {
        // 这一份已经在内存里了，再让它绕一趟数据库只会导出**另一份**数据：
        // 客户端排序、隐藏列、以及这期间别人对表的改动都会对不上
        const contents = serializeExport(activeColumns, activeRows, options);
        const bytesWritten = await invoke<number>('write_text_file', { path, contents });
        setWritten({ rowsWritten: activeRows.length, bytesWritten, path });
      }
    } catch (err) {
      if (isCancellation(err)) {
        setCancelled(true);
      } else {
        setError(describeError(err, t('export.failed')));
      }
    } finally {
      exportIdRef.current = null;
      setWriting(false);
      setCancelling(false);
    }
  };

  const handleExport = async () => {
    const path = await save({
      defaultPath: suggestExportFileName(sourceName, options.format),
      filters: [
        options.format === 'csv'
          ? { name: 'CSV', extensions: ['csv'] }
          : { name: 'JSON', extensions: ['json'] }
      ]
    }).catch((err) => {
      setError(describeError(err, t('export.failed')));
      return null;
    });

    // 用户取消保存对话框不是错误，也不该留下任何提示
    if (!path) {
      return;
    }
    await runExport(path);
  };

  const handleCancel = async () => {
    const exportId = exportIdRef.current;
    if (!exportId) {
      return;
    }
    setCancelling(true);
    await invoke<boolean>('cancel_export', { exportId }).catch(() => undefined);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-dialog-title"
      onClick={() => !writing && onClose()}
    >
      <div
        className="flex max-h-[calc(100vh-4rem)] w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <Download size={16} className="shrink-0 text-fg-muted" />
          <h2 id="export-dialog-title" className="text-sm font-medium text-fg">
            {t('export.title')}
          </h2>
          <span className="ml-auto text-xs text-fg-subtle">
            {/* 流式导出时行数是**整个范围**的，不是下面这几行预览的，说「3 行」是假话 */}
            {streaming
              ? t('export.shapeColumns', { count: activeColumns.length })
              : t('export.shape', { rows: activeRows.length, columns: activeColumns.length })}
          </span>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {(truncated || scope?.note || scopeNote) && (
            <p className="rounded-control border border-warning-line bg-warning-soft px-3 py-2 text-xs text-warning">
              {truncated && t('export.truncated')}
              {truncated && (scope?.note ?? scopeNote) && ' '}
              {scope?.note ?? scopeNote}
            </p>
          )}

          {scopes && scopes.length > 1 && (
            <Field label={t('export.scope')}>
              <SegmentedControl<string>
                value={scope?.id ?? ''}
                options={scopes.map((candidate) => ({
                  value: candidate.id,
                  label: candidate.label
                }))}
                onChange={(id) => {
                  setScopeId(id);
                  setWritten(null);
                  setError(null);
                  setCancelled(false);
                  setProgress(null);
                }}
              />
            </Field>
          )}

          <Field label={t('export.format')}>
            <SegmentedControl<ExportFormat>
              value={options.format}
              options={[
                { value: 'csv', label: 'CSV' },
                { value: 'json', label: 'JSON' }
              ]}
              onChange={format => update({ format })}
            />
          </Field>

          {options.format === 'csv' && (
            <>
              <Field label={t('export.delimiter')}>
                <SegmentedControl<CsvDelimiter>
                  value={options.delimiter}
                  options={DELIMITERS.map(({ value, labelKey }) => ({
                    value,
                    label: t(labelKey)
                  }))}
                  onChange={delimiter => update({ delimiter })}
                />
              </Field>

              <Field label={t('export.nullAs')}>
                <SegmentedControl<string>
                  value={options.nullText}
                  options={NULL_TEXTS.map(({ value, labelKey, label }) => ({
                    value,
                    label: labelKey ? t(labelKey) : label ?? value
                  }))}
                  onChange={nullText => update({ nullText })}
                />
              </Field>

              <Field label={t('export.header')}>
                <Checkbox
                  checked={options.includeHeader}
                  onChange={includeHeader => update({ includeHeader })}
                  label={t('export.header.writeNames')}
                />
              </Field>

              <Field label={t('export.encoding')}>
                <Checkbox
                  checked={options.byteOrderMark}
                  onChange={byteOrderMark => update({ byteOrderMark })}
                  label={t('export.encoding.bom')}
                  hint={t('export.encoding.bomHint')}
                />
              </Field>
            </>
          )}

          <div>
            <p className="mb-1 text-xs text-fg-subtle">
              {streaming
                ? t('export.previewStreamed', {
                    count: options.format === 'json' ? 1 : Math.min(PREVIEW_ROWS, activeRows.length)
                  })
                : options.format === 'json'
                  ? t('export.previewJson', { total: activeRows.length })
                  : t('export.previewCsv', {
                      shown: Math.min(PREVIEW_ROWS, activeRows.length),
                      total: activeRows.length
                    })}
            </p>
            <pre className="max-h-36 overflow-auto rounded-control border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-fg select-text whitespace-pre">
              {preview || t('export.previewEmpty')}
            </pre>
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-line bg-surface-sunken px-5 py-3">
          <div className="min-w-0 flex-1 text-xs">
            {writing && (
              <span className="text-fg-muted">
                {progress
                  ? t('export.progress', {
                      count: progress.rowsWritten,
                      size: formatBytes(progress.bytesWritten)
                    })
                  : t('export.writing')}
              </span>
            )}
            {!writing && error && <span className="break-words text-danger">{error}</span>}
            {!writing && !error && cancelled && (
              <span className="text-fg-muted">{t('export.cancelled')}</span>
            )}
            {!writing && !error && !cancelled && written && (
              <span className="break-all text-success">
                {t('export.writtenRows', {
                  count: written.rowsWritten,
                  size: formatBytes(written.bytesWritten),
                  path: written.path
                })}
              </span>
            )}
          </div>

          {/* 导出中：关闭按钮换成取消。留着「关闭」会让人以为关掉就停了，而它不停 */}
          {writing && streaming && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelling}
              className="shrink-0 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover disabled:opacity-50"
            >
              {cancelling ? t('export.cancelling') : t('common.cancel')}
            </button>
          )}
          {!writing && (
            <button
              type="button"
              ref={cancelRef}
              onClick={onClose}
              className="shrink-0 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
            >
              {written ? t('common.done') : lastPath ? t('common.close') : t('common.cancel')}
            </button>
          )}

          {/* 失败后重试用的是同一个路径与同一份选项，不再让用户重选一次 */}
          {!writing && (error || cancelled) && lastPath && (
            <button
              type="button"
              onClick={() => void runExport(lastPath)}
              className="shrink-0 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
            >
              {t('export.retry')}
            </button>
          )}

          <button
            type="button"
            onClick={handleExport}
            disabled={writing || (!streaming && rows.length === 0)}
            className="flex shrink-0 items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
          >
            {writing && <Loader2 size={14} className="animate-spin" />}
            {writing ? t('export.writing') : t('export.choosePath')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 取消回来的是一个错误，但它不是失败——界面上要说「已取消」，不是红字报错。
 * 认码而不是认文案：文案会跟着语言变。
 */
function isCancellation(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && (error as { code?: unknown }).code === EXPORT_CANCELLED_CODE
  );
}

/** 进度里的字节数给人看，不是给机器看：几百万行时 8777798 读不出量级 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-20 shrink-0 pt-1 text-xs text-fg-muted">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-control border border-line p-0.5">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={clsx(
            'rounded-[0.25rem] px-2.5 py-1 text-xs transition-colors',
            option.value === value
              ? 'bg-accent text-fg-on-accent'
              : 'text-fg-muted hover:bg-surface-hover'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        className="mt-0.5 accent-accent"
      />
      <span className="min-w-0">
        <span className="text-xs text-fg">{label}</span>
        {hint && <span className="block text-xs text-fg-subtle">{hint}</span>}
      </span>
    </label>
  );
}
