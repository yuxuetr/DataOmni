import { quoteQualifiedSqlIdentifier, type SqlIdentifierDialect } from './sqlIdentifiers';

/**
 * 目录查询该怎么发出去。
 *
 * SQL 文本住在 Rust 的 `schema_metadata.rs`——只有住在那边才能被
 * `tests/database_smoke.rs` 拿真库跑一遍。前端要回答的只剩一个问题：
 * **这一段要绑什么**。
 */

/** `get_schema_metadata_queries` 的返回；字段名按 Rust 侧的 snake_case */
export interface SchemaMetadataQueries {
  columns: string;
  indexes: string;
  foreign_keys: string;
  /** null = 该方言没有检查约束目录，不是「没有检查约束」 */
  check_constraints: string | null;
  /** 对象定义原文；PostgreSQL 只对视图与物化视图有 */
  ddl: DdlQuery | null;
  triggers: string;
  /** 上面每段 `bound` 查询要绑几个参数 */
  parameter_count: number;
}

/** `bound` 走绑定参数，`interpolated` 要把 `{table}` 换成引用过的标识符 */
export type DdlQuery =
  | { kind: 'bound'; sql: string }
  | { kind: 'interpolated'; sql: string };

export interface DdlRequest {
  sql: string;
  params: unknown[];
}

/**
 * 一个方言的全部目录查询绑同一组参数，个数由后端的 `parameter_count` 说了算。
 *
 * 不在这里按 `db_type` 分支，是因为那等于把「SQLite 的 pragma 只认表名、
 * 没有 schema 这一层」这条知识抄成两份——SQL 在 Rust，规则在这里。抄第二份
 * 的代价已经付过一次：取对象定义那一段此前照 SQLite 的形状只绑了表名，而
 * PostgreSQL 的视图定义要两个，真库上直接报
 * `bind message supplies 1 parameters, but prepared statement requires 2`。
 * 它和索引、外键、触发器在同一个 `Promise.all` 里，于是 PostgreSQL 上整个
 * 「结构」页一条索引都显示不出来。
 */
export function catalogQueryParams(
  parameterCount: number,
  tableName: string,
  schema?: string | null
): unknown[] {
  return parameterCount === 1 ? [tableName] : [tableName, schema ?? null];
}

/**
 * 取对象定义原文（视图的 `pg_get_viewdef`、`SHOW CREATE TABLE`、
 * `sqlite_master.sql`）要发的那一条。
 *
 * 两种形态不是为了对称：`SHOW CREATE TABLE` 不接受占位符，表名必须作为
 * **引用过的标识符**插进语句；而 `sqlite_master` 与 `pg_class` 里表名是
 * **字符串字面量**，走绑定参数。两种引用规则不同，混用会在含特殊字符的
 * 表名上出错。
 */
export function ddlRequest(
  ddl: DdlQuery,
  parameterCount: number,
  name: string,
  schema: string | null | undefined,
  dialect: SqlIdentifierDialect
): DdlRequest {
  if (ddl.kind === 'bound') {
    return { sql: ddl.sql, params: catalogQueryParams(parameterCount, name, schema) };
  }
  const quoted = quoteQualifiedSqlIdentifier(schema ? [schema, name] : [name], dialect);
  return { sql: ddl.sql.replace('{table}', quoted), params: [] };
}
