import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useLanguageStore } from '../stores/languageStore';
import { useQueryStore } from '../stores/queryStore';
import { describeError } from '../utils/describeError';
import {
  estimateAccuracy,
  formatPlanCost,
  formatPlanMs,
  formatPlanRows,
  worstEstimate,
  type PlanNode,
  type QueryPlan
} from '../utils/planInsights';

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
                <ul className="space-y-1">
                  {plan.roots.map((node, index) => (
                    <PlanNodeRow key={index} node={node} depth={0} />
                  ))}
                </ul>
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

const ACCURACY_CLASS = {
  unknown: '',
  close: '',
  off: 'text-warning',
  'way-off': 'text-danger'
} as const;

function PlanNodeRow({ node, depth }: { node: PlanNode; depth: number }) {
  const t = useLanguageStore((state) => state.t);
  // 细节默认收起：一个 PostgreSQL 节点有十几个字段，全摊开就看不见树了
  const [open, setOpen] = useState(false);
  const accuracy = estimateAccuracy(node);
  const hasDetail = node.detail.length > 0;

  return (
    <li>
      <div
        className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-control py-0.5 text-sm hover:bg-surface-hover"
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          disabled={!hasDetail}
          className="flex items-center gap-1 text-fg disabled:cursor-default"
        >
          {hasDetail
            ? (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)
            : <span className="inline-block w-3" />}
          <span className="font-medium">{node.operation}</span>
        </button>
        {node.target && <span className="font-mono text-xs text-accent">{node.target}</span>}
        <span className="text-xs text-fg-muted">
          {t('plan.estimated')} {formatPlanRows(node.estimatedRows)}
        </span>
        {node.actualRows !== null && (
          <span className={clsx('text-xs', ACCURACY_CLASS[accuracy] || 'text-fg-muted')}>
            {t('plan.actual')} {formatPlanRows(node.actualRows)}
          </span>
        )}
        {node.actualMs !== null && (
          <span className="text-xs text-fg-muted">{formatPlanMs(node.actualMs)}</span>
        )}
        {node.cost !== null && (
          <span className="text-xs text-fg-subtle">
            {t('plan.cost')} {formatPlanCost(node.cost)}
          </span>
        )}
      </div>

      {open && hasDetail && (
        <dl
          className="mt-0.5 mb-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs"
          style={{ paddingLeft: `${depth * 16 + 20}px` }}
        >
          {node.detail.map((item) => (
            <div key={item.key} className="contents">
              <dt className="text-fg-subtle">{item.key}</dt>
              <dd className="min-w-0 break-words font-mono text-fg-muted">{item.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {node.children.length > 0 && (
        <ul className="space-y-1">
          {node.children.map((child, index) => (
            <PlanNodeRow key={index} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
