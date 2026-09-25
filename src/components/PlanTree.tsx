import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import { useLanguageStore } from '../stores/languageStore';
import {
  estimateAccuracy,
  formatPlanCost,
  formatPlanMs,
  formatPlanRows,
  type PlanNode
} from '../utils/planInsights';

/** 计划树：SQL 的执行计划对话框与 Cypher 结果里的 `EXPLAIN` / `PROFILE` 共用 */
export function PlanTree({ roots }: { roots: PlanNode[] }) {
  return (
    <ul className="space-y-1">
      {roots.map((node, index) => (
        <PlanNodeRow key={index} node={node} depth={0} />
      ))}
    </ul>
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
