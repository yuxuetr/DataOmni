import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Clock, Loader2, Pencil, Plus, RefreshCw, Search, TextCursorInput, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { PLAIN_TEXT_INPUT, SegmentedControl } from './FormControls';
import { RedisConsole } from './RedisConsole';
import { RedisInputDialog } from './RedisInputDialog';
import { RedisValueTable, type ElementChange } from './RedisValueTable';
import { RedisNewKeyDialog } from './RedisNewKeyDialog';
import { useConfirmPrompt } from './ConfirmPrompt';
import { bytesToBase64 } from '../utils/redisCommandLine';
import { useLanguageStore } from '../stores/languageStore';
import { useQueryStore } from '../stores/queryStore';
import { describeError } from '../utils/describeError';
import {
  REDIS_KEY_KINDS,
  appendValuePage,
  nextPosition,
  parseTtlSeconds,
  ttlView,
  type RedisBytes,
  type RedisKeyRow,
  type RedisScanPage,
  type RedisValue
} from '../utils/redisKeys';

interface RedisKeyBrowserProps {
  /** 逻辑库号 */
  database: number;
}

/** 一页多少个键、一个值读多少个元素。与网格的 `MAX_UNVIRTUALIZED_ROWS` 同量级 */
const KEY_PAGE = 200;
const VALUE_PAGE = 100;

interface AppliedScan {
  pattern: string;
  kind: string;
}

/**
 * Redis 一个逻辑库的键浏览页：左边按模式翻键（`SCAN`，不用 `KEYS`），右边是选中那个键
 * 的值，按类型各一种表。这一版只读。
 *
 * 键列表不给总数：`DBSIZE` 是整个库的，而模式筛过之后的个数要扫完才知道——
 * 印一个「共 N 个」只会让人以为筛出了 N 个
 */
export function RedisKeyBrowser({ database }: RedisKeyBrowserProps) {
  const t = useLanguageStore((state) => state.t);
  const connectionString = useQueryStore((state) => state.connectionString);
  const timeoutMs = useQueryStore((state) => state.queryTimeoutMs);

  const [mode, setMode] = useState<'keys' | 'console'>('keys');
  // 命令行里跑过东西：切回键列表时重读一遍，不然看到的是跑之前的样子
  const [stale, setStale] = useState(false);
  const [patternDraft, setPatternDraft] = useState('*');
  const [kindDraft, setKindDraft] = useState('');
  const [applied, setApplied] = useState<AppliedScan>({ pattern: '*', kind: '' });
  const [keys, setKeys] = useState<RedisKeyRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const [selected, setSelected] = useState<RedisKeyRow | null>(null);
  const [value, setValue] = useState<RedisValue | null>(null);
  const [loadingValue, setLoadingValue] = useState(false);
  const [valueError, setValueError] = useState<string | null>(null);
  // 快速点两个键时，先发的那次晚回来不能盖掉后点的
  const valueRequest = useRef(0);
  const { ask, prompt: confirmPrompt } = useConfirmPrompt();
  const [dialog, setDialog] = useState<'rename' | 'ttl' | 'new' | null>(null);
  // 正在改的字符串；null 是没在改
  const [stringDraft, setStringDraft] = useState<string | null>(null);
  const [savingString, setSavingString] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const scan = useCallback(async (query: AppliedScan, from: string | null) => {
    if (!connectionString) return;
    setScanning(true);
    setScanError(null);
    try {
      const page = await invoke<RedisScanPage>('redis_scan', {
        connectionString,
        database,
        pattern: query.pattern,
        cursor: from ?? '0',
        kind: query.kind || null,
        page: KEY_PAGE,
        timeoutMs
      });
      setKeys((previous) => (from === null ? page.keys : [...previous, ...page.keys]));
      // 选中的那个键又扫到了：剩余时间换成这次的，否则列表写 42 秒、详情还写着 2 分
      setSelected((current) => (current && page.keys.find((row) => row.key.raw === current.key.raw)) ?? current);
      setCursor(page.cursor);
    } catch (caught) {
      setScanError(describeError(caught));
    } finally {
      setScanning(false);
    }
  }, [connectionString, database, timeoutMs]);

  useEffect(() => {
    void scan({ pattern: '*', kind: '' }, null);
  }, [scan]);

  const loadValue = async (row: RedisKeyRow, position: string | null) => {
    if (!connectionString) return;
    const request = ++valueRequest.current;
    setLoadingValue(true);
    setValueError(null);
    try {
      const page = await invoke<RedisValue>('redis_read_value', {
        connectionString,
        database,
        key: row.key.raw,
        position,
        page: VALUE_PAGE,
        timeoutMs
      });
      if (request !== valueRequest.current) return;
      setValue((previous) => (position !== null && previous ? appendValuePage(previous, page) : page));
    } catch (caught) {
      if (request !== valueRequest.current) return;
      setValueError(describeError(caught));
      if (position === null) setValue(null);
    } finally {
      if (request === valueRequest.current) setLoadingValue(false);
    }
  };

  const select = (row: RedisKeyRow) => {
    setSelected(row);
    setValue(null);
    setStringDraft(null);
    setActionError(null);
    void loadValue(row, null);
  };

  /** 对选中的键做一件事。失败时抛出去，由调用的地方决定显示在哪 */
  const changeKey = async (row: RedisKeyRow, change: Record<string, unknown>) => {
    await invoke('redis_change_key', { connectionString, database, key: row.key.raw, change, timeoutMs });
  };

  const encodeText = (text: string) => bytesToBase64(new TextEncoder().encode(text));

  const deleteKey = async (row: RedisKeyRow) => {
    const confirmed = await ask({
      title: t('redis.action.deleteTitle'),
      message: t('redis.action.deleteMessage', { key: row.key.text, database: `db${database}` }),
      confirmLabel: t('redis.action.delete'),
      destructive: true
    });
    if (!confirmed) return;
    try {
      await changeKey(row, { kind: 'delete' });
      setKeys((previous) => previous.filter((candidate) => candidate.key.raw !== row.key.raw));
      setSelected(null);
      setValue(null);
    } catch (caught) {
      setActionError(describeError(caught));
    }
  };

  /** 改一个元素。删的先问；成功后从第一页重读（元素的次序、个数都可能变了） */
  const changeElement = async (row: RedisKeyRow, change: ElementChange, destructive?: string) => {
    if (destructive) {
      const confirmed = await ask({
        title: t('redis.element.deleteTitle'),
        message: destructive,
        confirmLabel: t('redis.action.delete'),
        destructive: true
      });
      if (!confirmed) throw new Error('cancelled');
    }
    setActionError(null);
    try {
      await invoke('redis_change_element', { connectionString, database, key: row.key.raw, change, timeoutMs });
    } catch (caught) {
      setActionError(describeError(caught));
      throw caught;
    }
    void loadValue(row, null);
  };

  const saveString = async (row: RedisKeyRow, original: RedisBytes, draft: string) => {
    setSavingString(true);
    setActionError(null);
    try {
      await changeKey(row, { kind: 'setString', expected: original.raw, value: encodeText(draft) });
      setStringDraft(null);
      void loadValue(row, null);
    } catch (caught) {
      // 草稿留着：别处改过的话，先看一眼再决定
      setActionError(describeError(caught));
    } finally {
      setSavingString(false);
    }
  };

  const apply = () => {
    const query = { pattern: patternDraft.trim() || '*', kind: kindDraft };
    setApplied(query);
    setSelected(null);
    setValue(null);
    void scan(query, null);
  };

  const refresh = () => {
    void scan(applied, null);
    if (selected) void loadValue(selected, null);
  };

  const ttlText = (ms: number): string => {
    const view = ttlView(ms);
    if (view.kind === 'persistent') return t('redis.ttl.persistent');
    if (view.kind === 'gone') return t('redis.ttl.gone');
    return view.parts.map((part) => t(`redis.ttl.${part.unit}`, { value: part.value })).join(' ');
  };

  const more = value ? nextPosition(value) : null;

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center justify-between border-b bg-surface-sunken p-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-fg">{`db${database}`}</h2>
          <p className={clsx('mt-1 text-xs text-fg-muted', mode === 'console' && 'invisible')}>
            {cursor === null
              ? t('redis.keys.all', { count: keys.length })
              : t('redis.keys.partial', { count: keys.length })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl
            value={mode}
            options={[
              { value: 'keys', label: t('redis.mode.keys') },
              { value: 'console', label: t('redis.mode.console') }
            ]}
            onChange={(next) => {
              setMode(next);
              if (next === 'keys' && stale) {
                setStale(false);
                refresh();
              }
            }}
          />
          {mode === 'keys' && (
            <button
              onClick={refresh}
              disabled={!connectionString || scanning}
              className="flex items-center gap-1 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              <RefreshCw size={14} />
              <span>{t('redis.refresh')}</span>
            </button>
          )}
        </div>
      </div>

      {/* 两页都不卸掉，只藏起来：键列表翻到哪、选着哪个，命令行跑过什么，切回来都还在 */}
      <div className={clsx('flex min-h-0 flex-1 flex-col', mode !== 'console' && 'hidden')}>
        <RedisConsole database={database} onRan={() => setStale(true)} />
      </div>
      <div className={clsx('flex min-h-0 flex-1', mode === 'console' && 'hidden')}>
        <div className="flex w-[360px] shrink-0 flex-col border-r border-line">
          <div className="space-y-2 border-b border-line p-3">
            <div className="flex gap-2">
              <input
                value={patternDraft}
                onChange={(event) => setPatternDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    apply();
                  }
                }}
                aria-label={t('redis.pattern')}
                placeholder="user:*"
                className="min-w-0 flex-1 rounded-control border border-line-strong bg-surface px-2 py-1 font-mono text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:ring-2 focus:ring-accent"
                {...PLAIN_TEXT_INPUT}
              />
              <select
                value={kindDraft}
                onChange={(event) => setKindDraft(event.target.value)}
                aria-label={t('redis.kind')}
                className="rounded-control border border-line-strong bg-surface px-1 py-1 text-sm text-fg"
              >
                <option value="">{t('redis.kind.any')}</option>
                {REDIS_KEY_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
              <button
                onClick={apply}
                disabled={!connectionString || scanning}
                className="flex items-center gap-1 rounded-control border border-accent-line px-2 py-1 text-sm text-accent transition-colors hover:bg-accent-soft disabled:opacity-50"
                aria-label={t('redis.search')}
                title={t('redis.search')}
              >
                <Search size={14} />
              </button>
              <button
                onClick={() => setDialog('new')}
                disabled={!connectionString}
                className="flex items-center gap-1 rounded-control border border-line-strong px-2 py-1 text-sm text-fg transition-colors hover:bg-surface-hover disabled:opacity-50"
                aria-label={t('redis.newKey.open')}
                title={t('redis.newKey.open')}
              >
                <Plus size={14} />
              </button>
            </div>
            <p className="text-xs text-fg-subtle">{t('redis.patternHint')}</p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {scanError && <p className="select-text p-3 text-sm text-danger">{scanError}</p>}
            {!scanError && keys.length === 0 && !scanning && (
              <p className="p-3 text-sm text-fg-muted">{t('redis.keys.none')}</p>
            )}
            <ul>
              {keys.map((row) => (
                <li key={row.key.raw}>
                  <button
                    type="button"
                    onClick={() => select(row)}
                    className={clsx(
                      'flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-surface-hover',
                      selected?.key.raw === row.key.raw && 'bg-accent-soft'
                    )}
                  >
                    <span className="w-12 shrink-0 font-mono text-[11px] text-fg-subtle">{row.kind}</span>
                    <span
                      className={clsx('min-w-0 flex-1 truncate font-mono text-[13px]', row.key.binary ? 'text-warning' : 'text-fg')}
                      title={row.key.text}
                    >
                      {row.key.text}
                    </span>
                    {row.ttlMs !== -1 && (
                      <span className="shrink-0 text-[11px] text-warning">{ttlText(row.ttlMs)}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {(cursor !== null || scanning) && (
              <div className="p-3">
                <button
                  onClick={() => void scan(applied, cursor)}
                  disabled={scanning || cursor === null}
                  className="flex w-full items-center justify-center gap-1 rounded-control border border-line-strong px-3 py-1 text-sm text-fg transition-colors hover:bg-surface-hover disabled:opacity-50"
                >
                  {scanning && <Loader2 size={14} className="animate-spin" />}
                  {t('redis.keys.more')}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {!selected ? (
            <p className="p-4 text-sm text-fg-muted">{t('redis.value.pick')}</p>
          ) : (
            <>
              <div className="border-b border-line px-4 py-3">
                <p className="select-text break-all font-mono text-sm text-fg">{selected.key.text}</p>
                <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-fg-muted">
                  <span>{selected.kind}</span>
                  <span>
                    {selected.ttlMs === -1 ? t('redis.ttl.never') : t('redis.ttl.label', { ttl: ttlText(selected.ttlMs) })}
                  </span>
                  {value && <span>{sizeText(value, t)}</span>}
                  {selected.key.binary && <span className="text-warning">{t('redis.binaryKey')}</span>}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {/* 二进制的键改名要写出原样的字节，框里的转义文字写不回去 */}
                  <button
                    type="button"
                    onClick={() => setDialog('rename')}
                    disabled={selected.key.binary}
                    title={selected.key.binary ? t('redis.action.binaryKeyRename') : undefined}
                    className="flex items-center gap-1 rounded-control border border-line-strong px-2 py-1 text-xs text-fg hover:bg-surface-hover disabled:opacity-50"
                  >
                    <TextCursorInput size={12} />
                    {t('redis.action.rename')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDialog('ttl')}
                    className="flex items-center gap-1 rounded-control border border-line-strong px-2 py-1 text-xs text-fg hover:bg-surface-hover"
                  >
                    <Clock size={12} />
                    {t('redis.action.ttl')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteKey(selected)}
                    className="flex items-center gap-1 rounded-control border border-danger-line px-2 py-1 text-xs text-danger hover:bg-danger-soft"
                  >
                    <Trash2 size={12} />
                    {t('redis.action.delete')}
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4">
                {valueError && <p className="select-text text-sm text-danger">{valueError}</p>}
                {!value && loadingValue && (
                  <p className="flex items-center gap-2 text-sm text-fg-muted">
                    <Loader2 size={14} className="animate-spin" />
                    {t('redis.value.loading')}
                  </p>
                )}
                {actionError && <p className="mb-2 select-text text-sm text-danger">{actionError}</p>}
                {value?.kind === 'string' && stringDraft !== null ? (
                  <div className="space-y-2">
                    <textarea
                      value={stringDraft}
                      onChange={(event) => setStringDraft(event.target.value)}
                      aria-label={t('redis.action.editValue')}
                      rows={12}
                      className="w-full resize-y rounded-control border border-line-strong bg-surface px-3 py-2 font-mono text-[13px] text-fg outline-none focus:ring-2 focus:ring-accent"
                      {...PLAIN_TEXT_INPUT}
                    />
                    <p className="text-xs text-fg-subtle">{t('redis.action.editNote')}</p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void saveString(selected, value.value, stringDraft)}
                        disabled={savingString}
                        className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
                      >
                        {savingString && <Loader2 size={14} className="animate-spin" />}
                        {t('redis.action.save')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setStringDraft(null);
                          setActionError(null);
                        }}
                        disabled={savingString}
                        className="rounded-control border border-line-strong px-3 py-1 text-sm text-fg hover:bg-surface-hover"
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* 只改得了完整读回来的文字：截断的写回去会丢掉后半截，二进制的转义文字写不回原样的字节 */}
                    {value?.kind === 'string' && !value.truncated && !value.value.binary && (
                      <button
                        type="button"
                        onClick={() => setStringDraft(value.value.text)}
                        className="mb-2 flex items-center gap-1 rounded-control border border-line-strong px-2 py-1 text-xs text-fg hover:bg-surface-hover"
                      >
                        <Pencil size={12} />
                        {t('redis.action.edit')}
                      </button>
                    )}
                    {value && (value.kind === 'hash' || value.kind === 'list' || value.kind === 'set' || value.kind === 'zset') ? (
                      <RedisValueTable
                        value={value}
                        encode={encodeText}
                        onChange={(change, destructive) => changeElement(selected, change, destructive)}
                      />
                    ) : (
                      value && <ValueView value={value} t={t} />
                    )}
                  </>
                )}
                {more !== null && (
                  <button
                    onClick={() => void loadValue(selected, more)}
                    disabled={loadingValue}
                    className="mt-3 flex items-center gap-1 rounded-control border border-line-strong px-3 py-1 text-sm text-fg transition-colors hover:bg-surface-hover disabled:opacity-50"
                  >
                    {loadingValue && <Loader2 size={14} className="animate-spin" />}
                    {t('redis.value.more')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {confirmPrompt}
      {dialog === 'new' && connectionString && (
        <RedisNewKeyDialog
          connectionString={connectionString}
          database={database}
          timeoutMs={timeoutMs}
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null);
            void scan(applied, null);
          }}
        />
      )}
      {dialog === 'rename' && selected && (
        <RedisInputDialog
          title={t('redis.action.renameTitle')}
          label={t('redis.action.renameLabel')}
          initial={selected.key.text}
          hint={t('redis.action.renameHint')}
          confirmLabel={t('redis.action.rename')}
          validate={(text) => (text === '' ? t('redis.action.renameEmpty') : text === selected.key.text ? t('redis.action.renameSame') : null)}
          onSubmit={async (text) => {
            try {
              await changeKey(selected, { kind: 'rename', to: encodeText(text) });
            } catch (caught) {
              throw new Error(describeError(caught));
            }
            // 就地换掉这一行、选中不变：值没变，不必重读；重扫的话新名字未必匹配当前的模式，
            // 刚改的键就从眼前消失了
            const renamed = { ...selected, key: { raw: encodeText(text), text, binary: false } };
            setDialog(null);
            setSelected(renamed);
            setKeys((previous) => previous.map((row) => (row.key.raw === selected.key.raw ? renamed : row)));
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'ttl' && selected && (
        <RedisInputDialog
          title={t('redis.action.ttlTitle')}
          label={t('redis.action.ttlLabel')}
          initial={selected.ttlMs > 0 ? String(Math.ceil(selected.ttlMs / 1000)) : ''}
          hint={t('redis.action.ttlHint')}
          placeholder="3600"
          confirmLabel={t('redis.action.save')}
          validate={(text) => (parseTtlSeconds(text) === undefined ? t('redis.action.ttlInvalid') : null)}
          onSubmit={async (text) => {
            const ttlMs = parseTtlSeconds(text) ?? null;
            try {
              await changeKey(selected, { kind: 'expire', ttlMs });
            } catch (caught) {
              throw new Error(describeError(caught));
            }
            const updated = { ...selected, ttlMs: ttlMs ?? -1 };
            setDialog(null);
            setSelected(updated);
            setKeys((previous) => previous.map((row) => (row.key.raw === updated.key.raw ? updated : row)));
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

type Translate = ReturnType<typeof useLanguageStore.getState>['t'];

function sizeText(value: RedisValue, t: Translate): string {
  switch (value.kind) {
    case 'string':
      return t('redis.size.bytes', { count: value.size });
    case 'unsupported':
      return '';
    default:
      return t('redis.size.elements', { count: value.length });
  }
}

function Bytes({ bytes }: { bytes: RedisBytes }) {
  return (
    <span className={clsx('select-text whitespace-pre-wrap break-all font-mono text-[13px]', bytes.binary ? 'text-warning' : 'text-fg')}>
      {bytes.text}
    </span>
  );
}

const cellClass = 'border-b border-line px-2 py-1 align-baseline leading-5';
const headClass = 'border-b border-line px-2 py-1 text-left text-xs font-medium text-fg';

function ValueView({ value, t }: { value: RedisValue; t: Translate }) {
  switch (value.kind) {
    case 'string':
      return (
        <div className="space-y-2">
          {value.value.binary && <p className="text-xs text-warning">{t('redis.value.binary')}</p>}
          {value.truncated && (
            <p className="text-xs text-fg-muted">{t('redis.value.truncated', { count: value.size })}</p>
          )}
          <pre className="rounded-control border border-line bg-surface-sunken px-3 py-2">
            <Bytes bytes={value.value} />
          </pre>
        </div>
      );
    case 'hash':
      return (
        <table className="w-full table-auto border-collapse">
          <thead className="bg-surface-sunken">
            <tr><th className={headClass}>{t('redis.column.field')}</th><th className={headClass}>{t('redis.column.value')}</th></tr>
          </thead>
          <tbody>
            {value.entries.map(([field, item], index) => (
              <tr key={`${field.raw}-${index}`}>
                <td className={cellClass}><Bytes bytes={field} /></td>
                <td className={cellClass}><Bytes bytes={item} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'list':
      return (
        <table className="w-full table-auto border-collapse">
          <thead className="bg-surface-sunken">
            <tr><th className={clsx(headClass, 'w-16')}>{t('redis.column.index')}</th><th className={headClass}>{t('redis.column.value')}</th></tr>
          </thead>
          <tbody>
            {value.items.map((item, index) => (
              <tr key={index}>
                <td className={clsx(cellClass, 'font-mono text-xs text-fg-subtle')}>{value.offset + index}</td>
                <td className={cellClass}><Bytes bytes={item} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'set':
      return (
        <table className="w-full table-auto border-collapse">
          <thead className="bg-surface-sunken">
            <tr><th className={headClass}>{t('redis.column.member')}</th></tr>
          </thead>
          <tbody>
            {value.members.map((member, index) => (
              <tr key={`${member.raw}-${index}`}><td className={cellClass}><Bytes bytes={member} /></td></tr>
            ))}
          </tbody>
        </table>
      );
    case 'zset':
      return (
        <table className="w-full table-auto border-collapse">
          <thead className="bg-surface-sunken">
            <tr>
              <th className={clsx(headClass, 'w-16')}>{t('redis.column.rank')}</th>
              <th className={headClass}>{t('redis.column.member')}</th>
              <th className={clsx(headClass, 'text-right')}>{t('redis.column.score')}</th>
            </tr>
          </thead>
          <tbody>
            {value.entries.map(([member, score], index) => (
              <tr key={`${member.raw}-${index}`}>
                <td className={clsx(cellClass, 'font-mono text-xs text-fg-subtle')}>{value.offset + index}</td>
                <td className={cellClass}><Bytes bytes={member} /></td>
                <td className={clsx(cellClass, 'text-right font-mono text-[13px] tabular-nums text-fg')}>{score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'stream':
      return (
        <table className="w-full table-auto border-collapse">
          <thead className="bg-surface-sunken">
            <tr><th className={clsx(headClass, 'w-48')}>{t('redis.column.id')}</th><th className={headClass}>{t('redis.column.fields')}</th></tr>
          </thead>
          <tbody>
            {value.entries.map((entry) => (
              <tr key={entry.id}>
                <td className={clsx(cellClass, 'whitespace-nowrap font-mono text-xs text-fg-muted')}>{entry.id}</td>
                <td className={cellClass}>
                  {entry.fields.map(([field, item], index) => (
                    <div key={index}>
                      <span className="font-mono text-[13px] text-fg-muted">{field.text}</span>
                      <span className="text-fg-subtle"> = </span>
                      <Bytes bytes={item} />
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'unsupported':
      return <p className="text-sm text-fg-muted">{t('redis.value.unsupported', { type: value.redisType })}</p>;
  }
}
