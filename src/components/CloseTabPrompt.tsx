import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';

export type CloseTabChoice = 'retain' | 'discard' | 'cancel';

interface CloseTabPromptProps {
  tabTitle: string;
  onChoose: (choice: CloseTabChoice) => void;
}

/**
 * 关闭带草稿的 SQL 标签前的三选一。
 *
 * 自建而不用 `@tauri-apps/plugin-dialog` 的 `confirm`：那个只有确定/取消
 * 两个按钮，装不下「保留草稿」这个第三种结果。
 */
export function CloseTabPrompt({ tabTitle, onChoose }: CloseTabPromptProps) {
  const t = useLanguageStore((state) => state.t);
  const retainButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    retainButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Esc 等同取消：最保守的结果，不关也不丢
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
      aria-labelledby="close-tab-prompt-title"
      onClick={() => onChoose('cancel')}
    >
      <div
        className="w-[440px] max-w-[calc(100vw-2rem)] bg-surface rounded-panel shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-5">
          <AlertTriangle size={20} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0">
            <h2 id="close-tab-prompt-title" className="text-base font-medium text-fg">
              {t('tab.closeTitle', { title: tabTitle })}
            </h2>
            <p className="mt-2 text-sm text-fg-muted">
              {t('tab.unsavedDraft')}
            </p>
            <p className="mt-1 text-sm text-fg-muted">
              {t('tab.keepDraftHint')}
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 bg-surface-sunken border-t border-line rounded-b-control-panel">
          <button
            type="button"
            onClick={() => onChoose('cancel')}
            className="px-3 py-1.5 text-sm text-fg bg-surface border border-line-strong rounded-control hover:bg-surface-hover"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onChoose('discard')}
            className="px-3 py-1.5 text-sm text-danger bg-surface border border-danger-line rounded-control hover:bg-danger-soft"
          >
            {t('tab.discard')}
          </button>
          <button
            type="button"
            ref={retainButtonRef}
            onClick={() => onChoose('retain')}
            className="px-3 py-1.5 text-sm text-fg-on-accent bg-accent rounded-control hover:bg-accent-hover"
          >
            {t('tab.keepDraft')}
          </button>
        </div>
      </div>
    </div>
  );
}
