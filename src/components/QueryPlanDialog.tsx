import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useLanguageStore } from '../stores/languageStore';
import { useQueryStore } from '../stores/queryStore';
import { describeError } from '../utils/describeError';
import { formatPlanMs, formatPlanRows, worstEstimate, type QueryPlan } from '../utils/planInsights';
import { PlanTree } from './PlanTree';

interface QueryPlanDialogProps {
  sql: string;
  connectionId: string;
  /** 数据库类型，用来决定「真的执行一遍」给不给开 */
  dbType: string;
  databaseLabel: string;
  onClose: () => void;
}

/**
 * 只有 PostgreSQL 能真的跑一遍。
 *
 * 这一行和 Rust 的 `services::explain::supports_analyze` 是同一个判断。
 * 两边分叉时后端会**报错**而不是降级成普通 EXPLAIN——所以界面这边错了会立刻
 * 看见，不会变成一句「真的跑了一遍」的假话。
 */
function supportsAnalyze(dbType: string): boolean {
  return dbType === 'postgresql';
}

export function QueryPlanDialog({
  sql,
  connectionId,
  dbType,
  databaseLabel,
  onClose
}: QueryPlanDialogProps) {
  const t = useLanguageStore((state) => state.t);
  // 只订阅 id：`refreshTransaction` 每次都会换掉整个 session 对象，
  // 把对象本身放进 effect 的依赖里会让取计划和刷事务状态互相触发，转不停
  const sessionId = useQueryStore((state) => state.session?.id ?? null);
  const autocommit = useQueryStore((state) => state.autocommit);
  const refreshTransaction = useQueryStore((state) => state.refreshTransaction);

  const [analyze, setAnalyze] = useState(false);
  const [view, setView] = useState<'tree' | 'raw'>('tree');
  const [plan, setPlan] = useState<QueryPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<QueryPlan>('explain_query', {
      request: { connectionId, sessionId, sql, analyze, autocommit }
    })
      .then((result) => {
        if (!cancelled) {
          setPlan(result);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(describeError(caught));
          setPlan(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
        // ANALYZE 真的跑了语句，可能刚开了一个事务
        void refreshTransaction();
      });
    return () => {
      cancelled = true;
    };
  }, [sql, analyze, connectionId, sessionId, autocommit, refreshTransaction]);

  // 重新取计划时不显示上一份的结论：勾上「真的执行一遍」那一刻，旧计划的
  // 提示会停在屏幕上，读的人会以为那是新结果
  const worst = plan && !loading && !error ? worstEstimate(plan) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="query-plan-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[84vh] w-[860px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-line px-5 py-3">
          <div className="min-w-0">
            <h2 id="query-plan-title" className="text-base font-medium text-fg">
              {t('plan.title')}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-fg-muted">
              {!loading && plan?.planningMs !== null && plan?.planningMs !== undefined && (
                <span>{t('plan.planningTime', { time: formatPlanMs(plan.planningMs) })}</span>
              )}
              {!loading && plan?.executionMs !== null && plan?.executionMs !== undefined && (
                <span>{t('plan.executionTime', { time: formatPlanMs(plan.executionMs) })}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-control p-1 text-fg-muted hover:bg-surface-hover hover:text-fg"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface-sunken px-5 py-2 text-xs">
          <div className="flex items-center gap-1">
            {(['tree', 'raw'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setView(value)}
                className={clsx(
                  'rounded-control px-2 py-1',
                  view === value
                    ? 'bg-accent-soft text-accent'
                    : 'text-fg-muted hover:bg-surface-hover'
                )}
              >
                {t(value === 'tree' ? 'plan.tab.tree' : 'plan.tab.raw')}
              </button>
            ))}
          </div>

          <label
            className={clsx(
              'flex items-center gap-1',
              supportsAnalyze(dbType) ? 'cursor-pointer text-fg-muted' : 'text-fg-subtle'
            )}
            title={
              supportsAnalyze(dbType)
                ? t('plan.analyzeHint')
                : t('plan.analyzeUnsupported', { database: databaseLabel })
            }
          >
            <input
              type="checkbox"
              checked={analyze}
              disabled={!supportsAnalyze(dbType)}
              onChange={(event) => setAnalyze(event.target.checked)}
            />
            {t('plan.analyze')}
          </label>

          {analyze && (
            <span className="flex items-center gap-1 text-warning">
              <AlertTriangle size={12} />
              {/* 自动提交开着时，它写进去的东西**当场就提交了**，没有回滚的机会 */}
              {autocommit ? t('plan.analyzeWillCommit') : t('plan.analyzeWillRun')}
            </span>
          )}
        </div>

        {worst && (
          <p className="border-b border-warning-line bg-warning-soft px-5 py-2 text-xs text-warning">
            {t('plan.worstHint', {
              operation: worst.target ? `${worst.operation} (${worst.target})` : worst.operation,
              estimated: formatPlanRows(worst.estimatedRows),
              actual: formatPlanRows(worst.actualRows)
            })}
          </p>
        )}

        <div className="flex-1 overflow-auto px-5 py-3">
          {loading && (
            <p className="flex items-center gap-2 text-sm text-fg-muted">
              <Loader2 size={14} className="animate-spin" />
              {t('plan.loading')}
            </p>
          )}
          {!loading && error && <p className="text-sm text-danger">{error}</p>}
          {!loading && !error && plan && view === 'tree' && (
            plan.roots.length === 0
              ? <p className="text-sm text-fg-muted">{t('plan.empty')}</p>
              : (
                <PlanTree roots={plan.roots} />
              )
          )}
          {!loading && !error && plan && view === 'raw' && (
            <>
              <pre className="select-text whitespace-pre-wrap break-words rounded-control border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-fg">
                {plan.raw}
              </pre>
              <p className="mt-2 text-xs text-fg-subtle">{t('plan.rawNote')}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
