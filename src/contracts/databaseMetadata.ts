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
