import { describe, expect, it } from 'vitest';
import type { QueryHistoryEntry } from '../contracts/queryHistory';
import { EMPTY_HISTORY_FILTER, filterHistory, isEmptyFilter } from './historySearch';

function entry(overrides: Partial<QueryHistoryEntry> & { id: string }): QueryHistoryEntry {
  return {
    startedAt: '2026-09-21T10:00:00.000Z',
    profileId: 'p1',
    connectionName: '本地 MySQL',
    database: 'app',
    sql: 'SELECT * FROM orders',
    redacted: false,
    durationMs: 5,
    status: 'succeeded',
    rowsAffected: 3,
    ...overrides
  };
}

/** 把本地时间写成 ISO，免得测试断言被跑测试的机器所在时区左右 */
function localIso(year: number, month: number, day: number, hour = 12): string {
  return new Date(year, month - 1, day, hour).toISOString();
}

describe('filterHistory', () => {
  it('空筛选返回全部', () => {
    const entries = [entry({ id: 'a' }), entry({ id: 'b' })];
    expect(filterHistory(entries, EMPTY_HISTORY_FILTER)).toHaveLength(2);
    expect(isEmptyFilter(EMPTY_HISTORY_FILTER)).toBe(true);
  });

  it('按文本找 SQL，忽略大小写', () => {
    const entries = [
      entry({ id: 'orders', sql: 'SELECT * FROM orders' }),
      entry({ id: 'users', sql: 'SELECT * FROM users' })
    ];
    expect(
      filterHistory(entries, { ...EMPTY_HISTORY_FILTER, text: 'ORDERS' }).map((e) => e.id)
    ).toEqual(['orders']);
  });

  it('按文本也找命名和标签', () => {
    const entries = [
      entry({ id: 'named', sql: 'SELECT 1', name: '每日对账' }),
      entry({ id: 'tagged', sql: 'SELECT 2', tags: ['对账', '财务'] }),
      entry({ id: 'plain', sql: 'SELECT 3' })
    ];
    expect(
      filterHistory(entries, { ...EMPTY_HISTORY_FILTER, text: '对账' })
        .map((e) => e.id)
        .sort()
    ).toEqual(['named', 'tagged']);
  });

  it('文本是子串匹配，不是子序列', () => {
    // 子序列匹配下 `sel` 能命中含 s、e、l 的任何语句，等于没筛
    const entries = [entry({ id: 'other', sql: 'UPDATE sales SET label = 1' })];
    expect(filterHistory(entries, { ...EMPTY_HISTORY_FILTER, text: 'sel' })).toHaveLength(0);
  });

  it('按连接筛', () => {
    const entries = [entry({ id: 'a', profileId: 'p1' }), entry({ id: 'b', profileId: 'p2' })];
    expect(
      filterHistory(entries, { ...EMPTY_HISTORY_FILTER, profileId: 'p2' }).map((e) => e.id)
    ).toEqual(['b']);
  });

  it('按状态筛', () => {
    const entries = [
      entry({ id: 'ok', status: 'succeeded' }),
      entry({ id: 'bad', status: 'failed' }),
      entry({ id: 'slow', status: 'timed-out' })
    ];
    expect(
      filterHistory(entries, { ...EMPTY_HISTORY_FILTER, status: 'failed' }).map((e) => e.id)
    ).toEqual(['bad']);
  });

  it('日期区间含首尾两天', () => {
    const entries = [
      entry({ id: 'before', startedAt: localIso(2026, 9, 19) }),
      entry({ id: 'first', startedAt: localIso(2026, 9, 20) }),
      entry({ id: 'last', startedAt: localIso(2026, 9, 21, 23) }),
      entry({ id: 'after', startedAt: localIso(2026, 9, 22) })
    ];
    expect(
      filterHistory(entries, {
        ...EMPTY_HISTORY_FILTER,
        from: '2026-09-20',
        to: '2026-09-21'
      }).map((e) => e.id)
    ).toEqual(['first', 'last']);
  });

  it('日期按本地时区算，不按 UTC', () => {
    // 当地时间 9 月 20 日 00:30 —— 在东八区以东的时区里它的 UTC 日期是 9 月 19 日。
    // 按 UTC 解释日期框的话，选「9 月 20 日起」会把这条漏掉
    const entries = [entry({ id: 'early', startedAt: localIso(2026, 9, 20, 0) })];
    expect(
      filterHistory(entries, { ...EMPTY_HISTORY_FILTER, from: '2026-09-20' }).map((e) => e.id)
    ).toEqual(['early']);

    const previousDay = [entry({ id: 'yesterday', startedAt: localIso(2026, 9, 19, 23) })];
    expect(filterHistory(previousDay, { ...EMPTY_HISTORY_FILTER, from: '2026-09-20' })).toHaveLength(
      0
    );
  });

  it('只看收藏', () => {
    const entries = [entry({ id: 'fav', favorite: true }), entry({ id: 'plain' })];
    expect(
      filterHistory(entries, { ...EMPTY_HISTORY_FILTER, favoritesOnly: true }).map((e) => e.id)
    ).toEqual(['fav']);
  });

  it('多个条件是与的关系', () => {
    const entries = [
      entry({ id: 'match', profileId: 'p1', status: 'failed', sql: 'DELETE FROM orders' }),
      entry({ id: 'wrong-status', profileId: 'p1', status: 'succeeded', sql: 'DELETE FROM orders' }),
      entry({ id: 'wrong-profile', profileId: 'p2', status: 'failed', sql: 'DELETE FROM orders' })
    ];
    expect(
      filterHistory(entries, {
        ...EMPTY_HISTORY_FILTER,
        profileId: 'p1',
        status: 'failed',
        text: 'orders'
      }).map((e) => e.id)
    ).toEqual(['match']);
  });

  it('日期格式不对时当作没填这一端', () => {
    const entries = [entry({ id: 'a' })];
    expect(filterHistory(entries, { ...EMPTY_HISTORY_FILTER, from: '昨天' })).toHaveLength(1);
  });
});
