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
  collection: 'objectKind.collection',
  view: 'objectKind.view',
  'materialized-view': 'objectKind.materialized-view',
  function: 'objectKind.function',
  procedure: 'objectKind.procedure',
  sequence: 'objectKind.sequence'
};

/**
 * 指着**一个**对象时用的名字。
 *
 * 上面那份是分组抬头，英文是复数（Views、Sequences）。拿它去标一个对象，
 * 英文界面上会印出 `public.monthly_revenue [Views]`——一个视图被标成
 * 「视图们」。中文两份一样，所以这处错误只在英文界面上看得见。
 */
export const KIND_BADGE_KEYS: Record<DatabaseObjectKind, TranslationKey> = {
  table: 'objectKindOne.table',
  collection: 'objectKindOne.collection',
  view: 'objectKindOne.view',
  'materialized-view': 'objectKindOne.materialized-view',
  function: 'objectKindOne.function',
  procedure: 'objectKindOne.procedure',
  sequence: 'objectKindOne.sequence'
};

/** 分组次序。按「最常点开的在最上面」排，不按字母。 */
const KIND_ORDER: DatabaseObjectKind[] = [
  'table',
  'collection',
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
 * PostgreSQL 与 SQL Server 上保留：一个连接能横跨 public / dbo、业务 schema，
 * schema 是真实维度，抹掉它会让两个同名表挤在一起。
 */
export function showsSchemaLevel(dbType: DatabaseType): boolean {
  // SQL Server 与 PostgreSQL 一样：一个库里有 dbo 和业务 schema，schema 是真实维度
  // Oracle 的 schema 就是用户：一个连接能看到别的用户授给它的表
  // MongoDB 的一个连接横跨所有库，库就是这一层
  return dbType === DatabaseType.PostgreSQL
    || dbType === DatabaseType.SqlServer
    || dbType === DatabaseType.Oracle
    || dbType === DatabaseType.MongoDB;
}

/** 表、集合、视图、物化视图有行（文档），能打开；函数与序列没有。 */
export function isBrowsableKind(kind: DatabaseObjectKind): boolean {
  return kind === 'table' || kind === 'collection' || kind === 'view' || kind === 'materialized-view';
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
 * 一个分组里最多画多少项。
 *
 * 这个数是量出来的，不是拍的。同一套量法（点一下分组标题，等到节点全部落地，
 * 取 9 次中位数）在 MySQL 形态的对象树上：
 *
 * | 单组项数 | 展开中位数 | 页面节点数 |
 * | --- | --- | --- |
 * | 200 | 24.8ms | 1,699 |
 * | 500 | 41.7ms | 3,799 |
 * | 2000 | 183.5ms | 14,299 |
 * | 5000 | 300.1ms | 35,299 |
 *
 * 200 是唯一落在一帧预算里的档位，而且这还是 Chrome 里的开发构建，打包后的
 * WebView 只会更慢。和网格的 `MAX_UNVIRTUALIZED_ROWS` 同值不是巧合——两处
 * 问的是同一个问题：一次交互能画多少个节点。
 */
export const MAX_RENDERED_TREE_ITEMS = 200;

export interface RenderedTreeObjects {
  shown: DatabaseObject[];
  /**
   * 被上限挡住的个数。
   *
   * 必须画出来。悄悄少掉几百个对象，比多等 300ms 严重得多：慢是看得见的，
   * 而「这个库里没有这张表」是一个会让人去改连接配置的错误结论。
   */
  hidden: number;
}

export function renderedTreeObjects(
  objects: readonly DatabaseObject[]
): RenderedTreeObjects {
  return {
    shown: objects.slice(0, MAX_RENDERED_TREE_ITEMS),
    hidden: Math.max(0, objects.length - MAX_RENDERED_TREE_ITEMS)
  };
}

/**
 * 按名字筛选对象。匹配限定名（`schema.name`），所以输 schema 名能把那个 schema
 * 整个筛出来。
 *
 * **是子串，不是命令面板那套子序列匹配。** 一开始复用了 `matchFuzzy`，理由是
 * 「一棵树里两种搜索规则记不住」；写完测试才发现输 `or` 会把 `customers` 也留下
 * （c-u-s-t-**o**-m-e-**r**-s 顺序上确实命中）。面板能容忍这种宽松，是因为它按
 * 分数排序、只露前 50 条，噪音会沉下去；而树里结果保持字母序、一条不漏地铺开，
 * 噪音就摊在每一屏里。而人筛东西时第一个输入的恰恰是两三个字母。
 *
 * 两个控件两件事：树是「把看得见的东西缩窄」，面板是「凭印象找一个东西」。
 *
 * 顺序原样保留，不按相似度重排——树是按名字排好的，筛一下就跳位置会让人
 * 每次都要重新找一遍自己刚刚看到的那一行。
 */
export function filterObjects(
  objects: readonly DatabaseObject[],
  query: string
): DatabaseObject[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return [...objects];
  }
  return objects.filter((object) =>
    (object.schema ? `${object.schema}.${object.name}` : object.name)
      .toLowerCase()
      .includes(normalized)
  );
}

/**
 * `kindLabel` 由调用方传入而不是在这里查表：这个函数是纯的、可单测的，
 * 把翻译塞进来会让它依赖当前语言，测试也要跟着起一个 store。
 */
/**
 * 排在最后的 schema（库）：服务端自己的那几个。几乎没人是来看它们的，但也不藏——
 * 排在最前面的话，默认展开的就是它们，而业务库要往下找
 */
export function trailingSchemas(dbType: DatabaseType): ReadonlySet<string> {
  return dbType === DatabaseType.MongoDB ? MONGODB_SYSTEM_DATABASES : NO_TRAILING_SCHEMAS;
}

const MONGODB_SYSTEM_DATABASES: ReadonlySet<string> = new Set(['admin', 'config', 'local']);
const NO_TRAILING_SCHEMAS: ReadonlySet<string> = new Set();

export function buildObjectTree(
  objects: readonly DatabaseObject[],
  withSchemaLevel: boolean,
  kindLabel: (kind: DatabaseObjectKind) => string,
  trailing: ReadonlySet<string> = NO_TRAILING_SCHEMAS
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
    .sort(([left], [right]) => (
      Number(trailing.has(left)) - Number(trailing.has(right)) || left.localeCompare(right)
    ))
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
