export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  affected_rows: number;
  execution_time: number;
  truncated?: boolean;
  row_limit?: number;
  table_name?: string;
  primary_key?: string;
}

export interface DriverQueryBatch {
  index: number;
  offset: number;
  rows: Record<string, unknown>[];
}

export type DriverQueryResult =
  | {
      kind: 'rows';
      columns: string[];
      row_count: number;
      batch_count: number;
      truncated: boolean;
      row_limit: number;
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
  executedAt?: string;
}

export interface SqlHistory {
  connectionId: string;
  sqlInput: string;
  statements: SqlStatement[];
  lastUpdated: string;
}
