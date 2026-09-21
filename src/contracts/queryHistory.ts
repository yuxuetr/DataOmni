/**
 * 执行历史：每执行一次语句留下的一条记录。
 *
 * 与草稿是**两件事**，所以是两个模块。草稿回答「我关掉应用前正在写什么」，
 * 随标签生灭、随编辑覆盖，归 `workspacePersistence`；历史回答「我什么时候
 * 在哪个库上跑过什么、结果如何」，只追加不改写，一条执行完就定了。
 * 早先它们挤在同一份 `SqlHistory` 里，于是按连接只存得下一份，而且每敲一个
 * 字都要重写整条历史——两个生命周期不同的东西共用一个存储，哪边都做不对。
 *
 * **这里不存查询结果，一行都不存。** 结果可以重跑得到，而写进 localStorage
 * 会同时撑爆配额（工作区快照跟它抢同一份 5MB）并留下一份可能早已过期的数据。
 * 记录里只有行数这个标量。SQL 里的口令在入库前被 `redactSqlForHistory` 换掉。
 */

import { redactSqlForHistory } from '../utils/historyRedaction';
import type { QueryExecution, QueryExecutionStatus } from './queryExecution';

/**
 * `queued` 与 `running` 不在其中：历史只收**已经结束**的执行。
 * 一条还在跑的记录没有耗时也没有行数，写进去就是一行永远的问号。
 */
export type QueryHistoryStatus = Extract<
  QueryExecutionStatus,
  'succeeded' | 'failed' | 'cancelled' | 'timed-out'
>;

export const QUERY_HISTORY_STATUSES: readonly QueryHistoryStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'timed-out'
];

export interface QueryHistoryEntry {
  id: string;
  /** 执行**开始**的时刻，ISO 8601。按它排序与筛日期 */
  startedAt: string;
  profileId: string;
  /**
   * 执行当时的连接名，是份快照。
   *
   * 不在显示时回查 `connectionStore`：连接会被改名，也会被删除，而历史要
   * 说得出当时连的是哪个。回查的结果是一堆「未知连接」。
   */
  connectionName: string;
  database: string | null;
  /** 已经脱敏的语句。原文从不落盘 */
  sql: string;
  /** 语句里有口令被替换过，照原样重跑会失败 */
  redacted: boolean;
  durationMs: number;
  status: QueryHistoryStatus;
  /** 查询记返回行数，写入记受影响行数；取消与超时没有这个数 */
  rowsAffected: number | null;
  errorMessage?: string;
  /** 以下三项由用户事后添加，见 `favorite` / `name` / `tags` 的编辑动作 */
  favorite?: boolean;
  name?: string;
  tags?: string[];
}

export function isFinishedStatus(status: QueryExecutionStatus): status is QueryHistoryStatus {
  return (QUERY_HISTORY_STATUSES as readonly string[]).includes(status);
}

/** 一条记录被用户标注过——收藏、命名或打过标签 */
export function isAnnotated(entry: QueryHistoryEntry): boolean {
  return entry.favorite === true || Boolean(entry.name) || (entry.tags?.length ?? 0) > 0;
}

export interface QueryHistoryContext {
  /** 执行当时的连接名 */
  connectionName: string;
  /** 查询返回的行数或写入影响的行数；取不到时传 `null` */
  rowsAffected: number | null;
}

/**
 * 由一次已结束的执行造出历史记录。
 *
 * 输入是 `QueryExecution` 而不是一堆散字段：它本来就是「这次执行发生了什么」
 * 的权威记录，时刻、耗时、状态、错误都已经在里面定好了，再从调用方现攒一遍
 * 只会多出一处可以跟它不一致的地方。
 *
 * 还没结束的执行返回 `null`——历史不收在跑的记录。
 */
export function historyEntryFromExecution(
  execution: QueryExecution,
  context: QueryHistoryContext
): QueryHistoryEntry | null {
  if (!isFinishedStatus(execution.status)) {
    return null;
  }

  const { sql, redacted } = redactSqlForHistory(execution.sqlSnapshot);
  return {
    id: execution.id,
    startedAt: execution.startedAt ?? execution.createdAt,
    profileId: execution.session.profileId,
    connectionName: context.connectionName,
    database: execution.session.database,
    sql,
    redacted,
    durationMs: execution.durationMs ?? 0,
    status: execution.status,
    // 取消和超时没跑完，说不出影响了几行。写 0 会被读成「没有匹配的行」
    rowsAffected:
      execution.status === 'succeeded' || execution.status === 'failed'
        ? context.rowsAffected
        : null,
    errorMessage: execution.error?.message
  };
}
