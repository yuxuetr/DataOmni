import type { QueryExecutionError } from './queryExecution';
import type { SerializedResultValue } from './resultSet';

export interface QueryResult {
  columns: string[];
  column_metadata?: DriverQueryColumn[];
  rows: SerializedResultValue[][];
  affected_rows: number;
  execution_time: number;
  truncated?: boolean;
  truncation_reason?: 'row_limit' | 'byte_limit' | null;
  row_limit?: number;
  byte_limit?: number;
  bytes_read?: number;
  table_name?: string;
  primary_key?: string;
}

export interface DriverQueryColumn {
  name: string;
  ordinal: number;
  database_type: string;
  logical_type:
    | 'boolean'
    | 'integer'
    | 'decimal'
    | 'text'
    | 'binary'
    | 'date'
    | 'time'
    | 'datetime'
    | 'json'
    | 'unknown';
  nullable: boolean | null;
}

export interface DriverQueryBatch {
  index: number;
  offset: number;
  rows: Record<string, SerializedResultValue>[];
}

export type DriverQueryResult =
  | {
      kind: 'rows';
      columns: string[];
      column_metadata: DriverQueryColumn[];
      row_count: number;
      batch_count: number;
      truncated: boolean;
      truncation_reason: 'row_limit' | 'byte_limit' | null;
      row_limit: number;
      byte_limit: number;
      bytes_read: number;
    }
  | {
      kind: 'affected';
      rows_affected: number;
    };

export interface SqlStatement {
  id: string;
  sql: string;
  isExecuting: boolean;
  result?: QueryResult;
  resultSql?: string;
  error?: string;
  /** 数据库给的结构化错误，用来显示 SQLSTATE、位置与 DETAIL */
  errorDetails?: QueryExecutionError;
  executedAt?: string;
}

export interface SqlHistory {
  connectionId: string;
  sqlInput: string;
  statements: SqlStatement[];
  lastUpdated: string;
}
