import { useEffect, useRef } from 'react';
import { AlertTriangle, Ban, Undo2 } from 'lucide-react';
import { clsx } from 'clsx';
import type { ConnectionEnvironment } from '../contracts';
import { environmentBadge } from '../contracts/environment';
import { RISK_DESCRIPTION_KEYS, type StatementRisk } from '../utils/statementRisk';
import type { ExecutionReversibility } from '../utils/statementReversibility';
import { EnvironmentBadgeTag } from './EnvironmentBadge';
import { useLanguageStore } from '../stores/languageStore';

interface DestructiveStatementPromptProps {
  sql: string;
  risk: StatementRisk;
  connectionName: string;
  environment: ConnectionEnvironment;
  /** 这一批一共要执行几条；只有一条时不显示 */
  statementCount: number;
  /**
   * 这条语句会动到哪些对象，逐条列出。
   *
   * 只给 SQL 原文不够：一条 `ALTER TABLE t DROP COLUMN a, DROP COLUMN b`
   * 要从语句里数出「两列的数据都没了」，而这个框存在的理由正是让人**不必**
   * 现场读懂一条 SQL。自己写的语句给不出这个清单，所以是可选的。
   */
  impacts?: readonly string[];
  /** 执行完之后还能不能反悔。拦住人却不说这个，等于只拦不答 */
  reversibility: ExecutionReversibility;
  /** 方言名，用在「这条语句在哪个库上不受事务保护」里 */
  databaseLabel: string;
  onConfirm: () => void;
  /**
   * 这个框是否不受确认策略控制、每次都弹。对象树上的删除与清空是这样：
   * 那时再说「可在设置里调整」就是一句假话
   */
  alwaysAsks?: boolean;
  /** 自动提交时多给的一条路：先开事务再执行。包不住的语句上不提供 */
  onRunInTransaction?: () => void;
  onCancel: () => void;
}

/**
 * 执行前的确认。
 *
 * 自建而不用 plugin-dialog 的 confirm：那个只能给一段纯文本，而这里最需要
 * 让人看清的恰恰是三件带格式的信息——连的是哪个库、是什么环境、要跑的语句
 * 原文长什么样。
 *
 * 默认焦点落在「取消」上：这个框弹出来的时候，最可能的正确操作是停下。
 */
export function DestructiveStatementPrompt({
  sql,
  risk,
  connectionName,
  environment,
  statementCount,
  impacts,
  reversibility,
  databaseLabel,
  alwaysAsks = false,
  onConfirm,
  onRunInTransaction,
  onCancel
}: DestructiveStatementPromptProps) {
  const t = useLanguageStore((state) => state.t);
  const badge = environmentBadge(environment);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const isProduction = environment === 'production';

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const reversible = reversibility.kind === 'transactional';
  // 写成穷举的 switch：将来多一种可逆性，这里编译不过，而不是悄悄少印一行字
  const reversibilityNote = (() => {
    switch (reversibility.kind) {
      case 'transactional':
        return t('risk.reversible');
      case 'autocommit':
        return t('risk.irreversibleAutocommit');
      case 'atomic-batch':
        // 只有一条时「作为一个整体」「中途出错」都无从说起
        return statementCount > 1 ? t('risk.atomicBatch') : t('risk.committedOnRun');
      case 'not-transactional':
        return t('risk.irreversibleDialect', {
          keyword: reversibility.keyword,
          database: databaseLabel
        });
    }
  })();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="destructive-prompt-title"
      onClick={onCancel}
    >
      <div
        className="w-[520px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 py-4">
          <AlertTriangle
            size={20}
            className={clsx('mt-0.5 shrink-0', isProduction ? 'text-danger' : 'text-warning')}
          />
          <div className="min-w-0 flex-1">
            <h2 id="destructive-prompt-title" className="text-base font-medium text-fg">
              {t('risk.confirmTitle', { risk: t(RISK_DESCRIPTION_KEYS[risk]) })}
            </h2>

            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-fg-muted">
              <span>{t('risk.targetConnection')}</span>
              <span className="font-medium text-fg">{connectionName}</span>
              <EnvironmentBadgeTag environment={environment} />
            </p>

            {statementCount > 1 && (
              <p className="mt-1 text-sm text-fg-muted">
                {t('risk.batchNote', { count: statementCount })}
              </p>
            )}

            {impacts && impacts.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-sm text-danger">
                {impacts.map((impact) => (
                  <li key={impact}>{impact}</li>
                ))}
              </ul>
            )}

            <pre className="mt-2 max-h-40 overflow-auto rounded-control border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-fg select-text whitespace-pre-wrap break-words">
              {sql}
            </pre>

            {/* 被拦下来的人最想知道的下一件事：按下去之后还能不能反悔 */}
            <p
              className={clsx(
                'mt-2 flex items-start gap-1.5 text-sm',
                reversible ? 'text-fg-muted' : 'text-danger'
              )}
            >
              {reversible ? (
                <Undo2 size={14} className="mt-0.5 shrink-0" />
              ) : (
                <Ban size={14} className="mt-0.5 shrink-0" />
              )}
              <span>{reversibilityNote}</span>
            </p>

            {badge && (
              <p className="mt-2 text-xs text-fg-subtle">{t(badge.descriptionKey)}</p>
            )}
          </div>
        </div>

        {/* 提示和按钮上下排：多出「在事务里执行」之后并排会把提示挤成四行 */}
        <div className="border-t border-line bg-surface-sunken px-5 py-3">
          {/* 被打断的这一刻，正是最想知道「这东西能不能关掉」的时候 */}
          <p className="text-xs text-fg-subtle">
            {alwaysAsks ? t('prompt.alwaysAsks') : t('prompt.configurable')}
          </p>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            ref={cancelRef}
            onClick={onCancel}
            className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
          >
            {t('common.cancel')}
          </button>
          {reversibility.kind === 'autocommit' && onRunInTransaction && (
            <button
              type="button"
              onClick={onRunInTransaction}
              className="rounded-control border border-line-strong px-3 py-1.5 text-sm font-medium text-fg hover:bg-surface-hover"
            >
              {t('risk.runInTransaction')}
            </button>
          )}
          <button
            type="button"
            onClick={onConfirm}
            className={clsx(
              'rounded-control px-3 py-1.5 text-sm text-fg-on-solid',
              isProduction
                ? 'bg-danger-solid hover:opacity-90'
                : 'bg-warning text-fg-on-solid hover:opacity-90'
            )}
          >
            {t('risk.runAnyway')}
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}
