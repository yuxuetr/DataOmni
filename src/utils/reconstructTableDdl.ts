import type { TranslationKey, TranslationParams } from '../i18n/translate';
import type { ColumnInfo } from '../contracts';
import { createIndexSql } from './objectDdl';
import { DEFAULT_EXPRESSION_COLUMN_PLACEHOLDER, type CheckConstraintInfo, type ForeignKeyInfo, type IndexInfo } from './schemaObjects';
import { quoteQualifiedSqlIdentifier, quoteSqlIdentifier, type SqlIdentifierDialect } from './sqlIdentifiers';

type Translate = (key: TranslationKey, params?: TranslationParams) => string;

/** 库里不存表的建表原文、只能从目录重建的两家 */
export type ReconstructedDialect = 'postgresql' | 'sqlserver';

export interface TableCatalog {
  schema: string | null;
  name: string;
  columns: readonly ColumnInfo[];
  indexes: readonly IndexInfo[];
  foreignKeys: readonly ForeignKeyInfo[];
  checks: readonly CheckConstraintInfo[];
}

export interface ReconstructedTable {
  /** 注明建不出来的部分，再接 CREATE TABLE 与各个索引，每条以分号结尾 */
  ddl: string;
  /**
   * 外键单列出来，由调用方放到整个文件的最后：被引用的表可能排在后面，
   * 写在 CREATE TABLE 里照着执行就会在那张表上失败
   */
  foreignKeys: string[];
}

/**
 * PostgreSQL 系与 SQL Server 的表在库里没有建表原文，从结构页那四段目录查询（列、索引、外键、检查约束）重建。
 *
 * 这不是原表的等价物：触发器、分区、注释、权限、排序规则、存储参数都不在里面，调用方在文件开头说清楚。
 * **读得到却建不出来的**（拿不到表达式的计算列、带条件的索引、全文这类特殊索引）不悄悄丢、也不硬拼，
 * 在这张表前面逐条注明。
 *
 * PostgreSQL 索引的列是 `pg_get_indexdef(oid, n, true)` 给的，已经按需加了引号、表达式也原样在里面，
 * 所以照抄不再引用；其余标识符都是目录里的裸名字，按方言引用。
 */
export function reconstructTableDdl(
  table: TableCatalog,
  dialect: ReconstructedDialect,
  t: Translate
): ReconstructedTable {
  const quote = (name: string) => quoteSqlIdentifier(name, dialect);
  const qualified = (schema: string | null, name: string) =>
    quoteQualifiedSqlIdentifier(schema ? [schema, name] : [name], dialect);
  const target = qualified(table.schema, table.name);
  const notes: string[] = [];

  const definitions = table.columns.map((column) => {
    const parts = [quote(column.name), column.data_type.trim()];
    let defaultValue = column.default_value ?? null;
    if (column.identity_generation && dialect === 'postgresql') {
      parts.push(`GENERATED ${column.identity_generation} AS IDENTITY`);
    } else if (column.identity_generation) {
      parts.push('IDENTITY');
      notes.push(t('schemaExport.note.identitySeed', { column: column.name }));
    } else if (column.is_generated && dialect === 'postgresql' && defaultValue) {
      // 存储生成列的表达式就记在默认值那里（pg_attrdef），读得到
      parts.push(`GENERATED ALWAYS AS (${defaultValue}) STORED`);
      defaultValue = null;
    } else if (column.is_generated && column.data_type.trim().toLowerCase() !== 'timestamp') {
      // SQL Server 的 timestamp（rowversion）本身就是那个类型，照写即可
      notes.push(t('schemaExport.note.generatedUnknown', { column: column.name }));
    }
    if (!column.is_nullable) {
      parts.push('NOT NULL');
    }
    if (defaultValue) {
      parts.push(`DEFAULT ${defaultValue}`);
      // serial 的默认值指着一个序列，序列本身不在导出里：照着执行时那个序列得已经在
      const sequence = /nextval\('([^']+)'/i.exec(defaultValue)?.[1];
      if (sequence) {
        notes.push(t('schemaExport.note.sequence', { column: column.name, sequence }));
      }
    }
    return parts.join(' ');
  });

  const primary = table.indexes.find((index) => index.isPrimary);
  const keyColumns = table.columns
    .filter((column) => column.is_primary_key)
    .sort((left, right) => (left.primary_key_ordinal ?? 0) - (right.primary_key_ordinal ?? 0));
  if (keyColumns.length > 0) {
    const name = primary ? `CONSTRAINT ${quote(primary.name)} ` : '';
    const clustering = dialect === 'sqlserver' ? sqlServerClustering(primary?.method ?? null) : '';
    definitions.push(`${name}PRIMARY KEY${clustering} (${keyColumns.map((column) => quote(column.name)).join(', ')})`);
  }
  for (const check of table.checks) {
    const expression = check.expression.trim();
    definitions.push(`CONSTRAINT ${quote(check.name)} ${/^CHECK\b/i.test(expression) ? expression : `CHECK ${expression}`}`);
  }

  const statements = [`CREATE TABLE ${target} (\n  ${definitions.join(',\n  ')}\n);`];
  for (const index of table.indexes) {
    if (index.isPrimary) {
      continue;
    }
    const skipped = skippedIndexReason(index, dialect);
    if (skipped) {
      notes.push(t(skipped, { index: index.name, kind: index.method ?? '' }));
      continue;
    }
    statements.push(`${createIndexStatement(table, index, dialect)};`);
  }

  // 只有 SQLite 会省略被引用列，这两家不会；真缺了宁可不写，也不写一条指错列的外键
  const foreignKeys = table.foreignKeys
    .filter((key) => key.referencedColumns.every((column) => column !== null))
    .map((key) => `${addForeignKeyStatement(table, key, dialect)};`);

  const comments = notes.map((note) => `-- ${note.replace(/\s*\r?\n\s*/g, ' ')}`);
  return { ddl: [...comments, ...statements].join('\n'), foreignKeys };
}

/**
 * 一个索引的 CREATE INDEX（不带分号）。前提是 `skippedIndexReason` 为 null。
 *
 * PostgreSQL 的列照抄（`pg_get_indexdef` 已经按需加了引号，表达式也在里面）并写出非 btree 的方法；
 * SQL Server 写出聚集与否；其余几家与对象树建索引同一条（`createIndexSql`）
 */
export function createIndexStatement(
  table: { schema: string | null; name: string },
  index: IndexInfo,
  dialect: SqlIdentifierDialect
): string {
  if (dialect !== 'postgresql' && dialect !== 'sqlserver') {
    return createIndexSql(
      { schema: table.schema, table: table.name, name: index.name, columns: index.columns, unique: index.isUnique },
      dialect
    );
  }
  const quote = (name: string) => quoteSqlIdentifier(name, dialect);
  const target = quoteQualifiedSqlIdentifier(table.schema ? [table.schema, table.name] : [table.name], dialect);
  const columns = dialect === 'postgresql' ? index.columns.join(', ') : index.columns.map(quote).join(', ');
  const using = dialect === 'postgresql' && index.method && index.method !== 'btree' ? ` USING ${index.method}` : '';
  const clustering = dialect === 'sqlserver' ? sqlServerClustering(index.method).trim() : '';
  return `CREATE ${index.isUnique ? 'UNIQUE ' : ''}${clustering ? `${clustering} ` : ''}INDEX ${quote(index.name)} ON ${target}${using} (${columns})`;
}

/**
 * 加一条外键（不带分号）。被引用表没写 schema 时与本表同一个。NO ACTION 是默认行为，不写出来；
 * 被引用列不能是 null（只有 SQLite 会省略），调用方先排掉
 */
export function addForeignKeyStatement(
  table: { schema: string | null; name: string },
  key: ForeignKeyInfo,
  dialect: SqlIdentifierDialect
): string {
  const quote = (name: string) => quoteSqlIdentifier(name, dialect);
  const qualified = (schema: string | null, name: string) =>
    quoteQualifiedSqlIdentifier(schema ? [schema, name] : [name], dialect);
  const rules = [
    key.onDelete && key.onDelete !== 'NO ACTION' ? ` ON DELETE ${key.onDelete}` : '',
    key.onUpdate && key.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${key.onUpdate}` : ''
  ].join('');
  return `ALTER TABLE ${qualified(table.schema, table.name)} ADD CONSTRAINT ${quote(key.name)} FOREIGN KEY (${key.columns.map(quote).join(', ')})`
    + ` REFERENCES ${qualified(key.referencedSchema ?? table.schema, key.referencedTable)}`
    + ` (${key.referencedColumns.map((column) => quote(column ?? '')).join(', ')})${rules}`;
}

/** SQL Server 的聚集与否要写出来：主键默认聚集，另一个索引已经是聚集的就建不出来 */
function sqlServerClustering(method: string | null): string {
  if (method === 'clustered') return ' CLUSTERED';
  if (method === 'nonclustered') return ' NONCLUSTERED';
  return '';
}

/**
 * 读得到、建不出来的索引，以及为什么。SQL Server 以外的几家，列里有表达式占位（目录给不出表达式的那几家）也建不出来
 */
export function skippedIndexReason(index: IndexInfo, dialect: SqlIdentifierDialect): TranslationKey | null {
  if (!index.isValid) {
    return 'schemaExport.note.invalidIndex';
  }
  if (index.isPartial) {
    return 'schemaExport.note.partialIndex';
  }
  // 列存储、XML、空间索引的语法各自不同，不按普通索引拼
  if (dialect === 'sqlserver' && index.method !== 'clustered' && index.method !== 'nonclustered') {
    return 'schemaExport.note.indexKind';
  }
  if (dialect !== 'postgresql' && index.columns.includes(DEFAULT_EXPRESSION_COLUMN_PLACEHOLDER)) {
    return 'schemaExport.note.indexExpression';
  }
  return null;
}
