import React from 'react';
import { clsx } from 'clsx';

/**
 * 文本框共用的一组属性：**关掉系统的自动大写与自动更正**。
 *
 * macOS 会替 WebView 里的文本框做这件事，而应用里的文本框填的都是**原样
 * 要用**的东西：主机名、用户名、路径、筛选关键字，以及——最要紧的——
 * 表格里那一格要写回数据库的值。首字母被改掉之后，SSH 报的是一句
 * 「认证失败」，筛选是一条都匹配不上，而写库那一条根本不报错：存进去的
 * 和敲进去的不是一个东西，没有任何地方会说出来。
 *
 * 这三行原先零散写在几个格子上——有人踩过，只修了当时那一处。抽出来是为了
 * 让下一个文本框不必再想起这件事，`formInputs.test.ts` 那道门负责提醒。
 */
export const PLAIN_TEXT_INPUT = {
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false
} as const;

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
