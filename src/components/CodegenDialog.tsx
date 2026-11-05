import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Loader2, Save, X } from 'lucide-react';
import { clsx } from 'clsx';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { SqlDialect } from '../contracts/queryExecution';
import { useLanguageStore } from '../stores/languageStore';
import type { TranslationKey, TranslationParams } from '../i18n/translate';

import type { CodegenNote, CodegenSchema, GeneratedCode } from '../utils/codegenModel';
import { codegenTargetsFor, type CodegenTarget } from '../utils/codegenTargets';
import { describeError } from '../utils/describeError';
import { isImeKeyEvent } from '../utils/shortcuts';
import { HighlightedCode } from './HighlightedCode';
import { SegmentedControl } from './FormControls';

type Translate = (key: TranslationKey, params?: TranslationParams) => string;

interface CodegenDialogProps {
  dialect: SqlDialect;
  /** 写进生成文件开头的来源：连接名与库名，或「AI 设计」 */
  source: string;
  /** 读出要生成的那些表。已有库要逐表查结构，所以是异步的 */
  load: () => Promise<CodegenSchema>;
  onClose: () => void;
}

/**
 * 生成 ORM 实体 / 结构体（rfcs/codegen.md）。生成是确定性的纯函数，这里只管选目标、预览、复制与保存。
 * 一个文件的目标存为一个文件；多文件的选一个目录，只写新文件、不覆盖已有的
 */
export function CodegenDialog({ dialect, source, load, onClose }: CodegenDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const targets = useMemo(() => codegenTargetsFor(dialect), [dialect]);
  const [targetId, setTargetId] = useState<CodegenTarget['id'] | null>(targets[0]?.id ?? null);
  const [schema, setSchema] = useState<CodegenSchema | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fileIndex, setFileIndex] = useState(0);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isImeKeyEvent(event)) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (loaded) => {
        if (!cancelled) setSchema(loaded);
      },
      (cause) => {
        if (!cancelled) setLoadError(describeError(cause, t('codegen.loadFailed')));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [load, t]);

  const target = targets.find((item) => item.id === targetId) ?? null;
  const generated = useMemo((): GeneratedCode | { error: string } | null => {
    if (!schema || !target) return null;
    try {
      return target.generate(schema, source);
    } catch (cause) {
      return { error: describeError(cause, t('codegen.generateFailed')) };
    }
  }, [schema, target, source, t]);

  useEffect(() => {
    setFileIndex(0);
    setStatus(null);
  }, [targetId]);

  const files = generated && 'files' in generated ? generated.files : [];
  const file = files[Math.min(fileIndex, files.length - 1)];

  const copy = async () => {
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file.contents);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (cause) {
      setStatus({ kind: 'error', text: describeError(cause, t('common.copyFailed')) });
    }
  };

  const saveFiles = async () => {
    if (files.length === 0) return;
    setStatus(null);
    try {
      if (files.length === 1) {
        const path = await save({ defaultPath: files[0].path });
        if (!path) return;
        await invoke('write_text_file', { path, contents: files[0].contents });
        setStatus({ kind: 'ok', text: t('codegen.saved', { path }) });
        return;
      }
      const directory = await open({ directory: true, multiple: false });
      if (typeof directory !== 'string') return;
      await invoke<string[]>('write_new_text_files', { directory, files });
      setStatus({ kind: 'ok', text: t('codegen.savedFiles', { count: files.length, path: directory }) });
    } catch (cause) {
      setStatus({ kind: 'error', text: describeError(cause, t('codegen.saveFailed')) });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="codegen-title"
      onClick={onClose}
    >
      <div
        className="flex h-[calc(100vh-4rem)] w-[960px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <h2 id="codegen-title" className="shrink-0 text-sm font-medium text-fg">{t('codegen.title')}</h2>
          <span className="min-w-0 truncate text-xs text-fg-subtle">{source}</span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="ml-auto rounded-control p-1 text-fg-muted hover:bg-surface-hover"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-2">
          {targets.length > 0 && targetId ? (
            <SegmentedControl
              value={targetId}
              options={targets.map((item) => ({ value: item.id, label: item.label }))}
              onChange={setTargetId}
            />
          ) : (
            <span className="text-xs text-fg-subtle">{t('codegen.noTargets')}</span>
          )}
          {file && (
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={copy}
                className="flex items-center gap-1 rounded-control border border-line-strong px-2 py-1 text-xs text-fg hover:bg-surface-hover"
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                {copied ? t('common.copied') : t('codegen.copyFile')}
              </button>
              <button
                type="button"
                onClick={() => void saveFiles()}
                className="flex items-center gap-1 rounded-control bg-accent px-2 py-1 text-xs text-fg-on-accent hover:opacity-90"
              >
                <Save size={12} />
                {files.length > 1 ? t('codegen.saveToFolder', { count: files.length }) : t('codegen.save')}
              </button>
            </div>
          )}
        </div>

        {status && (
          <p className={clsx('border-b border-line px-5 py-1.5 text-xs break-words', status.kind === 'ok' ? 'text-success' : 'text-danger')}>
            {status.text}
          </p>
        )}

        {generated && 'notes' in generated && generated.notes.length > 0 && (
          <ul className="max-h-28 overflow-auto border-b border-line bg-warning-soft px-5 py-2 text-xs text-fg">
            {generated.notes.map((note, index) => (
              <li key={index}>{describeNote(note, t)}</li>
            ))}
          </ul>
        )}

        <div className="flex min-h-0 flex-1">
          {files.length > 1 && (
            <ul className="w-56 shrink-0 overflow-auto border-r border-line py-1">
              {files.map((item, index) => (
                <li key={item.path}>
                  <button
                    type="button"
                    onClick={() => setFileIndex(index)}
                    className={clsx(
                      'block w-full truncate px-3 py-1 text-left font-mono text-xs',
                      index === fileIndex ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-hover'
                    )}
                    title={item.path}
                  >
                    {item.path}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="min-w-0 flex-1 overflow-auto px-5 py-3">
            {!schema && !loadError && (
              <p className="flex items-center gap-2 text-xs text-fg-subtle">
                <Loader2 size={14} className="animate-spin" />
                {t('codegen.loading')}
              </p>
            )}
            {loadError && <p className="break-words text-xs text-danger">{loadError}</p>}
            {generated && 'error' in generated && <p className="break-words text-xs text-danger">{generated.error}</p>}
            {file && target && (
              <pre className="select-text whitespace-pre font-mono text-xs leading-5 text-fg">
                <HighlightedCode code={file.contents} language={target.language} />
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function describeNote(note: CodegenNote, t: Translate): string {
  switch (note.kind) {
    case 'unknown-type':
      return t('codegen.note.unknownType', { table: note.table, column: note.column, type: note.dataType });
    case 'skipped-table':
      return t('codegen.note.skippedTable', { table: note.table });
    case 'ignored-table':
      return t('codegen.note.ignoredTable', { table: note.table });
    case 'dangling-foreign-key':
      return t('codegen.note.danglingForeignKey', { table: note.table, constraint: note.constraint, target: note.referencedTable });
    case 'skipped-relation':
      return t(
        note.reason === 'target-not-unique' ? 'codegen.note.relationNotUnique' : 'codegen.note.relationSkippedTable',
        { table: note.table, constraint: note.constraint }
      );
  }
}
