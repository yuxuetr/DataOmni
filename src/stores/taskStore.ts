import { create } from 'zustand';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { ExportOptions } from '../utils/exportResult';
import {
  appendLog,
  type BackgroundTask,
  type TaskKind,
  type TaskLogEntry
} from '../utils/backgroundTasks';
import { describeError } from '../utils/describeError';
import { formatBytes } from '../utils/formatBytes';
import { translateNow } from './languageStore';

export interface ImportTaskPayload {
  connectionId: string;
  schema: string | null;
  table: string;
  path: string;
  csv: { delimiter: string; hasHeader: boolean; nullText: string };
  columns: Array<{ source: number; target: string; targetType: string }>;
  batchSize: number;
  strategy: 'single-transaction' | 'per-batch';
  onError: 'abort' | 'skip';
}

export interface ExportTaskPayload {
  connectionId: string;
  sql: string;
  path: string;
  options: ExportOptions;
}

export type TaskRequest =
  | { kind: 'import'; title: string; payload: ImportTaskPayload }
  | { kind: 'export'; title: string; payload: ExportTaskPayload };

interface ImportProgress {
  rowsRead: number;
  rowsInserted: number;
  rowsFailed: number;
}

interface ImportSummary extends ImportProgress {
  errors: Array<{ line: number; message: string; values: string[] }>;
  errorsTruncated: boolean;
  rolledBack: boolean;
  cancelled: boolean;
}

interface ExportProgress {
  rowsWritten: number;
  bytesWritten: number;
}

interface ExportSummary extends ExportProgress {
  path: string;
}

/** 后端在取消时给的错误码；界面上不该当成失败 */
const EXPORT_CANCELLED_CODE = 'EXPORT_CANCELLED';

interface TaskState {
  tasks: BackgroundTask[];
  /** 任务面板开着没有 */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** 起一个任务，返回它的 id。任务活在 store 里，关掉对话框不会打断它 */
  start: (request: TaskRequest) => string;
  setPaused: (id: string, paused: boolean) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  /** 原样再跑一遍，成为一个新任务；失败那次的日志留在列表里 */
  retry: (id: string) => void;
  dismiss: (id: string) => void;
  clearFinished: () => void;
}

function entry(level: TaskLogEntry['level'], text: string): TaskLogEntry {
  return { at: Date.now(), level, text };
}

export const useTaskStore = create<TaskState>((set, get) => {
  /** 请求留着是为了重试；它不属于任务的显示状态，所以不放进 task 里 */
  const requests = new Map<string, TaskRequest>();

  const patch = (id: string, change: (task: BackgroundTask) => BackgroundTask) => {
    set((state) => ({
      tasks: state.tasks.map((task) => (task.id === id ? change(task) : task))
    }));
  };

  const log = (id: string, entries: readonly TaskLogEntry[]) => {
    patch(id, (task) => ({ ...task, ...appendLog(task, entries) }));
  };

  const finish = (
    id: string,
    status: BackgroundTask['status'],
    detail: string | null,
    leftBehind: boolean
  ) => {
    patch(id, (task) => ({
      ...task,
      status,
      detail: detail ?? task.detail,
      leftBehind,
      finishedAt: Date.now()
    }));
  };

  const runImport = async (id: string, payload: ImportTaskPayload) => {
    const onProgress = new Channel<ImportProgress>((progress) => {
      patch(id, (task) => ({
        ...task,
        detail: translateNow('task.detail.import', {
          read: progress.rowsRead,
          inserted: progress.rowsInserted,
          failed: progress.rowsFailed
        })
      }));
    });

    try {
      const summary = await invoke<ImportSummary>('import_csv_file', {
        onProgress,
        request: { ...payload, importId: id }
      });

      const entries: TaskLogEntry[] = summary.errors.map((rowError) =>
        entry(
          'warn',
          `${translateNow('import.errorLine', { line: rowError.line })} ${rowError.message}`
        )
      );
      if (summary.errorsTruncated) {
        entries.push(
          entry('warn', translateNow('import.errorsTruncated', { count: summary.errors.length }))
        );
      }
      if (summary.rolledBack) {
        entries.push(entry('warn', translateNow('import.rolledBack')));
      } else if (payload.strategy === 'per-batch' && summary.rowsFailed > 0) {
        entries.push(entry('info', translateNow('import.partiallyKept')));
      }
      entries.push(
        entry(
          summary.rowsFailed > 0 ? 'warn' : 'info',
          translateNow('import.summary', {
            read: summary.rowsRead,
            inserted: summary.rowsInserted,
            failed: summary.rowsFailed
          })
        )
      );
      log(id, entries);

      finish(
        id,
        summary.cancelled ? 'cancelled' : 'succeeded',
        translateNow('task.detail.import', {
          read: summary.rowsRead,
          inserted: summary.rowsInserted,
          failed: summary.rowsFailed
        }),
        summary.rowsInserted > 0
      );
    } catch (error) {
      log(id, [entry('error', describeError(error, translateNow('import.failed')))]);
      // 单事务下报错意味着那个事务从没提交过，库里什么都没留下；分批提交
      // 则可能有批次已经进去了，而我们证明不了没有——那一侧不给「重试」
      finish(id, 'failed', null, payload.strategy === 'per-batch');
    }
  };

  const runExport = async (id: string, payload: ExportTaskPayload) => {
    const onProgress = new Channel<ExportProgress>((progress) => {
      patch(id, (task) => ({
        ...task,
        detail: translateNow('task.detail.export', {
          rows: progress.rowsWritten,
          bytes: formatBytes(progress.bytesWritten)
        })
      }));
    });

    try {
      const summary = await invoke<ExportSummary>('export_query_to_file', {
        onProgress,
        request: {
          connectionId: payload.connectionId,
          exportId: id,
          sql: payload.sql,
          path: payload.path,
          options: payload.options
        }
      });
      log(id, [entry('info', summary.path)]);
      finish(
        id,
        'succeeded',
        translateNow('task.detail.export', {
          rows: summary.rowsWritten,
          bytes: formatBytes(summary.bytesWritten)
        }),
        // 导出写的是文件，再跑一遍只是覆盖它；不存在「重复写入」
        false
      );
    } catch (error) {
      const cancelled =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: string }).code === EXPORT_CANCELLED_CODE
          : false;
      if (!cancelled) {
        log(id, [entry('error', describeError(error, translateNow('export.failed')))]);
      }
      finish(id, cancelled ? 'cancelled' : 'failed', null, false);
    }
  };

  const launch = (request: TaskRequest): string => {
    const id = crypto.randomUUID();
    requests.set(id, request);
    const task: BackgroundTask = {
      id,
      kind: request.kind satisfies TaskKind,
      title: request.title,
      status: 'running',
      detail: null,
      log: [entry('info', translateNow('task.log.started'))],
      logTruncated: false,
      startedAt: Date.now(),
      finishedAt: null,
      leftBehind: false
    };
    // 新的排在最前：最想看的永远是刚起的那个
    set((state) => ({ tasks: [task, ...state.tasks], open: true }));

    if (request.kind === 'import') {
      void runImport(id, request.payload);
    } else {
      void runExport(id, request.payload);
    }
    return id;
  };

  return {
    tasks: [],
    open: false,
    setOpen: (open) => set({ open }),
    start: launch,

    setPaused: async (id, paused) => {
      const applied = await invoke<boolean>('set_import_paused', { importId: id, paused })
        .catch(() => paused);
      patch(id, (task) =>
        // 已经结束的任务不该被一次迟到的暂停回答改回「进行中」
        task.status === 'running' || task.status === 'paused'
          ? { ...task, status: applied ? 'paused' : 'running' }
          : task
      );
    },

    cancel: async (id) => {
      const task = get().tasks.find((candidate) => candidate.id === id);
      if (!task) {
        return;
      }
      // 暂停着的导入正卡在等待里，收不到取消——先放开再取消
      if (task.status === 'paused') {
        await invoke('set_import_paused', { importId: id, paused: false }).catch(() => undefined);
        patch(id, (current) => ({ ...current, status: 'running' }));
      }
      log(id, [entry('warn', translateNow('task.log.cancelRequested'))]);
      const command = task.kind === 'import' ? 'cancel_import' : 'cancel_export';
      const key = task.kind === 'import' ? 'importId' : 'exportId';
      await invoke<boolean>(command, { [key]: id }).catch(() => undefined);
    },

    retry: (id) => {
      const request = requests.get(id);
      if (request) {
        launch(request);
      }
    },

    dismiss: (id) => {
      requests.delete(id);
      set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) }));
    },

    clearFinished: () => {
      set((state) => {
        const kept = state.tasks.filter(
          (task) => task.status === 'running' || task.status === 'paused'
        );
        for (const task of state.tasks) {
          if (!kept.includes(task)) {
            requests.delete(task.id);
          }
        }
        return { tasks: kept };
      });
    }
  };
});
