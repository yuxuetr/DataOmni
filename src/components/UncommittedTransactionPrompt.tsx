import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';

export type LeaveTransactionChoice = 'commit' | 'rollback' | 'cancel';

interface UncommittedTransactionPromptProps {
  /** 事务开始的时间，已经格式化过 */
  startedAt: string;
  /**
   * 还能不能提交。
   *
   * 废掉的事务不能：PostgreSQL 对一个 aborted 事务的 COMMIT 会照常返回成功，
   * 做的却是回滚。那时候给「提交并继续」，等于让人以为数据存进去了。
   */
  canCommit: boolean;
  onChoose: (choice: LeaveTransactionChoice) => void;
}

/**
 * 断开连接前还开着一个事务。
 *
 * 三选一而不是「确定/取消」：断开会让数据库把整个事务回滚掉，而用户此刻
 * 最可能想做的恰恰是**提交**它。只给「确定要断开吗」等于逼他先取消、
 * 自己去按提交、再断开一次。
 *
 * 默认焦点在「留下」上：这个框弹出来时，最保守的结果是先别走。
 */
export function UncommittedTransactionPrompt({
  startedAt,
  canCommit,
  onChoose
}: UncommittedTransactionPromptProps) {
  const t = useLanguageStore((state) => state.t);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onChoose('cancel');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onChoose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="leave-transaction-title"
      onClick={() => onChoose('cancel')}
    >
      <div
        className="w-[460px] max-w-[calc(100vw-2rem)] rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-5">
          <AlertTriangle size={20} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0">
            <h2 id="leave-transaction-title" className="text-base font-medium text-fg">
              {t('tx.leaveTitle')}
            </h2>
            <p className="mt-2 text-sm text-fg-muted">{t('tx.leaveBody', { started: startedAt })}</p>
            {!canCommit && (
              <p className="mt-1 text-sm text-danger">{t('tx.failedHint')}</p>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-sunken px-5 py-3">
          <button
            type="button"
            ref={cancelRef}
            onClick={() => onChoose('cancel')}
            className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
          >
            {t('tx.leaveCancel')}
          </button>
          <button
            type="button"
            onClick={() => onChoose('rollback')}
            className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
          >
            {t('tx.leaveRollback')}
          </button>
          {canCommit && (
            <button
              type="button"
              onClick={() => onChoose('commit')}
              className="rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-solid hover:opacity-90"
            >
              {t('tx.leaveCommit')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
