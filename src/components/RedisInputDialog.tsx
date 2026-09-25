import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { PLAIN_TEXT_INPUT } from './FormControls';
import { useLanguageStore } from '../stores/languageStore';

interface RedisInputDialogProps {
  title: string;
  label: string;
  initial: string;
  hint?: string;
  placeholder?: string;
  confirmLabel: string;
  /** 不合规矩时返回要显示的那句话；合规矩返回 null */
  validate: (text: string) => string | null;
  /** 抛出的错误原样显示，对话框留着——改一下再试 */
  onSubmit: (text: string) => Promise<void>;
  onClose: () => void;
}

/** 键浏览页上要填一格的两件事（改名、设过期）共用的小对话框 */
export function RedisInputDialog({
  title,
  label,
  initial,
  hint,
  placeholder,
  confirmLabel,
  validate,
  onSubmit,
  onClose
}: RedisInputDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const [text, setText] = useState(initial);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

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

  const problem = validate(text);

  const submit = async () => {
    if (problem || running) return;
    setRunning(true);
    setError(null);
    try {
      await onSubmit(text);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="redis-input-title"
      onClick={() => !running && onClose()}
    >
      <div
        className="flex w-[480px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="redis-input-title" className="text-base font-medium text-fg">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded-control p-1 text-fg-muted hover:bg-surface-hover hover:text-fg"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>
        <div className="space-y-2 px-5 py-4">
          <label className="block space-y-1">
            <span className="text-xs text-fg-muted">{label}</span>
            <input
              ref={inputRef}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={placeholder}
              className="w-full rounded-control border border-line bg-surface px-2 py-1.5 font-mono text-[13px] text-fg placeholder:text-fg-subtle"
              {...PLAIN_TEXT_INPUT}
            />
          </label>
          {hint && <p className="text-xs text-fg-subtle">{hint}</p>}
          {problem && text !== initial && <p className="text-xs text-danger">{problem}</p>}
          {error && <p className="select-text text-sm text-danger">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-sunken px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={problem !== null || running}
            className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
          >
            {running && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
