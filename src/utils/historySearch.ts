/**
 * 历史的筛选。
 *
 * 文本用**子串**匹配，不用命令面板那套模糊（子序列）匹配：SQL 动辄几行，
 * 子序列在这种长度上几乎命中一切——查 `sel` 会把每一条含 s、e、l 的语句
 * 都捞出来，等于没筛。翻历史的人心里有的是一个具体的表名或词。
 */

import type { QueryHistoryEntry, QueryHistoryStatus } from '../contracts/queryHistory';

export interface HistoryFilter {
  /** 在 SQL、命名和标签里找。空串表示不按文本筛 */
  text: string;
  /** 连接 id；`null` 表示全部连接 */
  profileId: string | null;
  status: QueryHistoryStatus | null;
  /** 本地日期 `YYYY-MM-DD`，含当天。`null` 表示这一端不限 */
  from: string | null;
  to: string | null;
  favoritesOnly: boolean;
  /**
   * 只看跑得慢的。`null` 表示不按耗时筛。
   *
   * 阈值是**筛选时**的，不是记录时的：存一个「当时算不算慢」的布尔，用户
   * 把阈值从 1 秒调到 200 毫秒之后，历史里那些 400 毫秒的记录仍然不见。
   * 耗时本来就存着，现算就行。
   */
  slowerThanMs: number | null;
}

export const EMPTY_HISTORY_FILTER: HistoryFilter = {
  text: '',
  profileId: null,
  status: null,
  from: null,
  to: null,
  favoritesOnly: false,
  slowerThanMs: null
};

export function isEmptyFilter(filter: HistoryFilter): boolean {
  return (
    filter.text.trim() === '' &&
    filter.profileId === null &&
    filter.status === null &&
    filter.from === null &&
    filter.to === null &&
    !filter.favoritesOnly &&
    filter.slowerThanMs === null
  );
}

/**
 * 把 `YYYY-MM-DD` 解释成**本地**时区那一天的起点。
 *
 * 不能用 `Date.parse('2026-09-21')`——那是按 UTC 解释的，东八区的用户选
 * 「9 月 21 日」会连 9 月 20 日早上八点之后的记录一起捞进来。日期框里写的
 * 是用户当地的日期，就得按当地算。
 */
function localDayStart(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) {
    return null;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

const ONE_DAY = 24 * 60 * 60 * 1000;

export function filterHistory(
  entries: readonly QueryHistoryEntry[],
  filter: HistoryFilter
): QueryHistoryEntry[] {
  const needle = filter.text.trim().toLowerCase();
  const fromTime = filter.from ? localDayStart(filter.from) : null;
  const toStart = filter.to ? localDayStart(filter.to) : null;
  // `to` 那一天本身也要算在内：选「到 9 月 21 日」却看不到当天跑过的查询，
  // 是这个筛选最容易出、也最难被发现的一种错
  const toTime = toStart === null ? null : toStart + ONE_DAY;

  return entries.filter((entry) => {
    if (filter.profileId !== null && entry.profileId !== filter.profileId) {
      return false;
    }
    if (filter.status !== null && entry.status !== filter.status) {
      return false;
    }
    if (filter.favoritesOnly && entry.favorite !== true) {
      return false;
    }
    if (filter.slowerThanMs !== null && entry.durationMs < filter.slowerThanMs) {
      return false;
    }

    if (fromTime !== null || toTime !== null) {
      const startedAt = Date.parse(entry.startedAt);
      if (Number.isNaN(startedAt)) {
        return false;
      }
      if (fromTime !== null && startedAt < fromTime) {
        return false;
      }
      if (toTime !== null && startedAt >= toTime) {
        return false;
      }
    }

    if (needle === '') {
      return true;
    }
    return searchableText(entry).includes(needle);
  });
}

function searchableText(entry: QueryHistoryEntry): string {
  // 命名和标签一起参与：给一条语句起了名字之后，再去记它原本的 SQL 长什么样
  // 就本末倒置了
  return [entry.sql, entry.name ?? '', ...(entry.tags ?? [])].join('\n').toLowerCase();
}
