import type { DesignMessages } from './aiDesign';
import { createCollectionCommand, shellString } from './mongoCommandText';

/**
 * AI 给出的 MongoDB 集合设计：每个集合一份 `$jsonSchema`（建成集合的 validator）和几条索引。
 * 和关系库的 `SchemaDraft` 是两回事：这里没有外键，引用关系写在字段说明里，数据库不管
 */
export interface MongoDesign {
  collections: MongoCollectionDraft[];
}

export interface MongoCollectionDraft {
  name: string;
  /** `$jsonSchema` 的**内容**（不含 `$jsonSchema` 这一层键） */
  jsonSchema: Record<string, unknown>;
  indexes: Array<{ keys: Record<string, unknown>; unique: boolean }>;
}

export type MongoIssueCode =
  | 'no-collections'
  | 'empty-name'
  | 'invalid-name'
  | 'duplicate-collection'
  | 'collection-exists'
  | 'schema-wrapped'
  | 'unsupported-keyword'
  | 'empty-index';

export interface MongoIssue {
  code: MongoIssueCode;
  collection: string;
  /** 出事的位置（`properties.email.format`）或撞上的名字 */
  detail: string;
}

/**
 * MongoDB 认的 `$jsonSchema` 关键字，照官方文档的 Available Keywords。
 * 用白名单而不是黑名单：MongoDB 自己就只认这张单子，单子之外的一律拒绝——8.0 上试过，
 * `format` / `default` / `$ref` 报「not currently supported」，`examples` / `const` 报
 * 「Unknown $jsonSchema keyword」。这和关系库的类型不同：那里没有一张封闭的单子，所以不校验
 */
const SUPPORTED_KEYWORDS = new Set([
  'bsonType', 'enum', 'type', 'allOf', 'anyOf', 'oneOf', 'not', 'multipleOf', 'maximum',
  'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'maxLength', 'minLength', 'pattern',
  'maxProperties', 'minProperties', 'required', 'additionalProperties', 'properties',
  'patternProperties', 'dependencies', 'additionalItems', 'items', 'maxItems', 'minItems',
  'uniqueItems', 'title', 'description'
]);

const SHAPE = `{ "collections": Array<{ "name": string, "jsonSchema": object, "indexes": Array<{ "keys": object, "unique": boolean }> }> }`;

/**
 * 两条规矩来自实验（2026-09-28，10 条需求）：10 份里 3 份把 `$jsonSchema` 又包了一层，
 * MongoDB 报「Unknown $jsonSchema keyword: $jsonSchema」；关键字只能用它认的那张单子
 */
export function buildMongoDesignMessages(
  requirement: string,
  existingCollections: readonly string[],
  current: MongoDesign | null
): DesignMessages {
  const system = [
    '你是 MongoDB 设计助手。按需求设计 MongoDB 8 的集合，只输出一个 JSON 对象，不要任何解释或代码块标记。',
    `JSON 结构：\n${SHAPE}`,
    'jsonSchema 直接写 $jsonSchema 的内容（最外层是 {"bsonType": "object", ...}），不要再包一层 {"$jsonSchema": ...}。',
    `只能用这些关键字：${[...SUPPORTED_KEYWORDS].join(', ')}。不要用 format、default、$ref、examples、const。`,
    '一对多的从属数据（订单明细、文章的标签）优先内嵌成数组；需要单独查询、会无限增长的才拆成集合，用 xxx_id 字段引用。',
    'indexes 的 keys 写 {"字段": 1} 或 {"字段": -1}；_id 不用写索引。集合名用蛇形小写复数。'
  ].join('\n');
  const parts: string[] = [];
  if (existingCollections.length > 0) {
    parts.push(`库里已有这些集合，不要重名：${existingCollections.join(', ')}`);
  }
  if (current) {
    parts.push(`当前的设计：\n${JSON.stringify(current)}\n\n在它的基础上修改，输出修改后的完整设计。`);
  }
  parts.push(`需求：${requirement.trim()}`);
  return { system, user: parts.join('\n\n') };
}

export type MongoParseResult =
  | { ok: true; design: MongoDesign }
  | { ok: false; reason: 'not-json' | 'bad-shape'; detail: string };

/** 同 `parseDraftResponse`：只容忍一层 ```json 代码块，形状不对就说哪一处，不补字段 */
export function parseMongoDesign(text: string): MongoParseResult {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    return { ok: false, reason: 'not-json', detail: error instanceof Error ? error.message : String(error) };
  }
  const collections = (value as { collections?: unknown } | null)?.collections;
  if (!Array.isArray(collections)) {
    return { ok: false, reason: 'bad-shape', detail: 'collections' };
  }
  for (const [index, collection] of collections.entries()) {
    const at = `collections[${index}]`;
    const record = (collection ?? {}) as Record<string, unknown>;
    if (typeof record.name !== 'string') return { ok: false, reason: 'bad-shape', detail: `${at}.name` };
    if (!isPlainObject(record.jsonSchema)) return { ok: false, reason: 'bad-shape', detail: `${at}.jsonSchema` };
    if (!Array.isArray(record.indexes)) return { ok: false, reason: 'bad-shape', detail: `${at}.indexes` };
    for (const [position, index_] of record.indexes.entries()) {
      const spec = (index_ ?? {}) as Record<string, unknown>;
      if (!isPlainObject(spec.keys) || typeof spec.unique !== 'boolean') {
        return { ok: false, reason: 'bad-shape', detail: `${at}.indexes[${position}]` };
      }
    }
  }
  return { ok: true, design: value as MongoDesign };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 集合名的规矩（MongoDB 文档）：不空、不含 `$` 与空字符、不以 `system.` 开头 */
const INVALID_NAME = /[$\0]|^system\./;

export function validateMongoDesign(design: MongoDesign, existing: readonly string[] = []): MongoIssue[] {
  const issues: MongoIssue[] = [];
  if (design.collections.length === 0) {
    return [{ code: 'no-collections', collection: '', detail: '' }];
  }
  const seen = new Set<string>();
  const existingSet = new Set(existing);
  for (const collection of design.collections) {
    const name = collection.name.trim();
    if (name === '') {
      issues.push({ code: 'empty-name', collection: '', detail: '' });
      continue;
    }
    if (INVALID_NAME.test(name)) {
      issues.push({ code: 'invalid-name', collection: name, detail: name });
    }
    // MongoDB 的集合名区分大小写，重名按原样比
    if (seen.has(name)) {
      issues.push({ code: 'duplicate-collection', collection: name, detail: '' });
    }
    seen.add(name);
    if (existingSet.has(name)) {
      issues.push({ code: 'collection-exists', collection: name, detail: '' });
    }
    if ('$jsonSchema' in collection.jsonSchema) {
      issues.push({ code: 'schema-wrapped', collection: name, detail: '$jsonSchema' });
    } else {
      for (const path of unsupportedKeywords(collection.jsonSchema, '')) {
        issues.push({ code: 'unsupported-keyword', collection: name, detail: path });
      }
    }
    collection.indexes.forEach((index, position) => {
      if (Object.keys(index.keys).length === 0) {
        issues.push({ code: 'empty-index', collection: name, detail: `indexes[${position}]` });
      }
    });
  }
  return issues;
}

/** 递归走一遍 schema：每个「schema 位置」上的键都得在白名单里 */
function unsupportedKeywords(schema: Record<string, unknown>, path: string): string[] {
  const found: string[] = [];
  const at = (key: string) => (path ? `${path}.${key}` : key);
  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      found.push(at(key));
      continue;
    }
    // 这几个关键字的值是「名字 → 子 schema」
    if ((key === 'properties' || key === 'patternProperties' || key === 'dependencies') && isPlainObject(value)) {
      for (const [child, sub] of Object.entries(value)) {
        if (isPlainObject(sub)) found.push(...unsupportedKeywords(sub, `${at(key)}.${child}`));
      }
    } else if ((key === 'allOf' || key === 'anyOf' || key === 'oneOf' || key === 'items') && Array.isArray(value)) {
      value.forEach((sub, index) => {
        if (isPlainObject(sub)) found.push(...unsupportedKeywords(sub, `${at(key)}[${index}]`));
      });
    } else if ((key === 'not' || key === 'items' || key === 'additionalItems' || key === 'additionalProperties') && isPlainObject(value)) {
      found.push(...unsupportedKeywords(value, at(key)));
    }
  }
  return found;
}

export interface MongoStep {
  kind: 'collection' | 'index';
  collection: string;
  /** 交给后端命令的文字：建集合是 options，建索引是 keys（选项另给） */
  document: string;
  options: string;
  /** 预览里显示的 mongosh 写法，和结构页、命令台是同一种 */
  command: string;
}

/** 先建所有集合，再建索引：索引建在还不存在的集合上会隐式建出一个没有校验规则的集合 */
export function planMongoDesign(design: MongoDesign, database: string): MongoStep[] {
  const collections = design.collections.map((collection): MongoStep => {
    const options = JSON.stringify({ validator: { $jsonSchema: collection.jsonSchema } }, null, 2);
    return {
      kind: 'collection',
      collection: collection.name,
      document: options,
      options: '',
      command: createCollectionCommand(database, collection.name, options)
    };
  });
  const indexes = design.collections.flatMap((collection) =>
    collection.indexes.map((index): MongoStep => {
      const keys = JSON.stringify(index.keys);
      const options = JSON.stringify(index.unique ? { unique: true } : {});
      return {
        kind: 'index',
        collection: collection.name,
        document: keys,
        options,
        command: `db.getSiblingDB(${shellString(database)}).getCollection(${shellString(collection.name)}).createIndex(${keys}${index.unique ? `, ${options}` : ''})`
      };
    }));
  return [...collections, ...indexes];
}
