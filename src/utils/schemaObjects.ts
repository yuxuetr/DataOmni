/**
 * 把目录查询返回的「每列一行」结果合成结构对象。
 *
 * 分组本身就是逻辑：复合键的列顺序必须按 ordinal 决定，不能按行到达的顺序。
 * 驱动不保证行序，而一旦本表列与被引用列错位，结果看上去完全正常——
 * 三列外键指向了三个错的列，页面上却是一行整齐的 `(a, b, c) → (x, y, z)`。
 */

/**
 * 数据库给不出列名时的占位。SQLite 的表达式索引既没有列名也没有表达式原文。
 *
 * 这里不写死文案：`groupIndexRows` 是纯函数，翻译由调用方传进来，
 * 免得为了一个占位符让它依赖当前语言。
 */
export const DEFAULT_EXPRESSION_COLUMN_PLACEHOLDER = '<expression>';

/**
 * 一张表的结构对象。
 *
 * 定义放在这里而不是画它的组件里：它同时被 `appStore` 的结构缓存引用，
 * 而 store 不该反过来依赖组件。
 */
export interface SchemaObjects {
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  /** null = 该方言没有检查约束目录，不是「没有检查约束」 */
  checkConstraints: CheckConstraintInfo[] | null;
  /** 对象定义原文；空 = 数据库不提供（PostgreSQL 的表） */
  ddl: string | null;
  triggers: TriggerInfo[];
  /**
   * 读失败的段及原因。在这里的段不能画成「没有」——「没有索引」和「没查到」
   * 对用户的意义完全相反，而前者还会让表被判成只读。
   */
  failures: Partial<Record<SchemaObjectSection, string>>;
}

export type SchemaObjectSection = 'indexes' | 'foreignKeys' | 'checkConstraints' | 'ddl' | 'triggers';

type SchemaObjectValues = Omit<SchemaObjects, 'failures'>;

const EMPTY_SCHEMA_OBJECTS: SchemaObjectValues = {
  indexes: [],
  foreignKeys: [],
  checkConstraints: null,
  ddl: null,
  triggers: []
};

/**
 * 各段各自成败。
 *
 * 五段目录查询此前放在一个 `Promise.all` 里，一段失败整页清空。实际撞上过：
 * CockroachDB 没有 `pg_get_triggerdef()`，只是触发器那段读不到，索引却跟着
 * 「不可用」，于是每张表都被判成只读。
 */
export function collectSchemaObjects(
  settled: { [K in SchemaObjectSection]: PromiseSettledResult<SchemaObjectValues[K]> },
  describeReason: (reason: unknown) => string
): SchemaObjects {
  const values: SchemaObjectValues = { ...EMPTY_SCHEMA_OBJECTS };
  const failures: SchemaObjects['failures'] = {};
  const assign = <K extends SchemaObjectSection>(section: K) => {
    const result = settled[section];
    if (result.status === 'fulfilled') {
      values[section] = result.value;
    } else {
      failures[section] = describeReason(result.reason);
    }
  };
  (Object.keys(settled) as SchemaObjectSection[]).forEach(assign);
  return { ...values, failures };
}

/** 连查询文本都没拿到：每一段都没查成 */
export function failAllSchemaObjects(reason: string): SchemaObjects {
  const failures: SchemaObjects['failures'] = {};
  (Object.keys(EMPTY_SCHEMA_OBJECTS) as SchemaObjectSection[]).forEach((section) => {
    failures[section] = reason;
  });
  return { ...EMPTY_SCHEMA_OBJECTS, failures };
}

export interface IndexInfo {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  /** 带谓词的部分索引：只在满足谓词的行上唯一，不能当行标识 */
  isPartial: boolean;
  /**
   * 唯一性是否已在存量数据上验证过。
   *
   * 只有 PostgreSQL 会是 false——`CREATE INDEX CONCURRENTLY` 建失败会留下一个
   * `indisvalid = false` 的索引。缺这一列时读到的是 `undefined`，按 false 处理：
   * 宁可让表变成只读，也不要拿一个不保证唯一的键去定位行。
   */
  isValid: boolean;
  /** btree / hash 等；SQLite 没有 */
  method: string | null;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedSchema: string | null;
  referencedTable: string;
  /** SQLite 允许省略被引用列（默认父表主键），那一位是 null */
  referencedColumns: Array<string | null>;
  onUpdate: string | null;
  onDelete: string | null;
}

export interface CheckConstraintInfo {
  name: string;
  expression: string;
}

type MetadataRow = Record<string, unknown>;

export function groupIndexRows(
  rows: readonly MetadataRow[],
  expressionPlaceholder: string = DEFAULT_EXPRESSION_COLUMN_PLACEHOLDER
): IndexInfo[] {
  const byName = new Map<string, { row: MetadataRow; columns: Array<{ ordinal: number; name: string }> }>();

  for (const row of rows) {
    const name = text(row.index_name);
    if (!name) {
      continue;
    }

    const group = byName.get(name) ?? { row, columns: [] };
    group.columns.push({
      ordinal: number(row.ordinal),
      name: text(row.column_name) || expressionPlaceholder
    });
    byName.set(name, group);
  }

  const indexes = [...byName.entries()].map(([name, group]) => ({
    name,
    columns: byOrdinal(group.columns).map(column => column.name),
    isUnique: boolean(group.row.is_unique),
    isPrimary: boolean(group.row.is_primary),
    isPartial: boolean(group.row.is_partial),
    isValid: boolean(group.row.is_valid),
    method: text(group.row.method) || null
  }));

  // 主键 → 唯一 → 其它，同类按名字。找「这张表靠什么唯一」是最常见的问题，
  // 答案不该埋在一串自动生成的索引名中间。
  return indexes.sort((left, right) =>
    rank(left) - rank(right) || left.name.localeCompare(right.name)
  );
}

export function groupForeignKeyRows(rows: readonly MetadataRow[]): ForeignKeyInfo[] {
  const byName = new Map<
    string,
    { row: MetadataRow; pairs: Array<{ ordinal: number; column: string; referenced: string | null }> }
  >();

  for (const row of rows) {
    const name = text(row.constraint_name);
    if (!name) {
      continue;
    }

    const group = byName.get(name) ?? { row, pairs: [] };
    group.pairs.push({
      ordinal: number(row.ordinal),
      column: text(row.column_name),
      referenced: text(row.referenced_column) || null
    });
    byName.set(name, group);
  }

  return [...byName.entries()].map(([name, group]) => {
    const pairs = byOrdinal(group.pairs);
    return {
      name,
      columns: pairs.map(pair => pair.column),
      referencedSchema: text(group.row.referenced_schema) || null,
      referencedTable: text(group.row.referenced_table),
      referencedColumns: pairs.map(pair => pair.referenced),
      onUpdate: text(group.row.on_update) || null,
      onDelete: text(group.row.on_delete) || null
    };
  });
}

export function toCheckConstraints(rows: readonly MetadataRow[]): CheckConstraintInfo[] {
  return rows.map(row => ({
    name: text(row.constraint_name),
    expression: text(row.expression)
  }));
}

function byOrdinal<T extends { ordinal: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.ordinal - right.ordinal);
}

function rank(index: IndexInfo): number {
  if (index.isPrimary) {
    return 0;
  }
  return index.isUnique ? 1 : 2;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** MySQL 与 SQLite 的布尔是 1 / 0，PostgreSQL 才是真布尔。 */
function boolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return value === '1' || value === 'true';
}

/**
 * 不同方言把建表语句放在不同列里，名字还带空格。
 * 认不出来的行直接跳过——把整行 `String(row)` 塞进去会得到 `[object Object]`，
 * 那是一段看上去有内容、复制出去却毫无用处的文本。
 */
const DDL_COLUMN_CANDIDATES = ['Create Table', 'Create View', 'sql'];

export function extractDdlStatements(rows: readonly MetadataRow[]): string[] {
  return rows.flatMap(row => {
    const column = DDL_COLUMN_CANDIDATES.find(
      candidate => typeof row[candidate] === 'string' && (row[candidate] as string).trim()
    );
    return column ? [(row[column] as string).trim()] : [];
  });
}

/** 拼成可直接粘回客户端执行的脚本：每条以分号结尾，条与条之间空一行。 */
export function joinDdlStatements(statements: readonly string[]): string {
  return statements
    .map(statement => (statement.endsWith(';') ? statement : `${statement};`))
    .join('\n\n');
}

export interface TriggerInfo {
  name: string;
  /** BEFORE / AFTER；只有 MySQL 拆开给，其它方言在 definition 原文里 */
  timing: string | null;
  /** INSERT / UPDATE / DELETE；同上 */
  event: string | null;
  definition: string;
}

/**
 * MySQL 只给拆开的组件（时机、事件、语句体），PostgreSQL 与 SQLite 给完整的
 * CREATE TRIGGER 原文。这里如实保留两种形态，**不把组件拼成一条 CREATE
 * TRIGGER**——拼出来的东西未必能照着执行，那是伪造原文。
 */
export function toTriggers(rows: readonly MetadataRow[]): TriggerInfo[] {
  return rows.map(row => ({
    name: text(row.trigger_name),
    timing: text(row.timing) || null,
    event: text(row.event) || null,
    definition: text(row.definition)
  }));
}
