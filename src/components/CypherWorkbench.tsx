import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import CodeMirror from '@uiw/react-codemirror';
import { EditorState } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { cypher } from '@codemirror/legacy-modes/mode/cypher';
import { oneDark } from '@codemirror/theme-one-dark';
import type { EditorView } from '@codemirror/view';
import { clsx } from 'clsx';
import { AlertCircle, Loader2, Play, X } from 'lucide-react';
import type { ConnectionProfile } from '../contracts/connection';
import { selectActiveSqlDocument, useQueryStore } from '../stores/queryStore';
import { useLanguageStore } from '../stores/languageStore';
import { useThemeStore } from '../stores/themeStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useAppStore } from '../stores/appStore';
import { takeCypherAutorun } from '../stores/cypherAutorun';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { PanelResizeHandle } from './PanelResizeHandle';
import { DestructiveStatementPrompt } from './DestructiveStatementPrompt';
import { appEditorTheme } from '../utils/editorTheme';
import { runShortcutKeymap, type RunShortcutHandlers } from '../utils/runShortcutKeymap';
import { editorPhrases } from '../utils/editorPhrases';
import { describeError } from '../utils/describeError';
import { SHORTCUTS, formatShortcut } from '../utils/shortcuts';
import { cypherStatementAt, splitCypherStatements } from '../utils/cypherStatements';
import {
  CYPHER_RISK_DESCRIPTION_KEYS,
  cypherMayWrite,
  riskiestCypherStatement,
  type CypherQueryType
} from '../utils/cypherRisk';
import { formatCypherValue, type CypherValue } from '../utils/cypherValue';
import { hasGraphValues } from '../utils/cypherGraph';
import { CypherGraphView } from './CypherGraphView';
import type { StatementRisk } from '../utils/statementRisk';
import type { TranslationKey } from '../i18n/translate';

/** 与后端 `CypherResult` 一致 */
interface CypherResult {
  columns: string[];
  rows: CypherValue[][];
  truncated: boolean;
  summary: {
    queryType: CypherQueryType;
    database: string | null;
    counters: Array<[string, number]>;
    notifications: Array<{ code: string; title: string; description: string; severity: string }>;
  };
}

type CypherRun =
  | { id: number; statement: string; state: 'running' | 'skipped' }
  | { id: number; statement: string; state: 'done'; result: CypherResult; elapsedMs: number }
  | { id: number; statement: string; state: 'failed'; error: string };

const COUNTER_KEYS: Record<string, TranslationKey> = {
  nodesCreated: 'cypher.counter.nodesCreated',
  nodesDeleted: 'cypher.counter.nodesDeleted',
  relationshipsCreated: 'cypher.counter.relationshipsCreated',
  relationshipsDeleted: 'cypher.counter.relationshipsDeleted',
  propertiesSet: 'cypher.counter.propertiesSet',
  labelsAdded: 'cypher.counter.labelsAdded',
  labelsRemoved: 'cypher.counter.labelsRemoved',
  indexesAdded: 'cypher.counter.indexesAdded',
  indexesRemoved: 'cypher.counter.indexesRemoved',
  constraintsAdded: 'cypher.counter.constraintsAdded',
  constraintsRemoved: 'cypher.counter.constraintsRemoved',
  systemUpdates: 'cypher.counter.systemUpdates'
};

interface CypherWorkbenchProps {
  connection: ConnectionProfile;
}

/**
 * Neo4j 的查询标签：写 Cypher、跑、看结果。
 *
 * 草稿存在查询标签的文档里（与 SQL 标签同一份），所以去重、持久化、恢复都是现成的。
 * 多条用分号隔开，依次跑，一条失败就停——后面的多半依赖它。会写的先问服务端
 * （`EXPLAIN`），按「设置 → 危险语句确认」的门槛决定要不要先确认。
 */
export function CypherWorkbench({ connection }: CypherWorkbenchProps) {
  const t = useLanguageStore((state) => state.t);
  const { sqlInput } = useQueryStore(selectActiveSqlDocument);
  const documentId = useQueryStore((state) => state.activeDocumentId);
  const connectionString = useQueryStore((state) => state.connectionString);
  const queryTimeoutMs = useQueryStore((state) => state.queryTimeoutMs);
  const rowLimit = useQueryStore((state) => state.queryResultRowLimit);
  const setSqlInput = useQueryStore((state) => state.setSqlInput);
  const setQueryTimeoutMs = useQueryStore((state) => state.setQueryTimeoutMs);
  const setRowLimit = useQueryStore((state) => state.setQueryResultRowLimit);
  const confirmationPolicy = useSettingsStore((state) => state.confirmationPolicy);
  const markSchemaChanged = useAppStore((state) => state.markSchemaChanged);
  const resolvedTheme = useThemeStore((state) => state.resolved);
  const editorViewRef = useRef<EditorView | null>(null);
  const nextRunId = useRef(0);
  const [runs, setRuns] = useState<CypherRun[]>([]);
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<{ statements: string[]; text: string; risk: StatementRisk } | null>(null);
  const [inspecting, setInspecting] = useState<CypherValue | null>(null);
  const editorPanel = useResizablePanel({
    storageKey: 'cypher-editor-height',
    defaultSize: 200,
    minSize: 96,
    maxSize: 640,
    axis: 'y'
  });

  const shortcuts = useRef<RunShortcutHandlers>({ runCurrent: () => {}, runAll: () => {} });
  const extensions = useMemo(
    () => [
      runShortcutKeymap(shortcuts),
      StreamLanguage.define(cypher),
      EditorState.phrases.of(editorPhrases(t)),
      appEditorTheme
    ],
    [t]
  );

  /** 真的跑：依次一条，失败就停，后面的标成没跑 */
  const execute = async (statements: string[]) => {
    if (!connectionString) return;
    const first = nextRunId.current;
    nextRunId.current += statements.length;
    setRuns(statements.map((statement, index) => ({ id: first + index, statement, state: 'running' })));
    setInspecting(null);
    setRunning(true);
    let wrote = false;
    for (const [index, statement] of statements.entries()) {
      const id = first + index;
      const started = performance.now();
      try {
        const result = await invoke<CypherResult>('neo4j_run', {
          connectionString,
          database: null,
          query: statement,
          limit: rowLimit,
          timeoutMs: queryTimeoutMs
        });
        wrote ||= result.summary.counters.length > 0;
        const elapsedMs = Math.round(performance.now() - started);
        setRuns((previous) => previous.map((run) => (run.id === id ? { id, statement, state: 'done', result, elapsedMs } : run)));
      } catch (caught) {
        const error = describeError(caught);
        setRuns((previous) => previous.map((run) => {
          if (run.id === id) return { id, statement, state: 'failed', error };
          return run.id > id ? { id: run.id, statement: run.statement, state: 'skipped' } : run;
        }));
        break;
      }
    }
    setRunning(false);
    // 建了、删了东西，标签与关系类型可能多了或少了：让对象树重新拉一遍
    if (wrote) markSchemaChanged();
  };

  /** 先按门槛看要不要确认；会写的才问服务端是读是写 */
  const run = async (statements: string[]) => {
    if (running || statements.length === 0 || !connectionString) return;
    setRunning(true);
    const typed = await Promise.all(statements.map(async (text) => {
      if (!cypherMayWrite(text)) return { text, queryType: 'r' as const };
      try {
        const queryType = await invoke<CypherQueryType>('neo4j_query_type', {
          connectionString,
          database: null,
          query: text,
          timeoutMs: queryTimeoutMs
        });
        return { text, queryType };
      } catch {
        // 问不到（管理命令不支持 EXPLAIN，或者写错了）：按字面从严，写错的跑的时候自会报出来
        return { text, queryType: null };
      }
    }));
    setRunning(false);
    const riskiest = riskiestCypherStatement(typed, connection.environment, confirmationPolicy);
    if (riskiest) {
      setPending({ statements, ...riskiest });
      return;
    }
    await execute(statements);
  };

  const runAll = () => void run(splitCypherStatements(sqlInput).map((statement) => statement.text));

  /** 有选区跑选区（里面可以有多条），没有就跑光标所在的那条 */
  const runCurrent = () => {
    const view = editorViewRef.current;
    const selection = view?.state.selection.main;
    if (view && selection && !selection.empty) {
      void run(splitCypherStatements(view.state.sliceDoc(selection.from, selection.to)).map((statement) => statement.text));
      return;
    }
    const current = cypherStatementAt(sqlInput, selection?.head ?? 0);
    if (current) void run([current.text]);
  };

  // 从对象树点标签开出来的标签：进来就跑一次
  useEffect(() => {
    if (documentId && sqlInput.trim() && takeCypherAutorun(documentId)) {
      void run(splitCypherStatements(sqlInput).map((statement) => statement.text));
    }
    // 只在换了标签、内容到位时看一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, sqlInput === '']);

  shortcuts.current = { runCurrent, runAll };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{connection.name}</p>
          <p className="truncate text-xs text-fg-muted">
            {`Neo4j · ${connection.host}:${connection.port}`}
            {connection.database?.trim() ? ` / ${connection.database.trim()}` : ` · ${t('cypher.homeDatabase')}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-fg-muted">
            <span>{t('editor.rowLimit')}</span>
            <select
              value={rowLimit}
              onChange={(event) => setRowLimit(Number(event.target.value))}
              className="rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm"
              aria-label={t('editor.rowLimitLabel')}
            >
              <option value={100}>{t('editor.rowsOption', { count: 100 })}</option>
              <option value={500}>{t('editor.rowsOption', { count: 500 })}</option>
              <option value={1000}>{t('editor.rowsOption', { count: '1,000' })}</option>
              <option value={5000}>{t('editor.rowsOption', { count: '5,000' })}</option>
              <option value={10000}>{t('editor.rowsOption', { count: '10,000' })}</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-fg-muted">
            <span>{t('editor.timeout')}</span>
            <select
              value={queryTimeoutMs}
              onChange={(event) => setQueryTimeoutMs(Number(event.target.value))}
              className="rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm"
              aria-label={t('editor.timeoutLabel')}
            >
              <option value={5000}>{t('editor.seconds', { count: 5 })}</option>
              <option value={15000}>{t('editor.seconds', { count: 15 })}</option>
              <option value={30000}>{t('editor.seconds', { count: 30 })}</option>
              <option value={60000}>{t('editor.minutes', { count: 1 })}</option>
              <option value={120000}>{t('editor.minutes', { count: 2 })}</option>
              <option value={300000}>{t('editor.minutes', { count: 5 })}</option>
            </select>
          </label>
          <button
            type="button"
            onClick={runCurrent}
            disabled={running || sqlInput.trim() === ''}
            title={formatShortcut(SHORTCUTS.runCurrent)}
            className="flex items-center gap-1 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover disabled:opacity-50"
          >
            <Play size={14} />
            <span>{t('cypher.runCurrent')}</span>
          </button>
          <button
            type="button"
            onClick={runAll}
            disabled={running || sqlInput.trim() === ''}
            title={formatShortcut(SHORTCUTS.runAll)}
            className="flex items-center gap-1 rounded-control bg-accent px-3 py-1.5 text-sm text-accent-fg hover:opacity-90 disabled:opacity-50"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            <span>{t('cypher.runAll')}</span>
          </button>
        </div>
      </div>

      <div className={clsx('shrink-0 px-3 pb-2 pt-3', editorPanel.collapsed && 'hidden')}>
        <div className="overflow-hidden rounded-control border border-line-strong">
          <CodeMirror
            value={sqlInput}
            onChange={(value) => setSqlInput(value)}
            onCreateEditor={(view) => {
              editorViewRef.current = view;
            }}
            theme={resolvedTheme === 'dark' ? oneDark : undefined}
            extensions={extensions}
            placeholder={t('cypher.placeholder')}
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
            style={{ fontSize: '14px' }}
            height={`${editorPanel.size}px`}
          />
        </div>
      </div>
      {!editorPanel.collapsed && (
        <PanelResizeHandle
          axis="y"
          active={editorPanel.isResizing}
          onPointerDown={editorPanel.startResize}
          onDoubleClick={editorPanel.resetSize}
          label={t('editor.resizeHeight')}
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {runs.length === 0 && (
          <p className="text-sm text-fg-muted">
            {t('cypher.empty', { current: formatShortcut(SHORTCUTS.runCurrent), all: formatShortcut(SHORTCUTS.runAll) })}
          </p>
        )}
        {runs.map((run) => (
          <RunSection
            key={run.id}
            run={run}
            showStatement={runs.length > 1}
            selectedId={inspecting?.kind === 'node' || inspecting?.kind === 'relationship' ? inspecting.elementId : null}
            onInspect={setInspecting}
          />
        ))}
      </div>

      {inspecting && (
        <div className="max-h-[40%] shrink-0 overflow-y-auto border-t border-line bg-surface-sunken px-3 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-fg-muted">{t('cypher.value')}</span>
            <button type="button" onClick={() => setInspecting(null)} aria-label={t('common.close')} className="text-fg-muted hover:text-fg">
              <X size={14} />
            </button>
          </div>
          {(inspecting.kind === 'node' || inspecting.kind === 'relationship') && (
            <p className="mb-1 select-text font-mono text-xs text-fg-muted">{`elementId: ${inspecting.elementId}`}</p>
          )}
          <pre className="select-text whitespace-pre-wrap break-all font-mono text-[13px] text-fg">
            {formatCypherValue(inspecting)}
          </pre>
        </div>
      )}

      {pending && (
        <DestructiveStatementPrompt
          sql={pending.text}
          risk={pending.risk}
          statementCount={pending.statements.length}
          connectionName={connection.name}
          environment={connection.environment}
          databaseLabel="Neo4j"
          reversibility={{ kind: 'autocommit' }}
          riskDescription={CYPHER_RISK_DESCRIPTION_KEYS[pending.risk] && t(CYPHER_RISK_DESCRIPTION_KEYS[pending.risk]!)}
          onConfirm={() => {
            const statements = pending.statements;
            setPending(null);
            void execute(statements);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

function RunSection({
  run,
  showStatement,
  selectedId,
  onInspect
}: {
  run: CypherRun;
  showStatement: boolean;
  selectedId: string | null;
  onInspect: (value: CypherValue) => void;
}) {
  const t = useLanguageStore((state) => state.t);
  return (
    <section className="mb-4">
      {showStatement && (
        <p className="mb-1 truncate font-mono text-xs text-fg-muted" title={run.statement}>{run.statement}</p>
      )}
      {run.state === 'running' && (
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 size={14} className="animate-spin" />
          {t('cypher.running')}
        </p>
      )}
      {run.state === 'skipped' && <p className="text-sm text-fg-muted">{t('cypher.skipped')}</p>}
      {run.state === 'failed' && (
        <div className="flex items-start gap-2 rounded-control border border-danger-line bg-danger-soft p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-danger" />
          <pre className="min-w-0 select-text whitespace-pre-wrap break-words font-mono text-xs text-danger">{run.error}</pre>
        </div>
      )}
      {run.state === 'done' && (
        <ResultView result={run.result} elapsedMs={run.elapsedMs} selectedId={selectedId} onInspect={onInspect} />
      )}
    </section>
  );
}

function ResultView({
  result,
  elapsedMs,
  selectedId,
  onInspect
}: {
  result: CypherResult;
  elapsedMs: number;
  selectedId: string | null;
  onInspect: (value: CypherValue) => void;
}) {
  const t = useLanguageStore((state) => state.t);
  const graphable = useMemo(() => hasGraphValues(result.rows), [result.rows]);
  // 有节点、关系的结果先看图
  const [view, setView] = useState<'graph' | 'table'>('graph');
  const showGraph = graphable && view === 'graph';
  const { summary } = result;
  const facts = [
    result.columns.length > 0 ? t('cypher.rows', { count: result.rows.length }) : null,
    result.truncated ? t('cypher.truncated') : null,
    ...summary.counters.map(([key, count]) => (COUNTER_KEYS[key] ? t(COUNTER_KEYS[key], { count }) : `${key}: ${count}`)),
    summary.database ? t('cypher.ranOn', { database: summary.database }) : null,
    t('cypher.elapsed', { ms: elapsedMs })
  ].filter((fact): fact is string => fact !== null);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className={clsx('text-xs', result.truncated ? 'text-warning' : 'text-fg-muted')}>{facts.join(' · ')}</p>
        {graphable && (
          <div className="flex shrink-0 overflow-hidden rounded-control border border-line text-xs" role="group">
            {(['graph', 'table'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setView(option)}
                aria-pressed={view === option}
                className={clsx(
                  'px-2 py-0.5',
                  view === option ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-hover'
                )}
              >
                {t(option === 'graph' ? 'cypher.view.graph' : 'cypher.view.table')}
              </button>
            ))}
          </div>
        )}
      </div>
      {summary.notifications.map((notification) => (
        <p key={`${notification.code}:${notification.description}`} className="mb-1 text-xs text-warning">
          {`${notification.title}：${notification.description}`}
        </p>
      ))}
      {showGraph && <CypherGraphView rows={result.rows} selectedId={selectedId} onInspect={onInspect} />}
      {!showGraph && result.columns.length > 0 && (
        <div className="overflow-x-auto rounded-control border border-line">
          <table className="min-w-full border-collapse font-mono text-[13px]">
            <thead className="bg-surface-sunken">
              <tr>
                {result.columns.map((column) => (
                  <th key={column} className="whitespace-nowrap border-b border-line px-2 py-1 text-left font-medium text-fg">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="hover:bg-surface-hover">
                  {row.map((value, columnIndex) => (
                    <td
                      key={columnIndex}
                      onClick={() => onInspect(value)}
                      className={clsx(
                        'max-w-[32rem] cursor-pointer truncate border-b border-line px-2 py-1',
                        value.kind === 'null' ? 'italic text-fg-subtle' : 'text-fg'
                      )}
                      title={formatCypherValue(value)}
                    >
                      {formatCypherValue(value)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
