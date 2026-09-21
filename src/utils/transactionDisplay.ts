import type { TransactionContext } from '../contracts/session';
import type { TranslationKey } from '../i18n/translate';

/**
 * 状态栏上事务那一格该显示什么。
 *
 * 抽成纯函数是因为它有三件容易错的判断，而它们在组件里都验不到：哪一档算
 * 「能开始」、哪一档算「能提交」、以及那个计时器在事务没开时必须不显示而
 * 不是显示 00:00——后者看起来像一个刚开始的事务。
 */
export interface TransactionDisplay {
  labelKey: TranslationKey;
  /** 设计令牌里的文字色 */
  tone: 'muted' | 'warning' | 'danger';
  canBegin: boolean;
  /**
   * 提交按钮能不能按。
   *
   * 废掉的事务里**不能**：PostgreSQL 对一个 aborted 事务的 COMMIT 会照常
   * 返回成功，但它做的是回滚（服务端回的是 `ROLLBACK`）。留着那个按钮等于
   * 让人按下「提交」之后以为数据存进去了。
   */
  canCommit: boolean;
  canRollback: boolean;
  /** 事务已经开了多久；不在事务里就是 null */
  elapsedMs: number | null;
}

const LABELS: Record<TransactionContext['status'], TranslationKey> = {
  idle: 'tx.idle',
  active: 'tx.active',
  failed: 'tx.failed'
};

const TONES: Record<TransactionContext['status'], TransactionDisplay['tone']> = {
  idle: 'muted',
  active: 'warning',
  failed: 'danger'
};

export function describeTransaction(
  transaction: TransactionContext,
  now: number = Date.now()
): TransactionDisplay {
  const inTransaction = transaction.status !== 'idle';
  const startedAt = transaction.startedAt ? Date.parse(transaction.startedAt) : Number.NaN;
  return {
    labelKey: LABELS[transaction.status],
    tone: TONES[transaction.status],
    canBegin: !inTransaction,
    canCommit: transaction.status === 'active',
    // 废掉的事务只剩这一条路
    canRollback: inTransaction,
    // 开始时间读不出来时给 null 而不是 0：一个显示 00:00 的计时器看起来像
    // 一个刚开始的事务，而真实情况是我们不知道它开了多久
    elapsedMs: inTransaction && Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : null
  };
}

/** `mm:ss`，超过一小时加上小时段。事务开了一小时是个该看见的数字 */
export function formatTransactionElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${String(minutes).padStart(2, '0')}:${seconds}`;
}
