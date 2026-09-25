import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useLanguageStore } from '../stores/languageStore';
import { describeError } from '../utils/describeError';
import { explainVerdict, planLine, type MongoExplain } from '../utils/mongoExplain';

interface MongoExplainDialogProps {
  connectionString: string;
  database: string;
  collection: string;
  filter: string;
  sort: string;
  /** 不是 null 就看这条管道，条件与排序不参与 */
  pipeline: string | null;
  timeoutMs: number;
  onClose: () => void;
}

/**
 * 执行计划：打开就问一次服务端。摘要回答「用没用上索引、为了返回这些看了多少」，
 * 全文收在下面，要细看再展开——服务端的 explain 有几十行，大多与这个问题无关
 */
export function MongoExplainDialog({
  connectionString,
  database,
  collection,
  filter,
  sort,
  pipeline,
  timeoutMs,
  onClose
}: MongoExplainDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const [explain, setExplain] = useState<MongoExplain | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<MongoExplain>('mongodb_explain', {
      connectionString,
      database,
      collection,
      filter,
      sort,
      pipeline,
      timeoutMs
    })
      .then((result) => {
        if (!cancelled) setExplain(result);
      })
      .catch((caught) => {
        if (!cancelled) setError(describeError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [connectionString, database, collection, filter, sort, pipeline, timeoutMs]);

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

  const verdict = explain ? explainVerdict(explain) : null;
  const count = (value: number | null) => (value === null ? '—' : value.toLocaleString());

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mongo-explain-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[640px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="mongo-explain-title" className="text-base font-medium text-fg">
            {t('mongo.explain.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-control p-1 text-fg-muted hover:bg-surface-hover hover:text-fg"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {!explain && !error && (
            <p className="flex items-center gap-2 text-sm text-fg-muted">
              <Loader2 size={14} className="animate-spin" />
              {t('mongo.explain.running')}
            </p>
          )}
          {error && <p className="select-text text-sm text-danger">{error}</p>}
          {explain && verdict && (
            <>
              <p
                className={clsx(
                  'rounded-control border px-3 py-2 text-sm',
                  verdict === 'collection-scan'
                    ? 'border-warning-line bg-warning-soft text-warning'
                    : 'border-line bg-surface-sunken text-fg'
                )}
              >
                {t(`mongo.explain.verdict.${verdict}`)}
              </p>
              <dl className="grid grid-cols-4 gap-2 text-sm">
                {([
                  ['mongo.explain.returned', explain.returned],
                  ['mongo.explain.docsExamined', explain.docsExamined],
                  ['mongo.explain.keysExamined', explain.keysExamined],
                  ['mongo.explain.millis', explain.millis]
                ] as const).map(([key, value]) => (
                  <div key={key} className="rounded-control border border-line px-2 py-1.5">
                    <dt className="text-xs text-fg-muted">{t(key)}</dt>
                    <dd className="font-mono tabular-nums text-fg">{count(value)}</dd>
                  </div>
                ))}
              </dl>
              {explain.stages.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs text-fg-muted">{t('mongo.explain.plan')}</p>
                  <pre className="select-text whitespace-pre rounded-control border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-fg">
                    {explain.stages.map(planLine).join('\n')}
                  </pre>
                </div>
              )}
              <details>
                <summary className="cursor-pointer text-xs text-fg-muted">{t('mongo.explain.full')}</summary>
                <pre className="mt-1 max-h-80 select-text overflow-auto whitespace-pre rounded-control border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-fg">
                  {explain.text}
                </pre>
              </details>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
