import type { ConnectionEnvironment } from '../contracts';
import type { ConfirmationPolicy } from './confirmationPolicy';
import { RISK_ORDER, requiresConfirmation, type StatementRisk } from './statementRisk';
import type { TranslationKey } from '../i18n/translate';

/**
 * Elasticsearch 控制台的写法，与 Kibana Dev Tools 一致：
 *
 * ```
 * GET books/_search
 * {
 *   "query": { "match": { "title": "dune" } }
 * }
 * ```
 *
 * 一条请求从行首的方法开始，到下一个方法行为止；下面跟着的是请求体。请求体里有几份 JSON
 * 就按 NDJSON 发（`_bulk`、`_msearch` 是这种），每份压成一行。`#` 与 `//` 开头的行是注释。
 * JSON 的字符串里不能有换行，所以「行首是方法」「行首是注释」在请求体里不会误认。
 */

export const ES_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'] as const;
export type EsMethod = (typeof ES_METHODS)[number];

export interface EsConsoleRequest {
  method: EsMethod;
  /** 以 `/` 开头，带着查询串 */
  path: string;
  /** 发出去的请求体；NDJSON 每份一行、以换行结尾 */
  body: string | null;
  ndjson: boolean;
  /** 请求体写错了：不发，指出是第几行（从 1 数，整个编辑器里的行号） */
  problem: { line: number; message: string } | null;
  /** 在原文里的起止偏移，给「光标所在的那条」用 */
  from: number;
  to: number;
}

const METHOD_LINE = /^(GET|POST|PUT|DELETE|HEAD)[ \t]+(\S+)[ \t]*$/i;

/** 只有一份 JSON 时也按 NDJSON 发的端点（每份后面都要有换行，服务端才认） */
const NDJSON_ENDPOINTS = new Set(['_bulk', '_msearch']);

function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('#') || trimmed.startsWith('//');
}

export function parseEsConsole(source: string): EsConsoleRequest[] {
  const lines = source.split('\n');
  const starts: number[] = [];
  let offset = 0;
  const lineOffsets = lines.map((line) => {
    const at = offset;
    offset += line.length + 1;
    return at;
  });
  lines.forEach((line, index) => {
    if (METHOD_LINE.test(line.trim())) starts.push(index);
  });

  return starts.map((start, position) => {
    const end = position + 1 < starts.length ? starts[position + 1] : lines.length;
    const [, method, rawPath] = METHOD_LINE.exec(lines[start].trim()) ?? [];
    const path = normalizePath(rawPath ?? '/');
    // 三引号先收成普通字符串，再按行去注释：里面 `//` 开头的那行是脚本的，不是控制台的注释
    const body = collapseTripleQuotes(lines.slice(start + 1, end).join('\n')).split('\n');
    const bodyLines: Array<{ text: string; line: number }> = [];
    body.forEach((text, index) => {
      if (!isComment(text) && text.trim() !== '') bodyLines.push({ text, line: start + 2 + index });
    });
    // 末尾的空行、注释不算这条请求的范围
    let last = start;
    for (let index = start + 1; index < end; index += 1) {
      if (!isComment(lines[index]) && lines[index].trim() !== '') last = index;
    }
    const request: EsConsoleRequest = {
      method: method.toUpperCase() as EsMethod,
      path,
      body: null,
      ndjson: false,
      problem: null,
      from: lineOffsets[start] + (lines[start].length - lines[start].trimStart().length),
      to: lineOffsets[last] + lines[last].trimEnd().length
    };
    if (bodyLines.length === 0) return request;

    const split = splitJsonValues(bodyLines);
    if ('problem' in split) return { ...request, problem: split.problem };
    const ndjson = split.values.length > 1 || NDJSON_ENDPOINTS.has(endpoint(path));
    return {
      ...request,
      ndjson,
      body: ndjson
        ? split.values.map((value) => value.text.replace(/\s*\n\s*/g, ' ')).join('\n') + '\n'
        : split.values[0].text
    };
  });
}

/**
 * 真会发出去的那几条：依次发、一条失败就停，请求体写错的那条之后的一条也发不出去。
 * 确认框只该为这些问——为一条到不了的 `DELETE` 弹框，人会以为它要执行了
 */
export function reachableRequests(requests: readonly EsConsoleRequest[]): EsConsoleRequest[] {
  const broken = requests.findIndex((request) => request.problem !== null);
  return broken === -1 ? [...requests] : requests.slice(0, broken + 1);
}

/** 光标所在的那条；落在第一条之前算第一条，落在两条之间算前一条 */
export function esRequestAt(source: string, offset: number): EsConsoleRequest | null {
  const requests = parseEsConsole(source);
  let found: EsConsoleRequest | null = null;
  for (const request of requests) {
    if (request.from <= offset) found = request;
  }
  return found ?? requests[0] ?? null;
}

/**
 * Kibana 的三引号字符串：`"""` 到 `"""` 之间原样是一个字符串，可以换行，引号与反斜杠不用转义。
 * ES|QL、SQL 与 painless 脚本的官方文档都这么写，照抄过来就该能发。规则照 Kibana 的
 * `collapseLiteralStrings`（同一个正则：只去掉开头紧跟的那个换行与收尾前的那个换行），
 * 另把字符串吞掉的换行补在它后面——JSON 里那是空白，后面各行的行号就还是编辑器里的行号
 */
const TRIPLE_QUOTED = /"""(?:\s*\r?\n)?((?:.|\r?\n)*?)(?:\r?\n\s*)?"""/g;

function collapseTripleQuotes(text: string): string {
  return text.replace(TRIPLE_QUOTED, (match, literal: string) =>
    JSON.stringify(literal) + '\n'.repeat(match.split('\n').length - 1)
  );
}

/** `books/_search` 与 `/books/_search` 一样。只收路径：写了主机的在后端也会被拒 */
function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/** 路径里最后一个以 `_` 开头的段：`/books/_search` 是 `_search` */
function endpoint(path: string): string {
  const segments = pathSegments(path);
  return [...segments].reverse().find((segment) => segment.startsWith('_')) ?? '';
}

function pathSegments(path: string): string[] {
  const [bare] = path.split('?');
  return bare.split('/').filter((segment) => segment !== '').map((segment) => segment.toLowerCase());
}

/**
 * 把请求体切成一份份 JSON：数括号、认字符串。只看语法对不对（`JSON.parse`），发出去的是原文——
 * 解析再写回会把超过 2^53 的整数改掉
 */
function splitJsonValues(
  lines: ReadonlyArray<{ text: string; line: number }>
): { values: Array<{ text: string; line: number }> } | { problem: { line: number; message: string } } {
  const values: Array<{ text: string; line: number }> = [];
  let current: string[] = [];
  let startLine = 0;
  let depth = 0;
  let inString = false;
  for (const { text, line } of lines) {
    if (current.length === 0) startLine = line;
    current.push(text);
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (char === '\\') index += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === '{' || char === '[') {
        depth += 1;
      } else if (char === '}' || char === ']') {
        depth -= 1;
      }
    }
    // 字符串到行尾还没收：JSON 里不行，交给下面的 `JSON.parse` 报
    if (depth <= 0 || inString) {
      const value = current.join('\n').trim();
      try {
        JSON.parse(value);
      } catch (error) {
        return { problem: { line: startLine, message: error instanceof Error ? error.message : String(error) } };
      }
      values.push({ text: value, line: startLine });
      current = [];
      depth = 0;
      inString = false;
    }
  }
  if (current.length > 0) {
    return { problem: { line: startLine, message: 'Unexpected end of JSON input' } };
  }
  return { values };
}

/** 这些端点只读：`POST books/_search` 与 `GET` 一样 */
const READ_ENDPOINTS: ReadonlySet<string> = new Set([
  '_search', '_msearch', '_count', '_mget', '_explain', '_validate', '_field_caps', '_termvectors',
  '_mtermvectors', '_analyze', '_sql', '_query', '_eql', '_async_search', '_pit', '_render',
  '_resolve', '_knn_search', '_terms_enum', '_rank_eval', '_search_shards', '_cat'
]);

/** 按查询改、删一大片，或一次一批：影响多少看不出来 */
const BULK_ENDPOINTS: ReadonlySet<string> = new Set([
  '_bulk', '_delete_by_query', '_update_by_query', '_reindex'
]);

/** 删了就连数据一起没的：数据流、快照 */
const DATA_HOLDERS: ReadonlySet<string> = new Set(['_data_stream', '_snapshot']);

/** 单个文档的写：路径里带着文档 id */
const DOCUMENT_ENDPOINTS: ReadonlySet<string> = new Set(['_doc', '_create', '_update', '_source']);

/**
 * 这条请求要不要先确认：等级沿用 SQL 那一套（`StatementRisk`），门槛也沿用
 * 「设置 → 危险语句确认」里按环境配的那一份。
 *
 * 只看方法与路径。`POST _search` 带什么请求体都是读；`DELETE books` 删掉整个索引，
 * 请求体里什么也没写。
 */
export function classifyEsRisk(method: EsMethod, path: string): StatementRisk {
  const segments = pathSegments(path);
  // `_all` 写在索引的位置上，是「所有索引」，不是端点
  const endpoints = segments.filter((segment) => segment.startsWith('_') && segment !== '_all');
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (endpoints.some((segment) => READ_ENDPOINTS.has(segment))) {
    // 关掉一个游标、一个异步搜索：不动数据
    return method === 'DELETE' ? 'scoped-write' : 'read';
  }
  // 改权限、改集群设置：影响面不在数据里，按批量写对待
  if (endpoints.includes('_security') || endpoints.includes('_cluster')) return 'bulk-write';
  if (endpoints.some((segment) => BULK_ENDPOINTS.has(segment))) return 'bulk-write';
  const document = endpoints.find((segment) => DOCUMENT_ENDPOINTS.has(segment));
  if (document) {
    const hasId = segments.indexOf(document) < segments.length - 1;
    // `POST books/_doc` 让服务端起 id：只加一份
    return method === 'POST' && document === '_doc' && !hasId ? 'append' : 'scoped-write';
  }
  if (method === 'DELETE') {
    // 删索引（路径里只有索引名）、删数据流、删快照：连同里面的全部数据。
    // 删别名、模板、策略不动数据
    return endpoints.length === 0 || endpoints.some((segment) => DATA_HOLDERS.has(segment))
      ? 'destructive'
      : 'scoped-write';
  }
  // `PUT books` 建索引
  if (method === 'PUT' && segments.length === 1 && endpoints.length === 0) return 'append';
  return 'scoped-write';
}

/** 确认框里风险那半句，只有和 SQL 说法不同的等级才列 */
export const ES_RISK_DESCRIPTION_KEYS: Partial<Record<StatementRisk, TranslationKey>> = {
  'bulk-write': 'es.risk.bulkWrite'
};

/** 这一批里最该确认的那条；都不必确认时是 `null`。与 SQL 那边同一个规矩 */
export function riskiestEsRequest(
  requests: ReadonlyArray<Pick<EsConsoleRequest, 'method' | 'path'>>,
  environment: ConnectionEnvironment,
  policy?: ConfirmationPolicy
): { request: Pick<EsConsoleRequest, 'method' | 'path'>; risk: StatementRisk } | null {
  let worst: { request: Pick<EsConsoleRequest, 'method' | 'path'>; risk: StatementRisk } | null = null;
  for (const request of requests) {
    const risk = classifyEsRisk(request.method, request.path);
    if (requiresConfirmation(risk, environment, policy)
      && (!worst || RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(worst.risk))) {
      worst = { request, risk };
    }
  }
  return worst;
}

/**
 * 对象树上删一个索引或数据流发的请求。别名不在里面：删别名不动数据，而右键「删除」在别的库上
 * 都是连数据一起删——同一个按钮做两种轻重不同的事，人会按轻的那种理解它
 */
export function esDropRequest(kind: string, name: string): { method: 'DELETE'; path: string } | null {
  if (kind === 'index') return { method: 'DELETE', path: `/${encodeURIComponent(name)}` };
  if (kind === 'data-stream') return { method: 'DELETE', path: `/_data_stream/${encodeURIComponent(name)}` };
  return null;
}

/** 对象树点开一个索引、别名、数据流：看前 20 份 */
export function browseRequest(name: string): string {
  return `GET ${encodeURIComponent(name)}/_search\n{\n  "size": 20,\n  "query": { "match_all": {} }\n}\n`;
}
