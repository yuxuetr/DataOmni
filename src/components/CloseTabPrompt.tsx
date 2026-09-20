import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';

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
              关闭「{tabTitle}」
            </h2>
            <p className="mt-2 text-sm text-fg-muted">
              这个标签有尚未保存的 SQL 草稿。
            </p>
            <p className="mt-1 text-sm text-fg-muted">
              选择「保留草稿」会关闭标签但把草稿留在「最近关闭」里，之后可以重新打开；
              选择「丢弃」则永久删除。
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 bg-surface-sunken border-t border-line rounded-b-control-panel">
          <button
            type="button"
            onClick={() => onChoose('cancel')}
            className="px-3 py-1.5 text-sm text-fg bg-surface border border-line-strong rounded-control hover:bg-surface-hover"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onChoose('discard')}
            className="px-3 py-1.5 text-sm text-danger bg-surface border border-danger-line rounded-control hover:bg-danger-soft"
          >
            丢弃
          </button>
          <button
            type="button"
            ref={retainButtonRef}
            onClick={() => onChoose('retain')}
            className="px-3 py-1.5 text-sm text-fg-on-accent bg-accent rounded-control hover:bg-accent-hover"
          >
            保留草稿
          </button>
        </div>
      </div>
    </div>
  );
}
