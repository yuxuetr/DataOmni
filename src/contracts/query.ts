import type { QueryExecutionError } from './queryExecution';
import type { SerializedResultValue } from './resultSet';
import type { ColumnInfo } from './databaseMetadata';
import type { ResultEditability } from '../utils/resultEditability';

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
  /**
   * 这份结果能不能就地改，以及靠哪几列定位一行。
   *
   * 不存表名和「主键」两个裸字段：那两个字段合法的组合远多于有意义的组合
   * （有表名没键、有键但键不在投影里…），每个读它们的地方都得自己重新判断一遍。
   */
  editability?: ResultEditability;
  /** 目标表的列元数据，写入时按声明类型决定比较该内联还是绑定 */
  tableColumns?: ColumnInfo[];
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
