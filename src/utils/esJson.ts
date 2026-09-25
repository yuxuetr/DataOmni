/**
 * Elasticsearch 的回答：解析、排版、摊成表。
 *
 * 不用 `JSON.parse` 取值：`_source` 里的 long 超过 2^53 就会被改掉（`9007199254740993` 读成
 * `…992`），而雪花 id 这类值正是这么大。这里的数一律留着原文；键按原来的次序
 * （JS 对象会把像整数的键挪到最前面）。
 */

export type JsonValue =
  | { kind: 'null' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; text: string }
  | { kind: 'string'; value: string }
  | { kind: 'array'; items: JsonValue[] }
  | { kind: 'object'; entries: Array<[string, JsonValue]> };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// 控制字符在 JSON 字符串里不合法，要原样写进这条规则才拒得掉
// eslint-disable-next-line no-control-regex
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const WHITESPACE = /[ \t\n\r]*/y;

/** 读不懂就是 `null`（HEAD 的空回答、`_cat` 不带 `format=json` 时的纯文本） */
export function parseJson(text: string): JsonValue | null {
  let index = 0;
  const skip = () => {
    WHITESPACE.lastIndex = index;
    WHITESPACE.exec(text);
    index = WHITESPACE.lastIndex;
  };
  const match = (pattern: RegExp): string | null => {
    pattern.lastIndex = index;
    const found = pattern.exec(text);
    if (!found) return null;
    index = pattern.lastIndex;
    return found[0];
  };
  const value = (): JsonValue => {
    skip();
    const char = text[index];
    if (char === '{') {
      index += 1;
      const entries: Array<[string, JsonValue]> = [];
      skip();
      if (text[index] === '}') {
        index += 1;
        return { kind: 'object', entries };
      }
      for (;;) {
        skip();
        const key = match(STRING);
        if (key === null) throw new SyntaxError(`key expected at ${index}`);
        skip();
        if (text[index] !== ':') throw new SyntaxError(`':' expected at ${index}`);
        index += 1;
        entries.push([JSON.parse(key) as string, value()]);
        skip();
        if (text[index] === ',') {
          index += 1;
          continue;
        }
        if (text[index] === '}') {
          index += 1;
          return { kind: 'object', entries };
        }
        throw new SyntaxError(`',' or '}' expected at ${index}`);
      }
    }
    if (char === '[') {
      index += 1;
      const items: JsonValue[] = [];
      skip();
      if (text[index] === ']') {
        index += 1;
        return { kind: 'array', items };
      }
      for (;;) {
        items.push(value());
        skip();
        if (text[index] === ',') {
          index += 1;
          continue;
        }
        if (text[index] === ']') {
          index += 1;
          return { kind: 'array', items };
        }
        throw new SyntaxError(`',' or ']' expected at ${index}`);
      }
    }
    if (char === '"') {
      const token = match(STRING);
      if (token === null) throw new SyntaxError(`bad string at ${index}`);
      return { kind: 'string', value: JSON.parse(token) as string };
    }
    for (const [word, parsed] of [['true', { kind: 'boolean', value: true }], ['false', { kind: 'boolean', value: false }], ['null', { kind: 'null' }]] as const) {
      if (text.startsWith(word, index)) {
        index += word.length;
        return parsed;
      }
    }
    const number = match(NUMBER);
    if (number === null) throw new SyntaxError(`value expected at ${index}`);
    return { kind: 'number', text: number };
  };

  try {
    const parsed = value();
    skip();
    return index === text.length ? parsed : null;
  } catch {
    return null;
  }
}

/** 一格里的写法：字符串不带引号，数用原文，对象与数组压成一行 JSON */
export function formatJsonCell(value: JsonValue): string {
  return value.kind === 'string' ? value.value : stringifyJson(value);
}

/** 写回 JSON。`indent` 给了就排版（两格缩进），空对象、空数组仍写在一行 */
export function stringifyJson(value: JsonValue, indent?: number, depth = 0): string {
  const pad = (level: number) => (indent === undefined ? '' : `\n${' '.repeat(indent * level)}`);
  switch (value.kind) {
    case 'null':
      return 'null';
    case 'boolean':
      return String(value.value);
    case 'number':
      return value.text;
    case 'string':
      return JSON.stringify(value.value);
    case 'array':
      if (value.items.length === 0) return '[]';
      return `[${value.items.map((item) => pad(depth + 1) + stringifyJson(item, indent, depth + 1)).join(',')}${pad(depth)}]`;
    case 'object': {
      if (value.entries.length === 0) return '{}';
      const colon = indent === undefined ? ':' : ': ';
      return `{${value.entries
        .map(([key, entry]) => `${pad(depth + 1)}${JSON.stringify(key)}${colon}${stringifyJson(entry, indent, depth + 1)}`)
        .join(',')}${pad(depth)}}`;
    }
  }
}

/** 响应体给人看的样子：是 JSON 就排版，不是就原样 */
export function prettyBody(body: string): string {
  const parsed = parseJson(body);
  return parsed === null ? body : stringifyJson(parsed, 2);
}

export function jsonField(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return value?.kind === 'object' ? value.entries.find(([name]) => name === key)?.[1] : undefined;
}

/** 这一格没有这个字段（和「值是 null」不一样，画成空格子） */
export const MISSING = null;

export interface EsTable {
  /** 从哪一种回答摊出来的：搜索命中、ES|QL / SQL 的列与值、一组对象（`_cat?format=json`） */
  source: 'hits' | 'columns' | 'objects';
  columns: string[];
  rows: Array<Array<JsonValue | typeof MISSING>>;
}

/**
 * 能画成表的回答。搜索命中：`_id`（跨索引时加 `_index`）、有分数时加 `_score`，再是
 * `_source` 的顶层字段，嵌套的对象写成一行 JSON。认不出的是 `null`，只看 JSON。
 */
export function toEsTable(value: JsonValue | null): EsTable | null {
  if (value === null) return null;
  const hits = jsonField(jsonField(value, 'hits'), 'hits');
  if (hits?.kind === 'array') return hitsTable(hits.items);

  // ES|QL（`values`）与 SQL（`rows`）：`columns` 是 `{name, type}` 的列表
  const columns = jsonField(value, 'columns');
  const rows = jsonField(value, 'values') ?? jsonField(value, 'rows');
  if (columns?.kind === 'array' && rows?.kind === 'array') {
    const names = columns.items.map((column) => {
      const name = jsonField(column, 'name');
      return name?.kind === 'string' ? name.value : '';
    });
    return {
      source: 'columns',
      columns: names,
      rows: rows.items.map((row) => names.map((_, index) => (row.kind === 'array' ? row.items[index] ?? MISSING : MISSING)))
    };
  }

  if (value.kind === 'array' && value.items.length > 0 && value.items.every((item) => item.kind === 'object')) {
    return objectsTable('objects', value.items.map((item) => (item.kind === 'object' ? item.entries : [])));
  }
  return null;
}

function hitsTable(hits: JsonValue[]): EsTable {
  const indices = new Set(hits.map((hit) => formatJsonCell(jsonField(hit, '_index') ?? { kind: 'null' })));
  const scored = hits.some((hit) => jsonField(hit, '_score')?.kind === 'number');
  const meta = [...(indices.size > 1 ? ['_index'] : []), '_id', ...(scored ? ['_score'] : [])];
  const sources = hits.map((hit) => {
    const source = jsonField(hit, '_source');
    return source?.kind === 'object' ? source.entries : [];
  });
  const body = objectsTable('hits', sources);
  // `_source` 里也有叫 `_id` 的字段时，元数据那一列在前、这一列照样留着
  return {
    source: 'hits',
    columns: [...meta, ...body.columns],
    rows: hits.map((hit, index) => [...meta.map((name) => jsonField(hit, name) ?? MISSING), ...body.rows[index]])
  };
}

function objectsTable(source: EsTable['source'], objects: Array<Array<[string, JsonValue]>>): EsTable {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const entries of objects) {
    for (const [key] of entries) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return {
    source,
    columns,
    rows: objects.map((entries) => columns.map((column) => entries.find(([key]) => key === column)?.[1] ?? MISSING))
  };
}

/** 搜索回答里一眼要看的：命中总数（`relation: gte` 时是下限）、服务端耗时、是否超时 */
export function searchFacts(value: JsonValue | null): { total: string | null; atLeast: boolean; tookMs: string | null; timedOut: boolean } | null {
  const hits = jsonField(value ?? undefined, 'hits');
  if (!hits) return null;
  const total = jsonField(hits, 'total');
  // 7.x 起是 `{value, relation}`，更早（以及 `rest_total_hits_as_int`）是一个数
  const count = total?.kind === 'number' ? total : jsonField(total, 'value');
  const relation = jsonField(total, 'relation');
  const took = jsonField(value ?? undefined, 'took');
  const timedOut = jsonField(value ?? undefined, 'timed_out');
  return {
    total: count?.kind === 'number' ? count.text : null,
    atLeast: relation?.kind === 'string' && relation.value === 'gte',
    tookMs: took?.kind === 'number' ? took.text : null,
    timedOut: timedOut?.kind === 'boolean' && timedOut.value
  };
}
