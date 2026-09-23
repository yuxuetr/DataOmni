import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Check, Play, Undo2 } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';
import { useQueryStore } from '../stores/queryStore';
import {
  describeTransaction,
  formatTransactionElapsed,
  type TransactionCommand
} from '../utils/transactionDisplay';

const TONE_CLASS = {
  muted: 'text-fg-subtle',
  warning: 'text-warning',
  danger: 'text-danger'
} as const;

/**
 * 事务状态与三个按钮，常驻在工作台头部。
 *
 * 状态由后端给——它是执行语句的那一侧，看得见用户自己写的 `BEGIN`，而前端
 * 只看得见自己发过什么。每执行完一条语句刷一次。
 */
export function TransactionBar() {
  const t = useLanguageStore((state) => state.t);
  const session = useQueryStore((state) => state.session);
  const autocommit = useQueryStore((state) => state.autocommit);
  const setAutocommit = useQueryStore((state) => state.setAutocommit);
  const runTransactionStatement = useQueryStore((state) => state.runTransactionStatement);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  const transaction = session?.transaction ?? { status: 'idle' as const, startedAt: null };
  const display = describeTransaction(transaction, now);

  // 只在事务开着时挂定时器：空转一个 setInterval 换不来任何东西。
  // 依赖的是「在不在事务里」，不是走动的那个数——后者每秒都变，会让这个
  // effect 每秒重挂一次
  const ticking = display.elapsedMs !== null;
  useEffect(() => {
    if (!ticking) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  if (!session?.capabilities.transactions) {
    return null;
  }

  const run = async (command: TransactionCommand) => {
    setBusy(true);
    try {
      await runTransactionStatement(command);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-l border-line pl-3 text-xs">
      <span
        className={clsx('flex items-center gap-1 font-medium', TONE_CLASS[display.tone])}
        title={display.tone === 'danger' ? t('tx.failedHint') : undefined}
      >
        {t(display.labelKey)}
        {display.elapsedMs !== null && (
          <span className="font-mono tabular-nums">
            {formatTransactionElapsed(display.elapsedMs)}
          </span>
        )}
      </span>

      <label
        className="flex cursor-pointer items-center gap-1 text-fg-muted"
        title={t('tx.autocommitHint')}
      >
        <input
          type="checkbox"
          checked={autocommit}
          onChange={(event) => setAutocommit(event.target.checked)}
        />
        {t('tx.autocommit')}
      </label>

      <button
        type="button"
        disabled={!display.canBegin || busy}
        onClick={() => void run('BEGIN')}
        className="flex items-center gap-1 rounded-control border border-line-strong px-2 py-1 text-fg hover:bg-surface-hover disabled:opacity-40"
      >
        <Play size={12} />
        {t('tx.begin')}
      </button>
      <button
        type="button"
        disabled={!display.canCommit || busy}
        onClick={() => void run('COMMIT')}
        className="flex items-center gap-1 rounded-control border border-line-strong px-2 py-1 text-fg hover:bg-surface-hover disabled:opacity-40"
      >
        <Check size={12} />
        {t('tx.commit')}
      </button>
      <button
        type="button"
        disabled={!display.canRollback || busy}
        onClick={() => void run('ROLLBACK')}
        className="flex items-center gap-1 rounded-control border border-line-strong px-2 py-1 text-fg hover:bg-surface-hover disabled:opacity-40"
      >
        <Undo2 size={12} />
        {t('tx.rollback')}
      </button>
    </div>
  );
}
