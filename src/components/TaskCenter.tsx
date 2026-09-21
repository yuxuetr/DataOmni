import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  X
} from 'lucide-react';
import { clsx } from 'clsx';
import {
  activeTaskCount,
  describeTask,
  formatTaskElapsed,
  type BackgroundTask
} from '../utils/backgroundTasks';
import { useTaskStore } from '../stores/taskStore';
import { useLanguageStore } from '../stores/languageStore';

/**
 * 后台任务。
 *
 * 浮在右下角而不是挤进某个标题栏：它只在**真有任务**的时候才存在，
 * 而任务是从各处发起的（导入向导、导出对话框），不属于任何一个标签页。
 */
export function TaskCenter() {
  const t = useLanguageStore((state) => state.t);
  const tasks = useTaskStore((state) => state.tasks);
  const open = useTaskStore((state) => state.open);
  const setOpen = useTaskStore((state) => state.setOpen);
  const clearFinished = useTaskStore((state) => state.clearFinished);

  const active = activeTaskCount(tasks);
  // 有任务在跑时每秒重算一次，好让用时走起来；都结束了就停下
  const [, setTick] = useState(0);
  useEffect(() => {
    if (active === 0) {
      return;
    }
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (tasks.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
      {open && (
        <div className="pointer-events-auto flex max-h-[60vh] w-[420px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel border border-line bg-surface-raised shadow-xl">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <span className="text-xs font-medium text-fg">{t('task.center')}</span>
            <button
              type="button"
              onClick={clearFinished}
              className="ml-auto rounded-control px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-hover"
            >
              {t('task.clearFinished')}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="pointer-events-auto flex items-center gap-2 rounded-panel border border-line bg-surface-raised px-3 py-2 text-xs text-fg shadow-lg hover:bg-surface-hover"
      >
        {active > 0 ? (
          <Loader2 size={14} className="animate-spin text-accent" />
        ) : (
          <CheckCircle2 size={14} className="text-fg-muted" />
        )}
        <span>{active > 0 ? t('task.running', { count: active }) : t('task.center')}</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
    </div>
  );
}

function TaskRow({ task }: { task: BackgroundTask }) {
  const t = useLanguageStore((state) => state.t);
  const setPaused = useTaskStore((state) => state.setPaused);
  const cancel = useTaskStore((state) => state.cancel);
  const retry = useTaskStore((state) => state.retry);
  const dismiss = useTaskStore((state) => state.dismiss);
  const [showLog, setShowLog] = useState(false);

  const display = describeTask(task);

  return (
    <div className="border-b border-line px-3 py-2 last:border-0">
      <div className="flex items-start gap-2">
        <StatusIcon tone={display.tone} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-fg">{task.title}</p>
          <p className="text-xs text-fg-muted">
            {t(display.labelKey)}
            {' · '}
            {formatTaskElapsed(display.elapsedMs)}
            {task.detail && ` · ${task.detail}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {display.canPause && (
            <IconButton label={t('import.pause')} onClick={() => void setPaused(task.id, true)}>
              <Pause size={13} />
            </IconButton>
          )}
          {display.canResume && (
            <IconButton label={t('import.resume')} onClick={() => void setPaused(task.id, false)}>
              <Play size={13} />
            </IconButton>
          )}
          {display.canCancel && (
            <IconButton label={t('common.cancel')} onClick={() => void cancel(task.id)} danger>
              <X size={13} />
            </IconButton>
          )}
          {display.canDismiss && (
            <IconButton
              label={display.canRetry ? t('task.retry') : t('task.retryBlocked')}
              onClick={() => retry(task.id)}
              disabled={!display.canRetry}
            >
              <RotateCcw size={13} />
            </IconButton>
          )}
          {display.canDismiss && (
            <IconButton label={t('task.dismiss')} onClick={() => dismiss(task.id)}>
              <X size={13} />
            </IconButton>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => setShowLog(!showLog)}
        className="mt-1 flex items-center gap-1 text-xs text-fg-subtle hover:text-fg-muted"
      >
        {showLog ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {t('task.log')} ({task.log.length})
      </button>

      {showLog && (
        <div className="mt-1 max-h-40 overflow-auto rounded-control bg-surface-sunken px-2 py-1">
          {task.logTruncated && (
            <p className="text-xs text-fg-subtle">{t('task.logTruncated')}</p>
          )}
          {task.log.map((line, index) => (
            <p
              key={`${line.at}-${index}`}
              className={clsx(
                'break-words font-mono text-xs',
                line.level === 'error'
                  ? 'text-danger'
                  : line.level === 'warn'
                    ? 'text-warning'
                    : 'text-fg-muted'
              )}
            >
              {line.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusIcon({ tone }: { tone: ReturnType<typeof describeTask>['tone'] }) {
  if (tone === 'running') {
    return <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-accent" />;
  }
  if (tone === 'success') {
    return <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />;
  }
  return (
    <AlertTriangle
      size={14}
      className={clsx('mt-0.5 shrink-0', tone === 'danger' ? 'text-danger' : 'text-warning')}
    />
  );
}

function IconButton({
  label,
  onClick,
  children,
  danger,
  disabled
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'rounded-control p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        danger ? 'text-danger hover:bg-danger-soft' : 'text-fg-muted hover:bg-surface-hover'
      )}
    >
      {children}
    </button>
  );
}
