import type { TranslationKey, TranslationParams } from '../i18n/translate';
import { tableKey, type ErLink, type ErTable } from './erLayout';
import type { DatabaseObject } from './databaseObjects';
import { catalogQueryParams, ddlRequest, type SchemaMetadataQueries } from './catalogQueries';
import {
  extractDdlStatements,
  groupForeignKeyRows,
  groupIndexRows,
  joinDdlStatements,
  toCheckConstraints
} from './schemaObjects';
import { toColumnInfo } from './tableMetadata';
import { describeError } from './describeError';
import { reconstructTableDdl } from './reconstructTableDdl';
import { quoteQualifiedSqlIdentifier, type SqlIdentifierDialect } from './sqlIdentifiers';

type Translate = (key: TranslationKey, params?: TranslationParams) => string;

/** 一张表读建表语句的结果：读到了原文，或者读的时候报了错 */
export type TableDdl =
  /** `foreignKeys`：重建出来的外键，放到文件最后 */
  | { key: string; ddl: string; foreignKeys?: readonly string[] }
  | { key: string; error: string };

export interface DdlScriptSource {
  /** 连接名 */
  title: string;
  database: string;
  /** `YYYY-MM-DD`，传进来：同样的输入要得到同样的文本 */
  date: string;
  /** 按导出的次序 */
  tables: readonly TableDdl[];
  /** 是从目录重建的（PostgreSQL 系、SQL Server），不是数据库给的原文：开头要说清楚 */
  reconstructed: boolean;
}

/**
 * 选中的那批表拼成一个 `.sql`：开头一段注释说是什么、读不到的有哪几张，
 * 之后每张表一段，原文就是数据库自己给的（`SHOW CREATE TABLE`）。
 *
 * 读不到的表不写空段落，只在开头列出来：文件要能直接拿去执行，
 * 而一段只有注释的「表」会让人以为它建出来了。
 */
export function buildDdlScript(source: DdlScriptSource, t: Translate): string {
  const read = source.tables.flatMap((table) => ('ddl' in table ? [table] : []));
  const failed = source.tables.flatMap((table) => ('error' in table ? [table] : []));

  const out = [
    `-- ${oneLine(t('schemaExport.scriptHeader', {
      title: source.title,
      database: source.database,
      count: read.length,
      date: source.date
    }))}`
  ];
  if (source.reconstructed) {
    out.push(`-- ${oneLine(t('schemaExport.reconstructedNote'))}`);
  }
  if (failed.length > 0) {
    out.push(`-- ${oneLine(t('schemaExport.scriptFailed', { count: failed.length }))}`);
    for (const table of failed) {
      out.push(`--   ${oneLine(table.key)}: ${oneLine(table.error)}`);
    }
  }

  for (const table of read) {
    const ddl = table.ddl.trim();
    out.push('', RULE, `-- ${oneLine(table.key)}`, RULE, ddl.endsWith(';') ? ddl : `${ddl};`);
  }
  const foreignKeys = read.flatMap((table) => table.foreignKeys ?? []);
  if (foreignKeys.length > 0) {
    out.push('', RULE, `-- ${oneLine(t('schemaExport.foreignKeysHeader'))}`, RULE, ...foreignKeys);
  }
  return out.join('\n') + '\n';
}

const RULE = `-- ${'-'.repeat(60)}`;

/** 注释只管到行尾：报错信息里的换行会把后半句漏成 SQL */
function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ');
}

/**
 * 数据字典只要选中的表。外键只要一端在选中的表里就留着：
 * 「这一列指向 users.id」即使 users 没选，也是这张表结构的一部分。
 */
export function dictionarySubset(
  tables: readonly ErTable[],
  links: readonly ErLink[],
  keys: ReadonlySet<string>
): { tables: ErTable[]; links: ErLink[] } {
  return {
    tables: tables.filter((table) => keys.has(tableKey(table))),
    links: links.filter((link) => keys.has(link.from.table) || keys.has(link.to.table))
  };
}

/**
 * 被引用的表排在前面，文件才能从头执行到尾：有原文的几家（MySQL、CockroachDB、SQLite、Oracle…）
 * 把外键写在 CREATE TABLE 里，按名字排的话引用别人的表常常先出现。
 *
 * 每一步取原次序里最靠前、引用的表都已排好的那张；有环（互相引用）时没有这样的表，
 * 就取剩下最靠前的一张——环本来就排不出能执行的次序，至少别的表不乱。只看选中的这批表之间的外键。
 */
export function orderByDependencies<T>(
  tables: readonly T[],
  links: readonly ErLink[],
  keyOf: (table: T) => string
): T[] {
  const keys = new Set(tables.map(keyOf));
  const dependsOn = new Map<string, Set<string>>();
  for (const link of links) {
    if (link.from.table !== link.to.table && keys.has(link.from.table) && keys.has(link.to.table)) {
      const set = dependsOn.get(link.from.table) ?? new Set<string>();
      set.add(link.to.table);
      dependsOn.set(link.from.table, set);
    }
  }
  const placed = new Set<string>();
  const remaining = [...tables];
  const ordered: T[] = [];
  while (remaining.length > 0) {
    const ready = remaining.findIndex((table) =>
      [...(dependsOn.get(keyOf(table)) ?? [])].every((key) => placed.has(key)));
    const [next] = remaining.splice(ready === -1 ? 0 : ready, 1);
    placed.add(keyOf(next));
    ordered.push(next);
  }
  return ordered;
}

/**
 * 最多 `limit` 个同时在跑，结果按输入次序返回。
 *
 * 一次导一百张表、每张一次往返：经 SSH 隧道一次一百多毫秒，一张张排队就是十几秒。
 * 同时跑几条把它压到几秒，又不至于一下子向服务端扔一百条。`run` 自己处理错误。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

type Select = (sql: string, params: unknown[]) => Promise<unknown>;

export interface ReadTableDdlsOptions {
  tables: readonly DatabaseObject[];
  dialect: SqlIdentifierDialect;
  queries: SchemaMetadataQueries;
  select: Select;
  t: Translate;
  /** 每读完一张表调一次 */
  onProgress: (done: number) => void;
  /** 同时读几张，见 `mapWithConcurrency` */
  concurrency: number;
}

/**
 * 读这批表的建表语句。三种取法，按方言定：
 *
 * - 数据库自己给原文（MySQL 系 `SHOW CREATE TABLE`、SQLite、Oracle、DuckDB、ClickHouse）：
 *   和结构页「对象定义」同一条查询
 * - CockroachDB 也有 `SHOW CREATE TABLE`，但连接类型就是 PostgreSQL：拿第一张表试一次，认就全用它
 * - 其余 PostgreSQL 系（PostgreSQL、openGauss）与 SQL Server 库里不存表的原文：用结构页那四段目录查询重建
 *
 * 每张表各自成败：一张读不到不让整批失败。
 */
export async function readTableDdls(options: ReadTableDdlsOptions): Promise<{ tables: TableDdl[]; reconstructed: boolean }> {
  const { tables, dialect, queries, select, t } = options;
  let mode: 'native' | 'show' | 'reconstruct' = dialect === 'postgresql' || dialect === 'sqlserver' ? 'reconstruct' : 'native';
  if (dialect === 'postgresql' && tables.length > 0) {
    try {
      await select(showCreateTable(tables[0]), []);
      mode = 'show';
    } catch {
      // PostgreSQL 与 openGauss 不认这条语法：照常重建
    }
  }

  const readOne = async (table: DatabaseObject): Promise<string | { ddl: string; foreignKeys: string[] }> => {
    if (mode === 'show') {
      const rows = await select(showCreateTable(table), []);
      return (Array.isArray(rows) ? rows : [])
        .map((row) => String((row as Record<string, unknown>).create_statement ?? '').trim())
        .filter(Boolean)
        .join('\n\n');
    }
    if (mode === 'native') {
      if (!queries.ddl) {
        return '';
      }
      const request = ddlRequest(queries.ddl, queries.parameter_count, table.name, table.schema, dialect);
      const rows = await select(request.sql, request.params);
      return joinDdlStatements(extractDdlStatements(asRows(rows)));
    }
    const params = catalogQueryParams(queries.parameter_count, table.name, table.schema);
    const [columns, indexes, foreignKeys, checks] = await Promise.all([
      select(queries.columns, params).then(toColumnInfo),
      select(queries.indexes, params).then((rows) => groupIndexRows(asRows(rows))),
      select(queries.foreign_keys, params).then((rows) => groupForeignKeyRows(asRows(rows))),
      queries.check_constraints
        ? select(queries.check_constraints, params).then((rows) => toCheckConstraints(asRows(rows)))
        : Promise.resolve([])
    ]);
    // 一列都读不到不是一张空表：表被删了，或者这个账号看不到它的结构
    if (columns.length === 0) {
      return '';
    }
    return reconstructTableDdl(
      { schema: table.schema, name: table.name, columns, indexes, foreignKeys, checks },
      dialect === 'sqlserver' ? 'sqlserver' : 'postgresql',
      t
    );
  };

  let done = 0;
  const read = await mapWithConcurrency(tables, options.concurrency, async (table): Promise<TableDdl> => {
    const key = tableKey(table);
    try {
      const result = await readOne(table);
      if (typeof result !== 'string') {
        return { key, ddl: result.ddl, foreignKeys: result.foreignKeys };
      }
      return result ? { key, ddl: result } : { key, error: t('objectDefinition.empty') };
    } catch (cause) {
      return { key, error: describeError(cause, t('objectDefinition.readFailed')) };
    } finally {
      done += 1;
      options.onProgress(done);
    }
  });
  return { tables: read, reconstructed: mode === 'reconstruct' };
}

function showCreateTable(table: DatabaseObject): string {
  return `SHOW CREATE TABLE ${quoteQualifiedSqlIdentifier(table.schema ? [table.schema, table.name] : [table.name], 'postgresql')}`;
}

function asRows(rows: unknown): Array<Record<string, unknown>> {
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
}
