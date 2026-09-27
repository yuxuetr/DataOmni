import type { DesignMessages } from './aiDesign';

/**
 * Neo4j 的图模型设计：节点标签（属性、唯一键、索引）与关系类型。
 *
 * 图库没有「建标签」这一步——标签和关系类型在写第一条数据时才出现，能落到库里的只有
 * 唯一约束与索引。所以这份设计的主要用处是**画出来**让人看清模型，其次才是建约束（TODOs A9b）
 */
export interface GraphDesign {
  labels: GraphLabelDraft[];
  relationships: GraphRelationshipDraft[];
}

export interface GraphProperty {
  name: string;
  /** Cypher 的类型名（STRING、INTEGER、DATE…），只用来显示；Community 版没有属性类型约束 */
  type: string;
}

export interface GraphLabelDraft {
  name: string;
  properties: GraphProperty[];
  /** 唯一标识这个节点的属性，建成 `REQUIRE … IS UNIQUE` */
  key: string[];
  /** 常按它查的属性组，每组一条索引 */
  indexes: string[][];
}

export interface GraphRelationshipDraft {
  type: string;
  from: string;
  to: string;
  properties: GraphProperty[];
}

export type GraphIssueCode =
  | 'no-labels'
  | 'empty-name'
  | 'duplicate-label'
  | 'duplicate-property'
  | 'unknown-property'
  | 'unknown-label'
  | 'duplicate-relationship'
  | 'redundant-index';

export interface GraphIssue {
  severity: 'error' | 'warning';
  code: GraphIssueCode;
  /** 标签名，或关系的 `(:A)-[:T]->(:B)` */
  subject: string;
  detail: string;
}

const SHAPE = `{ "labels": Array<{ "name": string, "properties": Array<{ "name": string, "type": string }>, "key": string[], "indexes": string[][] }>,
  "relationships": Array<{ "type": string, "from": string, "to": string, "properties": Array<{ "name": string, "type": string }> }> }`;

/**
 * 实验（2026-09-28，10 条需求，Neo4j 2026.09 上真建）：83 条约束与索引没有一条报错，
 * 关系两端、键的属性也都对得上——图模型这一侧模型很可靠，设计页的价值在「画出来」。
 * 「索引别重复唯一键」一条是按 Neo4j 的语义加的（唯一约束自带一条索引），不是实验里见到的
 */
export function buildGraphDesignMessages(
  requirement: string,
  existingLabels: readonly string[],
  current: GraphDesign | null
): DesignMessages {
  const system = [
    '你是 Neo4j 图模型设计助手。按需求设计图模型，只输出一个 JSON 对象，不要任何解释或代码块标记。',
    `JSON 结构：\n${SHAPE}`,
    '标签名用大驼峰（User），关系类型用大写蛇形（FOLLOWS），属性名用小驼峰或蛇形；属性类型写 STRING / INTEGER / FLOAT / BOOLEAN / DATE / DATETIME / LIST<STRING> 之一。',
    'key 是唯一标识节点的属性（会建成唯一约束，自带索引）；indexes 里不要再写 key 里的属性。',
    '关系的 from / to 只能是 labels 里的标签名。'
  ].join('\n');
  const parts: string[] = [];
  if (existingLabels.length > 0) {
    parts.push(`库里已有这些标签，可以沿用：${existingLabels.join(', ')}`);
  }
  if (current) {
    parts.push(`当前的设计：\n${JSON.stringify(current)}\n\n在它的基础上修改，输出修改后的完整设计。`);
  }
  parts.push(`需求：${requirement.trim()}`);
  return { system, user: parts.join('\n\n') };
}

export type GraphParseResult =
  | { ok: true; design: GraphDesign }
  | { ok: false; reason: 'not-json' | 'bad-shape'; detail: string };

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isPropertyList = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) =>
    typeof (item as GraphProperty | null)?.name === 'string' && typeof (item as GraphProperty | null)?.type === 'string');

/** 同另两种：只容忍一层 ```json 代码块，形状不对就说哪一处 */
export function parseGraphDesign(text: string): GraphParseResult {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    return { ok: false, reason: 'not-json', detail: error instanceof Error ? error.message : String(error) };
  }
  const record = (value ?? {}) as Record<string, unknown>;
  if (!Array.isArray(record.labels)) return { ok: false, reason: 'bad-shape', detail: 'labels' };
  if (!Array.isArray(record.relationships)) return { ok: false, reason: 'bad-shape', detail: 'relationships' };
  for (const [index, label] of record.labels.entries()) {
    const spec = (label ?? {}) as Record<string, unknown>;
    const at = `labels[${index}]`;
    if (typeof spec.name !== 'string') return { ok: false, reason: 'bad-shape', detail: `${at}.name` };
    if (!isPropertyList(spec.properties)) return { ok: false, reason: 'bad-shape', detail: `${at}.properties` };
    if (!isStringArray(spec.key)) return { ok: false, reason: 'bad-shape', detail: `${at}.key` };
    if (!Array.isArray(spec.indexes) || !spec.indexes.every(isStringArray)) return { ok: false, reason: 'bad-shape', detail: `${at}.indexes` };
  }
  for (const [index, relationship] of record.relationships.entries()) {
    const spec = (relationship ?? {}) as Record<string, unknown>;
    const at = `relationships[${index}]`;
    for (const field of ['type', 'from', 'to'] as const) {
      if (typeof spec[field] !== 'string') return { ok: false, reason: 'bad-shape', detail: `${at}.${field}` };
    }
    if (!isPropertyList(spec.properties)) return { ok: false, reason: 'bad-shape', detail: `${at}.properties` };
  }
  return { ok: true, design: value as GraphDesign };
}

export const relationshipLabel = (relationship: GraphRelationshipDraft): string =>
  `(:${relationship.from})-[:${relationship.type}]->(:${relationship.to})`;

/** 标签、关系类型、属性名在 Neo4j 里都区分大小写，重名按原样比 */
export function validateGraphDesign(design: GraphDesign, existingLabels: readonly string[] = []): GraphIssue[] {
  const issues: GraphIssue[] = [];
  if (design.labels.length === 0) {
    return [{ severity: 'error', code: 'no-labels', subject: '', detail: '' }];
  }
  const known = new Set(existingLabels);
  const seen = new Set<string>();
  for (const label of design.labels) {
    if (label.name.trim() === '') {
      issues.push({ severity: 'error', code: 'empty-name', subject: '', detail: '' });
      continue;
    }
    if (seen.has(label.name)) {
      issues.push({ severity: 'error', code: 'duplicate-label', subject: label.name, detail: '' });
    }
    seen.add(label.name);
    known.add(label.name);
    const properties = new Set<string>();
    for (const property of label.properties) {
      if (properties.has(property.name)) {
        issues.push({ severity: 'error', code: 'duplicate-property', subject: label.name, detail: property.name });
      }
      properties.add(property.name);
    }
    for (const name of [...label.key, ...label.indexes.flat()]) {
      if (!properties.has(name)) {
        issues.push({ severity: 'error', code: 'unknown-property', subject: label.name, detail: name });
      }
    }
    const key = [...label.key].sort().join('\0');
    for (const index of label.indexes) {
      if (label.key.length > 0 && [...index].sort().join('\0') === key) {
        issues.push({ severity: 'warning', code: 'redundant-index', subject: label.name, detail: index.join(', ') });
      }
    }
  }
  const relationships = new Set<string>();
  for (const relationship of design.relationships) {
    const subject = relationshipLabel(relationship);
    if (relationship.type.trim() === '') {
      issues.push({ severity: 'error', code: 'empty-name', subject, detail: '' });
    }
    for (const end of [relationship.from, relationship.to]) {
      if (!known.has(end)) {
        issues.push({ severity: 'error', code: 'unknown-label', subject, detail: end });
      }
    }
    if (relationships.has(subject)) {
      issues.push({ severity: 'error', code: 'duplicate-relationship', subject, detail: '' });
    }
    relationships.add(subject);
  }
  return issues;
}

/** 反引号是 Cypher 的标识符引号，里面的反引号写两遍 */
const quote = (name: string): string => '`' + name.replace(/`/g, '``') + '`';

/**
 * 能落到库里的：唯一约束（先建，自带索引）与索引。名字带标签名，`IF NOT EXISTS` 让重跑一遍不报错。
 * 注意 `IF NOT EXISTS` 在库里已有**等价**的约束或索引时（哪怕名字不同）也会悄悄跳过——
 * 实验里 10 份设计建在同一个库、都有 `User`，后几份的 9 条就是这样没建。结果仍是想要的样子，
 * 所以不拦；和唯一键重复的索引不列进预览（唯一约束自带索引）
 */
export function planGraphDesign(design: GraphDesign): string[] {
  const constraints = design.labels
    .filter((label) => label.key.length > 0)
    .map((label) => {
      const properties = label.key.map((name) => `n.${quote(name)}`);
      const target = properties.length === 1 ? properties[0] : `(${properties.join(', ')})`;
      return `CREATE CONSTRAINT ${quote(`${label.name}_key`)} IF NOT EXISTS FOR (n:${quote(label.name)}) REQUIRE ${target} IS UNIQUE`;
    });
  const indexes = design.labels.flatMap((label) => {
    const key = [...label.key].sort().join('\0');
    return label.indexes
      .filter((index) => index.length > 0 && [...index].sort().join('\0') !== key)
      .map((index) =>
        `CREATE INDEX ${quote(`${label.name}_${index.join('_')}`)} IF NOT EXISTS FOR (n:${quote(label.name)}) ON (${index.map((name) => `n.${quote(name)}`).join(', ')})`);
  });
  return [...constraints, ...indexes];
}

export interface GraphLayoutNode {
  name: string;
  x: number;
  y: number;
}

/**
 * 标签排成一个圆：设计里的标签通常不过十来个，圆上的边互不遮挡节点，也不必引入力导向布局。
 * 半径跟着个数长，保证相邻两个节点之间留得下一个节点宽
 */
export function layoutGraph(design: GraphDesign, nodeWidth: number): { nodes: GraphLayoutNode[]; size: number } {
  const count = design.labels.length;
  const radius = count <= 1 ? 0 : Math.max(140, (count * (nodeWidth + 40)) / (2 * Math.PI));
  const size = radius * 2 + nodeWidth + 120;
  const center = size / 2;
  const nodes = design.labels.map((label, index) => {
    const angle = (2 * Math.PI * index) / Math.max(count, 1) - Math.PI / 2;
    return { name: label.name, x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) };
  });
  return { nodes, size };
}
