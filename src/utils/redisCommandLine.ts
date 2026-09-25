import type { RedisBytes } from './redisKeys';

/** 与后端 `RedisReply` 一致 */
export type RedisReply =
  | { kind: 'nil' }
  | { kind: 'integer'; value: number }
  | { kind: 'bulk'; value: RedisBytes }
  | { kind: 'status'; value: string }
  | { kind: 'error'; message: string }
  | { kind: 'array'; items: RedisReply[] }
  | { kind: 'map'; entries: [RedisReply, RedisReply][] }
  | { kind: 'double'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'bigNumber'; value: string };

export type SplitResult = { ok: true; args: Uint8Array[] } | { ok: false; error: 'unbalancedQuotes' | 'empty' };

const ESCAPES: Record<string, number> = { n: 0x0a, r: 0x0d, t: 0x09, b: 0x08, a: 0x07 };
const encoder = new TextEncoder();

/**
 * 按 redis-cli 的规矩把一行拆成参数（它的 `sdssplitargs`）：空白分隔；双引号里认
 * `\n \r \t \b \a \\ \"` 与 `\xHH`（一个字节）；单引号里只认 `\'`；引号收尾后面必须是
 * 空白或行尾。结果是字节串，所以 `"\xff"` 发出去就是一个 0xff 字节，不是四个字符
 */
export function splitCommandLine(line: string): SplitResult {
  const args: Uint8Array[] = [];
  const chars = [...line];
  let index = 0;
  const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);
  while (index < chars.length) {
    while (isSpace(chars[index])) index += 1;
    if (index >= chars.length) break;
    const bytes: number[] = [];
    const push = (char: string) => bytes.push(...encoder.encode(char));
    let done = false;
    while (!done) {
      const char = chars[index];
      if (char === undefined || isSpace(char)) {
        done = true;
      } else if (char === '"') {
        index += 1;
        let closed = false;
        while (index < chars.length) {
          const inner = chars[index];
          if (inner === '\\' && chars[index + 1] === 'x' && /^[0-9a-fA-F]{2}$/.test(`${chars[index + 2] ?? ''}${chars[index + 3] ?? ''}`)) {
            bytes.push(parseInt(`${chars[index + 2]}${chars[index + 3]}`, 16));
            index += 4;
          } else if (inner === '\\' && index + 1 < chars.length) {
            const escaped = chars[index + 1];
            if (escaped in ESCAPES) bytes.push(ESCAPES[escaped]);
            else push(escaped);
            index += 2;
          } else if (inner === '"') {
            closed = true;
            index += 1;
            break;
          } else {
            push(inner);
            index += 1;
          }
        }
        if (!closed || (index < chars.length && !isSpace(chars[index]))) {
          return { ok: false, error: 'unbalancedQuotes' };
        }
      } else if (char === "'") {
        index += 1;
        let closed = false;
        while (index < chars.length) {
          const inner = chars[index];
          if (inner === '\\' && chars[index + 1] === "'") {
            push("'");
            index += 2;
          } else if (inner === "'") {
            closed = true;
            index += 1;
            break;
          } else {
            push(inner);
            index += 1;
          }
        }
        if (!closed || (index < chars.length && !isSpace(chars[index]))) {
          return { ok: false, error: 'unbalancedQuotes' };
        }
      } else {
        push(char);
        index += 1;
      }
    }
    args.push(Uint8Array.from(bytes));
  }
  return args.length === 0 ? { ok: false, error: 'empty' } : { ok: true, args };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

/** redis-cli 给字符串加的引号：二进制的后端已经转义过（反斜杠也转了），文字的这里转 */
function quoted(bytes: RedisBytes): string {
  if (bytes.binary) return `"${bytes.text}"`;
  const escaped = bytes.text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** 一条回答 → redis-cli 画出来的样子，一行一个元素，嵌套的按序号宽度缩进 */
export function formatReply(reply: RedisReply): string {
  return replyLines(reply).join('\n');
}

function replyLines(reply: RedisReply): string[] {
  switch (reply.kind) {
    case 'nil':
      return ['(nil)'];
    case 'integer':
      return [`(integer) ${reply.value}`];
    case 'bulk':
      return [quoted(reply.value)];
    case 'status':
      return [reply.value];
    case 'error':
      return [`(error) ${reply.message}`];
    case 'double':
      return [`(double) ${reply.value}`];
    case 'boolean':
      return [reply.value ? '(true)' : '(false)'];
    case 'bigNumber':
      return [`(big number) ${reply.value}`];
    case 'array':
      if (reply.items.length === 0) return ['(empty array)'];
      return numbered(reply.items.map(replyLines), ') ');
    case 'map':
      if (reply.entries.length === 0) return ['(empty hash)'];
      return numbered(
        reply.entries.map(([key, value]) => {
          const keyLines = replyLines(key);
          const valueLines = replyLines(value);
          const head = `${keyLines.join(' ')} => `;
          return [`${head}${valueLines[0]}`, ...valueLines.slice(1).map((line) => `${' '.repeat(head.length)}${line}`)];
        }),
        '# '
      );
  }
}

function numbered(children: string[][], marker: string): string[] {
  const width = String(children.length).length;
  return children.flatMap((lines, index) => {
    const prefix = `${String(index + 1).padStart(width)}${marker}`;
    return lines.map((line, lineIndex) => (lineIndex === 0 ? prefix : ' '.repeat(prefix.length)) + line);
  });
}

/**
 * 跑之前要先问一句的命令：清掉整个库或整台服务端的数据、把服务端卡住的（`KEYS` 在大库上
 * 是全表扫描，期间别的请求都等着）、改服务端本身的。其余照常直接跑——Redis 的写命令
 * 太多，都问一遍等于都不问
 */
export type CommandRisk = 'wipes' | 'blocksServer' | 'changesServer';

export function commandRisk(args: readonly Uint8Array[]): CommandRisk | null {
  const word = (index: number) => new TextDecoder().decode(args[index] ?? new Uint8Array()).toUpperCase();
  const name = word(0);
  const sub = word(1);
  if (name === 'FLUSHALL' || name === 'FLUSHDB' || name === 'SWAPDB') return 'wipes';
  if ((name === 'SCRIPT' || name === 'FUNCTION') && sub === 'FLUSH') return 'wipes';
  if (name === 'KEYS' || name === 'DEBUG') return 'blocksServer';
  if (['SHUTDOWN', 'REPLICAOF', 'SLAVEOF', 'CLUSTER', 'MIGRATE', 'FAILOVER'].includes(name)) return 'changesServer';
  if (name === 'CONFIG' && ['SET', 'REWRITE', 'RESETSTAT'].includes(sub)) return 'changesServer';
  if (name === 'ACL' && ['SETUSER', 'DELUSER', 'LOAD'].includes(sub)) return 'changesServer';
  if (name === 'FUNCTION' && ['DELETE', 'RESTORE'].includes(sub)) return 'changesServer';
  return null;
}
