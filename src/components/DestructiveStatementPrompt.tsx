import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { clsx } from 'clsx';
import type { ConnectionEnvironment } from '../contracts';
import { environmentBadge } from '../contracts/environment';
import { describeStatementRisk, type StatementRisk } from '../utils/statementRisk';
import { EnvironmentBadgeTag } from './EnvironmentBadge';

interface DestructiveStatementPromptProps {
  sql: string;
  risk: StatementRisk;
  connectionName: string;
  environment: ConnectionEnvironment;
  /** 这一批一共要执行几条；只有一条时不显示 */
  statementCount: number;
  onConfirm: () => void;
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
  onConfirm,
  onCancel
}: DestructiveStatementPromptProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const isProduction = environment === 'production';

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

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
              执行前确认：{describeStatementRisk(risk)}
            </h2>

            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-fg-muted">
              <span>目标连接</span>
              <span className="font-medium text-fg">{connectionName}</span>
              <EnvironmentBadgeTag environment={environment} />
            </p>

            {statementCount > 1 && (
              <p className="mt-1 text-sm text-fg-muted">
                本次共执行 {statementCount} 条语句，下面是其中风险最高的一条。
              </p>
            )}

            <pre className="mt-2 max-h-40 overflow-auto rounded-control border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-fg select-text whitespace-pre-wrap break-words">
              {sql}
            </pre>

            {environmentBadge(environment) && (
              <p className="mt-2 text-xs text-fg-subtle">
                {environmentBadge(environment)?.description}
              </p>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-line bg-surface-sunken px-5 py-3">
          <button
            type="button"
            ref={cancelRef}
            onClick={onCancel}
            className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
          >
            取消
          </button>
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
            仍然执行
          </button>
        </div>
      </div>
    </div>
  );
}
