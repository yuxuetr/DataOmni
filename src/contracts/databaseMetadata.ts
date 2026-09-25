export interface SchemaInfo {
  name: string;
  owner?: string;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  is_nullable: boolean;
  is_primary_key: boolean;
  primary_key_ordinal?: number;
  default_value?: string;
  /**
   * 值由数据库产生：自增、identity、计算列。
   *
   * 和「有默认值」是两回事。`GENERATED ALWAYS AS IDENTITY` 与
   * `AUTO_INCREMENT` 的 `default_value` 都是 null，同时又是非空列——
   * 少了这个标志，新增行时它们会被当成必填项点名，那两种表一行都插不进去。
   */
  is_generated?: boolean;
  /**
   * 以下三项只有 MySQL 有值。
   *
   * 改一列的类型或可空性在 MySQL 里只能用 `MODIFY COLUMN`，而 MODIFY
   * **重述整段定义**：没写进去的排序规则、注释、AUTO_INCREMENT 会被静默丢掉。
   * PostgreSQL 与 SQLite 走 `ALTER COLUMN ... TYPE` 这类窄语法，只改被点名的
   * 那一项，用不上这三项。
   */
  collation?: string | null;
  comment?: string | null;
  /** information_schema 的 `EXTRA` 原文：`auto_increment`、`DEFAULT_GENERATED`… */
  column_extra?: string | null;
}

export interface TableInfo {
  schema?: string;
  name: string;
  table_type: string;
  columns: ColumnInfo[];
  row_count?: number;
}

export interface ViewInfo {
  schema?: string;
  name: string;
  definition?: string;
}

export interface FunctionInfo {
  schema?: string;
  name: string;
  return_type?: string;
}

export interface IndexInfo {
  schema?: string;
  name: string;
  table_name?: string;
}

export interface DatabaseMetadata {
  schemas: SchemaInfo[];
  tables: TableInfo[];
  views: ViewInfo[];
  functions: FunctionInfo[];
  indexes: IndexInfo[];
}

export interface TableSchema {
  columns: ColumnInfo[];
  indexes?: Array<{ name: string; columns: string[] }>;
  constraints?: Array<{ name: string; type: string; columns: string[] }>;
}

/**
 * 库级对象的类型。
 *
 * 不是所有方言都有全部类型：MySQL 与 SQLite 没有序列（AUTO_INCREMENT 是列
 * 属性，不是独立对象），SQLite 的函数是宿主程序注册的、目录里查不到。
 */
export type DatabaseObjectKind =
  | 'table'
  /** MongoDB 的集合。和表分开：它没有结构页、没有 DDL，右键能做的事也不一样 */
  | 'collection'
  /** Redis 的一个逻辑库（`db0`、`db3`）。键太多，不进树；点开是那个库的键浏览页 */
  | 'keyspace'
  /** Neo4j 的标签。点开是一个查询标签：`MATCH (n:标签) RETURN n` */
  | 'label'
  /** Neo4j 的关系类型。点开同样是一个查询标签，看带这种关系的路径 */
  | 'relationship-type'
  | 'view'
  | 'materialized-view'
  | 'function'
  | 'procedure'
  | 'sequence';

export interface DatabaseObject {
  schema: string | null;
  name: string;
  kind: DatabaseObjectKind;
  /** 取定义时用的标识。PostgreSQL 是 oid——函数可以重载，名字不唯一。 */
  id: string;
}

export interface CachedDatabaseMetadata {
  objects: DatabaseObject[];
  lastUpdated: number;
}

/**
 * 补全目录里的关系类型。只有表和视图——函数与序列没有列，补不出字段来。
 */
export type RelationKind = 'table' | 'view';

export interface CompletionColumn {
  name: string;
  /** 完整类型，带长度：`varchar(32)` 而不是 `varchar` */
  dataType: string;
}

export interface CompletionRelation {
  schema: string | null;
  name: string;
  kind: RelationKind;
  columns: CompletionColumn[];
}

/**
 * SQL 编辑器的补全目录缓存。
 *
 * 与 `CachedDatabaseMetadata` 分开：对象树不需要列，而整库的列在大库上是
 * 几千行，不该让侧边栏为补全付这个代价。它由编辑器按需加载。
 */
export interface CachedCompletionCatalog {
  relations: CompletionRelation[];
  /** 加载时的 schemaVersion。对不上说明我们自己执行过 DDL，目录要重拉。 */
  schemaVersion: number;
}
