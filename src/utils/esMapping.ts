import { jsonField, stringifyJson, type JsonValue } from './esJson';

/**
 * 索引的 Mapping 摊成一行一个字段：`author.name` 这样按路径写，多字段（`title.kw`）跟在它的
 * 主字段后面，运行时字段另成一组。
 *
 * 参数不逐个认：`analyzer`、`format`、`ignore_above`、`dims`……除了 `type` 与装子字段的
 * `properties` / `fields`，其余的原样列成「细节」。ES 每个版本都在加参数，逐个认的话，
 * 认不出来的那些就在界面上消失了。
 */

export interface MappingField {
  path: string;
  /** 缩进层级：`author` 是 0，`author.name` 是 1 */
  depth: number;
  /** 没写 `type` 而有 `properties` 的是对象（ES 的默认） */
  type: string;
  /** 多字段：同一份值换一种方式索引（`title` 是 text，`title.kw` 是 keyword） */
  multiField: boolean;
  details: Array<[string, string]>;
}

export interface IndexMapping {
  fields: MappingField[];
  runtime: MappingField[];
  /** `dynamic`：没写就是 `true`（新字段自动加进 Mapping） */
  dynamic: string;
  /** `_source` 关掉了：文档原文不存，搜出来只有 id */
  sourceDisabled: boolean;
}

const NESTING_KEYS = new Set(['type', 'properties', 'fields']);

function text(value: JsonValue): string {
  return value.kind === 'string' ? value.value : stringifyJson(value);
}

function walk(properties: JsonValue | undefined, prefix: string, depth: number, out: MappingField[]): void {
  if (properties?.kind !== 'object') return;
  for (const [name, definition] of properties.entries) {
    const path = prefix ? `${prefix}.${name}` : name;
    out.push(fieldOf(path, depth, definition, false));
    const fields = jsonField(definition, 'fields');
    if (fields?.kind === 'object') {
      for (const [sub, subDefinition] of fields.entries) {
        out.push(fieldOf(`${path}.${sub}`, depth + 1, subDefinition, true));
      }
    }
    walk(jsonField(definition, 'properties'), path, depth + 1, out);
  }
}

function fieldOf(path: string, depth: number, definition: JsonValue, multiField: boolean): MappingField {
  const type = jsonField(definition, 'type');
  const entries = definition.kind === 'object' ? definition.entries : [];
  return {
    path,
    depth,
    type: type?.kind === 'string' ? type.value : 'object',
    multiField,
    details: entries.filter(([key]) => !NESTING_KEYS.has(key)).map(([key, value]) => [key, text(value)])
  };
}

/**
 * `GET 索引/_mapping` 的回答 → 这个索引的 Mapping。回答按具体索引分组；给的是索引名，
 * 就取同名那一组，找不到（名字是别名）取第一组。
 */
export function readIndexMapping(response: JsonValue | null, index: string): IndexMapping | null {
  if (response?.kind !== 'object' || response.entries.length === 0) return null;
  const entry = response.entries.find(([name]) => name === index) ?? response.entries[0];
  const mappings = jsonField(entry[1], 'mappings');
  if (mappings?.kind !== 'object') return null;
  const fields: MappingField[] = [];
  walk(jsonField(mappings, 'properties'), '', 0, fields);
  const runtime: MappingField[] = [];
  const runtimeFields = jsonField(mappings, 'runtime');
  if (runtimeFields?.kind === 'object') {
    for (const [name, definition] of runtimeFields.entries) runtime.push(fieldOf(name, 0, definition, false));
  }
  const dynamic = jsonField(mappings, 'dynamic');
  const sourceEnabled = jsonField(jsonField(mappings, '_source'), 'enabled');
  return {
    fields,
    runtime,
    dynamic: dynamic ? text(dynamic) : 'true',
    sourceDisabled: sourceEnabled?.kind === 'boolean' && !sourceEnabled.value
  };
}

export interface IndexSettings {
  shards: string | null;
  replicas: string | null;
  /** 建索引的时刻，毫秒 */
  createdAt: number | null;
  uuid: string | null;
}

/** `GET 索引/_settings?flat_settings=true` 的回答里一眼要看的几项 */
export function readIndexSettings(response: JsonValue | null, index: string): IndexSettings | null {
  if (response?.kind !== 'object' || response.entries.length === 0) return null;
  const entry = response.entries.find(([name]) => name === index) ?? response.entries[0];
  const settings = jsonField(entry[1], 'settings');
  const read = (key: string) => {
    const value = jsonField(settings, key);
    return value ? text(value) : null;
  };
  const created = Number(read('index.creation_date'));
  return {
    shards: read('index.number_of_shards'),
    replicas: read('index.number_of_replicas'),
    createdAt: Number.isFinite(created) && created > 0 ? created : null,
    uuid: read('index.uuid')
  };
}

/** `GET 索引/_alias` 的回答 → 指向它的别名 */
export function readIndexAliases(response: JsonValue | null, index: string): string[] {
  if (response?.kind !== 'object') return [];
  const entry = response.entries.find(([name]) => name === index) ?? response.entries[0];
  const aliases = jsonField(entry?.[1], 'aliases');
  return aliases?.kind === 'object' ? aliases.entries.map(([name]) => name) : [];
}

/** 按路径的一段（不分大小写）或整个类型名筛：`title` 连带 `title.kw`，`keyword` 列出所有 keyword 字段 */
export function filterMappingFields(fields: readonly MappingField[], query: string): MappingField[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...fields];
  return fields.filter((field) => field.path.toLowerCase().includes(needle)
    || field.type.toLowerCase() === needle);
}
