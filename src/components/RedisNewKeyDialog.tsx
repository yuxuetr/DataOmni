import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, X } from 'lucide-react';
import { PLAIN_TEXT_INPUT } from './FormControls';
import { useLanguageStore } from '../stores/languageStore';
import { describeError } from '../utils/describeError';
import { bytesToBase64 } from '../utils/redisCommandLine';
import { REDIS_KEY_KINDS, isRedisScore, parseTtlSeconds } from '../utils/redisKeys';

type Kind = (typeof REDIS_KEY_KINDS)[number];

interface RedisNewKeyDialogProps {
  connectionString: string;
  database: number;
  timeoutMs: number;
  onClose: () => void;
  onCreated: () => void;
}

/** 每种类型第一个元素要填哪几格。Redis 没有空的 hash / list / set，建的时候就得有一个 */
const PARTS: Record<Kind, { first: 'value' | 'field' | 'member'; second?: 'value' | 'score' }> = {
  string: { first: 'value' },
  hash: { first: 'field', second: 'value' },
  list: { first: 'value' },
  set: { first: 'member' },
  zset: { first: 'member', second: 'score' },
  stream: { first: 'field', second: 'value' }
};

export function RedisNewKeyDialog({ connectionString, database, timeoutMs, onClose, onCreated }: RedisNewKeyDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const [key, setKey] = useState('');
  const [kind, setKind] = useState<Kind>('string');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [ttl, setTtl] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    keyRef.current?.focus();
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

  const parts = PARTS[kind];
  const ttlMs = parseTtlSeconds(ttl);
  // string 的值可以是空串；别的第一格是字段或成员，不能空
  const ready = key !== ''
    && (kind === 'string' || first !== '')
    && (parts.second !== 'score' || isRedisScore(second))
    && ttlMs !== undefined;

  const encode = (text: string) => bytesToBase64(new TextEncoder().encode(text));

  const create = async () => {
    if (!ready || running) return;
    setRunning(true);
    setError(null);
    try {
      await invoke('redis_create_key', {
        connectionString,
        database,
        request: {
          key: encode(key),
          kind,
          first: encode(first),
          second: encode(parts.second === 'score' ? second.trim() : second),
          ttlMs: ttlMs ?? null
        },
        timeoutMs
      });
      onCreated();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setRunning(false);
    }
  };

  const inputClass = 'w-full rounded-control border border-line bg-surface px-2 py-1.5 font-mono text-[13px] text-fg placeholder:text-fg-subtle';
  const label = (part: 'value' | 'field' | 'member' | 'score') => t(`redis.column.${part}`);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="redis-new-key-title"
      onClick={() => !running && onClose()}
    >
      <div
        className="flex max-h-[80vh] w-[520px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="redis-new-key-title" className="text-base font-medium text-fg">{t('redis.newKey.title', { database: `db${database}` })}</h2>
          <button type="button" onClick={onClose} disabled={running} className="rounded-control p-1 text-fg-muted hover:bg-surface-hover hover:text-fg" aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div className="flex gap-2">
            <label className="block min-w-0 flex-1 space-y-1">
              <span className="text-xs text-fg-muted">{t('redis.newKey.key')}</span>
              <input ref={keyRef} value={key} onChange={(event) => setKey(event.target.value)} placeholder="user:42" className={inputClass} {...PLAIN_TEXT_INPUT} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-fg-muted">{t('redis.kind')}</span>
              <select value={kind} onChange={(event) => setKind(event.target.value as Kind)} className="block rounded-control border border-line bg-surface px-2 py-1.5 text-sm text-fg">
                {REDIS_KEY_KINDS.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          </div>
          <p className="text-xs text-fg-subtle">{t(`redis.newKey.hint.${kind}`)}</p>
          {kind === 'string' ? (
            <label className="block space-y-1">
              <span className="text-xs text-fg-muted">{label('value')}</span>
              <textarea value={first} onChange={(event) => setFirst(event.target.value)} rows={4} className={inputClass} {...PLAIN_TEXT_INPUT} />
            </label>
          ) : (
            <div className="flex gap-2">
              <label className="block min-w-0 flex-1 space-y-1">
                <span className="text-xs text-fg-muted">{label(parts.first)}</span>
                <input value={first} onChange={(event) => setFirst(event.target.value)} className={inputClass} {...PLAIN_TEXT_INPUT} />
              </label>
              {parts.second && (
                <label className="block min-w-0 flex-1 space-y-1">
                  <span className="text-xs text-fg-muted">{label(parts.second)}</span>
                  <input value={second} onChange={(event) => setSecond(event.target.value)} placeholder={parts.second === 'score' ? '1' : undefined} className={inputClass} {...PLAIN_TEXT_INPUT} />
                </label>
              )}
            </div>
          )}
          <label className="block space-y-1">
            <span className="text-xs text-fg-muted">{t('redis.action.ttlLabel')}</span>
            <input value={ttl} onChange={(event) => setTtl(event.target.value)} placeholder={t('redis.newKey.ttlPlaceholder')} className={inputClass} {...PLAIN_TEXT_INPUT} />
          </label>
          {ttlMs === undefined && <p className="text-xs text-danger">{t('redis.action.ttlInvalid')}</p>}
          {error && <p className="select-text text-sm text-danger">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-sunken px-5 py-3">
          <button type="button" onClick={onClose} disabled={running} className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void create()}
            disabled={!ready || running}
            className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
          >
            {running && <Loader2 size={14} className="animate-spin" />}
            {t('redis.newKey.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
