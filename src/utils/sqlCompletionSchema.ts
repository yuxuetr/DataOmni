import type { Completion } from '@codemirror/autocomplete';
import {
  MSSQL,
  PLSQL,
  MySQL,
  PostgreSQL,
  SQLite,
  StandardSQL,
  type SQLDialect,
  type SQLNamespace
} from '@codemirror/lang-sql';
import { DatabaseType } from '../contracts/connection';
import type {
  CompletionColumn,
  CompletionRelation,
  RelationKind
} from '../contracts/databaseMetadata';
import { showsSchemaLevel } from './databaseObjects';
import { identifierDialectFor, sqlIdentifierAsTyped, type SqlIdentifierDialect } from './sqlIdentifiers';

export type { CompletionColumn, CompletionRelation, RelationKind };

/** `boost` 的取值范围是 -99..99，两端都用满 */
const MAX_COLUMN_BOOST = 99;

/**
 * 表 / 视图 / Schema 的类型说明。由调用方翻译好再传进来——这个模块是纯的，
 * 在里面读当前语言会让它依赖 store，测试也要跟着起一个。
 */
export interface CompletionLabels {
  table: string;
  view: string;
  schema: string;
}

export interface CompletionSchemaResult {
  schema: SQLNamespace;
  /**
   * 这个 Schema 下的表可以不带前缀补全。只有 PostgreSQL 有值，且只在库里
   * 真有 `public` 时才给——`search_path` 默认就是它。
   */
  defaultSchema?: string;
}

/**
 * 把后端 `get_completion_catalog_query` 查出来的扁平行按关系归组。
 *
 * 保持行本身的顺序：SQL 已经 `ORDER BY` 过表内列序，补全列表照抄这个次序。
 * 按字母排会把 `id` 冲到中间去，而绝大多数时候想选的就是最前面那几列。
 */
export function normalizeCompletionRows(
  rows: ReadonlyArray<Record<string, unknown>>
): CompletionRelation[] {
  const byRelation = new Map<string, CompletionRelation>();

  for (const row of rows) {
    const name = text(row.relation_name);
    const column = text(row.column_name);
    if (!name || !column) {
      continue;
    }

    const schema = text(row.relation_schema) || null;
    // 同名不同 Schema 是两张表，键里必须带 Schema。分隔符用 NUL：
    // 它不可能出现在标识符里，用点号会让 `a.b` 和 schema `a` 的表 `b` 撞车。
    const key = `${schema ?? ''}\u0000${name}`;
    const existing = byRelation.get(key);
    if (existing) {
      existing.columns.push({ name: column, dataType: text(row.data_type) });
      continue;
    }

    byRelation.set(key, {
      schema,
      name,
      kind: text(row.relation_kind) === 'view' ? 'view' : 'table',
      columns: [{ name: column, dataType: text(row.data_type) }]
    });
  }

  return [...byRelation.values()];
}

/**
 * 把真实的库结构翻成 `@codemirror/lang-sql` 的补全命名空间。
 *
 * 层级跟着对象树走：PostgreSQL 保留 Schema 一层（一个连接能横跨多个 Schema，
 * 抹掉它会让两张同名表挤在一起），MySQL 与 SQLite 不保留（连接时已经选定了库）。
 */
export function buildCompletionSchema(
  relations: readonly CompletionRelation[],
  dbType: DatabaseType,
  labels: CompletionLabels,
  /** 登录用户。Oracle 不带前缀的名字落在用户自己的 schema 里（名字大写） */
  username?: string,
  /** 连接上填的库。ClickHouse 不带前缀的名字落在当前库里，空着是 `default` */
  database?: string | null
): CompletionSchemaResult {
  const dialect = identifierDialectFor(dbType);
  if (!showsSchemaLevel(dbType)) {
    const flat: Record<string, SQLNamespace> = {};
    for (const relation of relations) {
      flat[relation.name] = relationNamespace(relation, labels, dialect);
    }
    return { schema: flat };
  }

  const bySchema = new Map<string, Record<string, SQLNamespace>>();
  for (const relation of relations) {
    const schema = relation.schema ?? '';
    const group = bySchema.get(schema) ?? {};
    group[relation.name] = relationNamespace(relation, labels, dialect);
    bySchema.set(schema, group);
  }

  const schema: Record<string, SQLNamespace> = {};
  for (const [name, children] of bySchema) {
    schema[name] = {
      self: completionName(name, dialect, { type: 'type', detail: labels.schema }),
      children
    };
  }

  return {
    schema,
    // 不带前缀的名字落在哪个 schema：PostgreSQL 是 public，SQL Server 是 dbo，
    // DuckDB 是 main，Oracle 是登录用户（目录里是大写），ClickHouse 是连上的库
    defaultSchema: [
      ...(dbType === DatabaseType.ClickHouse ? [database?.trim() || 'default'] : []),
      'public',
      'dbo',
      ...(dbType === DatabaseType.DuckDB ? ['main'] : []),
      ...(dbType === DatabaseType.Oracle && username ? [username.toUpperCase()] : [])
    ].find((name) => bySchema.has(name))
  };
}

/**
 * 方言决定补全出哪些关键字与内建类型：`AUTO_INCREMENT` 只在 MySQL 有，
 * `RETURNING` 只在 PostgreSQL 有。认不出的类型退回标准 SQL——给一份通用
 * 关键字，比一个都不给强。
 */
export function sqlDialectFor(dbType: DatabaseType): SQLDialect {
  switch (dbType) {
    case DatabaseType.MySQL:
      return MySQL;
    case DatabaseType.PostgreSQL:
      return PostgreSQL;
    case DatabaseType.SQLite:
      return SQLite;
    case DatabaseType.SqlServer:
      return MSSQL;
    case DatabaseType.Oracle:
      return PLSQL;
    // CodeMirror 没有 DuckDB 方言；它的语法照 PostgreSQL 来（`::` 转换、`$1` 参数、
    // `RETURNING`、双引号标识符），关键字表也最接近
    case DatabaseType.DuckDB:
      return PostgreSQL;
    // 也没有 ClickHouse 方言；它的标识符用反引号、`#` 是注释、字符串里反斜杠转义，都和 MySQL 一样
    case DatabaseType.ClickHouse:
      return MySQL;
    default:
      return StandardSQL;
  }
}

/**
 * 表内顺序在补全列表里的权重。
 *
 * CodeMirror 默认按字母排，`created_at` 会被顶到最前、`id` 埋进中间。而表内
 * 顺序是有意义的：主键在前、审计列在后。`boost` 直接加在匹配得分上，而匹配
 * 质量的档位差至少 100（见 autocomplete 的 Penalty），所以 ±99 的范围只在
 * **匹配质量相同时**决定次序，不会让一个更差的匹配插队。
 *
 * 列数超过 199 的表，尾部的列会挤在同一档上退回字母序——那时候靠的已经是
 * 输入前缀而不是浏览列表了。
 */
function columnBoost(index: number): number {
  return Math.max(MAX_COLUMN_BOOST - index, -MAX_COLUMN_BOOST);
}

function relationNamespace(
  relation: CompletionRelation,
  labels: CompletionLabels,
  dialect: SqlIdentifierDialect
): SQLNamespace {
  const self = completionName(relation.name, dialect, {
    type: 'type',
    detail: relation.kind === 'view' ? labels.view : labels.table
  });

  // 类型放在 detail 里：选列的时候最想知道的就是它是什么类型
  const children: Completion[] = relation.columns.map((column, index) => completionName(
    column.name,
    dialect,
    { type: 'property', detail: column.dataType, boost: columnBoost(index) }
  ));

  return { self, children };
}

/**
 * 按名字筛（`label` 是原名），插进去的是这个方言里能执行的写法。
 *
 * lang-sql 只给**字符串**形式的候选自动加引号，而我们传的是带说明的对象，
 * 不写 `apply` 就插裸名字：PostgreSQL 的 `Orders`、叫 `order` 的列补进去就报错。
 * 已经敲了左引号时 lang-sql 会丢掉 `apply`、自己补右引号，不会引两层
 */
function completionName(
  name: string,
  dialect: SqlIdentifierDialect,
  rest: Omit<Completion, 'label' | 'apply'>
): Completion {
  const typed = sqlIdentifierAsTyped(name, dialect);
  return typed === name ? { label: name, ...rest } : { label: name, apply: typed, ...rest };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}
