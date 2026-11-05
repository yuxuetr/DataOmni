import type { TranslationKey, TranslationParams } from '../i18n/translate';
import { tableKey } from './erLayout';
import { dropObjectSql, suggestIndexName } from './objectDdl';
import { addForeignKeyStatement, createIndexStatement, reconstructTableDdl, skippedIndexReason, type TableCatalog } from './reconstructTableDdl';
import type { SchemaDiff, SchemaDiffDialect, SchemaDifference } from './schemaDiff';
import { orderByDependencies } from './schemaExport';
import type { ForeignKeyInfo, IndexInfo } from './schemaObjects';
import { quoteQualifiedSqlIdentifier, quoteSqlIdentifier } from './sqlIdentifiers';
import {
  buildTableDdl,
  columnDefaultSql,
  renamesApart,
  renamesByChange,
  typeChangesApart,
  type ColumnDraft
} from './tableDdl';

/**
 * 由比对结果生成同步脚本（rfcs/schema-diff.md §4）：在目标库上跑完，目标的结构就和源一样。
 * 只在同一方言之间生成；做不到的逐项带理由列出，不拼一条跑不通或建错地方的语句。
 *
 * 次序：删外键 → 删索引 → 建表 → 改列 → 建索引 → 加外键 → 删表。外键先删后加，
 * 改列与建表就不会被引用关系挡住。
 */

type Translate = (key: TranslationKey, params?: TranslationParams) => string;

export interface SyncRefusal {
  /** 表名（目标里的写法；新建的表是源里的） */
  table: string;
  /** 列名、索引名、外键名；整张表时为空 */
  subject: string;
  reason: TranslationKey;
  params?: TranslationParams;
}

/** 会连数据一起没掉的操作。预览里逐条列出，不只给一段 SQL */
export interface SyncImpact {
  kind: 'drop-table' | 'drop-column';
  table: string;
  column: string | null;
}

export interface SyncPlan {
  /** 每条一个完整的语句或语句块；新建的表可能带注释行与多条语句，见 `renderSyncScript` */
  statements: string[];
  refusals: SyncRefusal[];
  impacts: SyncImpact[];
}

export interface SyncOptions {
  dialect: SchemaDiffDialect;
  /** 目标的服务端版本：TiDB、CockroachDB、旧 MySQL 的改列要拆开或换写法（见 `tableDdl.ts`） */
  serverVersion: string | null;
  /**
   * 新建的表用源库自己给的建表原文（MySQL 系、SQLite、Oracle、DuckDB），按源表的 `tableKey`。
   * PostgreSQL 系与 SQL Server 不用，从目录重建
   */
  nativeDdl: ReadonlyMap<string, string | { error: string }>;
  t: Translate;
}

/** 删表默认不勾（用户 2026-11-05 定），主键不同只报告；其余默认都勾 */
export function defaultSelection(diff: SchemaDiff): Set<number> {
  return new Set(
    diff.differences.flatMap((difference, index) =>
      difference.kind === 'table-removed' || difference.kind === 'primary-key-changed' ? [] : [index])
  );
}

/** 能不能勾：主键不同只报告 */
export function isSyncable(difference: SchemaDifference): boolean {
  return difference.kind !== 'primary-key-changed';
}

const fold = (name: string) => name.trim().toLowerCase();

/** 建表之后加、删外键：SQLite 与 DuckDB 都做不到（要重建整张表） */
const ALTERS_FOREIGN_KEYS = (dialect: SchemaDiffDialect) => dialect !== 'sqlite' && dialect !== 'duckdb';

/** 建表原文里写着 schema 名的方言（`DBMS_METADATA` 写出 `"OWNER"."T"`），换 schema 时照抄会建错地方 */
const NATIVE_DDL_NAMES_SCHEMA = (dialect: SchemaDiffDialect) => dialect === 'oracle' || dialect === 'duckdb';

export function buildSyncScript(diff: SchemaDiff, selected: ReadonlySet<number>, options: SyncOptions): SyncPlan {
  const { dialect } = options;
  const chosen = diff.differences.filter((difference, index) => selected.has(index) && isSyncable(difference));
  const refusals: SyncRefusal[] = [];
  const impacts: SyncImpact[] = [];

  // 忽略 schema 时新表建在目标那唯一一个 schema 里；目标一张表都没有时不写 schema，落在连接的默认 schema
  const targetSchemaFor = (source: TableCatalog): string | null =>
    diff.ignoreSchema ? diff.targetTables.find((table) => table.schema)?.schema ?? null : source.schema;
  const placeInTarget = (source: TableCatalog): TableCatalog => {
    const schema = targetSchemaFor(source);
    return {
      ...source,
      schema,
      foreignKeys: source.foreignKeys.map((key) => ({
        ...key,
        referencedSchema: diff.ignoreSchema ? schema : key.referencedSchema
      }))
    };
  };

  for (const difference of diff.differences) {
    if (difference.kind === 'primary-key-changed') {
      refusals.push({
        table: difference.table.target?.name ?? '',
        subject: '',
        reason: 'schemaSync.refuse.primaryKey',
        params: { source: difference.source.join(', ') || '—', target: difference.target.join(', ') || '—' }
      });
    }
  }

  // 改类型的列上挂着的外键（本表引用别人的、别人引用本表的）先删后加：MySQL 不许改外键两端的类型
  const typeChanged = new Set(
    chosen.flatMap((difference) =>
      difference.kind === 'column-changed' && difference.changes.includes('type') && difference.table.target
        ? [`${tableKey(difference.table.target)}\u0000${difference.target.name}`]
        : [])
  );
  const touchesChangedType = (owner: TableCatalog, key: ForeignKeyInfo) =>
    key.columns.some((column) => typeChanged.has(`${tableKey(owner)}\u0000${column}`))
    || key.referencedColumns.some((column) =>
      column !== null && typeChanged.has(`${tableKey({ schema: key.referencedSchema ?? owner.schema, name: key.referencedTable })}\u0000${column}`));

  const removedKeys = chosen.flatMap((difference) =>
    difference.kind === 'foreign-key-removed' && difference.table.target ? [{ owner: difference.table.target, key: difference.foreignKey }] : []);
  const removedSet = new Set(removedKeys.map((entry) => entry.key));
  const rebuilt = typeChanged.size === 0
    ? []
    : diff.targetTables.flatMap((owner) =>
      owner.foreignKeys.filter((key) => !removedSet.has(key) && touchesChangedType(owner, key)).map((key) => ({ owner, key })));

  // 1. 删外键
  const dropKeys: string[] = [];
  for (const { owner, key } of removedKeys) {
    if (ALTERS_FOREIGN_KEYS(dialect)) dropKeys.push(dropForeignKeySql(owner, key.name, dialect));
    else refusals.push({ table: owner.name, subject: key.name, reason: 'schemaSync.refuse.foreignKeyAfterCreate' });
  }
  // SQLite 与 DuckDB 本来就改不了类型（`buildTableDdl` 会拒），也就没有要临时删的外键
  if (ALTERS_FOREIGN_KEYS(dialect)) {
    dropKeys.push(...rebuilt.map(({ owner, key }) => dropForeignKeySql(owner, key.name, dialect)));
  }

  // 2. 删索引
  const dropIndexes: string[] = [];
  for (const difference of chosen) {
    if (difference.kind !== 'index-removed' || !difference.table.target) continue;
    const statement = dropIndexStatement(difference.table.target, difference.index, dialect);
    if (typeof statement === 'string') dropIndexes.push(statement);
    else refusals.push({ table: difference.table.target.name, subject: difference.index.name, reason: statement.reason });
  }

  // 3. 建表，被引用的先建
  const created = chosen.flatMap((difference) => (difference.kind === 'table-added' && difference.table.source ? [difference.table.source] : []));
  const links = created.flatMap((table) => table.foreignKeys.map((key) => ({
    constraintName: key.name,
    from: { table: tableKey(table), column: key.columns[0] ?? '' },
    to: { table: tableKey({ schema: key.referencedSchema ?? table.schema, name: key.referencedTable }), column: key.referencedColumns[0] ?? '' }
  })));
  const createTables: string[] = [];
  const createdForeignKeys: string[] = [];
  for (const source of orderByDependencies(created, links, (table) => tableKey(table))) {
    const placed = placeInTarget(source);
    if (dialect === 'postgresql' || dialect === 'sqlserver') {
      const rebuiltTable = reconstructTableDdl(placed, dialect, options.t);
      createTables.push(...(dialect === 'postgresql' ? withSequences(placed, rebuiltTable.ddl) : [rebuiltTable.ddl]));
      createdForeignKeys.push(...rebuiltTable.foreignKeys);
      continue;
    }
    if (NATIVE_DDL_NAMES_SCHEMA(dialect) && fold(source.schema ?? '') !== fold(placed.schema ?? '')) {
      refusals.push({ table: source.name, subject: '', reason: 'schemaSync.refuse.createAcrossSchemas', params: { schema: placed.schema ?? '' } });
      continue;
    }
    const native = options.nativeDdl.get(tableKey(source));
    if (typeof native === 'string' && native.trim()) {
      createTables.push(native.trim());
    } else {
      refusals.push({
        table: source.name,
        subject: '',
        reason: 'schemaSync.refuse.ddlUnavailable',
        params: { error: native && typeof native === 'object' ? native.error : '' }
      });
    }
  }

  // 4. 改列：一张表一次 `buildTableDdl`
  const alterColumns: string[] = [];
  const byTable = new Map<TableCatalog, SchemaDifference[]>();
  for (const difference of chosen) {
    const target = difference.table.target;
    if (target && (difference.kind === 'column-added' || difference.kind === 'column-removed' || difference.kind === 'column-changed')) {
      byTable.set(target, [...(byTable.get(target) ?? []), difference]);
    }
  }
  for (const [target, changes] of byTable) {
    const plan = buildTableDdl({
      schema: target.schema,
      table: target.name,
      newTableName: target.name,
      dialect,
      columns: columnDrafts(target, changes, dialect),
      renameApart: renamesApart(dialect, options.serverVersion),
      typeChangesApart: typeChangesApart(dialect, options.serverVersion),
      renameByChange: renamesByChange(dialect, options.serverVersion)
    });
    alterColumns.push(...plan.statements);
    refusals.push(...plan.refusals.map((refusal) => ({ table: target.name, subject: refusal.column, reason: refusal.reason })));
    impacts.push(...plan.impacts.map((impact) => ({ kind: impact.kind, table: target.name, column: impact.column })));
  }

  // 5. 建索引
  const createIndexes: string[] = [];
  for (const difference of chosen) {
    if (difference.kind !== 'index-added' || !difference.table.target) continue;
    const skipped = skippedIndexReason(difference.index, dialect);
    if (skipped) {
      refusals.push({ table: difference.table.target.name, subject: difference.index.name, reason: skipped, params: { index: difference.index.name, kind: difference.index.method ?? '' } });
      continue;
    }
    // SQLite 不许自己建 `sqlite_` 开头的索引；源里那种是唯一约束自动建的，换个名字建成唯一索引，定义一样
    const index = dialect === 'sqlite' && /^sqlite_/i.test(difference.index.name)
      ? { ...difference.index, name: suggestIndexName(difference.table.target.name, difference.index.columns, true, dialect) }
      : difference.index;
    createIndexes.push(createIndexStatement(difference.table.target, index, dialect));
  }

  // 6. 加外键：源里多的、为改类型临时删掉的、新建表从目录重建出来的
  const addKeys: string[] = [];
  for (const difference of chosen) {
    const owner = difference.table.target;
    if (difference.kind !== 'foreign-key-added' || !owner) continue;
    if (!ALTERS_FOREIGN_KEYS(dialect)) {
      refusals.push({ table: owner.name, subject: difference.foreignKey.name, reason: 'schemaSync.refuse.foreignKeyAfterCreate' });
      continue;
    }
    // 忽略 schema 时被引用的表在目标这一侧的 schema 里，也就是本表的
    const key = diff.ignoreSchema ? { ...difference.foreignKey, referencedSchema: owner.schema } : difference.foreignKey;
    addKeys.push(addForeignKeyStatement(owner, key, dialect));
  }
  if (ALTERS_FOREIGN_KEYS(dialect)) {
    addKeys.push(...rebuilt.map(({ owner, key }) => addForeignKeyStatement(owner, key, dialect)));
  }
  addKeys.push(...createdForeignKeys);

  // 7. 删表
  const dropTables: string[] = [];
  for (const difference of chosen) {
    if (difference.kind !== 'table-removed' || !difference.table.target) continue;
    dropTables.push(dropObjectSql({ ...difference.table.target, kind: 'table' }, dialect));
    impacts.push({ kind: 'drop-table', table: difference.table.target.name, column: null });
  }

  return {
    statements: [...dropKeys, ...dropIndexes, ...createTables, ...alterColumns, ...createIndexes, ...addKeys, ...dropTables],
    refusals,
    impacts
  };
}

/** 交给编辑器的文本：没以分号结尾的补上，语句之间空一行 */
export function renderSyncScript(statements: readonly string[]): string {
  return statements.map((statement) => {
    const trimmed = statement.trimEnd();
    return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
  }).join('\n\n');
}

/**
 * 目标表现有的列原样放进草稿，再按选中的差异改：改了哪一项才换成源的值，
 * 没改的保持目标的原文，`buildTableDdl` 就不会把它当成改动
 */
function columnDrafts(target: TableCatalog, changes: readonly SchemaDifference[], dialect: SchemaDiffDialect): ColumnDraft[] {
  const drafts: ColumnDraft[] = target.columns.map((column) => ({
    origin: column,
    name: column.name,
    dataType: column.data_type,
    nullable: column.is_nullable,
    defaultValue: columnDefaultSql(column, dialect),
    dropped: false,
    primaryKey: column.is_primary_key
  }));
  for (const change of changes) {
    if (change.kind === 'column-removed') {
      const draft = drafts.find((item) => item.origin === change.column);
      if (draft) draft.dropped = true;
    } else if (change.kind === 'column-changed') {
      const draft = drafts.find((item) => item.origin === change.target);
      if (!draft) continue;
      if (change.changes.includes('type')) draft.dataType = change.source.data_type;
      if (change.changes.includes('nullable')) draft.nullable = change.source.is_nullable;
      if (change.changes.includes('default')) draft.defaultValue = columnDefaultSql(change.source, dialect);
    } else if (change.kind === 'column-added') {
      drafts.push({
        origin: null,
        name: change.column.name,
        dataType: change.column.data_type,
        nullable: change.column.is_nullable,
        defaultValue: columnDefaultSql(change.column, dialect),
        dropped: false,
        primaryKey: false
      });
    }
  }
  return drafts;
}

function qualifiedTable(table: { schema: string | null; name: string }, dialect: SchemaDiffDialect): string {
  return quoteQualifiedSqlIdentifier(table.schema ? [table.schema, table.name] : [table.name], dialect);
}

function dropForeignKeySql(table: TableCatalog, name: string, dialect: SchemaDiffDialect): string {
  const keyword = dialect === 'mysql' ? 'FOREIGN KEY' : 'CONSTRAINT';
  return `ALTER TABLE ${qualifiedTable(table, dialect)} DROP ${keyword} ${quoteSqlIdentifier(name, dialect)}`;
}

/**
 * 主键、唯一约束背后的索引要删约束；SQLite 自动建的那种与 DuckDB 的约束删不掉（要重建整张表）
 */
function dropIndexStatement(table: TableCatalog, index: IndexInfo, dialect: SchemaDiffDialect): string | { reason: TranslationKey } {
  if (index.isConstraint && dialect !== 'mysql') {
    if (dialect === 'sqlite' || dialect === 'duckdb') return { reason: 'schemaSync.refuse.constraintIndex' };
    return `ALTER TABLE ${qualifiedTable(table, dialect)} DROP CONSTRAINT ${quoteSqlIdentifier(index.name, dialect)}`;
  }
  if (dialect === 'mysql' || dialect === 'sqlserver') {
    return `DROP INDEX ${quoteSqlIdentifier(index.name, dialect)} ON ${qualifiedTable(table, dialect)}`;
  }
  return `DROP INDEX ${qualifiedTable({ schema: table.schema, name: index.name }, dialect)}`;
}

/**
 * PostgreSQL 的 `serial` 列默认值指着一个序列，目录重建的建表语句不建它：先建序列、建完表再把序列挂到列上
 * （与 `serial` 展开后的效果相同），再比一次默认值就一样了
 */
function withSequences(table: TableCatalog, ddl: string): string[] {
  const sequences = table.columns.flatMap((column) => {
    const name = /^\s*nextval\('((?:[^']|'')+)'(?:::regclass)?\)\s*$/i.exec(column.default_value ?? '')?.[1]?.replace(/''/g, "'");
    return name ? [{ name, column: column.name }] : [];
  });
  return [
    ...sequences.map((sequence) => `CREATE SEQUENCE IF NOT EXISTS ${sequence.name}`),
    ddl,
    ...sequences.map((sequence) =>
      `ALTER SEQUENCE ${sequence.name} OWNED BY ${qualifiedTable(table, 'postgresql')}.${quoteSqlIdentifier(sequence.column, 'postgresql')}`)
  ];
}
