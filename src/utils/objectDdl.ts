import type { DatabaseObject } from '../contracts/databaseMetadata';
import { quoteQualifiedSqlIdentifier, type SqlIdentifierDialect } from './sqlIdentifiers';

/**
 * 对象树上右键能做的结构操作：删掉一个对象、清空一张表。
 *
 * 和 `tableDdl.ts` 分开：那边回答「这批列的改动要发哪些 ALTER」，是一次 diff；
 * 这里每个动作恰好一条语句，没有 diff，也没有「哪几项做不到」。
 *
 * 语句由 `fixtures/object-ddl-conformance.json` 钉住，同一份语料在真库上跑。
 */
export type DroppableKind = Extract<DatabaseObject['kind'], 'table' | 'view' | 'materialized-view'>;

export function isDroppableKind(kind: DatabaseObject['kind']): kind is DroppableKind {
  return kind === 'table' || kind === 'view' || kind === 'materialized-view';
}

const DROP_KEYWORDS: Record<DroppableKind, string> = {
  table: 'TABLE',
  view: 'VIEW',
  'materialized-view': 'MATERIALIZED VIEW'
};

function qualified(object: Pick<DatabaseObject, 'schema' | 'name'>, dialect: SqlIdentifierDialect) {
  return quoteQualifiedSqlIdentifier(
    object.schema ? [object.schema, object.name] : [object.name],
    dialect
  );
}

/**
 * 不加 `IF EXISTS` 也不加 `CASCADE`：树上看得见的对象是存在的，真的不在了
 * 就该让服务端说出来；而 CASCADE 会连带删掉依赖它的视图与外键，那是另一件
 * 用户没有要求、确认框里也没列出来的事。被依赖时服务端会拒绝，原话照给。
 */
export function dropObjectSql(
  object: Pick<DatabaseObject, 'schema' | 'name'> & { kind: DroppableKind },
  dialect: SqlIdentifierDialect
): string {
  return `DROP ${DROP_KEYWORDS[object.kind]} ${qualified(object, dialect)}`;
}

/**
 * SQLite 没有 TRUNCATE；`DELETE FROM` 不带 WHERE 时它自己会走截断优化。
 * 两者对外的差别（自增计数器是否归零、触发器是否触发）由调用方在确认框里说。
 */
export function truncateTableSql(
  table: Pick<DatabaseObject, 'schema' | 'name'>,
  dialect: SqlIdentifierDialect
): string {
  return dialect === 'sqlite'
    ? `DELETE FROM ${qualified(table, dialect)}`
    : `TRUNCATE TABLE ${qualified(table, dialect)}`;
}

/**
 * 能在树上新建 schema 的方言：树上本来就有 schema 这一层的那几家。
 *
 * MySQL 系的 schema 就是库，而连接绑在一个库上、树只列这一个，建出来看不见；
 * Oracle 的 schema 是用户，建它要 `CREATE USER` 的权限与口令；SQLite 的是
 * ATTACH 进来的另一个文件。三者都不是「建一个名字」这么一件事。
 */
export const CREATES_SCHEMAS: ReadonlySet<SqlIdentifierDialect> = new Set([
  'postgresql',
  'sqlserver'
]);

export function createSchemaSql(name: string, dialect: SqlIdentifierDialect): string {
  return `CREATE SCHEMA ${quoteQualifiedSqlIdentifier([name], dialect)}`;
}

export interface IndexRequest {
  schema: string | null;
  table: string;
  name: string;
  /** 按键内次序排好的列 */
  columns: readonly string[];
  unique: boolean;
}

/**
 * 索引名放在哪：PostgreSQL / Oracle 的索引属于 schema（和表同一个命名空间），
 * MySQL 与 SQL Server 的属于表，写在 `ON` 后面。
 *
 * PostgreSQL 建的时候**不能**限定——索引永远建在表所在的 schema，写了反而报错；
 * 删的时候**要**限定，否则按 search_path 找，表不在路径上的 schema 里就找不到。
 *
 * PostgreSQL 不加 `CONCURRENTLY`：它不能进事务，而写入批次跑在事务里。代价是
 * 建索引期间这张表的写会被挡住——大表上会被注意到，这一句写在对话框里。
 */
export function createIndexSql(request: IndexRequest, dialect: SqlIdentifierDialect): string {
  const table = qualified({ schema: request.schema, name: request.table }, dialect);
  const name = dialect === 'oracle'
    ? qualified({ schema: request.schema, name: request.name }, dialect)
    : quoteQualifiedSqlIdentifier([request.name], dialect);
  const columns = request.columns
    .map((column) => quoteQualifiedSqlIdentifier([column], dialect))
    .join(', ');
  return `CREATE ${request.unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${table} (${columns})`;
}

export function dropIndexSql(
  request: Pick<IndexRequest, 'schema' | 'table' | 'name'>,
  dialect: SqlIdentifierDialect
): string {
  if (dialect === 'mysql' || dialect === 'sqlserver') {
    const name = quoteQualifiedSqlIdentifier([request.name], dialect);
    return `DROP INDEX ${name} ON ${qualified({ schema: request.schema, name: request.table }, dialect)}`;
  }
  return `DROP INDEX ${qualified({ schema: request.schema, name: request.name }, dialect)}`;
}

/**
 * 起手的索引名：`idx_表_列_列`，唯一索引用 `uq_`。
 *
 * Oracle 写成大写：名字会被引号括起来，带引号的小写名字大小写敏感，以后每次
 * 提到它都得加引号。按 UTF-8 截到 60 字节：PostgreSQL 的上限是 63 字节，超了它会
 * 悄悄截断，建出来的名字和界面上显示的就对不上了——中文表名三个字节一个字。
 */
const INDEX_NAME_BYTES = 60;

export function suggestIndexName(
  table: string,
  columns: readonly string[],
  unique: boolean,
  dialect: SqlIdentifierDialect
): string {
  const joined = [unique ? 'uq' : 'idx', table, ...columns].join('_');
  const cased = dialect === 'oracle' ? joined.toUpperCase() : joined.toLowerCase();
  const encoder = new TextEncoder();
  let name = '';
  for (const character of cased) {
    if (encoder.encode(name + character).length > INDEX_NAME_BYTES) {
      break;
    }
    name += character;
  }
  return name;
}
