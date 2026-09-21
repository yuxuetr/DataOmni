/**
 * 执行历史的持久化与淘汰。
 *
 * 存在 localStorage，和工作区快照、设置一样——历史是本机的一份笔记，不需要
 * 跨机器同步。这也意味着它和工作区快照**抢同一份 5MB 配额**：历史把配额撑满，
 * 代价是用户下次启动时标签全没了。所以容量上限不是可选项，而是这个模块存在
 * 的前提，写入路径上每次都执行。
 *
 * 出现「历史要跨机器同步」或「上限需要上万条」时该重估，换成后端的 SQLite
 * 文件。当前两者都没有。
 *
 * 全模块统一约定：记录列表**最新的在前**。新记录 unshift 进去，界面直接按
 * 这个顺序显示，写不下时从尾部砍。
 */

import type { QueryHistoryEntry } from '../contracts/queryHistory';
import { isAnnotated } from '../contracts/queryHistory';

const STORAGE_KEY = 'dataomni.query-history';
const SNAPSHOT_VERSION = 1;

export interface HistoryRetention {
  /** 保留天数。`0` 表示不按时间淘汰 */
  maxAgeDays: number;
  /** 最多留多少条。必须有限，见模块说明 */
  maxEntries: number;
}

export const DEFAULT_HISTORY_RETENTION: HistoryRetention = {
  maxAgeDays: 30,
  maxEntries: 500
};

/**
 * 淘汰：先按时间，再按条数，两轮都**先淘汰没被标注过的**。
 *
 * 收藏、命名、打标签都是在说「这条我还要」。让它跟着 30 天一起过期，等于
 * 用户做的标注被系统悄悄撤销——收藏一条语句之后还得记着它哪天到期，那这个
 * 收藏就没有意义。所以标注过的记录不参与按时间淘汰，只在总数仍然超限时
 * 才从最旧的开始动，并且排在所有未标注记录之后。
 */
export function pruneHistory(
  entries: readonly QueryHistoryEntry[],
  retention: HistoryRetention,
  now: Date = new Date()
): QueryHistoryEntry[] {
  const cutoff =
    retention.maxAgeDays > 0 ? now.getTime() - retention.maxAgeDays * 24 * 60 * 60 * 1000 : null;

  const kept = entries.filter((entry) => {
    if (cutoff === null || isAnnotated(entry)) {
      return true;
    }
    const startedAt = Date.parse(entry.startedAt);
    // 时间戳坏掉的记录按「留着」处理：删掉一条读不懂的记录比留着它更糟，
    // 用户会发现历史里凭空少了东西而找不到原因
    return Number.isNaN(startedAt) || startedAt >= cutoff;
  });

  if (kept.length <= retention.maxEntries) {
    return kept;
  }

  // 保留优先级从高到低：标注过的 → 更新的。最先被牺牲的因此是未标注的最旧一条
  const byKeepPriority = [...kept].sort((a, b) => {
    const annotated = Number(isAnnotated(b)) - Number(isAnnotated(a));
    if (annotated !== 0) {
      return annotated;
    }
    return Date.parse(b.startedAt) - Date.parse(a.startedAt);
  });
  const survivors = new Set(byKeepPriority.slice(0, retention.maxEntries));
  return kept.filter((entry) => survivors.has(entry));
}

interface HistorySnapshot {
  version: number;
  entries: QueryHistoryEntry[];
}

function isEntry(value: unknown): value is QueryHistoryEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<QueryHistoryEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.sql === 'string' &&
    typeof entry.startedAt === 'string' &&
    typeof entry.profileId === 'string' &&
    typeof entry.status === 'string'
  );
}

export function loadQueryHistory(): QueryHistoryEntry[] {
  let stored: unknown;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    return [];
  }

  if (typeof stored !== 'object' || stored === null) {
    return [];
  }
  const snapshot = stored as Partial<HistorySnapshot>;
  if (snapshot.version !== SNAPSHOT_VERSION || !Array.isArray(snapshot.entries)) {
    return [];
  }
  // 逐条过滤而不是整份丢弃：一条写坏的记录不该带走其余九百条
  return snapshot.entries.filter(isEntry);
}

/**
 * 写回，写不下就砍一半再试。
 *
 * localStorage 满了抛的是 `QuotaExceededError`，而配额是**整个源**共享的：
 * 撑爆它的不一定是历史自己。这里只对自己负责——把自己缩小到能写进去为止，
 * 给工作区快照让出位置。彻底写不进去时静默放弃：历史存不下不该让正在跑的
 * 查询报错。
 */
export function saveQueryHistory(entries: readonly QueryHistoryEntry[]): void {
  let candidate = [...entries];
  while (candidate.length > 0) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: SNAPSHOT_VERSION, entries: candidate })
      );
      return;
    } catch {
      // 最新的在前，所以从尾部砍——先丢掉的是最旧的那些
      candidate = candidate.slice(0, Math.floor(candidate.length / 2));
    }
  }

  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage 整个不可用，没有别的办法
  }
}
