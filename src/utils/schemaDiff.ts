import type { ColumnInfo } from '../contracts';
import type { SqlDialect } from '../contracts/queryExecution';
import type { TableCatalog } from './reconstructTableDdl';
import type { ForeignKeyInfo, IndexInfo } from './schemaObjects';
import { columnDefaultSql } from './tableDdl';

/**
 * 两个库的结构比对（rfcs/schema-diff.md §3）：只比，不生成语句。脚本在 `schemaSync.ts`。
 *
 * 方向固定为「源 → 目标」：差异都按「目标要怎么改才和源一样」来描述，
 * `table-added` 是源里有、目标里没有的表。
 */

/** ClickHouse 不能结构编辑，同理不比 */
export type SchemaDiffDialect = Exclude<SqlDialect, 'clickhouse'>;

export interface SchemaSnapshot {
  dialect: SchemaDiffDialect;
  tables: TableCatalog[];
}

export type ColumnChange = 'type' | 'nullable' | 'default';

/** 一对表：两边都有时就是同一张；只在一边有时另一边是 null */
export interface TablePair {
  source: TableCatalog | null;
  target: TableCatalog | null;
}

export type SchemaDifference =
  | { kind: 'table-added'; table: TablePair }
  | { kind: 'table-removed'; table: TablePair }
  | { kind: 'column-added'; table: TablePair; column: ColumnInfo }
  | { kind: 'column-removed'; table: TablePair; column: ColumnInfo }
  | { kind: 'column-changed'; table: TablePair; source: ColumnInfo; target: ColumnInfo; changes: ColumnChange[] }
  /** 只报告，不生成语句（`buildTableDdl` 不改主键，理由见那里） */
  | { kind: 'primary-key-changed'; table: TablePair; source: string[]; target: string[] }
  | { kind: 'index-added'; table: TablePair; index: IndexInfo }
  | { kind: 'index-removed'; table: TablePair; index: IndexInfo }
  | { kind: 'foreign-key-added'; table: TablePair; foreignKey: ForeignKeyInfo }
  | { kind: 'foreign-key-removed'; table: TablePair; foreignKey: ForeignKeyInfo };

export interface SchemaDiff {
  /** 两边方言相同：类型、默认值、外键动作都比，也能生成脚本。不同时只比有无与可空 */
  sameDialect: boolean;
  /** 两边各只有一个 schema：按表名对齐，schema 名不同也算同一张表（`dev` 对 `prod`） */
  ignoreSchema: boolean;
  differences: SchemaDifference[];
  /** 目标的全部表：同步时要找挂在改类型的列上的外键，那些表本身未必有差异 */
  targetTables: TableCatalog[];
}

const fold = (name: string): string => name.trim().toLowerCase();

/**
 * 两边各至多一个 schema 时忽略它。没有 schema 的方言（MySQL、SQLite）都是 null，同样成立
 */
function schemasIgnored(source: SchemaSnapshot, target: SchemaSnapshot): boolean {
  const count = (snapshot: SchemaSnapshot) => new Set(snapshot.tables.map((table) => table.schema ?? '')).size;
  return count(source) <= 1 && count(target) <= 1;
}

/**
 * 类型的比较形式：抹去大小写与空白。MySQL 8.0.19 起整数类型不再带显示宽度，
 * `int(11)` 与 `int` 是同一个类型——不去掉的话 5.7 对 8.0 处处报差异
 */
export function comparableType(dataType: string, dialect: SchemaDiffDialect): string {
  const compact = dataType.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\(\s*/g, '(').replace(/\s*\)/g, ')').replace(/\s*,\s*/g, ',');
  return dialect === 'mysql'
    ? compact.replace(/\b(tinyint|smallint|mediumint|int|integer|bigint)\(\d+\)/g, '$1')
    : compact;
}

/**
 * `serial` 的默认值里序列名带着 schema（表不在 search_path 上时 `nextval('dev.t_id_seq'::regclass)`）。
 * 忽略 schema 比的时候它也该忽略：`dev` 与 `prod` 各自的序列是各自的
 */
const QUALIFIED_NEXTVAL = /nextval\('(?:"(?:[^"]|"")+"|[^'".]+)\./gi;

function comparableDefault(column: ColumnInfo, dialect: SchemaDiffDialect, ignoreSchema: boolean): string | null {
  const value = columnDefaultSql(column, dialect)?.trim() ?? null;
  return value != null && ignoreSchema && dialect === 'postgresql' ? value.replace(QUALIFIED_NEXTVAL, "nextval('") : value;
}

function columnChanges(
  source: ColumnInfo,
  target: ColumnInfo,
  options: { sameDialect: boolean; ignoreSchema: boolean; dialect: SchemaDiffDialect }
): ColumnChange[] {
  const { sameDialect, ignoreSchema, dialect } = options;
  const changes: ColumnChange[] = [];
  if (sameDialect && comparableType(source.data_type, dialect) !== comparableType(target.data_type, dialect)) {
    changes.push('type');
  }
  if (source.is_nullable !== target.is_nullable) {
    changes.push('nullable');
  }
  if (sameDialect && comparableDefault(source, dialect, ignoreSchema) !== comparableDefault(target, dialect, ignoreSchema)) {
    changes.push('default');
  }
  return changes;
}

export function primaryKeyOf(table: TableCatalog): string[] {
  return table.columns
    .filter((column) => column.is_primary_key)
    .sort((left, right) => (left.primary_key_ordinal ?? 0) - (right.primary_key_ordinal ?? 0))
    .map((column) => column.name);
}

/**
 * 索引按**定义**比：唯一与否、是否带谓词、列与次序（列名区分大小写，同列的对齐）。名字不同不算差异——两个环境各自建的索引
 * 名字常常不一样，报出来只是噪音
 */
function indexSignature(index: IndexInfo): string {
  return [index.isUnique ? 'u' : 'i', index.isPartial ? 'p' : '', ...index.columns].join('\u0000');
}

/**
 * 外键按定义比：列、被引用的表与列，同方言时再加上两种动作（没有写就是 NO ACTION）。
 * 被引用表的 schema 只在不忽略 schema 时比
 */
function foreignKeySignature(key: ForeignKeyInfo, owner: TableCatalog, ignoreSchema: boolean, sameDialect: boolean): string {
  const rule = (value: string | null) => (value ?? 'NO ACTION').trim().toUpperCase();
  return [
    ...key.columns,
    '>',
    ignoreSchema ? '' : fold(key.referencedSchema ?? owner.schema ?? ''),
    fold(key.referencedTable),
    ...key.referencedColumns.map((column) => column ?? ''),
    ...(sameDialect ? [rule(key.onDelete), rule(key.onUpdate)] : [])
  ].join('\u0000');
}

/**
 * 两边按签名配对，同一签名出现几次就消耗几次（重复的索引也是差异）。
 * 返回只在源里的与只在目标里的
 */
function unmatched<T>(source: readonly T[], target: readonly T[], signature: (item: T, side: 'source' | 'target') => string): { added: T[]; removed: T[] } {
  const remaining = new Map<string, T[]>();
  for (const item of target) {
    const key = signature(item, 'target');
    remaining.set(key, [...(remaining.get(key) ?? []), item]);
  }
  const added: T[] = [];
  for (const item of source) {
    const bucket = remaining.get(signature(item, 'source'));
    if (bucket && bucket.length > 0) bucket.shift();
    else added.push(item);
  }
  return { added, removed: [...remaining.values()].flat() };
}

export function diffSchemas(source: SchemaSnapshot, target: SchemaSnapshot): SchemaDiff {
  const sameDialect = source.dialect === target.dialect;
  const dialect = target.dialect;
  const ignoreSchema = schemasIgnored(source, target);
  const keyOf = (table: TableCatalog) => (ignoreSchema ? fold(table.name) : `${fold(table.schema ?? '')}.${fold(table.name)}`);

  const targets = new Map(target.tables.map((table) => [keyOf(table), table]));
  const differences: SchemaDifference[] = [];
  const matched = new Set<TableCatalog>();

  for (const sourceTable of source.tables) {
    const targetTable = targets.get(keyOf(sourceTable)) ?? null;
    const pair: TablePair = { source: sourceTable, target: targetTable };
    if (!targetTable) {
      differences.push({ kind: 'table-added', table: pair });
      continue;
    }
    matched.add(targetTable);
    differences.push(...diffTable(pair, sourceTable, targetTable, { sameDialect, ignoreSchema, dialect }));
  }
  for (const targetTable of target.tables) {
    if (!matched.has(targetTable)) {
      differences.push({ kind: 'table-removed', table: { source: null, target: targetTable } });
    }
  }
  return { sameDialect, ignoreSchema, differences, targetTables: target.tables };
}

function diffTable(
  pair: TablePair,
  source: TableCatalog,
  target: TableCatalog,
  options: { sameDialect: boolean; ignoreSchema: boolean; dialect: SchemaDiffDialect }
): SchemaDifference[] {
  const differences: SchemaDifference[] = [];
  // 列按名字对齐，区分大小写：不猜改名，PostgreSQL 里 `Name` 与 `name` 也确实是两列
  const targetColumns = new Map(target.columns.map((column) => [column.name, column]));
  const sourceNames = new Set(source.columns.map((column) => column.name));
  for (const column of source.columns) {
    const other = targetColumns.get(column.name);
    if (!other) {
      differences.push({ kind: 'column-added', table: pair, column });
      continue;
    }
    const changes = columnChanges(column, other, options);
    if (changes.length > 0) {
      differences.push({ kind: 'column-changed', table: pair, source: column, target: other, changes });
    }
  }
  for (const column of target.columns) {
    if (!sourceNames.has(column.name)) {
      differences.push({ kind: 'column-removed', table: pair, column });
    }
  }

  const sourceKey = primaryKeyOf(source);
  const targetKey = primaryKeyOf(target);
  if (sourceKey.join('\u0000') !== targetKey.join('\u0000')) {
    differences.push({ kind: 'primary-key-changed', table: pair, source: sourceKey, target: targetKey });
  }

  const indexes = unmatched(
    source.indexes.filter((index) => !index.isPrimary),
    target.indexes.filter((index) => !index.isPrimary),
    indexSignature
  );
  differences.push(
    ...indexes.added.map((index): SchemaDifference => ({ kind: 'index-added', table: pair, index })),
    ...indexes.removed.map((index): SchemaDifference => ({ kind: 'index-removed', table: pair, index }))
  );

  const keys = unmatched(source.foreignKeys, target.foreignKeys, (key, side) =>
    foreignKeySignature(key, side === 'source' ? source : target, options.ignoreSchema, options.sameDialect));
  differences.push(
    ...keys.added.map((foreignKey): SchemaDifference => ({ kind: 'foreign-key-added', table: pair, foreignKey })),
    ...keys.removed.map((foreignKey): SchemaDifference => ({ kind: 'foreign-key-removed', table: pair, foreignKey }))
  );
  return differences;
}
