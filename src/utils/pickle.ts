/**
 * Python pickle 的只读解析：把字节流按操作码跑一遍栈机，得到一棵数据树给人看。
 *
 * 与 Python 的 `pickle.loads` 根本不同的一点：**不导入、不调用任何东西**。
 * `GLOBAL` / `STACK_GLOBAL` 只记下「模块.名字」，`REDUCE` / `NEWOBJ` / `BUILD` 只把
 * 「拿什么、用什么参数、带什么状态」原样记成一个对象节点。唯一的例外是几个
 * 纯数据的构造（`_codecs.encode`、`set`、`frozenset`、`bytearray`），它们只是
 * protocol 2 表达 bytes 与集合的写法，在这里直接还原成对应的节点。
 *
 * 解析失败（截断、不认识的操作码、栈不对）一律返回 null，调用方退回转义的原始字节。
 */

export type PickleValue =
  | { kind: 'none' }
  | { kind: 'bool'; value: boolean }
  | { kind: 'int'; value: bigint }
  | { kind: 'float'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bytes'; value: Uint8Array; mutable: boolean }
  | { kind: 'list' | 'tuple' | 'set' | 'frozenset'; items: PickleValue[] }
  | { kind: 'dict'; entries: [PickleValue, PickleValue][] }
  | { kind: 'global'; module: string; name: string }
  | {
      kind: 'object';
      callable: PickleValue;
      args: PickleValue[];
      state?: PickleValue;
      /** 对象之后又被 SETITEMS / APPENDS 填进去的（OrderedDict、defaultdict、list 子类） */
      dictItems?: [PickleValue, PickleValue][];
      listItems?: PickleValue[];
    };

export interface DecodedPickle {
  protocol: number;
  value: PickleValue;
}

const MARK = Symbol('mark');
type StackItem = PickleValue | typeof MARK;

class PickleError extends Error {}

function fail(message: string): never {
  throw new PickleError(message);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');

class Reader {
  private position = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.position >= this.bytes.length;
  }

  byte(): number {
    if (this.position >= this.bytes.length) fail('truncated');
    return this.bytes[this.position++];
  }

  take(length: number): Uint8Array {
    if (length < 0 || this.position + length > this.bytes.length) fail('truncated');
    const slice = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return slice;
  }

  uint(width: 1 | 2 | 4 | 8): number {
    const slice = this.take(width);
    let value = 0;
    for (let index = width - 1; index >= 0; index -= 1) value = value * 256 + slice[index];
    if (!Number.isSafeInteger(value)) fail('length too large');
    return value;
  }

  int32(): number {
    const slice = this.take(4);
    return new DataView(slice.buffer, slice.byteOffset, 4).getInt32(0, true);
  }

  float64(): number {
    const slice = this.take(8);
    return new DataView(slice.buffer, slice.byteOffset, 8).getFloat64(0, false);
  }

  /** protocol 0 的文本参数：到 `\n` 为止，不含换行 */
  line(): string {
    const start = this.position;
    while (this.position < this.bytes.length && this.bytes[this.position] !== 0x0a) this.position += 1;
    if (this.position >= this.bytes.length) fail('truncated');
    const text = latin1.decode(this.bytes.subarray(start, this.position));
    this.position += 1;
    return text;
  }
}

/** 小端补码 → bigint（LONG1 / LONG4） */
function signedLittleEndian(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n;
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index]);
  if (bytes[bytes.length - 1] & 0x80) value -= 1n << BigInt(bytes.length * 8);
  return value;
}

/** protocol 0 的 `S` 参数是带引号的 Python 2 字面量；只认引号与常见转义，够看即可 */
function quotedString(text: string): Uint8Array {
  const quote = text[0];
  if ((quote !== "'" && quote !== '"') || text[text.length - 1] !== quote || text.length < 2) fail('bad STRING');
  const body = text.slice(1, -1);
  const out: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      out.push(char.charCodeAt(0) & 0xff);
      continue;
    }
    const next = body[++index];
    const simple: Record<string, number> = { n: 10, r: 13, t: 9, '\\': 92, "'": 39, '"': 34, '0': 0 };
    if (next === 'x') {
      out.push(Number.parseInt(body.slice(index + 1, index + 3), 16));
      index += 2;
    } else if (next !== undefined && next in simple) {
      out.push(simple[next]);
    } else {
      fail('bad STRING escape');
    }
  }
  return Uint8Array.from(out);
}

/** protocol 0 的 `V` 参数：raw-unicode-escape，只有 `\uXXXX` / `\UXXXXXXXX` 是转义 */
function rawUnicodeEscape(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g, (_, short: string | undefined, long: string | undefined) =>
    String.fromCodePoint(Number.parseInt(short ?? long ?? '0', 16)),
  );
}

function asString(value: PickleValue | undefined): string | null {
  return value?.kind === 'str' ? value.value : null;
}

/**
 * 纯数据的「调用」：protocol 2 没有 bytes / set 的专门操作码，靠这几个可调用对象表达。
 * 认不出的返回 null，照常记成对象节点。
 */
function pureReduce(callable: PickleValue, args: PickleValue[]): PickleValue | null {
  if (callable.kind !== 'global') return null;
  const name = `${callable.module}.${callable.name}`;
  const [first] = args;
  switch (name) {
    case '_codecs.encode': {
      const text = asString(first);
      const encoding = asString(args[1]);
      if (text === null || (encoding !== 'latin1' && encoding !== 'latin-1')) return null;
      return { kind: 'bytes', value: Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff), mutable: false };
    }
    case 'builtins.set':
    case '__builtin__.set':
    case 'builtins.frozenset':
    case '__builtin__.frozenset': {
      const kind = callable.name === 'set' ? 'set' : 'frozenset';
      if (args.length === 0) return { kind, items: [] };
      return first?.kind === 'list' || first?.kind === 'tuple' ? { kind, items: first.items } : null;
    }
    case 'builtins.bytearray':
    case '__builtin__.bytearray':
      if (args.length === 0) return { kind: 'bytes', value: new Uint8Array(), mutable: true };
      return first?.kind === 'bytes' ? { kind: 'bytes', value: first.value, mutable: true } : null;
    default:
      return null;
  }
}

function run(reader: Reader): PickleValue {
  const stack: StackItem[] = [];
  const memo = new Map<number, PickleValue>();

  const pop = (): PickleValue => {
    const item = stack.pop();
    if (item === undefined || item === MARK) fail('stack underflow');
    return item;
  };
  const top = (): PickleValue => {
    const item = stack[stack.length - 1];
    if (item === undefined || item === MARK) fail('stack underflow');
    return item;
  };
  const popToMark = (): PickleValue[] => {
    const index = stack.lastIndexOf(MARK);
    if (index < 0) fail('no mark');
    const items = stack.splice(index) as StackItem[];
    return items.slice(1) as PickleValue[];
  };
  const push = (value: PickleValue) => stack.push(value);
  const put = (index: number) => memo.set(index, top());
  const get = (index: number) => {
    const value = memo.get(index);
    if (value === undefined) fail('memo miss');
    push(value);
  };
  const pairs = (items: PickleValue[]): [PickleValue, PickleValue][] => {
    if (items.length % 2 !== 0) fail('odd items');
    const out: [PickleValue, PickleValue][] = [];
    for (let index = 0; index < items.length; index += 2) out.push([items[index], items[index + 1]]);
    return out;
  };
  const setItems = (target: PickleValue, entries: [PickleValue, PickleValue][]) => {
    if (target.kind === 'dict') target.entries.push(...entries);
    else if (target.kind === 'object') (target.dictItems ??= []).push(...entries);
    else fail('SETITEMS on non-dict');
  };
  const appendItems = (target: PickleValue, items: PickleValue[]) => {
    if (target.kind === 'list') target.items.push(...items);
    else if (target.kind === 'object') (target.listItems ??= []).push(...items);
    else fail('APPENDS on non-list');
  };
  const addItems = (target: PickleValue, items: PickleValue[]) => {
    if (target.kind !== 'set') fail('ADDITEMS on non-set');
    target.items.push(...items);
  };
  const reduce = (callable: PickleValue, args: PickleValue) => {
    if (args.kind !== 'tuple') fail('REDUCE args not a tuple');
    push(pureReduce(callable, args.items) ?? { kind: 'object', callable, args: args.items });
  };
  const str = (bytes: Uint8Array) => {
    try {
      push({ kind: 'str', value: utf8.decode(bytes) });
    } catch {
      fail('bad utf-8');
    }
  };
  const bytes = (value: Uint8Array, mutable = false) => push({ kind: 'bytes', value: value.slice(), mutable });

  for (;;) {
    const op = reader.byte();
    switch (op) {
      case 0x2e: // STOP
        if (stack.length !== 1) fail('stack not single at STOP');
        return pop();
      case 0x80: // PROTO
        reader.byte();
        break;
      case 0x95: // FRAME：只是分块提示，内容照常顺序读
        reader.uint(8);
        break;
      case 0x28: // MARK
        stack.push(MARK);
        break;
      case 0x30: // POP
        if (stack.pop() === undefined) fail('stack underflow');
        break;
      case 0x31: // POP_MARK
        popToMark();
        break;
      case 0x32: // DUP
        push(top());
        break;

      case 0x4e: // NONE
        push({ kind: 'none' });
        break;
      case 0x88: // NEWTRUE
        push({ kind: 'bool', value: true });
        break;
      case 0x89: // NEWFALSE
        push({ kind: 'bool', value: false });
        break;
      case 0x49: {
        // INT：protocol 0 里 01 / 00 表示布尔
        const text = reader.line();
        if (text === '01' || text === '00') push({ kind: 'bool', value: text === '01' });
        else push({ kind: 'int', value: BigInt(text) });
        break;
      }
      case 0x4a: // BININT
        push({ kind: 'int', value: BigInt(reader.int32()) });
        break;
      case 0x4b: // BININT1
        push({ kind: 'int', value: BigInt(reader.uint(1)) });
        break;
      case 0x4d: // BININT2
        push({ kind: 'int', value: BigInt(reader.uint(2)) });
        break;
      case 0x4c: // LONG
        push({ kind: 'int', value: BigInt(reader.line().replace(/L$/, '')) });
        break;
      case 0x8a: // LONG1
        push({ kind: 'int', value: signedLittleEndian(reader.take(reader.uint(1))) });
        break;
      case 0x8b: // LONG4
        push({ kind: 'int', value: signedLittleEndian(reader.take(reader.uint(4))) });
        break;
      case 0x46: {
        // FLOAT
        const value = Number(reader.line());
        if (Number.isNaN(value)) fail('bad FLOAT');
        push({ kind: 'float', value });
        break;
      }
      case 0x47: // BINFLOAT
        push({ kind: 'float', value: reader.float64() });
        break;

      case 0x53: // STRING（Python 2 str，按字节看）
        bytes(quotedString(reader.line()));
        break;
      case 0x54: // BINSTRING
        bytes(reader.take(reader.int32()));
        break;
      case 0x55: // SHORT_BINSTRING
        bytes(reader.take(reader.uint(1)));
        break;
      case 0x56: // UNICODE
        push({ kind: 'str', value: rawUnicodeEscape(reader.line()) });
        break;
      case 0x58: // BINUNICODE
        str(reader.take(reader.uint(4)));
        break;
      case 0x8c: // SHORT_BINUNICODE
        str(reader.take(reader.uint(1)));
        break;
      case 0x8d: // BINUNICODE8
        str(reader.take(reader.uint(8)));
        break;
      case 0x42: // BINBYTES
        bytes(reader.take(reader.uint(4)));
        break;
      case 0x43: // SHORT_BINBYTES
        bytes(reader.take(reader.uint(1)));
        break;
      case 0x8e: // BINBYTES8
        bytes(reader.take(reader.uint(8)));
        break;
      case 0x96: // BYTEARRAY8
        bytes(reader.take(reader.uint(8)), true);
        break;

      case 0x5d: // EMPTY_LIST
        push({ kind: 'list', items: [] });
        break;
      case 0x6c: // LIST
        push({ kind: 'list', items: popToMark() });
        break;
      case 0x61: {
        // APPEND
        const item = pop();
        appendItems(top(), [item]);
        break;
      }
      case 0x65: {
        // APPENDS
        const items = popToMark();
        appendItems(top(), items);
        break;
      }
      case 0x29: // EMPTY_TUPLE
        push({ kind: 'tuple', items: [] });
        break;
      case 0x74: // TUPLE
        push({ kind: 'tuple', items: popToMark() });
        break;
      case 0x85: // TUPLE1
      case 0x86: // TUPLE2
      case 0x87: {
        // TUPLE3
        const count = op - 0x84;
        const items: PickleValue[] = [];
        for (let index = 0; index < count; index += 1) items.unshift(pop());
        push({ kind: 'tuple', items });
        break;
      }
      case 0x7d: // EMPTY_DICT
        push({ kind: 'dict', entries: [] });
        break;
      case 0x64: // DICT
        push({ kind: 'dict', entries: pairs(popToMark()) });
        break;
      case 0x73: {
        // SETITEM
        const value = pop();
        const key = pop();
        setItems(top(), [[key, value]]);
        break;
      }
      case 0x75: {
        // SETITEMS
        const items = popToMark();
        setItems(top(), pairs(items));
        break;
      }
      case 0x8f: // EMPTY_SET
        push({ kind: 'set', items: [] });
        break;
      case 0x90: {
        // ADDITEMS
        const items = popToMark();
        addItems(top(), items);
        break;
      }
      case 0x91: // FROZENSET
        push({ kind: 'frozenset', items: popToMark() });
        break;

      case 0x67: // GET
        get(Number(reader.line()));
        break;
      case 0x68: // BINGET
        get(reader.uint(1));
        break;
      case 0x6a: // LONG_BINGET
        get(reader.uint(4));
        break;
      case 0x70: // PUT
        put(Number(reader.line()));
        break;
      case 0x71: // BINPUT
        put(reader.uint(1));
        break;
      case 0x72: // LONG_BINPUT
        put(reader.uint(4));
        break;
      case 0x94: // MEMOIZE
        put(memo.size);
        break;

      case 0x63: {
        // GLOBAL
        const module = reader.line();
        push({ kind: 'global', module, name: reader.line() });
        break;
      }
      case 0x93: {
        // STACK_GLOBAL
        const name = asString(pop());
        const module = asString(pop());
        if (name === null || module === null) fail('STACK_GLOBAL needs two str');
        push({ kind: 'global', module, name });
        break;
      }
      case 0x52: {
        // REDUCE
        const args = pop();
        reduce(pop(), args);
        break;
      }
      case 0x81: {
        // NEWOBJ
        const args = pop();
        reduce(pop(), args);
        break;
      }
      case 0x92: {
        // NEWOBJ_EX：kwargs 多半为空，非空时并进参数一起显示
        const kwargs = pop();
        const args = pop();
        const callable = pop();
        if (args.kind !== 'tuple') fail('NEWOBJ_EX args not a tuple');
        const extra = kwargs.kind === 'dict' && kwargs.entries.length === 0 ? [] : [kwargs];
        push({ kind: 'object', callable, args: [...args.items, ...extra] });
        break;
      }
      case 0x69: {
        // INST
        const module = reader.line();
        const name = reader.line();
        push({ kind: 'object', callable: { kind: 'global', module, name }, args: popToMark() });
        break;
      }
      case 0x6f: {
        // OBJ
        const [callable, ...args] = popToMark();
        if (callable === undefined) fail('OBJ without class');
        push({ kind: 'object', callable, args });
        break;
      }
      case 0x62: {
        // BUILD
        const state = pop();
        const target = top();
        if (target.kind !== 'object') fail('BUILD on non-object');
        target.state = state;
        break;
      }

      // PERSID / BINPERSID / EXT1-4 / NEXT_BUFFER / READONLY_BUFFER 依赖解码方的外部上下文，看不了
      default:
        fail(`unsupported opcode 0x${op.toString(16)}`);
    }
  }
}

/**
 * 只认带 PROTO 头（protocol 2 起）的 pickle。protocol 0 / 1 没有魔数，
 * 拿任意二进制去试容易误判，而它们本来大多是可读的文字。
 */
export function decodePickle(bytes: Uint8Array): DecodedPickle | null {
  if (bytes.length < 3 || bytes[0] !== 0x80 || bytes[1] < 2 || bytes[1] > 5) return null;
  const reader = new Reader(bytes);
  try {
    const value = run(reader);
    // STOP 之后还有东西，说明这不是一个完整的 pickle（或者只是碰巧这么开头）
    if (!reader.done) return null;
    return { protocol: bytes[1], value };
  } catch (error) {
    if (error instanceof PickleError || error instanceof SyntaxError || error instanceof RangeError) return null;
    throw error;
  }
}

// ---- 显示：按 Python repr 的写法，长的换行缩进 ----

const INLINE_LIMIT = 72;

function pythonString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\') out += '\\\\';
    else if (char === quote) out += `\\${quote}`;
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += char;
  }
  return out + quote;
}

function pythonBytes(value: Uint8Array): string {
  const hasSingle = value.includes(0x27);
  const quote = hasSingle && !value.includes(0x22) ? '"' : "'";
  let out = `b${quote}`;
  for (const byte of value) {
    if (byte === 0x5c) out += '\\\\';
    else if (byte === quote.charCodeAt(0)) out += `\\${quote}`;
    else if (byte === 0x0a) out += '\\n';
    else if (byte === 0x0d) out += '\\r';
    else if (byte === 0x09) out += '\\t';
    else if (byte < 0x20 || byte >= 0x7f) out += `\\x${byte.toString(16).padStart(2, '0')}`;
    else out += String.fromCharCode(byte);
  }
  return out + quote;
}

function pythonFloat(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return `${value}.0`;
  return String(value);
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** `timezone(timedelta(...))` → `+08:00`；认不出的 tzinfo 返回 null，交给通用写法 */
function utcOffset(tz: PickleValue | undefined): string | null {
  if (tz?.kind !== 'object' || tz.callable.kind !== 'global') return null;
  if (`${tz.callable.module}.${tz.callable.name}` !== 'datetime.timezone') return null;
  const delta = tz.args[0];
  if (delta?.kind !== 'object' || delta.callable.kind !== 'global' || delta.callable.name !== 'timedelta') return null;
  const [days, seconds] = delta.args.map((arg) => (arg.kind === 'int' ? Number(arg.value) : Number.NaN));
  const total = (days ?? 0) * 86400 + (seconds ?? 0);
  if (!Number.isFinite(total)) return null;
  const sign = total < 0 ? '-' : '+';
  const minutes = Math.abs(total) / 60;
  return `${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/**
 * datetime / date / time 的 pickle 参数是打包好的字节（年两字节、月、日……），
 * 原样显示成 `datetime(b'\x07\xea…')` 没法看，这里还原成 ISO 写法。
 */
function temporal(node: Extract<PickleValue, { kind: 'object' }>): string | null {
  if (node.callable.kind !== 'global' || node.callable.module !== 'datetime') return null;
  const [packed, tz] = node.args;
  if (packed?.kind !== 'bytes') return null;
  const b = packed.value;
  const micro = (offset: number) => {
    const value = (b[offset] << 16) | (b[offset + 1] << 8) | b[offset + 2];
    return value ? `.${pad(value, 6)}` : '';
  };
  const zone = () => {
    if (tz === undefined) return '';
    return utcOffset(tz) ?? ` ${format(tz, '', new Set())}`;
  };
  switch (node.callable.name) {
    case 'datetime':
      if (b.length !== 10) return null;
      return `datetime(${pad(b[0] * 256 + b[1], 4)}-${pad(b[2] & 0x7f)}-${pad(b[3])} ${pad(b[4])}:${pad(b[5])}:${pad(b[6])}${micro(7)}${zone()})`;
    case 'date':
      if (b.length !== 4) return null;
      return `date(${pad(b[0] * 256 + b[1], 4)}-${pad(b[2])}-${pad(b[3])})`;
    case 'time':
      if (b.length !== 6) return null;
      return `time(${pad(b[0] & 0x7f)}:${pad(b[1])}:${pad(b[2])}${micro(3)}${zone()})`;
    default:
      return null;
  }
}

function sequence(open: string, close: string, parts: string[], indent: string): string {
  const inline = `${open}${parts.join(', ')}${close}`;
  if (inline.length <= INLINE_LIMIT && !inline.includes('\n')) return inline;
  const inner = `${indent}  `;
  return `${open}\n${parts.map((part) => `${inner}${part},`).join('\n')}\n${indent}${close}`;
}

function format(value: PickleValue, indent: string, open: Set<PickleValue>): string {
  switch (value.kind) {
    case 'none':
      return 'None';
    case 'bool':
      return value.value ? 'True' : 'False';
    case 'int':
      return value.value.toString();
    case 'float':
      return pythonFloat(value.value);
    case 'str':
      return pythonString(value.value);
    case 'bytes':
      return value.mutable ? `bytearray(${pythonBytes(value.value)})` : pythonBytes(value.value);
    case 'global':
      return `${value.module}.${value.name}`;
    default:
      break;
  }
  // 容器可能引用自己（memo 里拿回正在构造的那个），与 Python repr 一样画成省略号
  if (open.has(value)) return value.kind === 'dict' ? '{...}' : '[...]';
  open.add(value);
  const inner = `${indent}  `;
  const child = (node: PickleValue) => format(node, inner, open);
  let text: string;
  switch (value.kind) {
    case 'list':
      text = sequence('[', ']', value.items.map(child), indent);
      break;
    case 'tuple':
      text =
        value.items.length === 1 ? `(${child(value.items[0])},)` : sequence('(', ')', value.items.map(child), indent);
      break;
    case 'set':
      text = value.items.length === 0 ? 'set()' : sequence('{', '}', value.items.map(child), indent);
      break;
    case 'frozenset':
      text = `frozenset(${value.items.length === 0 ? '' : sequence('{', '}', value.items.map(child), indent)})`;
      break;
    case 'dict':
      text = sequence(
        '{',
        '}',
        value.entries.map(([key, item]) => `${child(key)}: ${child(item)}`),
        indent,
      );
      break;
    case 'object': {
      const special = temporal(value);
      if (special !== null) {
        text = special;
        break;
      }
      const parts = value.args.map(child);
      if (value.dictItems) {
        parts.push(sequence('{', '}', value.dictItems.map(([key, item]) => `${child(key)}: ${child(item)}`), inner));
      }
      if (value.listItems) parts.push(sequence('[', ']', value.listItems.map(child), inner));
      // 没有参数只有状态的（pydantic 模型、普通类实例），写成 `模块.类 {状态}` 比空括号好读
      const name = format(value.callable, indent, open);
      const call = parts.length === 0 && value.state ? name : sequence(`${name}(`, ')', parts, indent);
      text = value.state ? `${call} ${format(value.state, indent, open)}` : call;
      break;
    }
  }
  open.delete(value);
  return text;
}

export function formatPickle(value: PickleValue): string {
  return format(value, '', new Set());
}

/** 给界面用：base64 的原始字节 → 能解就给出 protocol 与排好版的文字 */
export function pickleView(base64: string): { protocol: number; text: string } | null {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  const decoded = decodePickle(bytes);
  return decoded && { protocol: decoded.protocol, text: formatPickle(decoded.value) };
}
