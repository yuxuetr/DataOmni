import { describe, expect, it } from 'vitest';
import { describeTransaction, formatTransactionElapsed } from './transactionDisplay';

const START = '2026-09-21T00:00:00.000Z';
const started = Date.parse(START);

describe('describeTransaction', () => {
  it('没在事务里：能开始，不能提交，也不显示计时', () => {
    // 一个显示 00:00 的计时器看起来像一个刚开始的事务
    expect(describeTransaction({ status: 'idle', startedAt: null })).toEqual({
      labelKey: 'tx.idle',
      tone: 'muted',
      canBegin: true,
      canCommit: false,
      canRollback: false,
      elapsedMs: null
    });
  });

  it('事务中：不能再开始，能提交，计时从开始时间算起', () => {
    const display = describeTransaction(
      { status: 'active', startedAt: START },
      started + 75_000
    );
    expect(display.canBegin).toBe(false);
    expect(display.canCommit).toBe(true);
    expect(display.canRollback).toBe(true);
    expect(display.elapsedMs).toBe(75_000);
    expect(display.tone).toBe('warning');
  });

  it('事务已废：只能回滚，不能提交', () => {
    // PostgreSQL 对 aborted 事务的 COMMIT 会返回成功，做的却是回滚。
    // 留着那个按钮等于让人按下「提交」之后以为数据存进去了
    const display = describeTransaction({ status: 'failed', startedAt: START }, started);
    expect(display.canCommit).toBe(false);
    expect(display.canRollback).toBe(true);
    expect(display.canBegin).toBe(false);
    expect(display.tone).toBe('danger');
  });

  it('开始时间读不出来时不算计时，而不是算成 0', () => {
    expect(describeTransaction({ status: 'active', startedAt: null }).elapsedMs).toBeNull();
    expect(describeTransaction({ status: 'active', startedAt: 'nonsense' }).elapsedMs).toBeNull();
  });

  it('时钟回拨不给出负数', () => {
    expect(describeTransaction({ status: 'active', startedAt: START }, started - 5000).elapsedMs)
      .toBe(0);
  });
});

describe('formatTransactionElapsed', () => {
  it('分秒补零', () => {
    expect(formatTransactionElapsed(0)).toBe('00:00');
    expect(formatTransactionElapsed(9_000)).toBe('00:09');
    expect(formatTransactionElapsed(75_000)).toBe('01:15');
    expect(formatTransactionElapsed(599_000)).toBe('09:59');
  });

  it('超过一小时加上小时段——开了一小时的事务是个该看见的数字', () => {
    expect(formatTransactionElapsed(3_600_000)).toBe('1:00:00');
    expect(formatTransactionElapsed(3_725_000)).toBe('1:02:05');
  });
});
