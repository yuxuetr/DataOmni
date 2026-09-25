import { useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { PLAIN_TEXT_INPUT } from './FormControls';
import { useLanguageStore } from '../stores/languageStore';
import { isRedisScore as validScore, type RedisBytes, type RedisValue } from '../utils/redisKeys';

type Translate = ReturnType<typeof useLanguageStore.getState>['t'];

/** 与后端 `ElementChangeRequest` 一致；字节串都是 base64 */
export type ElementChange =
  | { kind: 'hashSet'; field: string; expected: string | null; value: string }
  | { kind: 'hashDelete'; field: string }
  | { kind: 'listSet'; index: number; expected: string; value: string }
  | { kind: 'listDelete'; index: number; expected: string }
  | { kind: 'listPush'; value: string; head: boolean }
  | { kind: 'setAdd'; member: string }
  | { kind: 'setDelete'; member: string }
  | { kind: 'zsetSet'; member: string; expected: string | null; score: string }
  | { kind: 'zsetDelete'; member: string };

type Collection = Extract<RedisValue, { kind: 'hash' | 'list' | 'set' | 'zset' }>;

interface RedisValueTableProps {
  value: Collection;
  /** 文字 → 发出去的 base64（UTF-8） */
  encode: (text: string) => string;
  /** 发一条改动；成功后由调用方重读。抛出的错误由调用方显示 */
  onChange: (change: ElementChange, destructive?: string) => Promise<void>;
}


const cellClass = 'border-b border-line px-2 py-1 align-baseline leading-5';
const headClass = 'border-b border-line px-2 py-1 text-left text-xs font-medium text-fg';
const inputClass = 'min-w-0 flex-1 rounded-control border bg-surface px-2 py-0.5 font-mono text-[13px] text-fg outline-none focus:ring-2';
/** 两种状态各一组：同时写两种 ring 颜色时谁赢取决于样式表里的次序 */
const inputState = (valid: boolean) => (valid ? 'border-line-strong focus:ring-accent' : 'border-danger-line focus:ring-danger');
const iconButton = 'rounded-control p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg disabled:opacity-40';

function Bytes({ bytes }: { bytes: RedisBytes }) {
  return (
    <span className={clsx('select-text whitespace-pre-wrap break-all font-mono text-[13px]', bytes.binary ? 'text-warning' : 'text-fg')}>
      {bytes.text}
    </span>
  );
}

/**
 * hash / list / set / zset 的表，可以改。改的是一格：点铅笔变成输入框，回车或对勾提交。
 * 二进制的元素只给删不给改——框里是转义过的文字，写回去就不是原来的字节了
 */
export function RedisValueTable({ value, encode, onChange }: RedisValueTableProps) {
  const t = useLanguageStore((state) => state.t);
  // 正在改哪一行（hash 的字段 / list 的下标 / zset 的成员），和框里的字
  const [editing, setEditing] = useState<{ row: string; draft: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /** 成功与否告诉调用方：失败时（调用方已经显示了原因）框里的字要留着，改一下再试 */
  const submit = async (change: ElementChange, destructive?: string): Promise<boolean> => {
    setBusy(true);
    try {
      await onChange(change, destructive);
      setEditing(null);
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  };

  const editor = (row: string, onSubmit: (draft: string) => void, valid: (draft: string) => boolean = () => true) => {
    if (editing?.row !== row) return null;
    const ok = valid(editing.draft);
    return (
      <span className="flex items-center gap-1">
        <input
          autoFocus
          value={editing.draft}
          onChange={(event) => setEditing({ row, draft: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && ok) {
              event.preventDefault();
              onSubmit(editing.draft);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setEditing(null);
            }
          }}
          aria-label={t('redis.element.editing')}
          className={clsx(inputClass, inputState(ok))}
          {...PLAIN_TEXT_INPUT}
        />
        <button type="button" disabled={busy || !ok} onClick={() => onSubmit(editing.draft)} className={iconButton} aria-label={t('redis.action.save')}>
          <Check size={14} />
        </button>
        <button type="button" disabled={busy} onClick={() => setEditing(null)} className={iconButton} aria-label={t('common.cancel')}>
          <X size={14} />
        </button>
      </span>
    );
  };

  const actions = (row: string, current: string, editable: boolean, remove: () => void) => (
    <td className={clsx(cellClass, 'w-16 whitespace-nowrap text-right')}>
      <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          disabled={busy || !editable}
          title={editable ? t('redis.action.edit') : t('redis.element.binaryReadOnly')}
          aria-label={t('redis.action.edit')}
          onClick={() => setEditing({ row, draft: current })}
          className={iconButton}
        >
          <Pencil size={13} />
        </button>
        <button type="button" disabled={busy} onClick={remove} className={clsx(iconButton, 'hover:text-danger')} aria-label={t('redis.action.delete')}>
          <Trash2 size={13} />
        </button>
      </span>
    </td>
  );

  switch (value.kind) {
    case 'hash':
      return (
        <>
          <table className="w-full table-auto border-collapse">
            <thead className="bg-surface-sunken">
              <tr><th className={headClass}>{t('redis.column.field')}</th><th className={headClass}>{t('redis.column.value')}</th><th className="w-16 border-b border-line" /></tr>
            </thead>
            <tbody>
              {value.entries.map(([field, item], index) => (
                <tr key={`${field.raw}-${index}`} className="group">
                  <td className={cellClass}><Bytes bytes={field} /></td>
                  <td className={cellClass}>
                    {editor(field.raw, (draft) => void submit({ kind: 'hashSet', field: field.raw, expected: item.raw, value: encode(draft) }))
                      ?? <Bytes bytes={item} />}
                  </td>
                  {actions(field.raw, item.text, !item.binary, () => void submit({ kind: 'hashDelete', field: field.raw }, t('redis.element.deleteField', { name: field.text })))}
                </tr>
              ))}
            </tbody>
          </table>
          <AddRow
            t={t}
            busy={busy}
            fields={[{ label: t('redis.column.field') }, { label: t('redis.column.value') }]}
            onAdd={([field, item]) => submit({ kind: 'hashSet', field: encode(field), expected: null, value: encode(item) })}
          />
        </>
      );
    case 'list':
      return (
        <>
          <table className="w-full table-auto border-collapse">
            <thead className="bg-surface-sunken">
              <tr><th className={clsx(headClass, 'w-16')}>{t('redis.column.index')}</th><th className={headClass}>{t('redis.column.value')}</th><th className="w-16 border-b border-line" /></tr>
            </thead>
            <tbody>
              {value.items.map((item, position) => {
                const index = value.offset + position;
                return (
                  <tr key={index} className="group">
                    <td className={clsx(cellClass, 'font-mono text-xs text-fg-subtle')}>{index}</td>
                    <td className={cellClass}>
                      {editor(String(index), (draft) => void submit({ kind: 'listSet', index, expected: item.raw, value: encode(draft) }))
                        ?? <Bytes bytes={item} />}
                    </td>
                    {actions(String(index), item.text, !item.binary, () => void submit({ kind: 'listDelete', index, expected: item.raw }, t('redis.element.deleteItem', { index })))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <AddRow
            t={t}
            busy={busy}
            fields={[{ label: t('redis.column.value') }]}
            choices={[{ value: 'tail', label: t('redis.element.pushTail') }, { value: 'head', label: t('redis.element.pushHead') }]}
            onAdd={([item], choice) => submit({ kind: 'listPush', value: encode(item), head: choice === 'head' })}
          />
        </>
      );
    case 'set':
      return (
        <>
          <table className="w-full table-auto border-collapse">
            <thead className="bg-surface-sunken">
              <tr><th className={headClass}>{t('redis.column.member')}</th><th className="w-16 border-b border-line" /></tr>
            </thead>
            <tbody>
              {value.members.map((member, index) => (
                <tr key={`${member.raw}-${index}`} className="group">
                  <td className={cellClass}><Bytes bytes={member} /></td>
                  {/* 集合的成员没有「改」：改就是删一个加一个，那样写更清楚 */}
                  <td className={clsx(cellClass, 'w-16 text-right')}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void submit({ kind: 'setDelete', member: member.raw }, t('redis.element.deleteMember', { name: member.text }))}
                      className={clsx(iconButton, 'opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100')}
                      aria-label={t('redis.action.delete')}
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <AddRow t={t} busy={busy} fields={[{ label: t('redis.column.member') }]} onAdd={([member]) => submit({ kind: 'setAdd', member: encode(member) })} />
        </>
      );
    case 'zset':
      return (
        <>
          <table className="w-full table-auto border-collapse">
            <thead className="bg-surface-sunken">
              <tr>
                <th className={clsx(headClass, 'w-16')}>{t('redis.column.rank')}</th>
                <th className={headClass}>{t('redis.column.member')}</th>
                <th className={clsx(headClass, 'text-right')}>{t('redis.column.score')}</th>
                <th className="w-16 border-b border-line" />
              </tr>
            </thead>
            <tbody>
              {value.entries.map(([member, score], index) => (
                <tr key={`${member.raw}-${index}`} className="group">
                  <td className={clsx(cellClass, 'font-mono text-xs text-fg-subtle')}>{value.offset + index}</td>
                  <td className={cellClass}><Bytes bytes={member} /></td>
                  <td className={clsx(cellClass, 'text-right font-mono text-[13px] tabular-nums text-fg')}>
                    {editor(member.raw, (draft) => void submit({ kind: 'zsetSet', member: member.raw, expected: score, score: draft.trim() }), validScore) ?? score}
                  </td>
                  {/* 分数是数字，成员是二进制也照样能改分数 */}
                  {actions(member.raw, score, true, () => void submit({ kind: 'zsetDelete', member: member.raw }, t('redis.element.deleteMember', { name: member.text })))}
                </tr>
              ))}
            </tbody>
          </table>
          <AddRow
            t={t}
            busy={busy}
            fields={[{ label: t('redis.column.member') }, { label: t('redis.column.score'), valid: validScore }]}
            onAdd={([member, score]) => submit({ kind: 'zsetSet', member: encode(member), expected: null, score: score.trim() })}
          />
        </>
      );
  }
}

interface AddRowProps {
  t: Translate;
  busy: boolean;
  fields: { label: string; valid?: (text: string) => boolean }[];
  choices?: { value: string; label: string }[];
  /** 返回是否加上了：没加上时框里的字留着 */
  onAdd: (values: string[], choice: string) => Promise<boolean>;
}

/** 表底下「加一个」的那一行。加成功就清空，失败留着 */
function AddRow({ t, busy, fields, choices, onAdd }: AddRowProps) {
  const [values, setValues] = useState<string[]>(() => fields.map(() => ''));
  const [choice, setChoice] = useState(choices?.[0]?.value ?? '');
  const ready = values.every((value, index) => value !== '' && (fields[index].valid?.(value) ?? true));

  const add = async () => {
    if (!ready || busy) return;
    const before = values;
    if (await onAdd(values, choice)) {
      setValues((current) => (current === before ? fields.map(() => '') : current));
    }
  };

  return (
    <div className="mt-2 flex items-center gap-2">
      {fields.map((field, index) => (
        <input
          key={field.label}
          value={values[index]}
          onChange={(event) => setValues((current) => current.map((value, position) => (position === index ? event.target.value : value)))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void add();
            }
          }}
          placeholder={field.label}
          aria-label={field.label}
          className={clsx(inputClass, inputState(values[index] === '' || !field.valid || field.valid(values[index])))}
          {...PLAIN_TEXT_INPUT}
        />
      ))}
      {choices && (
        <select value={choice} onChange={(event) => setChoice(event.target.value)} className="rounded-control border border-line-strong bg-surface px-1 py-0.5 text-sm text-fg">
          {choices.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      )}
      <button
        type="button"
        disabled={!ready || busy}
        onClick={() => void add()}
        className="flex shrink-0 items-center gap-1 rounded-control border border-line-strong px-2 py-0.5 text-sm text-fg hover:bg-surface-hover disabled:opacity-50"
      >
        <Plus size={13} />
        {t('redis.element.add')}
      </button>
    </div>
  );
}
