/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryHistoryEntry } from '../contracts/queryHistory';
import {
  DEFAULT_HISTORY_RETENTION,
  loadQueryHistory,
  pruneHistory,
  saveQueryHistory
} from './queryHistoryStorage';

const NOW = new Date('2026-09-21T12:00:00.000Z');

function entry(overrides: Partial<QueryHistoryEntry> & { id: string }): QueryHistoryEntry {
  return {
    startedAt: NOW.toISOString(),
    profileId: 'p1',
    connectionName: '本地 MySQL',
    database: 'app',
    sql: 'SELECT 1',
    redacted: false,
    durationMs: 3,
    status: 'succeeded',
    rowsAffected: 1,
    ...overrides
  };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('pruneHistory', () => {
  it('按保留天数淘汰过期记录', () => {
    const kept = pruneHistory(
      [entry({ id: 'new', startedAt: daysAgo(3) }), entry({ id: 'old', startedAt: daysAgo(40) })],
      { maxAgeDays: 30, maxEntries: 100 },
      NOW
    );
    expect(kept.map((e) => e.id)).toEqual(['new']);
  });

  it('maxAgeDays 为 0 时不按时间淘汰', () => {
    const entries = [entry({ id: 'ancient', startedAt: daysAgo(3650) })];
    expect(pruneHistory(entries, { maxAgeDays: 0, maxEntries: 100 }, NOW)).toHaveLength(1);
  });

  it('标注过的记录不会因为过期被删掉', () => {
    const entries = [
      entry({ id: 'fav', startedAt: daysAgo(400), favorite: true }),
      entry({ id: 'named', startedAt: daysAgo(400), name: '每日对账' }),
      entry({ id: 'tagged', startedAt: daysAgo(400), tags: ['对账'] }),
      entry({ id: 'plain', startedAt: daysAgo(400) })
    ];
    expect(pruneHistory(entries, { maxAgeDays: 30, maxEntries: 100 }, NOW).map((e) => e.id)).toEqual(
      ['fav', 'named', 'tagged']
    );
  });

  it('超过条数上限时先牺牲未标注的最旧一条', () => {
    const entries = [
      entry({ id: 'newest', startedAt: daysAgo(1) }),
      entry({ id: 'middle', startedAt: daysAgo(2) }),
      entry({ id: 'oldest-but-favorite', startedAt: daysAgo(3), favorite: true })
    ];
    const kept = pruneHistory(entries, { maxAgeDays: 0, maxEntries: 2 }, NOW);
    // 收藏过的那条最旧，却是最后才动的
    expect(kept.map((e) => e.id)).toEqual(['newest', 'oldest-but-favorite']);
  });

  it('条数上限小于标注过的记录数时，标注的也按从旧到新淘汰', () => {
    const entries = [
      entry({ id: 'a', startedAt: daysAgo(1), favorite: true }),
      entry({ id: 'b', startedAt: daysAgo(2), favorite: true }),
      entry({ id: 'c', startedAt: daysAgo(3), favorite: true })
    ];
    expect(pruneHistory(entries, { maxAgeDays: 0, maxEntries: 2 }, NOW).map((e) => e.id)).toEqual([
      'a',
      'b'
    ]);
  });

  it('保留原有次序，不因为淘汰而重排', () => {
    const entries = [
      entry({ id: 'a', startedAt: daysAgo(1) }),
      entry({ id: 'expired', startedAt: daysAgo(90) }),
      entry({ id: 'b', startedAt: daysAgo(2) })
    ];
    expect(pruneHistory(entries, DEFAULT_HISTORY_RETENTION, NOW).map((e) => e.id)).toEqual([
      'a',
      'b'
    ]);
  });

  it('时间戳读不懂的记录留着，不静默消失', () => {
    const entries = [entry({ id: 'broken', startedAt: '不是时间' })];
    expect(pruneHistory(entries, DEFAULT_HISTORY_RETENTION, NOW)).toHaveLength(1);
  });
});

describe('loadQueryHistory / saveQueryHistory', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('存进去再读出来是同一批记录', () => {
    const entries = [entry({ id: 'a' }), entry({ id: 'b' })];
    saveQueryHistory(entries);
    expect(loadQueryHistory().map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('没存过时是空的', () => {
    expect(loadQueryHistory()).toEqual([]);
  });

  it('内容坏掉时不抛，返回空', () => {
    localStorage.setItem('dataomni.query-history', '{ 不是 JSON');
    expect(loadQueryHistory()).toEqual([]);
  });

  it('单条记录写坏只丢那一条，不带走其余的', () => {
    localStorage.setItem(
      'dataomni.query-history',
      JSON.stringify({ version: 1, entries: [entry({ id: 'good' }), { id: 'bad' }] })
    );
    expect(loadQueryHistory().map((e) => e.id)).toEqual(['good']);
  });

  it('配额写不下时砍掉最旧的部分而不是整份丢掉', () => {
    const entries = Array.from({ length: 8 }, (_, index) =>
      entry({ id: `e${index}`, startedAt: daysAgo(index) })
    );
    // 直接盯 localStorage 这个实例而不是 Storage.prototype：happy-dom 的
    // localStorage 自带 setItem，挂在原型上的桩根本不会被调到，于是断言
    // 「不抛」会无条件通过——一条永远绿的门
    const real = localStorage.setItem.bind(localStorage);
    let rejections = 2;
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (rejections > 0) {
        rejections -= 1;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      real(key, value);
    });

    saveQueryHistory(entries);
    expect(setItem).toHaveBeenCalledTimes(3);
    setItem.mockRestore();

    // 8 → 4 → 2：两次被拒之后写进去的是最新的两条
    expect(loadQueryHistory().map((e) => e.id)).toEqual(['e0', 'e1']);
  });

  it('localStorage 完全不可用时不抛', () => {
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(() => saveQueryHistory([entry({ id: 'a' })])).not.toThrow();
    // 桩确实被调到了，否则这条「不抛」什么也没证明
    expect(setItem).toHaveBeenCalled();
    setItem.mockRestore();
  });
});
