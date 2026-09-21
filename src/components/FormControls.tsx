import React from 'react';
import { clsx } from 'clsx';

/**
 * 对话框里那几个重复的表单件。
 *
 * 从导出对话框里搬出来的，因为导入向导要用同样的一套——「标签 + 控件」
 * 的对齐宽度、分段按钮的选中配色这类东西一旦两处各写一份，就会慢慢长歪。
 */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-20 shrink-0 pt-1 text-xs text-fg-muted">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled = false
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  /** 选项此刻改不动时要按得下去也看得出来——看着能点却什么都没发生更糟 */
  disabled?: boolean;
}) {
  return (
    <div className={clsx('inline-flex rounded-control border border-line p-0.5', disabled && 'opacity-50')}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={clsx(
            'rounded-[0.25rem] px-2.5 py-1 text-xs transition-colors',
            option.value === value
              ? 'bg-accent text-fg-on-accent'
              : 'text-fg-muted hover:bg-surface-hover',
            disabled && 'cursor-not-allowed'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        className="mt-0.5 accent-accent"
      />
      <span className="min-w-0">
        <span className="text-xs text-fg">{label}</span>
        {hint && <span className="block text-xs text-fg-subtle">{hint}</span>}
      </span>
    </label>
  );
}
