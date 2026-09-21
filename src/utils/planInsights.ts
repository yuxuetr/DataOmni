/**
 * 执行计划上值得一眼看到的那几件事。
 *
 * 一棵树上几十个节点，逐个读代价数字没人做得到。真正需要被指出来的只有
 * 一件：**优化器估错了多少**——绝大多数「这条查询怎么这么慢」最后都落在
 * 某个节点的估算行数和实际行数差了几个数量级，而那意味着统计信息过期或者
 * 条件之间的相关性没被看出来。
 */

/** 后端给的计划节点，字段名按 Rust 侧的 camelCase */
export interface PlanNode {
  operation: string;
  target: string | null;
  estimatedRows: number | null;
  actualRows: number | null;
  cost: number | null;
  actualMs: number | null;
  detail: Array<{ key: string; value: string }>;
  children: PlanNode[];
}

export interface QueryPlan {
  roots: PlanNode[];
  analyzed: boolean;
  planningMs: number | null;
  executionMs: number | null;
  raw: string;
}

export type EstimateAccuracy = 'unknown' | 'close' | 'off' | 'way-off';

/**
 * 估算差了多少。
 *
 * 没跑过（没有实际行数）就是 `unknown`，不是「准」——一个没有实际值可比的
 * 节点被标成准确，正好把这个提示最该说话的场合变成了沉默。
 *
 * 阈值按**倍数**不按差值：估 1 行实际 100 行是灾难（嵌套循环会跑 100 次），
 * 估 100 万实际 100 万零 100 无所谓。两侧都加 1 再比，免得估 0 行时除零，
 * 也免得把「估 0 实际 1」这种正常的取整误差报成无穷大。
 */
export function estimateAccuracy(node: PlanNode): EstimateAccuracy {
  const { estimatedRows, actualRows } = node;
  if (estimatedRows === null || actualRows === null) {
    return 'unknown';
  }
  const estimated = Math.max(0, estimatedRows) + 1;
  const actual = Math.max(0, actualRows) + 1;
  const ratio = Math.max(estimated / actual, actual / estimated);
  if (ratio >= 100) {
    return 'way-off';
  }
  return ratio >= 10 ? 'off' : 'close';
}

/**
 * 整棵树里最值得看的那个节点。
 *
 * 只挑一个：指出十个「可疑」节点等于没指出任何一个。同一档里挑实际行数
 * 最多的——差 100 倍的 10 行和差 100 倍的一百万行不是同一件事。
 */
export function worstEstimate(plan: QueryPlan): PlanNode | null {
  const ranking: Record<EstimateAccuracy, number> = {
    'way-off': 3,
    off: 2,
    close: 1,
    unknown: 0
  };
  let worst: { node: PlanNode; rank: number } | null = null;
  for (const node of flattenPlan(plan)) {
    const rank = ranking[estimateAccuracy(node)];
    if (rank < 2) {
      continue;
    }
    const better = !worst
      || rank > worst.rank
      || (rank === worst.rank && (node.actualRows ?? 0) > (worst.node.actualRows ?? 0));
    if (better) {
      worst = { node, rank };
    }
  }
  return worst?.node ?? null;
}

/** 深度优先展开，顺序就是树上从上到下的顺序 */
export function flattenPlan(plan: QueryPlan): PlanNode[] {
  const out: PlanNode[] = [];
  const visit = (node: PlanNode) => {
    out.push(node);
    node.children.forEach(visit);
  };
  plan.roots.forEach(visit);
  return out;
}

/**
 * 行数写成紧凑形式。
 *
 * 计划上的数字是数量级的问题，不是精度的问题：`1.2M` 比 `1234567` 更快读懂
 * 「这一步在处理一百万行」。
 */
export function formatPlanRows(value: number | null): string {
  if (value === null) {
    return '—';
  }
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  // 小数行数是估算才有的（PostgreSQL 会给 0.5 行），取整会把它变成 0 或 1
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** 毫秒；不到 1ms 的保留小数，否则一串 0ms 什么也说明不了 */
export function formatPlanMs(value: number | null): string {
  if (value === null) {
    return '—';
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)} s`;
  }
  return value >= 1 ? `${value.toFixed(1)} ms` : `${value.toFixed(3)} ms`;
}
