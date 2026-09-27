import { Loader2 } from 'lucide-react';
import type { DesignMessages } from '../utils/aiDesign';
import { useLanguageStore } from '../stores/languageStore';
import { PLAIN_TEXT_INPUT } from './FormControls';

interface AiRequestPanelProps {
  requirement: string;
  onRequirementChange: (requirement: string) => void;
  /** 已经有一份设计：按钮变成「按要求修改」，多一个「清空设计」 */
  hasDraft: boolean;
  configured: boolean;
  running: boolean;
  onGenerate: () => void;
  onDiscard: () => void;
  sent: DesignMessages | null;
  error: string | null;
  rawReply: string | null;
}

/**
 * 设计页左上那一块：需求、生成 / 修改、发出去的原文、出错时的原始回复。
 * 关系库与 MongoDB 两种设计页共用——发什么、怎么读回复各不相同，这一块完全一样
 */
export function AiRequestPanel({
  requirement,
  onRequirementChange,
  hasDraft,
  configured,
  running,
  onGenerate,
  onDiscard,
  sent,
  error,
  rawReply
}: AiRequestPanelProps) {
  const t = useLanguageStore((state) => state.t);
  return (
    <>
      {!configured && (
        <p className="rounded-control border border-warning-line bg-warning-soft px-3 py-2 text-xs text-warning">
          {t('aiDesign.notConfigured')}
        </p>
      )}

      <textarea
        value={requirement}
        onChange={(event) => onRequirementChange(event.target.value)}
        placeholder={hasDraft ? t('aiDesign.revisePlaceholder') : t('aiDesign.requirementPlaceholder')}
        aria-label={t('aiDesign.requirement')}
        rows={4}
        className="w-full resize-y rounded-control border border-line-strong bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        {...PLAIN_TEXT_INPUT}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onGenerate}
          disabled={!configured || running || requirement.trim() === ''}
          className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
        >
          {running && <Loader2 size={14} className="animate-spin" />}
          {hasDraft ? t('aiDesign.revise') : t('aiDesign.generate')}
        </button>
        {hasDraft && (
          <button
            type="button"
            onClick={onDiscard}
            disabled={running}
            className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover disabled:opacity-50"
          >
            {t('aiDesign.discard')}
          </button>
        )}
      </div>

      {sent && (
        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer select-none">{t('aiDesign.sent')}</summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-control border border-line bg-surface-sunken p-2 font-mono text-fg select-text">
            {`[system]\n${sent.system}\n\n[user]\n${sent.user}`}
          </pre>
        </details>
      )}

      {error && (
        <div className="rounded-control border border-danger-line bg-danger-soft px-3 py-2 text-xs text-danger">
          <p className="break-words">{error}</p>
          {rawReply && (
            <details className="mt-1">
              <summary className="cursor-pointer select-none">{t('aiDesign.rawReply')}</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono select-text">{rawReply}</pre>
            </details>
          )}
        </div>
      )}
    </>
  );
}
