import type { DatabaseObject } from '../contracts/databaseMetadata';
import type { TranslationKey, TranslationParams } from '../i18n/translate';
import { catalogQueryParams, type SchemaMetadataQueries } from './catalogQueries';
import { toErTables, type ErTable } from './erLayout';
import type { TableCatalog } from './reconstructTableDdl';
import type { SchemaDiff, SchemaDiffDialect, SchemaSnapshot } from './schemaDiff';
import { mapWithConcurrency, readTableDdls } from './schemaExport';
import { groupForeignKeyRows, groupIndexRows, toCheckConstraints } from './schemaObjects';
import { toColumnInfo } from './tableMetadata';

/**
 * 结构比对的一侧：读整库的表，再逐表读列、索引、外键、检查约束（结构页那四段查询）。
 * 应用与往返验收脚本（scripts/schema-diff-verify.ts）共用这一份，验的就是界面跑的那条路。
 */

type Select = (sql: string, params: unknown[]) => Promise<unknown>;
type Translate = (key: TranslationKey, params?: TranslationParams) => string;

/** `get_er_diagram_queries` 的返回 */
export interface ErDiagramQueries {
  columns: string;
  foreign_keys: string;
  parameter_count: number;
}

/** 同时在途的单表查询数，同代码生成：网络库上太多并发反而挤占用户正在跑的查询 */
const CONCURRENCY = 4;

/** 整库的表（ER 图那段查询，只要表不要视图）。`database` 是要绑定时的库名 */
export async function listTables(select: Select, er: ErDiagramQueries, database: string | null): Promise<ErTable[]> {
  const rows = await select(er.columns, Array.from({ length: er.parameter_count }, () => database));
  return toErTables(Array.isArray(rows) ? rows : []);
}

/** 这批表里出现的 schema，按名字排；没有 schema 的方言是空的 */
export function schemasOf(tables: readonly ErTable[]): string[] {
  return [...new Set(tables.flatMap((table) => (table.schema ? [table.schema] : [])))].sort((left, right) => left.localeCompare(right));
}

export async function loadSchemaSnapshot(options: {
  select: Select;
  metadata: SchemaMetadataQueries;
  dialect: SchemaDiffDialect;
  tables: readonly ErTable[];
  /** 只比这一个 schema；null = 全部 */
  schema: string | null;
}): Promise<SchemaSnapshot> {
  const { select, metadata } = options;
  const wanted = options.tables.filter((table) => options.schema == null || table.schema === options.schema);
  const rows = (value: unknown) => (Array.isArray(value) ? value as Array<Record<string, unknown>> : []);
  const tables = await mapWithConcurrency(wanted, CONCURRENCY, async (table): Promise<TableCatalog> => {
    const params = catalogQueryParams(metadata.parameter_count, table.name, table.schema);
    const [columns, indexes, foreignKeys, checks] = await Promise.all([
      select(metadata.columns, params),
      select(metadata.indexes, params),
      select(metadata.foreign_keys, params),
      metadata.check_constraints ? select(metadata.check_constraints, params) : Promise.resolve([])
    ]);
    return {
      schema: table.schema,
      name: table.name,
      columns: toColumnInfo(columns),
      indexes: groupIndexRows(rows(indexes)),
      foreignKeys: groupForeignKeyRows(rows(foreignKeys)),
      checks: toCheckConstraints(rows(checks))
    };
  });
  return { dialect: options.dialect, tables };
}

/**
 * 新建的表要的建表原文，从**源**库读（`buildSyncScript` 的 `nativeDdl`）。PostgreSQL 系与 SQL Server
 * 从目录重建，不读
 */
export async function readNativeDdl(options: {
  select: Select;
  metadata: SchemaMetadataQueries;
  dialect: SchemaDiffDialect;
  diff: SchemaDiff;
  t: Translate;
}): Promise<Map<string, string | { error: string }>> {
  const { dialect } = options;
  const created = options.diff.differences.flatMap((difference) =>
    difference.kind === 'table-added' && difference.table.source ? [difference.table.source] : []);
  if (dialect === 'postgresql' || dialect === 'sqlserver' || created.length === 0) {
    return new Map();
  }
  // `id` 只有取函数定义时用得上（PostgreSQL 的 oid），表按 schema 与名字取
  const objects: DatabaseObject[] = created.map((table) => ({ schema: table.schema, name: table.name, kind: 'table', id: '' }));
  const { tables } = await readTableDdls({
    tables: objects,
    dialect,
    queries: options.metadata,
    select: options.select,
    t: options.t,
    onProgress: () => {},
    concurrency: CONCURRENCY
  });
  return new Map(tables.map((entry) => [entry.key, 'ddl' in entry ? entry.ddl : { error: entry.error }]));
}
