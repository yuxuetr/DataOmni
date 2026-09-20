import { DatabaseType } from '../contracts/connection';
import type { DatabaseObject, DatabaseObjectKind } from '../contracts/databaseMetadata';
import type { TranslationKey } from '../i18n/translate';

export type { DatabaseObject, DatabaseObjectKind };

/**
 * 类型到文案键的映射，不是到文案本身：这是个模块级常量，用不了 hook，
 * 而文案要跟着语言走。调用方拿到键再翻译。
 */
export const KIND_LABEL_KEYS: Record<DatabaseObjectKind, TranslationKey> = {
  table: 'objectKind.table',
  view: 'objectKind.view',
  'materialized-view': 'objectKind.materialized-view',
  function: 'objectKind.function',
  procedure: 'objectKind.procedure',
  sequence: 'objectKind.sequence'
};

/** 分组次序。按「最常点开的在最上面」排，不按字母。 */
const KIND_ORDER: DatabaseObjectKind[] = [
  'table',
  'view',
  'materialized-view',
  'function',
  'procedure',
  'sequence'
];

export interface ObjectTreeNode {
  /** 用作 React key 与展开状态的键 */
  key: string;
  label: string;
  objects: DatabaseObject[];
  children?: ObjectTreeNode[];
}

/**
 * 顶层是否保留 schema 一层。
 *
 * MySQL 与 SQLite 上不保留：连接时已经选定了库，再显示一层库名是噪音。
 * PostgreSQL 上保留：一个连接能横跨 public、业务 schema、扩展装的 schema，
 * schema 是真实维度，抹掉它会让两个同名表挤在一起。
 */
export function showsSchemaLevel(dbType: DatabaseType): boolean {
  return dbType === DatabaseType.PostgreSQL;
}

/** 表、视图、物化视图有行，能用表视图打开；函数与序列没有。 */
export function isBrowsableKind(kind: DatabaseObjectKind): boolean {
  return kind === 'table' || kind === 'view' || kind === 'materialized-view';
}

export function normalizeObjectRows(
  rows: ReadonlyArray<Record<string, unknown>>
): DatabaseObject[] {
  return rows.flatMap(row => {
    const name = text(row.object_name);
    if (!name) {
      return [];
    }

    const schema = text(row.object_schema);
    return [
      {
        schema: schema || null,
        name,
        kind: toKind(text(row.object_kind)),
        // 没有 id 就退回名字：MySQL 与 SQLite 的对象名本来就唯一
        id: text(row.object_id) || name
      }
    ];
  });
}

/**
 * `kindLabel` 由调用方传入而不是在这里查表：这个函数是纯的、可单测的，
 * 把翻译塞进来会让它依赖当前语言，测试也要跟着起一个 store。
 */
export function buildObjectTree(
  objects: readonly DatabaseObject[],
  withSchemaLevel: boolean,
  kindLabel: (kind: DatabaseObjectKind) => string
): ObjectTreeNode[] {
  if (!withSchemaLevel) {
    return groupByKind(objects, '', kindLabel);
  }

  const bySchema = new Map<string, DatabaseObject[]>();
  for (const object of objects) {
    const schema = object.schema ?? '';
    const group = bySchema.get(schema) ?? [];
    group.push(object);
    bySchema.set(schema, group);
  }

  return [...bySchema.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([schema, schemaObjects]) => ({
      key: `schema:${schema}`,
      label: schema,
      objects: schemaObjects,
      children: groupByKind(schemaObjects, `${schema}:`, kindLabel)
    }));
}

function groupByKind(
  objects: readonly DatabaseObject[],
  keyPrefix: string,
  kindLabel: (kind: DatabaseObjectKind) => string
): ObjectTreeNode[] {
  return KIND_ORDER.flatMap(kind => {
    const matching = objects
      .filter(object => object.kind === kind)
      .sort((left, right) => left.name.localeCompare(right.name));

    // 查不到的类型不出现空分组：一行「函数 0」既占地方又不提供信息
    return matching.length === 0
      ? []
      : [{ key: `${keyPrefix}kind:${kind}`, label: kindLabel(kind), objects: matching }];
  });
}

function toKind(value: string): DatabaseObjectKind {
  const normalized = value.toLowerCase();
  return (KIND_ORDER as string[]).includes(normalized)
    ? (normalized as DatabaseObjectKind)
    // 认不出来的当表：PostgreSQL 的 FOREIGN / 分区表都是能查数据的表，
    // 凭空造一个新分组只会让人以为多了一类对象
    : 'table';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}
