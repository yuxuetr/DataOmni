export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  affected_rows: number;
  execution_time: number;
  table_name?: string;
  primary_key?: string;
}

export interface SqlStatement {
  id: string;
  sql: string;
  isExecuting: boolean;
  result?: QueryResult;
  error?: string;
  executedAt?: string;
}

export interface SqlHistory {
  connectionId: string;
  sqlInput: string;
  statements: SqlStatement[];
  lastUpdated: string;
}
