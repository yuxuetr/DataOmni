import type { QueryExecutionError } from '../contracts/queryExecution';
import { translateBackendMessage } from './backendError';
import { describeError } from './describeError';

export const QUERY_TIMEOUT_CODE = 'QUERY_TIMEOUT';
export const QUERY_CANCELLED_CODE = 'QUERY_CANCELLED';
/**
 * 一条语句没有影响到预期的行数。
 *
 * 不是数据库报的错——是 `execute_write_batch` 在事务里自己发现并回滚的，
 * 所以前端要按码识别它并换一句说得清原因的话（那一行被别人改了或删了）。
 */
export const ROW_COUNT_MISMATCH_CODE = 'ROW_COUNT_MISMATCH';

/**
 * 把 `invoke` reject 出来的东西变成结构化错误。
 *
 * 后端的 `execute_query` 现在 reject 一个对象；其余命令仍然 reject 一个字符串，
 * 而 JS 侧也可能抛出普通 Error（比如断网）。三种都要能落地，否则一条
 * 「读不出结构」的错误会变成整块错误面板消失。
 */
export function toQueryExecutionError(error: unknown): QueryExecutionError {
  if (typeof error === 'object' && error !== null && !(error instanceof Error)) {
    const source = error as Record<string, unknown>;
    if (typeof source.message === 'string') {
      return {
        // 这条路绕过 `describeError`，所以翻译要在这里自己做一次——
        // 「数据库会话未连接」这类后端错误就是从这里印到界面上的
        message: translateBackendMessage(source.message),
        code: text(source.code),
        position: positive(source.position),
        detail: text(source.detail),
        hint: text(source.hint),
        constraint: text(source.constraint),
        table: text(source.table)
      };
    }
  }

  return { message: describeError(error) };
}

export interface QueryErrorLocation {
  /** 从 1 开始，供显示 */
  line: number;
  column: number;
  /** 在整份文档里的偏移，供编辑器定位 */
  offset: number;
}

/**
 * 把数据库给的字符位置换算成行列，以及在整份文档里的偏移。
 *
 * 数据库数的是**字符**（码位），而 JavaScript 的字符串下标数的是 UTF-16
 * 码元。一个 emoji 占两个码元、一个码位——直接拿位置当下标用，语句里每多一个
 * 这样的字符就偏一格，而偏出来的位置看上去完全像个正常位置。
 */
export function locateQueryError(
  sql: string,
  position: number,
  statementOffset = 0
): QueryErrorLocation | null {
  if (!Number.isInteger(position) || position < 1) {
    return null;
  }

  const characters = Array.from(sql);
  if (position > characters.length + 1) {
    return null;
  }

  const before = characters.slice(0, position - 1).join('');
  const lines = before.split('\n');
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1,
    offset: statementOffset + before.length
  };
}

/**
 * 可复制的完整详情。
 *
 * 贴到工单或聊天里时，只有一句 message 往往不够——对方要的正是 SQLSTATE
 * 和那条语句。字段缺的就不写，不留一堆「位置: 无」。
 */
export function formatQueryErrorReport(
  error: QueryExecutionError,
  sql: string,
  labels: QueryErrorReportLabels
): string {
  const lines = [`${labels.message}: ${error.message}`];
  const append = (label: string, value: string | number | undefined) => {
    if (value !== undefined && value !== '') {
      lines.push(`${label}: ${value}`);
    }
  };

  append(labels.code, error.code);
  append(labels.position, error.position);
  append(labels.detail, error.detail);
  append(labels.hint, error.hint);
  append(labels.constraint, error.constraint);
  append(labels.table, error.table);
  lines.push('', `${labels.sql}:`, sql);
  return lines.join('\n');
}

export interface QueryErrorReportLabels {
  message: string;
  code: string;
  position: string;
  detail: string;
  hint: string;
  constraint: string;
  table: string;
  sql: string;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
