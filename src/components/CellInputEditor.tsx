import { useEffect, useRef, useState } from 'react';
import { PLAIN_TEXT_INPUT } from './FormControls';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';
import type { TranslationKey } from '../i18n/translate';
import { CELL_INPUT_KINDS, type CellInput, type CellInputKind } from '../utils/cellInput';
import {
  binaryLiteral,
  columnEditorKind,
  databaseTextToPickerValue,
  isCompleteHex,
  normalizeHex,
  pickerValueToDatabaseText,
  prettyJson,
  type ColumnEditorKind
} from '../utils/columnEditors';
import type { SqlIdentifierDialect } from '../utils/sqlIdentifiers';

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
  /** 列的声明类型，决定值那一格用哪种编辑器 */
  dataType?: string;
  /** 二进制字面量与 bytea 的写法按方言分 */
  dialect?: SqlIdentifierDialect;
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
  dataType = '',
  dialect = 'sqlite',
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
  const editor = columnEditorKind(dataType, dialect);

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
    <div ref={rootRef} className={clsx('relative flex items-start gap-1', className)}>
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
        <ValueField
          value={value}
          onChange={onChange}
          editor={editor}
          dialect={dialect}
          autoFocus={autoFocus}
          onKeyDown={onKeyDown}
        />
      )}

      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        title={t('cellInput.pickKind')}
        aria-label={t('cellInput.pickKind')}
        // 顶端对齐：JSON 的多行框和二进制的两行控件下面，一根从头拉到尾的
        // 细长箭头既难点也难看
        className="flex shrink-0 items-center self-start rounded-control border border-line-strong px-1 py-[7px] text-fg-muted hover:bg-surface-hover"
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

interface ValueFieldProps {
  value: Extract<CellInput, { kind: 'value' | 'expression' | 'unset' }>;
  onChange: (next: CellInput) => void;
  editor: ColumnEditorKind;
  dialect: SqlIdentifierDialect;
  autoFocus: boolean;
  onKeyDown: (event: React.KeyboardEvent) => void;
}

/**
 * 「值」那一格。按列的类型换控件，但**文本永远是权威**：控件只往文本里写，
 * 不替文本做解释。日期选择器认不出的值就让它空着，而不是把一个认不出的
 * 时间戳显示成某个看似合理的日期，再在保存时把原值改掉。
 *
 * 表达式档一律用等宽文本框：它原样进语句，长得必须和字面量不一样。
 */
function ValueField({ value, onChange, editor, dialect, autoFocus, onKeyDown }: ValueFieldProps) {
  const t = useLanguageStore((state) => state.t);
  const text = value.kind === 'value' ? String(value.value) : value.kind === 'expression' ? value.sql : '';
  const setText = (next: string) => onChange(
    value.kind === 'expression' ? { kind: 'expression', sql: next } : { kind: 'value', value: next }
  );

  if (value.kind === 'expression') {
    return (
      <input
        type="text"
        autoFocus={autoFocus}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('cellInput.expressionHint')}
        className="min-w-0 flex-1 rounded-control border border-accent-line bg-accent-soft px-2 py-1 font-mono text-sm text-accent"
        {...PLAIN_TEXT_INPUT}
      />
    );
  }

  if (editor === 'boolean') {
    // 两个按钮而不是下拉：真假只有两个值，下拉要点两次才看得到第二个。
    // 第三种情况 NULL 由外面那个档位管，不挤进这里
    return (
      <div className="flex min-w-0 flex-1 gap-1">
        {['true', 'false'].map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange({ kind: 'value', value: option === 'true' })}
            className={clsx(
              'flex-1 rounded-control border px-2 py-1 font-mono text-xs',
              String(text) === option
                ? 'border-accent-line bg-accent-soft text-accent'
                : 'border-line-strong bg-surface text-fg-muted hover:bg-surface-hover'
            )}
          >
            {option.toUpperCase()}
          </button>
        ))}
      </div>
    );
  }

  if (editor === 'json') {
    const invalid = text.trim() !== '' && prettyJson(text) === null;
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <textarea
          autoFocus={autoFocus}
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t(value.kind === 'unset' ? 'cellInput.unsetHint' : 'cellInput.emptyString')}
          className={clsx(
            'min-w-0 flex-1 rounded-control border px-2 py-1 font-mono text-xs',
            // 无效 JSON 仍然可以提交——列可能真的存着一段不是 JSON 的文本，
            // 而数据库自己会拒。这里只说一声，不挡路
            invalid ? 'border-danger-line bg-danger-soft text-fg' : 'border-line-strong bg-surface text-fg'
          )}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setText(prettyJson(text) ?? text)}
            disabled={invalid || text.trim() === ''}
            className="rounded-control border border-line-strong px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-surface-hover disabled:opacity-40"
          >
            {t('cellInput.formatJson')}
          </button>
          {invalid && <span className="text-[11px] text-danger">{t('cellInput.invalidJson')}</span>}
        </div>
      </div>
    );
  }

  if (editor === 'binary') {
    const complete = isCompleteHex(text);
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          type="text"
          autoFocus={autoFocus}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('cellInput.hexHint')}
          className={clsx(
            'min-w-0 flex-1 rounded-control border px-2 py-1 font-mono text-xs',
            complete ? 'border-line-strong bg-surface text-fg' : 'border-danger-line bg-danger-soft text-fg'
          )}
          {...PLAIN_TEXT_INPUT}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            // 二进制只能走表达式：绑定的是一串十六进制文本，存进 BLOB 得到的
            // 是那串字符的字节，长度正好翻倍而语句不报错
            onClick={() => onChange({ kind: 'expression', sql: binaryLiteral(text, dialect) })}
            disabled={!complete}
            className="rounded-control border border-line-strong px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-surface-hover disabled:opacity-40"
          >
            {complete
              // 位数是奇数时算出来会是「1.5 字节」——一句没有意义的话，
              // 哪怕按钮是灰的也不该说
              ? t('cellInput.asBinary', { count: normalizeHex(text).length / 2 })
              : t('cellInput.asBinaryPending')}
          </button>
          {!complete && <span className="text-[11px] text-danger">{t('cellInput.invalidHex')}</span>}
        </div>
      </div>
    );
  }

  if (editor === 'date' || editor === 'time' || editor === 'datetime') {
    const pickerValue = databaseTextToPickerValue(text, editor);
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {/* 文本框独占一行：它才是权威的那一份，而 `2024-01-01 12:30:45+08`
            和选择器挤在一行里会被截成 `2024-01-01 12:3` */}
        <input
          type="text"
          autoFocus={autoFocus}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t(value.kind === 'unset' ? 'cellInput.unsetHint' : 'cellInput.emptyString')}
          className="min-w-0 rounded-control border border-line-strong bg-surface px-2 py-1 font-mono text-xs text-fg"
          {...PLAIN_TEXT_INPUT}
        />
        <div className="flex items-center gap-1">
          {/* 选择器只往文本里写。认不出的原值（`0000-00-00`、带时区的、
              带小数秒的）它会空着，而文本框里那一份始终原样保留 */}
          <input
            type={editor === 'date' ? 'date' : editor === 'time' ? 'time' : 'datetime-local'}
            step={editor === 'date' ? undefined : 1}
            value={pickerValue}
            onChange={(event) => setText(pickerValueToDatabaseText(event.target.value))}
            title={t('cellInput.pickDateTime')}
            className="min-w-0 flex-1 rounded-control border border-line-strong bg-surface px-1 py-0.5 text-xs text-fg-muted"
          />
          <button
            type="button"
            onClick={() => onChange({ kind: 'expression', sql: 'CURRENT_TIMESTAMP' })}
            title={t('cellInput.nowHint')}
            className="shrink-0 rounded-control border border-line-strong px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-surface-hover"
          >
            {t('cellInput.now')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <input
      type="text"
      autoFocus={autoFocus}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={onKeyDown}
      // 空文本框有两种含义，只有占位符能分开它们：还没填，还是要写一个空字符串
      placeholder={t(PLACEHOLDER[value.kind])}
      className="min-w-0 flex-1 rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-fg"
      {...PLAIN_TEXT_INPUT}
    />
  );
}
