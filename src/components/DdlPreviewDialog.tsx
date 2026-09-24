import { useEffect } from 'react';
import { AlertTriangle, Ban, Loader2, X } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';
import type { TranslationKey } from '../i18n/translate';
import type { DdlAction, DdlPlan } from '../utils/tableDdl';
import type { SqlIdentifierDialect } from '../utils/sqlIdentifiers';

interface DdlPreviewDialogProps {
  plan: DdlPlan;
  dialect: SqlIdentifierDialect;
  /** 改表名被拆成了单独一条（TiDB） */
  renameApart?: boolean;
  running: boolean;
  error: string | null;
  onApply: () => void;
  onClose: () => void;
}

/** 写成完整的 Record：新增一种动作时这里编译不过 */
const ACTION_KEYS: Record<DdlAction, TranslationKey> = {
  'add-column': 'ddl.action.add-column',
  'drop-column': 'ddl.action.drop-column',
  'rename-column': 'ddl.action.rename-column',
  'change-type': 'ddl.action.change-type',
  'change-nullability': 'ddl.action.change-nullability',
  'change-default': 'ddl.action.change-default'
};

/**
 * 按下执行之前，这次改结构到底会发出哪几条语句。
 *
 * 三块内容各回答一个不同的问题，所以不合并：**会丢什么**（删掉的列，连数据
 * 一起没）、**会跑什么**（语句原文），以及**哪几项做不到**（方言限制，带理由）。
 * 只给一段 SQL 的话，第一件事要靠读语句自己看出来，第三件事根本看不出来——
 * 用户会以为他勾掉的那个「可空」已经改了。
 */
export function DdlPreviewDialog({
  plan,
  dialect,
  renameApart = false,
  running,
  error,
  onApply,
  onClose
}: DdlPreviewDialogProps) {
  const t = useLanguageStore((state) => state.t);

  // 点遮罩已经会把填的内容丢掉，Esc 却不动——两条关闭路径得一致，否则人会
  // 以为这个弹窗「关不掉」。跑着的时候不关：那一下会让人以为动作被取消了，
  // 而语句已经发出去了
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [running, onClose]);

  // MySQL 的 MODIFY / CHANGE 会重述整段定义，没写进语句的属性就此消失。
  // 这句提示只在真的发了这种语句时出现
  const restates = dialect === 'mysql'
    && plan.statements.some((sql) => sql.includes('MODIFY COLUMN') || sql.includes('CHANGE COLUMN'));
  // Oracle 的 DDL 逐条隐式提交：只有一条时它本身是原子的，不用多说
  const commitsEach = dialect === 'oracle' && plan.statements.length > 1;
  // 只有改表名之外还有别的改动时才真的拆成了两条
  const splitRename = renameApart && plan.statements.length > 1
    && plan.statements.some((sql) => sql.includes('RENAME TO'));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ddl-preview-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[640px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <h2 id="ddl-preview-title" className="text-base font-medium text-fg">
              {t('ddl.previewTitle')}
            </h2>
            <p className="mt-0.5 text-xs text-fg-muted">
              {t('ddl.statementCount', { count: plan.statements.length })}
            </p>
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

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {plan.impacts.length > 0 && (
            <section className="rounded-control border border-danger-line bg-danger-soft px-3 py-2">
              <h3 className="flex items-center gap-1.5 text-sm font-medium text-danger">
                <AlertTriangle size={14} />
                {t('ddl.impactsTitle')}
              </h3>
              <ul className="mt-1 space-y-0.5 text-sm text-danger">
                {plan.impacts.map((impact) => (
                  <li key={impact.column}>
                    {t('ddl.impact.dropColumn', { column: impact.column })}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {plan.statements.length > 0 ? (
            <ol className="space-y-2">
              {plan.statements.map((sql, index) => (
                <li key={sql} className="flex gap-2">
                  <span className="mt-2 w-4 shrink-0 text-right font-mono text-xs text-fg-subtle">
                    {index + 1}
                  </span>
                  <pre className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words rounded-control border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-fg">
                    {sql}
                  </pre>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-fg-muted">{t('ddl.noChanges')}</p>
          )}

          {restates && <p className="text-xs text-fg-subtle">{t('ddl.mysqlRestates')}</p>}
          {splitRename && <p className="text-xs text-fg-subtle">{t('ddl.tidbRenameApart')}</p>}
          {commitsEach && (
            <p className="text-xs text-fg-subtle">
              {t('ddl.oracleCommitsEach', { count: plan.statements.length })}
            </p>
          )}

          {plan.refusals.length > 0 && (
            <section className="rounded-control border border-warning-line bg-warning-soft px-3 py-2">
              <h3 className="flex items-center gap-1.5 text-sm font-medium text-warning">
                <Ban size={14} />
                {t('ddl.refusalsTitle')}
              </h3>
              <ul className="mt-1 space-y-1 text-sm text-fg">
                {plan.refusals.map((refusal) => (
                  <li key={`${refusal.column}:${refusal.action}`}>
                    <span className="font-medium">{refusal.column}</span>
                    <span className="text-fg-muted"> · {t(ACTION_KEYS[refusal.action])}</span>
                    <p className="text-xs text-fg-muted">{t(refusal.reason)}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {error && <p className="text-sm text-danger">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-sunken px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={running || plan.statements.length === 0}
            className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
          >
            {running && <Loader2 size={14} className="animate-spin" />}
            {running ? t('ddl.applying') : t('ddl.apply')}
          </button>
        </div>
      </div>
    </div>
  );
}
