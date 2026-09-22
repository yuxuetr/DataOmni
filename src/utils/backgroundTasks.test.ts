import { describe, expect, it } from 'vitest';
import {
  activeTaskCount,
  appendLog,
  describeTask,
  formatTaskElapsed,
  MAX_LOG_ENTRIES,
  TASK_STATUSES,
  type BackgroundTask
} from './backgroundTasks';
import { QUERY_EXECUTION_STATUSES } from '../contracts/queryExecution';

const NOW = 1_800_000_000_000;

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: 't1',
    kind: 'import',
    title: '导入 public.users',
    status: 'running',
    detail: null,
    log: [],
    logTruncated: false,
    startedAt: NOW - 5_000,
    finishedAt: null,
    leftBehind: false,
    ...overrides
  };
}

describe('describeTask', () => {
  it('只有导入能暂停', () => {
    // 导出的行是在一个同步回调里写出去的，那里没法等
    expect(describeTask(task({ kind: 'import' }), NOW).canPause).toBe(true);
    expect(describeTask(task({ kind: 'export' }), NOW).canPause).toBe(false);
  });

  it('暂停着的任务能继续，也还能取消', () => {
    const display = describeTask(task({ status: 'paused' }), NOW);
    expect(display.canResume).toBe(true);
    expect(display.cancel).toBe('available');
    expect(display.canPause).toBe(false);
  });

  it('在库里留下了东西就不给重试', () => {
    // 分批提交下被取消的导入，前面的批次已经在表里，再跑一遍就是重复写入
    expect(
      describeTask(task({ status: 'cancelled', finishedAt: NOW, leftBehind: true }), NOW).canRetry
    ).toBe(false);
    expect(
      describeTask(task({ status: 'cancelled', finishedAt: NOW, leftBehind: false }), NOW).canRetry
    ).toBe(true);
  });

  it('成功的导入不给重试', () => {
    // 成功意味着行已经在表里；「重试」在这里只会变成重复导入
    expect(
      describeTask(task({ status: 'succeeded', finishedAt: NOW, leftBehind: true }), NOW).canRetry
    ).toBe(false);
  });

  it('请求取消之后：转圈继续转，取消按钮变成等待态', () => {
    // 那一批要先收尾，任务并没有停。转圈停下来会让人以为已经停了，
    // 而这时候去关窗口、去改表，撞上的是一个还在写的事务
    const display = describeTask(task({ status: 'cancel-requested' }), NOW);
    expect(display.tone).toBe('running');
    expect(display.cancel).toBe('pending');
    expect(display.labelKey).toBe('task.status.cancel-requested');
  });

  it('请求取消之后不给暂停、继续、重试和划掉', () => {
    // 暂停一个正在关门的循环，要么无效，要么把取消又拖长一批
    const display = describeTask(task({ status: 'cancel-requested' }), NOW);
    expect(display.canPause).toBe(false);
    expect(display.canResume).toBe(false);
    expect(display.canRetry).toBe(false);
    expect(display.canDismiss).toBe(false);
  });

  it('结束之后取消按钮就不在了', () => {
    expect(describeTask(task({ status: 'succeeded', finishedAt: NOW }), NOW).cancel).toBe('none');
    expect(describeTask(task({ status: 'cancelled', finishedAt: NOW }), NOW).cancel).toBe('none');
  });

  it('跑着的任务不能重试也不能划掉', () => {
    const display = describeTask(task(), NOW);
    expect(display.canRetry).toBe(false);
    expect(display.canDismiss).toBe(false);
  });

  it('已经结束的任务用结束时刻算用时，不跟着现在走', () => {
    const display = describeTask(
      task({ status: 'succeeded', startedAt: NOW - 9_000, finishedAt: NOW - 4_000 }),
      NOW
    );
    expect(display.elapsedMs).toBe(5_000);
  });

  it('时钟倒退时用时不是负数', () => {
    expect(describeTask(task({ startedAt: NOW + 1_000 }), NOW).elapsedMs).toBe(0);
  });
});

describe('appendLog', () => {
  const entry = (text: string) => ({ at: NOW, level: 'info' as const, text });

  it('照原样追加', () => {
    const next = appendLog({ log: [entry('a')], logTruncated: false }, [entry('b')]);
    expect(next.log.map((item) => item.text)).toEqual(['a', 'b']);
    expect(next.logTruncated).toBe(false);
  });

  it('超过上限时丢掉最早的，并且留下一句「丢过」', () => {
    // 悄悄丢掉会让人以为前面什么都没发生过
    const log = Array.from({ length: MAX_LOG_ENTRIES }, (_, index) => entry(`e${index}`));
    const next = appendLog({ log, logTruncated: false }, [entry('newest')]);
    expect(next.log).toHaveLength(MAX_LOG_ENTRIES);
    expect(next.log[0]?.text).toBe('e1');
    expect(next.log[next.log.length - 1]?.text).toBe('newest');
    expect(next.logTruncated).toBe(true);
  });

  it('丢过的标记不会因为后来没满而被抹掉', () => {
    const next = appendLog({ log: [entry('a')], logTruncated: true }, [entry('b')]);
    expect(next.logTruncated).toBe(true);
  });
});

describe('activeTaskCount', () => {
  it('暂停的、正在取消的都算在跑', () => {
    // 暂停不是结束：那个事务还开着。请求取消也不是结束：那一批还在写
    expect(
      activeTaskCount([
        task({ status: 'running' }),
        task({ status: 'paused' }),
        task({ status: 'cancel-requested' }),
        task({ status: 'succeeded' }),
        task({ status: 'failed' }),
        task({ status: 'cancelled' })
      ])
    ).toBe(3);
  });
});

describe('两套状态机在这五档上必须同名', () => {
  // 「长任务统一显示运行中、取消请求中、已取消、成功和失败」。此前它们不统一：
  // 查询执行有 cancel-requested，导入导出没有——点了取消，界面还写着「运行中」。
  // 两边各自演进得很容易再次漂开，所以把这五个名字钉在这里。
  const SHARED = ['running', 'cancel-requested', 'cancelled', 'succeeded', 'failed'] as const;

  it('导入导出这边都有', () => {
    for (const status of SHARED) {
      expect(TASK_STATUSES, status).toContain(status);
    }
  });

  it('查询执行那边都有', () => {
    for (const status of SHARED) {
      expect(QUERY_EXECUTION_STATUSES, status).toContain(status);
    }
  });

  it('每一档都有自己的文案，不许两档共用一句', () => {
    // 共用一句就等于没有这一档：界面上看不出区别
    const labels = TASK_STATUSES.map((status) => describeTask(task({ status }), NOW).labelKey);
    expect(new Set(labels).size).toBe(TASK_STATUSES.length);
  });
});

describe('formatTaskElapsed', () => {
  it('不到一分钟只写秒', () => {
    expect(formatTaskElapsed(42_000)).toBe('42s');
  });

  it('超过一分钟补零，不写成 3m 5s', () => {
    expect(formatTaskElapsed(185_000)).toBe('3m 05s');
  });
});
