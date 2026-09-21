import type { TranslationKey } from '../i18n/translate';

export type TaskKind = 'import' | 'export';
export type TaskStatus = 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export interface TaskLogEntry {
  at: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface BackgroundTask {
  id: string;
  kind: TaskKind;
  /** 一句话说清这是哪个任务：「导入 public.users」 */
  title: string;
  status: TaskStatus;
  /** 进度那一行，已经格式化好；没有进度时为 null */
  detail: string | null;
  log: TaskLogEntry[];
  /** 日志满了之后丢掉的是最早的那些，这里记一笔，不让它悄悄消失 */
  logTruncated: boolean;
  startedAt: number;
  finishedAt: number | null;
  /**
   * 这次任务在数据库里留下了东西。
   *
   * 决定能不能一键重试：导了一半又被取消的分批导入，前面提交过的批次还在表里，
   * 再跑一遍就是**重复写入**。导出没有这个问题——文件写一遍和写两遍一样。
   */
  leftBehind: boolean;
}

/**
 * 日志最多留多少条。
 *
 * 后端最多带回 100 条错误行，加上生命周期那几条，200 条绰绰有余；
 * 而一份列全错位的文件能让每一行都进日志，界面会先于数据库倒下。
 */
export const MAX_LOG_ENTRIES = 200;

export function appendLog(
  task: Pick<BackgroundTask, 'log' | 'logTruncated'>,
  entries: readonly TaskLogEntry[]
): Pick<BackgroundTask, 'log' | 'logTruncated'> {
  const merged = [...task.log, ...entries];
  if (merged.length <= MAX_LOG_ENTRIES) {
    return { log: merged, logTruncated: task.logTruncated };
  }
  return {
    log: merged.slice(merged.length - MAX_LOG_ENTRIES),
    logTruncated: true
  };
}

export interface TaskDisplay {
  labelKey: TranslationKey;
  tone: 'running' | 'success' | 'warning' | 'danger';
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  /** 能不能原样再跑一遍 */
  canRetry: boolean;
  /** 能不能从列表里划掉 */
  canDismiss: boolean;
  elapsedMs: number;
}

const STATUS_LABELS: Record<TaskStatus, TranslationKey> = {
  running: 'task.status.running',
  paused: 'task.status.paused',
  succeeded: 'task.status.succeeded',
  failed: 'task.status.failed',
  cancelled: 'task.status.cancelled'
};

const STATUS_TONES: Record<TaskStatus, TaskDisplay['tone']> = {
  running: 'running',
  paused: 'warning',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'warning'
};

/**
 * 一个任务此刻能做什么。
 *
 * 两条规则值得单独说：
 *
 * - **只有导入能暂停。** 导出的行是在一个同步回调里写出去的，那里没法等；
 *   而导入的批次循环是我们自己的 async 循环，停在两批之间是干净的。
 * - **留下了东西就不能重试。** 成功的导入重跑一遍是重复写入；分批提交下被
 *   取消的导入，前面的批次已经在表里，同样是重复写入。只有「什么都没留下」
 *   的那一次才谈得上「再来一遍」。
 */
export function describeTask(task: BackgroundTask, now: number = Date.now()): TaskDisplay {
  const active = task.status === 'running' || task.status === 'paused';
  return {
    labelKey: STATUS_LABELS[task.status],
    tone: STATUS_TONES[task.status],
    canPause: task.kind === 'import' && task.status === 'running',
    canResume: task.status === 'paused',
    canCancel: active,
    canRetry: !active && !task.leftBehind,
    canDismiss: !active,
    elapsedMs: Math.max(0, (task.finishedAt ?? now) - task.startedAt)
  };
}

/** 角标上的数字：正在跑的（含暂停的）有几个 */
export function activeTaskCount(tasks: readonly BackgroundTask[]): number {
  return tasks.filter((task) => task.status === 'running' || task.status === 'paused').length;
}

export function formatTaskElapsed(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}
