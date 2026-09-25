/**
 * Cypher 的值怎么写给人看：与后端 `CypherValue`（`services/neo4j.rs`）一一对应。
 *
 * 写法照 Cypher 字面量（`(:Person {name: 'a'})`、`[:KNOWS]`、`date('2024-01-02')`），
 * 这样一格里的东西能原样抄回查询里用。表格顶层的字符串不加引号，与 SQL 结果网格一致；
 * 嵌在列表、映射、属性里的才加。
 */

export type CypherEntry = [string, CypherValue];

export interface CypherNodeValue {
  kind: 'node';
  elementId: string;
  labels: string[];
  properties: CypherEntry[];
}

export interface CypherRelationshipValue {
  kind: 'relationship';
  elementId: string;
  type: string;
  startElementId: string;
  endElementId: string;
  properties: CypherEntry[];
}

export interface CypherPathSegment {
  relationship: CypherRelationshipValue;
  /** 关系的方向是否与路径走的方向一致 */
  forward: boolean;
  node: CypherNodeValue;
}

export type CypherValue =
  | { kind: 'null' }
  | { kind: 'boolean'; value: boolean }
  /** 64 位整数按字符串传，JavaScript 的数到 2⁵³ 就不准了 */
  | { kind: 'integer'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  /** base64 */
  | { kind: 'bytes'; value: string }
  | { kind: 'list'; items: CypherValue[] }
  | { kind: 'map'; entries: CypherEntry[] }
  | CypherNodeValue
  | CypherRelationshipValue
  | { kind: 'path'; start: CypherNodeValue; segments: CypherPathSegment[] }
  | { kind: 'point'; value: string }
  | { kind: 'temporal'; value: string }
  | { kind: 'unsupported'; reason: string };

/** Cypher 的字符串字面量：单引号，反斜杠转义（Cypher 不认 SQL 那种 `''`） */
export function cypherString(text: string): string {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `'${escaped}'`;
}

/** 名字（标签、关系类型、属性键）：简单的原样，其余用反引号括起来，里面的反引号写两个 */
export function cypherName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/`/g, '``')}\``;
}

function properties(entries: CypherEntry[]): string {
  return entries.length === 0
    ? ''
    : ` {${entries.map(([key, value]) => `${cypherName(key)}: ${formatCypherValue(value, true)}`).join(', ')}}`;
}

function node(value: CypherNodeValue): string {
  return `(${value.labels.map((label) => `:${cypherName(label)}`).join('')}${properties(value.properties)})`;
}

function relationship(value: CypherRelationshipValue): string {
  return `[:${cypherName(value.type)}${properties(value.properties)}]`;
}

/**
 * 一个值的 Cypher 写法。`nested` 为真时字符串带引号——顶层的格子里不带，与 SQL 网格一致
 */
export function formatCypherValue(value: CypherValue, nested = false): string {
  switch (value.kind) {
    case 'null':
      return 'null';
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'integer':
    case 'float':
    case 'point':
    case 'temporal':
      return value.value;
    case 'string':
      return nested ? cypherString(value.value) : value.value;
    case 'bytes':
      return `0x${bytesToHex(value.value)}`;
    case 'list':
      return `[${value.items.map((item) => formatCypherValue(item, true)).join(', ')}]`;
    case 'map':
      return `{${value.entries.map(([key, item]) => `${cypherName(key)}: ${formatCypherValue(item, true)}`).join(', ')}}`;
    case 'node':
      return node(value);
    case 'relationship':
      return relationship(value);
    case 'path':
      return value.segments.reduce(
        (text, segment) => `${text}${segment.forward ? '-' : '<-'}${relationship(segment.relationship)}${segment.forward ? '->' : '-'}${node(segment.node)}`,
        node(value.start)
      );
    case 'unsupported':
      return `<${value.reason}>`;
  }
}

function bytesToHex(base64: string): string {
  try {
    return Array.from(atob(base64), (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return base64;
  }
}

/**
 * 对象树上点一个标签或关系类型时开出来的查询。库不是连接配置里的那个时带 `USE`
 */
export function browseQuery(
  kind: 'label' | 'relationship-type',
  name: string,
  database: string | null,
  defaultDatabase: string | null,
  limit = 25
): string {
  const use = database && database !== defaultDatabase ? `USE ${cypherName(database)}\n` : '';
  return kind === 'label'
    ? `${use}MATCH (n:${cypherName(name)})\nRETURN n\nLIMIT ${limit}`
    : `${use}MATCH p = ()-[r:${cypherName(name)}]->()\nRETURN p\nLIMIT ${limit}`;
}
