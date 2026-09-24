import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';

export interface ConfirmOptions {
  title: string;
  message: string;
  /** 确认按钮上的字；不给就是「确定」 */
  confirmLabel?: string;
  /** 会丢东西的操作：确认按钮画成危险色 */
  destructive?: boolean;
}

interface ConfirmPromptProps extends ConfirmOptions {
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 两个按钮的确认框。
 *
 * 不用 `@tauri-apps/plugin-dialog` 的 `confirm`：打包版在 macOS 上它不弹框，
 * Promise 也不回来（2026-09-24 实测，侧边栏的「删除连接」因此一直删不掉）。
 * 应用里别的确认框本来就是自己画的（`CloseTabPrompt`、`DestructiveStatementPrompt`），
 * 这一个补上「只要是或否」的那种。`dialogUsage.test.ts` 守着不许再引那个 `confirm`。
 *
 * 默认焦点在「取消」上，Esc 与点遮罩都是取消。
 */
export function ConfirmPrompt({
  title,
  message,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel
}: ConfirmPromptProps) {
  const t = useLanguageStore((state) => state.t);
  const cancelRef = useRef<HTMLButtonElement>(null);

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
      aria-labelledby="confirm-prompt-title"
      onClick={onCancel}
    >
      <div
        className="w-[440px] max-w-[calc(100vw-2rem)] rounded-panel bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-5">
          <AlertTriangle size={20} className={destructive ? 'mt-0.5 shrink-0 text-danger' : 'mt-0.5 shrink-0 text-warning'} />
          <div className="min-w-0">
            <h2 id="confirm-prompt-title" className="text-base font-medium text-fg">{title}</h2>
            <p className="mt-2 break-words text-sm text-fg-muted">{message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 rounded-b-control-panel border-t border-line bg-surface-sunken px-5 py-3">
          <button
            type="button"
            ref={cancelRef}
            onClick={onCancel}
            className="rounded-control border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={destructive
              ? 'rounded-control bg-danger-solid px-3 py-1.5 text-sm text-fg-on-solid hover:opacity-90'
              : 'rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:bg-accent-hover'}
          >
            {confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * `await ask({...})` 的写法：调用处照旧按顺序写「问 → 做」，框由返回的 `prompt`
 * 画出来，调用方把它放进自己的 JSX 里。
 */
export function useConfirmPrompt(): {
  ask: (options: ConfirmOptions) => Promise<boolean>;
  prompt: React.ReactNode;
} {
  const [pending, setPending] = useState<
    { options: ConfirmOptions; resolve: (confirmed: boolean) => void } | null
  >(null);

  const ask = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    setPending({ options, resolve });
  }), []);

  const settle = (confirmed: boolean) => {
    pending?.resolve(confirmed);
    setPending(null);
  };

  const prompt = pending ? (
    <ConfirmPrompt
      {...pending.options}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;

  return { ask, prompt };
}
