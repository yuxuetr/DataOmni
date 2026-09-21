import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';
import type { TranslationKey } from '../i18n/translate';
import { CELL_INPUT_KINDS, type CellInput, type CellInputKind } from '../utils/cellInput';

const KIND_LABEL: Record<CellInputKind, TranslationKey> = {
  value: 'cellInput.kind.value',
  null: 'cellInput.kind.null',
  default: 'cellInput.kind.default',
  expression: 'cellInput.kind.expression',
  unset: 'cellInput.kind.unset'
};

/** 空文本框的占位符。三种 kind 在框里都是空的，只有这句话能分开它们 */
const PLACEHOLDER: Record<'value' | 'expression' | 'unset', TranslationKey> = {
  value: 'cellInput.emptyString',
  expression: 'cellInput.expressionHint',
  unset: 'cellInput.unsetHint'
};

interface CellInputEditorProps {
  value: CellInput;
  onChange: (next: CellInput) => void;
  /** SQLite 的 UPDATE 没有 `SET 列 = DEFAULT`，那一档在那里不给选 */
  allowDefault?: boolean;
  autoFocus?: boolean;
  onCommit?: () => void;
  onCancel?: () => void;
  className?: string;
}

/**
 * 一个单元格要写什么。
 *
 * 文本框之外必须有这几档，因为它们在 SQL 里是不同的东西而在文本框里长得一样：
 * 空文本是**空字符串**不是 NULL，`CURRENT_TIMESTAMP` 当字面量存下的是那串字符
 * 本身，而「让数据库套用默认值」根本不是任何一个值。
 */
export function CellInputEditor({
  value,
  onChange,
  allowDefault = true,
  autoFocus = false,
  onCommit,
  onCancel,
  className
}: CellInputEditorProps) {
  const t = useLanguageStore((state) => state.t);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [menuOpen]);

  const kinds = CELL_INPUT_KINDS.filter((kind) => allowDefault || kind !== 'default');

  const pick = (kind: CellInputKind) => {
    setMenuOpen(false);
    switch (kind) {
      case 'value':
        // 从 NULL / 默认值切回来时给一个空文本，也就是空字符串——
        // 这正是这几档要分开的原因，不悄悄替用户改成 NULL
        onChange({ kind: 'value', value: value.kind === 'expression' ? value.sql : '' });
        return;
      case 'expression':
        onChange({ kind: 'expression', sql: value.kind === 'value' ? String(value.value) : '' });
        return;
      case 'default':
        onChange({ kind: 'default' });
        return;
      default:
        onChange({ kind: 'null' });
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onCommit?.();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancel?.();
    }
  };

  return (
    <div ref={rootRef} className={clsx('relative flex items-stretch gap-1', className)}>
      {value.kind === 'null' || value.kind === 'default' ? (
        <button
          type="button"
          // 也能点：NULL / DEFAULT 那一格长得像个输入框，用户的第一反应是点它
          // 然后开始打字，而不是先去找旁边那个箭头
          onClick={() => setMenuOpen((open) => !open)}
          className="flex min-w-0 flex-1 items-center rounded-control border border-dashed border-line-strong bg-surface-sunken px-2 py-1 text-left font-mono text-xs italic text-fg-subtle hover:bg-surface-hover"
          title={t(value.kind === 'null' ? 'cellInput.nullHint' : 'cellInput.defaultHint')}
        >
          {value.kind === 'null' ? 'NULL' : 'DEFAULT'}
        </button>
      ) : (
        <input
          type="text"
          autoFocus={autoFocus}
          value={value.kind === 'value' ? String(value.value) : value.kind === 'expression' ? value.sql : ''}
          onChange={(event) => onChange(
            value.kind === 'expression'
              ? { kind: 'expression', sql: event.target.value }
              // 没填过的格子一打字就成了一个值
              : { kind: 'value', value: event.target.value }
          )}
          onKeyDown={onKeyDown}
          // 空文本框有三种含义，只有占位符能分开它们：还没填、要写一个空字符串、
          // 还是一段待写的表达式。前两者在 `IS NULL` / `= ''` 下是两条不同的路
          placeholder={t(PLACEHOLDER[value.kind])}
          className={clsx(
            'min-w-0 flex-1 rounded-control border px-2 py-1 text-sm',
            value.kind === 'expression'
              // 表达式原样进语句，长得必须和字面量不一样，否则只会在事后
              // 从数据里发现存进去的是那串字符本身
              ? 'border-accent-line bg-accent-soft font-mono text-accent'
              : 'border-line-strong bg-surface text-fg'
          )}
        />
      )}

      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        title={t('cellInput.pickKind')}
        aria-label={t('cellInput.pickKind')}
        className="flex shrink-0 items-center rounded-control border border-line-strong px-1 text-fg-muted hover:bg-surface-hover"
      >
        <ChevronDown size={14} />
      </button>

      {menuOpen && (
        <div className="absolute right-0 top-full z-50 mt-1 w-40 rounded-control border border-line-strong bg-surface py-1 shadow-lg">
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => pick(kind)}
              className={clsx(
                'flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-surface-hover',
                kind === value.kind ? 'text-accent' : 'text-fg'
              )}
            >
              {t(KIND_LABEL[kind])}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
