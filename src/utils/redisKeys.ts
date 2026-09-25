/** 与后端 `RedisBytes` 一致：`raw` 是 base64，拿去定位；`text` 给人看 */
export interface RedisBytes {
  raw: string;
  text: string;
  binary: boolean;
}

export interface RedisKeyRow {
  key: RedisBytes;
  kind: string;
  ttlMs: number;
}

export interface RedisScanPage {
  keys: RedisKeyRow[];
  cursor: string | null;
}

export interface RedisStreamEntry {
  id: string;
  fields: [RedisBytes, RedisBytes][];
}

/** 与后端 `RedisValue` 一致，按 `kind` 分 */
export type RedisValue =
  | { kind: 'string'; size: number; value: RedisBytes; truncated: boolean }
  | { kind: 'hash'; length: number; entries: [RedisBytes, RedisBytes][]; next: string | null }
  | { kind: 'list'; length: number; offset: number; items: RedisBytes[]; next: string | null }
  | { kind: 'set'; length: number; members: RedisBytes[]; next: string | null }
  | { kind: 'zset'; length: number; offset: number; entries: [RedisBytes, string][]; next: string | null }
  | { kind: 'stream'; length: number; entries: RedisStreamEntry[]; next: string | null }
  | { kind: 'unsupported'; redisType: string };

/** 能按类型筛的几种，即 `SCAN … TYPE` 认的名字 */
export const REDIS_KEY_KINDS = ['string', 'hash', 'list', 'set', 'zset', 'stream'] as const;

/** 对象树上的名字 `db3` → 库号 3；认不出的当 0（树里只会有 `db<数字>`） */
export function redisDatabaseIndex(name: string): number {
  const match = /^db(\d+)$/.exec(name);
  return match ? Number(match[1]) : 0;
}

export type TtlUnit = 'd' | 'h' | 'm' | 's';

export type TtlView =
  | { kind: 'persistent' }
  | { kind: 'gone' }
  | { kind: 'expiring'; parts: { value: number; unit: TtlUnit }[] };

/**
 * `PTTL` 的毫秒数 → 给人看的剩余时间，最多两段（「3 天 2 小时」「9 分 58 秒」）。
 * -1 是不过期，-2 是这一刻已经没了。不足一秒按 1 秒算：说「0 秒」像是已经过期了
 */
export function ttlView(ms: number): TtlView {
  if (ms === -1) return { kind: 'persistent' };
  if (ms < 0) return { kind: 'gone' };
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  const units: [TtlUnit, number][] = [['d', 86_400], ['h', 3_600], ['m', 60], ['s', 1]];
  // 第一段是够得着的最大一级；第二段只取紧挨着的下一级，是 0 就不说
  // （「1 天 0 小时 5 分」只说「1 天」）
  const first = Math.max(0, units.findIndex(([, size]) => seconds >= size));
  const [unit, size] = units[first];
  const parts = [{ value: Math.floor(seconds / size), unit }];
  const next = units[first + 1];
  if (next) {
    const value = Math.floor((seconds % size) / next[1]);
    if (value > 0) parts.push({ value, unit: next[0] });
  }
  return { kind: 'expiring', parts };
}

/**
 * 「再读一页」：把后一页接在前一页后面，总数与下一页的位置取后一页的。
 * 类型对不上（两次之间键被删了重建成别的类型）就只要后一页——拼起来的会是两种东西
 */
export function appendValuePage(previous: RedisValue, next: RedisValue): RedisValue {
  if (previous.kind === 'hash' && next.kind === 'hash') {
    return { ...next, entries: [...previous.entries, ...next.entries] };
  }
  if (previous.kind === 'list' && next.kind === 'list') {
    return { ...next, offset: previous.offset, items: [...previous.items, ...next.items] };
  }
  if (previous.kind === 'set' && next.kind === 'set') {
    return { ...next, members: [...previous.members, ...next.members] };
  }
  if (previous.kind === 'zset' && next.kind === 'zset') {
    return { ...next, offset: previous.offset, entries: [...previous.entries, ...next.entries] };
  }
  if (previous.kind === 'stream' && next.kind === 'stream') {
    return { ...next, entries: [...previous.entries, ...next.entries] };
  }
  return next;
}

/** 这个值还有没有下一页 */
export function nextPosition(value: RedisValue): string | null {
  return value.kind === 'string' || value.kind === 'unsupported' ? null : value.next;
}

/**
 * 「过期」那一格：空着是不过期（`PERSIST`），否则是正整数秒。返回毫秒；`undefined` 是写得不对。
 * 只收整数秒：毫秒级的过期是程序的事，界面上填的人想的是「一小时后」
 */
export function parseTtlSeconds(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  return seconds > 0 && Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : undefined;
}

/**
 * zset 的分数：Redis 认的浮点写法，含 `inf` / `+inf` / `-inf`。`ZADD` 自己也会拒，
 * 这里先挡一下，让那一格当场标红，而不是提交之后才说「not a valid float」
 */
export function isRedisScore(text: string): boolean {
  return /^[+-]?(inf|(\d+\.?\d*|\.\d+)(e[+-]?\d+)?)$/i.test(text.trim());
}
