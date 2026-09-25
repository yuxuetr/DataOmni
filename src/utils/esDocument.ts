import { jsonField, parseJson, stringifyJson, type JsonValue } from './esJson';

/**
 * 从搜索结果里改一份文档、删一份文档。
 *
 * 并发靠 ES 自己的乐观锁：读的时候拿到 `_seq_no` 与 `_primary_term`，写的时候带上
 * `if_seq_no` / `if_primary_term`；这之间别人写过，服务端回 409，不会覆盖掉别人的改动。
 * 写完用 `refresh=wait_for`：等改动能被搜到再回来，接着重发的那条搜索才看得见它。
 */

/** 一份文档在哪：命中里的 `_index`（数据流的是后备索引）、`_id`，自定义了路由的还有 `_routing` */
export interface DocumentAddress {
  index: string;
  id: string;
  routing: string | null;
}

export interface DocumentVersion {
  seqNo: string;
  primaryTerm: string;
}

export interface LoadedDocument {
  version: DocumentVersion;
  /** 排好版的 `_source`，数用原文 */
  sourceText: string;
}

function textOf(value: JsonValue | undefined): string | null {
  if (value?.kind === 'string') return value.value;
  if (value?.kind === 'number') return value.text;
  return null;
}

/** 命中 → 地址；缺 `_index` 或 `_id` 的（聚合里的 top_hits 之类照样有，`_source` 被关掉的也有）不能改 */
export function documentAddress(hit: JsonValue): DocumentAddress | null {
  const index = textOf(jsonField(hit, '_index'));
  const id = textOf(jsonField(hit, '_id'));
  if (index === null || id === null) return null;
  return { index, id, routing: textOf(jsonField(hit, '_routing')) };
}

/** `GET 索引/_doc/id` 的回答。没找到、`_source` 关着的是 `null` */
export function readDocument(response: JsonValue | null): LoadedDocument | null {
  const field = (key: string) => jsonField(response ?? undefined, key);
  const found = field('found');
  const source = field('_source');
  const seqNo = textOf(field('_seq_no'));
  const primaryTerm = textOf(field('_primary_term'));
  if (found?.kind !== 'boolean' || !found.value || source?.kind !== 'object' || seqNo === null || primaryTerm === null) {
    return null;
  }
  return { version: { seqNo, primaryTerm }, sourceText: stringifyJson(source, 2) };
}

function query(address: DocumentAddress, extra: Array<[string, string]>): string {
  const params = [...(address.routing !== null ? [['routing', address.routing] as [string, string]] : []), ...extra];
  return params.length === 0 ? '' : `?${params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}

function documentPath(address: DocumentAddress): string {
  return `/${encodeURIComponent(address.index)}/_doc/${encodeURIComponent(address.id)}`;
}

/** 读：拿最新的 `_source` 与版本 */
export function readPath(address: DocumentAddress): string {
  return documentPath(address) + query(address, []);
}

/** 改或删：带着读到的版本，等到能被搜到再回来 */
export function writePath(address: DocumentAddress, version: DocumentVersion): string {
  return documentPath(address) + query(address, [
    ['if_seq_no', version.seqNo],
    ['if_primary_term', version.primaryTerm],
    ['refresh', 'wait_for']
  ]);
}

/** 编辑框里的文字能不能当 `_source` 发：必须是一个 JSON 对象。发的是原文，不经解析再写回 */
export function sourceProblem(text: string): 'invalid' | 'not-object' | null {
  const parsed = parseJson(text.trim());
  if (parsed === null) return 'invalid';
  return parsed.kind === 'object' ? null : 'not-object';
}

/** 写的回答怎么说：成了、别处改过了（409）、已经没了（404）、别的错 */
export function writeOutcome(status: number): 'done' | 'conflict' | 'gone' | 'failed' {
  if (status >= 200 && status < 300) return 'done';
  if (status === 409) return 'conflict';
  if (status === 404) return 'gone';
  return 'failed';
}
