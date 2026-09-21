import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
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

interface ExportResultDialogProps {
  columns: readonly string[];
  rows: ReadonlyArray<readonly SerializedResultValue[]>;
  /** 用来起默认文件名：表名，或者标签页名 */
  sourceName: string;
  /** 结果被行数/字节上限截断过——导出的是截断后的那份，必须说清楚 */
  truncated?: boolean;
  /** 服务端分页时，这里只有当前页的数据 */
  scopeNote?: string;
  onClose: () => void;
}

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
  onClose
}: ExportResultDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [written, setWritten] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

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
      return serializeExport(columns, rows.slice(0, 1), { ...options, byteOrderMark: false });
    }
    return toCsv(columns, rows.slice(0, PREVIEW_ROWS), options);
  }, [columns, rows, options]);

  const update = (patch: Partial<ExportOptions>) => {
    setOptions(current => ({ ...current, ...patch }));
    setWritten(null);
    setError(null);
  };

  const handleExport = async () => {
    setError(null);
    setWritten(null);

    try {
      const path = await save({
        defaultPath: suggestExportFileName(sourceName, options.format),
        filters: [
          options.format === 'csv'
            ? { name: 'CSV', extensions: ['csv'] }
            : { name: 'JSON', extensions: ['json'] }
        ]
      });

      // 用户取消保存对话框不是错误，也不该留下任何提示
      if (!path) {
        return;
      }

      setWriting(true);
      const contents = serializeExport(columns, rows, options);
      await invoke<number>('write_text_file', { path, contents });
      setWritten(path);
    } catch (err) {
      setError(describeError(err, t('export.failed')));
    } finally {
      setWriting(false);
    }
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
            {t('export.shape', { rows: rows.length, columns: columns.length })}
          </span>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {(truncated || scopeNote) && (
            <p className="rounded-control border border-warning-line bg-warning-soft px-3 py-2 text-xs text-warning">
              {truncated && t('export.truncated')}
              {truncated && scopeNote && ' '}
              {scopeNote}
            </p>
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
              {options.format === 'json'
                ? t('export.previewJson', { total: rows.length })
                : t('export.previewCsv', {
                    shown: Math.min(PREVIEW_ROWS, rows.length),
                    total: rows.length
                  })}
            </p>
            <pre className="max-h-36 overflow-auto rounded-control border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-fg select-text whitespace-pre">
              {preview || t('export.previewEmpty')}
            </pre>
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-line bg-surface-sunken px-5 py-3">
          <div className="min-w-0 flex-1 text-xs">
            {error && <span className="break-words text-danger">{error}</span>}
            {!error && written && (
              <span className="break-all text-success">{t('export.written', { path: written })}</span>
            )}
          </div>
          <button
            type="button"
            ref={cancelRef}
            onClick={onClose}
            disabled={writing}
            className="shrink-0 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover disabled:opacity-50"
          >
            {written ? t('common.done') : t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={writing || rows.length === 0}
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
