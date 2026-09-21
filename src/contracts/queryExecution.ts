import { DatabaseSession } from './session';

export type QueryExecutionStatus =
  | 'queued'
  | 'running'
  | 'cancel-requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

export type SqlDialect = 'mysql' | 'postgresql' | 'sqlite';

export interface QueryExecutionSessionSnapshot {
  readonly profileId: string;
  readonly sessionId: string;
  readonly database: string | null;
}

/**
 * 数据库说的那一套，原样带上来。
 *
 * `code` 之外的几项只有部分数据库会给：位置只有 PostgreSQL 有，MySQL 与
 * SQLite 不给——界面据此决定显不显示「跳到出错位置」，而不是凭空算一个。
 */
export interface QueryExecutionError {
  message: string;
  /** PostgreSQL 的 SQLSTATE、MySQL 的错误号、SQLite 的扩展结果码；
   *  超时与取消用 `QUERY_TIMEOUT` / `QUERY_CANCELLED` */
  code?: string;
  /** 出错处在**这条语句**里的字符位置，从 1 开始。只有 PostgreSQL 给 */
  position?: number;
  detail?: string;
  hint?: string;
  constraint?: string;
  table?: string;
}

export interface QueryExecutionCancellation {
  requestedAt: string | null;
  acknowledgedAt: string | null;
}

export interface QueryExecution {
  id: string;
  tabId: string;
  readonly sqlSnapshot: string;
  readonly dialect: SqlDialect;
  readonly session: QueryExecutionSessionSnapshot;
  status: QueryExecutionStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  cancellation: QueryExecutionCancellation;
  resultSetIds: string[];
  error: QueryExecutionError | null;
}

interface CreateQueryExecutionOptions {
  id?: string;
  now?: string;
}

function getDurationMs(execution: QueryExecution, finishedAt: string): number {
  const startedAt = execution.startedAt ?? execution.createdAt;
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
}

function assertActiveExecution(execution: QueryExecution): void {
  if (execution.status !== 'running' && execution.status !== 'cancel-requested') {
    throw new Error(`查询执行 ${execution.id} 当前状态为 ${execution.status}，无法完成`);
  }
}

export function createQueryExecution(
  tabId: string,
  sql: string,
  session: DatabaseSession,
  dialect: SqlDialect,
  options: CreateQueryExecutionOptions = {}
): QueryExecution {
  const now = options.now ?? new Date().toISOString();

  return {
    id: options.id ?? crypto.randomUUID(),
    tabId,
    sqlSnapshot: sql,
    dialect,
    session: {
      profileId: session.profileId,
      sessionId: session.id,
      database: session.database
    },
    status: 'queued',
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    cancellation: {
      requestedAt: null,
      acknowledgedAt: null
    },
    resultSetIds: [],
    error: null
  };
}

export function startQueryExecution(
  execution: QueryExecution,
  startedAt: string = new Date().toISOString()
): QueryExecution {
  if (execution.status !== 'queued') {
    throw new Error(`查询执行 ${execution.id} 当前状态为 ${execution.status}，无法启动`);
  }

  return {
    ...execution,
    status: 'running',
    startedAt
  };
}

export function requestQueryExecutionCancellation(
  execution: QueryExecution,
  requestedAt: string = new Date().toISOString()
): QueryExecution {
  if (execution.status !== 'running') {
    throw new Error(`查询执行 ${execution.id} 当前状态为 ${execution.status}，无法请求取消`);
  }

  return {
    ...execution,
    status: 'cancel-requested',
    cancellation: {
      ...execution.cancellation,
      requestedAt
    }
  };
}

export function completeQueryExecution(
  execution: QueryExecution,
  resultSetIds: string[],
  finishedAt: string = new Date().toISOString()
): QueryExecution {
  assertActiveExecution(execution);

  return {
    ...execution,
    status: 'succeeded',
    finishedAt,
    durationMs: getDurationMs(execution, finishedAt),
    resultSetIds: [...resultSetIds],
    error: null
  };
}

export function failQueryExecution(
  execution: QueryExecution,
  error: QueryExecutionError,
  finishedAt: string = new Date().toISOString(),
  status: 'failed' | 'timed-out' = 'failed'
): QueryExecution {
  assertActiveExecution(execution);

  return {
    ...execution,
    status,
    finishedAt,
    durationMs: getDurationMs(execution, finishedAt),
    resultSetIds: [],
    error: { ...error }
  };
}

export function cancelQueryExecution(
  execution: QueryExecution,
  finishedAt: string = new Date().toISOString()
): QueryExecution {
  if (execution.status !== 'cancel-requested') {
    throw new Error(`查询执行 ${execution.id} 当前状态为 ${execution.status}，无法确认取消`);
  }

  return {
    ...execution,
    status: 'cancelled',
    finishedAt,
    durationMs: getDurationMs(execution, finishedAt),
    cancellation: {
      ...execution.cancellation,
      acknowledgedAt: finishedAt
    }
  };
}
