import { Loader2, Undo2 } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';

interface PendingChangesBarProps {
  count: number;
  committing: boolean;
  /** 上一次提交失败时留下的那句话；变更仍然都在 */
  error: string | null;
  onPreview: () => void;
  onRevertAll: () => void;
  onCommit: () => void;
}

/**
 * 待提交变更的常驻提示。
 *
 * 改动不再一改一提交之后，用户需要一个始终看得见的地方告诉他「有东西还没写进去」。
 * 没有它，关掉标签页就等于悄悄丢掉一批改动。
 */
export function PendingChangesBar({
  count,
  committing,
  error,
  onPreview,
  onRevertAll,
  onCommit
}: PendingChangesBarProps) {
  const t = useLanguageStore((state) => state.t);
  if (count === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-accent-line bg-accent-soft px-4 py-2">
      <span className="text-xs font-medium text-accent">
        {t('changes.pending', { count })}
      </span>
      {error && (
        // 失败之后变更原样还在，这里说的是「上次为什么没成」，不是「没了」
        <span className="min-w-0 flex-1 truncate text-xs text-danger" title={error}>
          {error}
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onPreview}
          className="rounded-control border border-line-strong bg-surface px-2 py-1 text-xs text-fg hover:bg-surface-hover"
        >
          {t('changes.preview')}
        </button>
        <button
          type="button"
          onClick={onRevertAll}
          disabled={committing}
          className="flex items-center gap-1 rounded-control border border-line-strong bg-surface px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover disabled:opacity-40"
        >
          <Undo2 size={12} />
          {t('changes.revertAll')}
        </button>
        <button
          type="button"
          onClick={onCommit}
          disabled={committing}
          className="flex items-center gap-1 rounded-control bg-accent px-2.5 py-1 text-xs text-fg-on-accent hover:bg-accent-hover disabled:opacity-40"
        >
          {committing && <Loader2 size={12} className="animate-spin" />}
          {t('changes.commit', { count })}
        </button>
      </div>
    </div>
  );
}
