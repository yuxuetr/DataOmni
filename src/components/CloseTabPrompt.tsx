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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="close-tab-prompt-title"
      onClick={() => onChoose('cancel')}
    >
      <div
        className="w-[440px] max-w-[calc(100vw-2rem)] bg-white rounded-lg shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-5">
          <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <h2 id="close-tab-prompt-title" className="text-base font-medium text-gray-900">
              关闭「{tabTitle}」
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              这个标签有尚未保存的 SQL 草稿。
            </p>
            <p className="mt-1 text-sm text-gray-600">
              选择「保留草稿」会关闭标签但把草稿留在「最近关闭」里，之后可以重新打开；
              选择「丢弃」则永久删除。
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 bg-gray-50 border-t border-gray-200 rounded-b-lg">
          <button
            type="button"
            onClick={() => onChoose('cancel')}
            className="px-3 py-1.5 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onChoose('discard')}
            className="px-3 py-1.5 text-sm text-red-700 bg-white border border-red-300 rounded-md hover:bg-red-50"
          >
            丢弃
          </button>
          <button
            type="button"
            ref={retainButtonRef}
            onClick={() => onChoose('retain')}
            className="px-3 py-1.5 text-sm text-white bg-blue-600 rounded-md hover:bg-blue-700"
          >
            保留草稿
          </button>
        </div>
      </div>
    </div>
  );
}
