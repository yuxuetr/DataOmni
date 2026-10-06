import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import CodeMirror from '@uiw/react-codemirror';
import { EditorState } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { javascript } from '@codemirror/legacy-modes/mode/javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import type { EditorView } from '@codemirror/view';
import { Loader2, Play } from 'lucide-react';
import type { ConnectionProfile } from '../contracts/connection';
import { selectActiveSqlDocument, useQueryStore } from '../stores/queryStore';
import { useLanguageStore } from '../stores/languageStore';
import { useThemeStore } from '../stores/themeStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useAppStore } from '../stores/appStore';
import { useHistoryStore } from '../stores/historyStore';
import { DestructiveStatementPrompt } from './DestructiveStatementPrompt';
import { appEditorTheme } from '../utils/editorTheme';
import { runShortcutKeymap, type RunShortcutHandlers } from '../utils/runShortcutKeymap';
import { editorPhrases } from '../utils/editorPhrases';
import { describeError } from '../utils/describeError';
import { SHORTCUTS, formatShortcut } from '../utils/shortcuts';
import { requiresConfirmation, type StatementRisk } from '../utils/statementRisk';

/** 与后端 `CommandPlan` / `CommandReply` 一致 */
interface CommandPlan {
  name: string;
  risk: StatementRisk;
}
interface CommandReply {
  text: string;
  more: boolean;
}

type ConsoleRun =
  | { id: number; database: string; command: string; state: 'running' }
  | { id: number; database: string; command: string; state: 'done'; reply: CommandReply; elapsedMs: number }
  | { id: number; database: string; command: string; state: 'failed'; error: string };

/** 一段回答最多画这么多字符：`serverStatus` 这类几十 KB 没事，整页 16 MB 的 `find` 会卡住 WebView */
const MAX_RENDERED_CHARS = 200_000;
/** 留着的回答条数：再往前的已经滚出视线，留着只是多画 */
const MAX_RUNS = 20;

/**
 * MongoDB 的命令台标签：写一条 `db.runCommand({...})` 的命令文档、选库、跑、看回答。
 *
 * 写法与集合页的筛选框相同（mongosh 字面量）。有选区跑选区，没有就跑整个编辑器——一次一条，
 * 因为 mongosh 字面量里分不出「两条命令」的边界。会写的按「设置 → 危险语句确认」先问，
 * 等级由后端按命令名定（`services/mongo_command.rs`）
 */
export function MongoConsole({ connection }: { connection: ConnectionProfile }) {
  const t = useLanguageStore((state) => state.t);
  const { sqlInput } = useQueryStore(selectActiveSqlDocument);
  const connectionString = useQueryStore((state) => state.connectionString);
  const queryTimeoutMs = useQueryStore((state) => state.queryTimeoutMs);
  const setSqlInput = useQueryStore((state) => state.setSqlInput);
  const confirmationPolicy = useSettingsStore((state) => state.confirmationPolicy);
  const markSchemaChanged = useAppStore((state) => state.markSchemaChanged);
  const objects = useAppStore((state) => state.databaseMetadata[connection.id]?.objects);
  const resolvedTheme = useThemeStore((state) => state.resolved);
  const editorViewRef = useRef<EditorView | null>(null);
  const nextRunId = useRef(0);
  const outputRef = useRef<HTMLDivElement>(null);
  // 新的一条追加在最后；上一条回复很长时它在视口外面，按了执行像是没反应
  const scrollToRun = useRef<number | null>(null);
  const [database, setDatabase] = useState(connection.database || 'admin');
  const [runs, setRuns] = useState<ConsoleRun[]>([]);
  const [pending, setPending] = useState<{ command: string; plan: CommandPlan; database: string } | null>(null);
  const running = runs.some((run) => run.state === 'running');

  // 对象树里有集合的库，加上连接上填的和 admin（管理命令多半要在 admin 上跑）
  const databases = useMemo(() => {
    const names = new Set<string>(['admin', connection.database || 'admin', database]);
    for (const object of objects ?? []) {
      if (object.schema) names.add(object.schema);
    }
    return [...names].sort();
  }, [objects, connection.database, database]);

  const shortcuts = useRef<RunShortcutHandlers>({ runCurrent: () => {}, runAll: () => {} });
  const extensions = useMemo(
    () => [runShortcutKeymap(shortcuts), StreamLanguage.define(javascript), EditorState.phrases.of(editorPhrases(t)), appEditorTheme],
    [t]
  );

  const update = (id: number, next: ConsoleRun) =>
    setRuns((previous) => previous.map((run) => (run.id === id ? next : run)));
  const append = (run: ConsoleRun) => {
    scrollToRun.current = run.id;
    setRuns((previous) => [...previous, run].slice(-MAX_RUNS));
  };

  useEffect(() => {
    const section = outputRef.current?.querySelector<HTMLElement>(`[data-run-id="${scrollToRun.current}"]`);
    if (!section) return;
    scrollToRun.current = null;
    // 滚到这一条的开头而不是底部：回复长的时候先看到的该是命令和它的第一行。
    // 不用 scrollIntoView：它会连外层能滚的祖先一起滚
    outputRef.current?.scrollTo({ top: section.offsetTop });
  }, [runs]);

  const execute = async (command: string, plan: CommandPlan, target: string) => {
    if (!connectionString) return;
    const id = nextRunId.current;
    nextRunId.current += 1;
    append({ id, database: target, command, state: 'running' });
    const started = Date.now();
    const remember = (status: 'succeeded' | 'failed' | 'timed-out', errorMessage?: string) =>
      useHistoryStore.getState().recordConsole({
        id: crypto.randomUUID(),
        language: 'mongodb',
        profileId: connection.id,
        connectionName: connection.name,
        database: target,
        text: command,
        startedAt: started,
        durationMs: Date.now() - started,
        status,
        rowsAffected: null,
        errorMessage
      });
    try {
      const reply = await invoke<CommandReply>('mongodb_run_command', {
        connectionString,
        database: target,
        command,
        timeoutMs: queryTimeoutMs
      });
      update(id, { id, database: target, command, state: 'done', reply, elapsedMs: Date.now() - started });
      remember('succeeded');
      // 建了、删了集合或索引，对象树可能多了或少了：让它重新拉一遍
      if (plan.risk !== 'read') markSchemaChanged();
    } catch (caught) {
      const error = describeError(caught);
      update(id, { id, database: target, command, state: 'failed', error });
      remember(String(caught).startsWith('DATAOMNI_MONGO_TIMEOUT') ? 'timed-out' : 'failed', error);
    }
  };

  const run = async (command: string) => {
    if (running || command.trim() === '' || !connectionString) return;
    let plan: CommandPlan;
    try {
      plan = await invoke<CommandPlan>('mongodb_plan_command', { command });
    } catch (caught) {
      // 没发出去：写法错了、被拒了。不进历史
      const id = nextRunId.current;
      nextRunId.current += 1;
      append({ id, database, command, state: 'failed', error: describeError(caught) });
      return;
    }
    if (requiresConfirmation(plan.risk, connection.environment, confirmationPolicy)) {
      setPending({ command, plan, database });
      return;
    }
    void execute(command, plan, database);
  };

  const runAll = () => void run(sqlInput);
  const runCurrent = () => {
    const view = editorViewRef.current;
    const selection = view?.state.selection.main;
    void run(view && selection && !selection.empty ? view.state.sliceDoc(selection.from, selection.to) : sqlInput);
  };
  shortcuts.current = { runCurrent, runAll };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{connection.name}</p>
          <p className="truncate text-xs text-fg-muted">{t('mongo.console.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-fg-muted">
            <span>{t('mongo.console.database')}</span>
            <select
              value={database}
              onChange={(event) => setDatabase(event.target.value)}
              className="rounded-control border border-line-strong bg-surface px-2 py-1.5 font-mono text-sm"
            >
              {databases.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <button
            type="button"
            onClick={runCurrent}
            disabled={running || sqlInput.trim() === ''}
            title={formatShortcut(SHORTCUTS.runCurrent)}
            className="flex items-center gap-1 rounded-control bg-accent px-3 py-1.5 text-sm text-accent-fg hover:opacity-90 disabled:opacity-50"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            <span>{t('mongo.console.run')}</span>
          </button>
        </div>
      </div>

      <div className="shrink-0 px-3 pb-2 pt-3">
        <div className="overflow-hidden rounded-control border border-line-strong">
          <CodeMirror
            value={sqlInput}
            onChange={(value) => setSqlInput(value)}
            onCreateEditor={(view) => {
              editorViewRef.current = view;
            }}
            theme={resolvedTheme === 'dark' ? oneDark : undefined}
            extensions={extensions}
            placeholder={t('mongo.console.placeholder')}
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              dropCursor: false,
              allowMultipleSelections: false,
              indentOnInput: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: false,
              highlightSelectionMatches: true,
              searchKeymap: true
            }}
            className="text-sm"
            height="200px"
          />
        </div>
      </div>

      <div ref={outputRef} className="relative min-h-0 flex-1 overflow-y-auto border-t border-line bg-surface-sunken px-4 py-3">
        {runs.length === 0 && <p className="text-sm text-fg-muted">{t('mongo.console.intro')}</p>}
        {runs.map((run) => (
          <div key={run.id} data-run-id={run.id} className="mb-4">
            <p className="flex items-center gap-2 font-mono text-xs text-fg-muted">
              <span className="truncate">{`${run.database}> ${run.command.replace(/\s+/g, ' ').trim()}`}</span>
              {run.state === 'running' && <Loader2 size={12} className="shrink-0 animate-spin" />}
              {run.state === 'done' && <span className="shrink-0">{`${run.elapsedMs} ms`}</span>}
            </p>
            {run.state === 'failed' && (
              <pre className="mt-1 select-text whitespace-pre-wrap break-words font-mono text-[13px] text-danger">{run.error}</pre>
            )}
            {run.state === 'done' && (
              <>
                <pre className="mt-1 select-text whitespace-pre-wrap break-all font-mono text-[13px] text-fg">
                  {run.reply.text.length > MAX_RENDERED_CHARS ? run.reply.text.slice(0, MAX_RENDERED_CHARS) : run.reply.text}
                </pre>
                {run.reply.text.length > MAX_RENDERED_CHARS && (
                  <p className="mt-1 text-xs text-warning">{t('mongo.console.truncated', { limit: MAX_RENDERED_CHARS.toLocaleString() })}</p>
                )}
                {run.reply.more && <p className="mt-1 text-xs text-fg-muted">{t('mongo.console.more')}</p>}
              </>
            )}
          </div>
        ))}
      </div>

      {pending && (
        <DestructiveStatementPrompt
          language="javascript"
          sql={pending.command}
          risk={pending.plan.risk}
          statementCount={1}
          connectionName={connection.name}
          environment={connection.environment}
          databaseLabel="MongoDB"
          reversibility={{ kind: 'no-transaction' }}
          riskDescription={pending.plan.risk === 'bulk-write' ? t('mongo.console.risk.bulkWrite') : undefined}
          onConfirm={() => {
            const { command, plan, database: target } = pending;
            setPending(null);
            void execute(command, plan, target);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
