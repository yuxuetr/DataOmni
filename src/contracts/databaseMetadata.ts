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

export interface ExplorerTableInfo {
  name: string;
  type: string;
}

export interface ExplorerSchemaInfo {
  name: string;
  tables: ExplorerTableInfo[];
}

export interface CachedDatabaseMetadata {
  schemas: ExplorerSchemaInfo[];
  lastUpdated: number;
}
