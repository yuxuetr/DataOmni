import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { clsx } from 'clsx';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import type { ColumnInfo } from '../contracts/databaseMetadata';
import {
  autoMapColumns,
  columnKind,
  fitsColumn,
  importColumns,
  validateImport,
  type ColumnMapping,
  type CsvPreview,
  type ImportIssue
} from '../utils/csvImport';
import { describeError } from '../utils/describeError';
import { formatBytes } from '../utils/formatBytes';
import { useLanguageStore } from '../stores/languageStore';
import { useTaskStore } from '../stores/taskStore';
import type { TranslationKey } from '../i18n/translate';
import { Checkbox, Field, SegmentedControl } from './FormControls';
import type { SqlIdentifierDialect } from '../utils/sqlIdentifiers';

interface CsvImportDialogProps {
  connectionId: string;
  schema: string | null;
  table: string;
  columns: readonly ColumnInfo[];
  dialect: SqlIdentifierDialect;
  onClose: () => void;
  /**
   * 导入已经交给后台任务，这是它的 id。
   *
   * 导入不再在这个对话框里跑完——它可能要几分钟，而把一个模态框钉在屏幕上
   * 几分钟意味着这期间什么都干不了。调用方拿这个 id 盯着任务，结束了再重读数据。
   */
  onStarted: (taskId: string) => void;
}

type Step = 'source' | 'mapping' | 'run';
type DelimiterChoice = 'auto' | ',' | ';' | '\t' | '|';
type Strategy = 'single-transaction' | 'per-batch';
type OnError = 'abort' | 'skip';

const DELIMITERS: Array<{ value: DelimiterChoice; labelKey: TranslationKey }> = [
  { value: 'auto', labelKey: 'import.delimiter.auto' },
  { value: ',', labelKey: 'export.delimiter.comma' },
  { value: ';', labelKey: 'export.delimiter.semicolon' },
  { value: '\t', labelKey: 'export.delimiter.tab' }
];

// 与导出那一侧同一套写法：导出再导入应该拿回同一份数据
const NULL_TEXTS: Array<{ value: string; labelKey?: TranslationKey; label?: string }> = [
  { value: '', labelKey: 'import.nullAs.empty' },
  { value: 'NULL', label: 'NULL' },
  { value: '\\N', label: '\\N' }
];

const BATCH_SIZES = [100, 500, 1000, 5000];

const STEPS: Array<{ id: Step; labelKey: TranslationKey }> = [
  { id: 'source', labelKey: 'import.step.source' },
  { id: 'mapping', labelKey: 'import.step.mapping' },
  { id: 'run', labelKey: 'import.step.run' }
];

function fileNameOf(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

export function CsvImportDialog({
  connectionId,
  schema,
  table,
  columns,
  dialect,
  onClose,
  onStarted
}: CsvImportDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const [step, setStep] = useState<Step>('source');

  const [path, setPath] = useState<string | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [delimiter, setDelimiter] = useState<DelimiterChoice>('auto');
  const [nullText, setNullText] = useState('');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [batchSize, setBatchSize] = useState(500);
  const [strategy, setStrategy] = useState<Strategy>('single-transaction');
  const [onError, setOnError] = useState<OnError>('abort');

  const startTask = useTaskStore((state) => state.start);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const loadPreview = async (target: string, header: boolean, choice: DelimiterChoice) => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const next = await invoke<CsvPreview>('preview_csv_file', {
        request: {
          path: target,
          delimiter: choice === 'auto' ? null : choice,
          hasHeader: header
        }
      });
      setPreview(next);
      // 换文件、换分隔符、换表头开关都会让列的含义变掉，映射必须重来
      setMappings(autoMapColumns(next.headers, columns));
    } catch (error) {
      setPreview(null);
      setPreviewError(describeError(error, t('import.failed')));
    } finally {
      setPreviewing(false);
    }
  };

  const pickFile = async () => {
    const chosen = await open({
      multiple: false,
      filters: [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }]
    }).catch((error) => {
      setPreviewError(describeError(error, t('import.failed')));
      return null;
    });
    if (typeof chosen !== 'string') {
      return;
    }
    setPath(chosen);
    await loadPreview(chosen, hasHeader, delimiter);
  };

  const issues = useMemo<ImportIssue[]>(
    () => (preview ? validateImport(mappings, columns, preview, nullText, dialect) : []),
    [preview, mappings, columns, nullText, dialect]
  );
  const blocking = issues.filter((issue) => issue.level === 'error');

  const runImport = () => {
    if (!path || !preview) {
      return;
    }
    const taskId = startTask({
      kind: 'import',
      title: t('task.title.import', { table: schema ? `${schema}.${table}` : table }),
      payload: {
        connectionId,
        schema,
        table,
        path,
        csv: { delimiter: preview.delimiter, hasHeader, nullText },
        columns: importColumns(mappings, columns),
        batchSize,
        strategy,
        onError
      }
    });
    onStarted(taskId);
    onClose();
  };

  const canAdvance = step === 'source' ? Boolean(preview) : true;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="csv-import-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[calc(100vh-4rem)] w-[720px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <Upload size={16} className="shrink-0 text-fg-muted" />
          <h2 id="csv-import-title" className="text-sm font-medium text-fg">
            {t('import.title')}
          </h2>
          <span className="ml-auto truncate text-xs text-fg-subtle">
            {t('import.target', { table: schema ? `${schema}.${table}` : table })}
          </span>
        </div>

        <div className="flex items-center gap-1 border-b border-line px-5 py-2 text-xs">
          {STEPS.map((candidate, index) => (
            <button
              key={candidate.id}
              type="button"
              disabled={!preview && candidate.id !== 'source'}
              onClick={() => setStep(candidate.id)}
              className={clsx(
                'rounded-control px-2 py-1 transition-colors disabled:opacity-40',
                candidate.id === step
                  ? 'bg-accent-soft text-accent'
                  : 'text-fg-muted hover:bg-surface-hover'
              )}
            >
              {index + 1}. {t(candidate.labelKey)}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {step === 'source' && (
            <SourceStep
              path={path}
              preview={preview}
              previewing={previewing}
              previewError={previewError}
              hasHeader={hasHeader}
              delimiter={delimiter}
              nullText={nullText}
              onPick={pickFile}
              onHeaderChange={(next) => {
                setHasHeader(next);
                if (path) {
                  void loadPreview(path, next, delimiter);
                }
              }}
              onDelimiterChange={(next) => {
                setDelimiter(next);
                if (path) {
                  void loadPreview(path, hasHeader, next);
                }
              }}
              onNullTextChange={setNullText}
            />
          )}

          {step === 'mapping' && preview && (
            <MappingStep
              preview={preview}
              columns={columns}
              mappings={mappings}
              nullText={nullText}
              dialect={dialect}
              onChange={setMappings}
              onReset={() => setMappings(autoMapColumns(preview.headers, columns))}
            />
          )}

          {step === 'run' && preview && (
            <RunStep
              batchSize={batchSize}
              strategy={strategy}
              onErrorPolicy={onError}
              onBatchSizeChange={setBatchSize}
              onStrategyChange={setStrategy}
              onErrorPolicyChange={setOnError}
            />
          )}

          {step !== 'source' && issues.length > 0 && <IssueList issues={issues} />}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-sunken px-5 py-3">
          <div className="min-w-0 text-xs text-fg-subtle">
            {preview && `${fileNameOf(path ?? '')} · ${formatBytes(preview.totalBytes)}`}
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              ref={closeRef}
              onClick={onClose}
              className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
            >
              {t('common.close')}
            </button>
            {step !== 'run' ? (
              <button
                type="button"
                disabled={!canAdvance}
                onClick={() => setStep(step === 'source' ? 'mapping' : 'run')}
                className="rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
              >
                {t('import.next')}
              </button>
            ) : (
              <button
                type="button"
                disabled={blocking.length > 0 || !preview}
                onClick={runImport}
                className="rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
              >
                {t('import.run')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SourceStep({
  path,
  preview,
  previewing,
  previewError,
  hasHeader,
  delimiter,
  nullText,
  onPick,
  onHeaderChange,
  onDelimiterChange,
  onNullTextChange
}: {
  path: string | null;
  preview: CsvPreview | null;
  previewing: boolean;
  previewError: string | null;
  hasHeader: boolean;
  delimiter: DelimiterChoice;
  nullText: string;
  onPick: () => void;
  onHeaderChange: (value: boolean) => void;
  onDelimiterChange: (value: DelimiterChoice) => void;
  onNullTextChange: (value: string) => void;
}) {
  const t = useLanguageStore((state) => state.t);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onPick}
          className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
        >
          {t('import.pick')}
        </button>
        <span className="min-w-0 truncate text-xs text-fg-muted">
          {path ? fileNameOf(path) : t('import.noFile')}
        </span>
        {previewing && <Loader2 size={14} className="animate-spin text-fg-subtle" />}
      </div>

      {previewError && (
        <p className="rounded-control border border-danger-line bg-danger-soft px-3 py-2 text-xs text-danger">
          {previewError}
        </p>
      )}

      <Field label={t('import.delimiter')}>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<DelimiterChoice>
            value={delimiter}
            options={DELIMITERS.map((option) => ({
              value: option.value,
              label: t(option.labelKey)
            }))}
            onChange={onDelimiterChange}
          />
          {delimiter === 'auto' && preview && (
            <span className="text-xs text-fg-subtle">
              {t('import.delimiter.detected', {
                delimiter: preview.delimiter === '\t' ? '\\t' : preview.delimiter
              })}
            </span>
          )}
        </div>
      </Field>

      <Field label={t('import.nullAs')}>
        <SegmentedControl<string>
          value={nullText}
          options={NULL_TEXTS.map((option) => ({
            value: option.value,
            label: option.label ?? (option.labelKey ? t(option.labelKey) : '')
          }))}
          onChange={onNullTextChange}
        />
      </Field>

      <Checkbox checked={hasHeader} onChange={onHeaderChange} label={t('import.hasHeader')} />

      {preview && (
        <div>
          <p className="mb-1 text-xs text-fg-subtle">
            {t('import.preview', { count: preview.rows.length })}
            {preview.more && ` · ${t('import.previewMore')}`}
          </p>
          <PreviewGrid preview={preview} />
        </div>
      )}
    </div>
  );
}

function PreviewGrid({ preview }: { preview: CsvPreview }) {
  return (
    <div className="max-h-48 overflow-auto rounded-control border border-line">
      <table className="min-w-full text-xs">
        <thead className="sticky top-0 bg-surface-sunken">
          <tr>
            {preview.headers.map((header, index) => (
              <th
                key={`${header}-${index}`}
                className="whitespace-nowrap border-b border-line px-2 py-1 text-left font-medium text-fg-muted"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.slice(0, 8).map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-line last:border-0">
              {preview.headers.map((_, columnIndex) => (
                <td
                  key={columnIndex}
                  className="max-w-[16rem] truncate whitespace-nowrap px-2 py-1 font-mono text-fg"
                >
                  {row[columnIndex] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MappingStep({
  preview,
  columns,
  mappings,
  nullText,
  dialect,
  onChange,
  onReset
}: {
  preview: CsvPreview;
  columns: readonly ColumnInfo[];
  mappings: readonly ColumnMapping[];
  nullText: string;
  dialect: SqlIdentifierDialect;
  onChange: (mappings: ColumnMapping[]) => void;
  onReset: () => void;
}) {
  const t = useLanguageStore((state) => state.t);
  const byName = new Map(columns.map((column) => [column.name, column]));

  const setSource = (target: string, source: number | null) => {
    onChange(
      mappings.map((mapping) => (mapping.target === target ? { ...mapping, source } : mapping))
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-fg-muted">{t('import.step.mapping')}</span>
        <button
          type="button"
          onClick={onReset}
          className="rounded-control border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover"
        >
          {t('import.mapping.auto')}
        </button>
      </div>

      <div className="overflow-hidden rounded-control border border-line">
        <table className="min-w-full text-xs">
          <thead className="bg-surface-sunken">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium text-fg-muted">
                {t('import.mapping.targetColumn')}
              </th>
              <th className="px-2 py-1.5 text-left font-medium text-fg-muted">
                {t('import.mapping.csvColumn')}
              </th>
              <th className="px-2 py-1.5 text-left font-medium text-fg-muted">
                {t('import.mapping.sample')}
              </th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((mapping) => {
              const column = byName.get(mapping.target);
              const kind = column ? columnKind(column.data_type, dialect) : 'text';
              // 样例优先挑**不合类型的**那个值：挑第一个非空值的话，屏幕上会出现
              // 一个看着没问题的样例，底下却挂着一条说这列有坏值的提醒
              const values =
                mapping.source === null
                  ? []
                  : preview.rows
                      .map((row) => row[mapping.source ?? 0] ?? '')
                      .filter((value) => value !== '' && value !== nullText);
              const offending = values.find((value) => !fitsColumn(value, kind));
              const sample = offending ?? values[0] ?? null;
              const mismatched = offending !== undefined;

              return (
                <tr key={mapping.target} className="border-t border-line">
                  <td className="px-2 py-1.5 align-top">
                    <span className="font-medium text-fg">{mapping.target}</span>
                    <span className="ml-1 font-mono text-fg-subtle">{column?.data_type}</span>
                    {column?.is_generated && (
                      <span className="ml-1 text-fg-subtle">
                        （{t('import.mapping.generated')}）
                      </span>
                    )}
                    {column && !column.is_nullable && !column.is_generated
                      && column.default_value == null && (
                      <span className="ml-1 text-warning">{t('import.mapping.required')}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 align-top">
                    <select
                      value={mapping.source ?? ''}
                      onChange={(event) =>
                        setSource(
                          mapping.target,
                          event.target.value === '' ? null : Number(event.target.value)
                        )
                      }
                      className="w-full rounded-control border border-line bg-surface px-1.5 py-1 text-xs text-fg"
                    >
                      <option value="">{t('import.mapping.skip')}</option>
                      {preview.headers.map((header, index) => (
                        <option key={`${header}-${index}`} value={index}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="max-w-[14rem] px-2 py-1.5 align-top">
                    <span
                      className={clsx(
                        'block truncate font-mono',
                        mismatched ? 'text-warning' : 'text-fg-muted'
                      )}
                      title={
                        mismatched && column
                          ? t('import.mapping.mismatch', { type: column.data_type })
                          : undefined
                      }
                    >
                      {sample ?? '—'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RunStep({
  batchSize,
  strategy,
  onErrorPolicy,
  onBatchSizeChange,
  onStrategyChange,
  onErrorPolicyChange
}: {
  batchSize: number;
  strategy: Strategy;
  onErrorPolicy: OnError;
  onBatchSizeChange: (value: number) => void;
  onStrategyChange: (value: Strategy) => void;
  onErrorPolicyChange: (value: OnError) => void;
}) {
  const t = useLanguageStore((state) => state.t);

  return (
    <div className="space-y-3">
      <Field label={t('import.batchSize')}>
        <div className="space-y-1">
          <SegmentedControl<string>
            value={String(batchSize)}
            options={BATCH_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
            onChange={(value) => onBatchSizeChange(Number(value))}
          />
          <p className="text-xs text-fg-subtle">{t('import.batchSizeNote')}</p>
        </div>
      </Field>

      <Field label={t('import.strategy')}>
        <div className="space-y-1">
          <SegmentedControl<Strategy>
            value={strategy}
            options={[
              { value: 'single-transaction', label: t('import.strategy.single-transaction') },
              { value: 'per-batch', label: t('import.strategy.per-batch') }
            ]}
            onChange={onStrategyChange}
          />
          <p className="text-xs text-fg-subtle">{t(`import.strategy.${strategy}Note`)}</p>
        </div>
      </Field>

      <Field label={t('import.onError')}>
        <div className="space-y-1">
          <SegmentedControl<OnError>
            value={onErrorPolicy}
            options={[
              { value: 'abort', label: t('import.onError.abort') },
              { value: 'skip', label: t('import.onError.skip') }
            ]}
            onChange={onErrorPolicyChange}
          />
          <p className="text-xs text-fg-subtle">{t(`import.onError.${onErrorPolicy}Note`)}</p>
        </div>
      </Field>

      {/* 按下之后这个框就关了，进度与失败的行都去后台任务里看 */}
      <p className="rounded-control border border-line bg-surface-sunken px-3 py-2 text-xs text-fg-subtle">
        {t('import.runsInBackground')}
      </p>
    </div>
  );
}

function IssueList({ issues }: { issues: readonly ImportIssue[] }) {
  const t = useLanguageStore((state) => state.t);

  return (
    <div>
      <p className="mb-1 text-xs text-fg-subtle">{t('import.issues')}</p>
      <ul className="space-y-1">
        {issues.map((issue, index) => (
          <li
            key={`${issue.key}-${index}`}
            className={clsx(
              'rounded-control border px-3 py-1.5 text-xs',
              issue.level === 'error'
                ? 'border-danger-line bg-danger-soft text-danger'
                : 'border-warning-line bg-warning-soft text-warning'
            )}
          >
            {/* 列名在这里才拼起来：分隔符跟着语言走，纯函数那边不知道语言 */}
            {t(
              issue.key,
              issue.columns
                ? { ...issue.params, columns: issue.columns.join(t('common.listSeparator')) }
                : issue.params
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
