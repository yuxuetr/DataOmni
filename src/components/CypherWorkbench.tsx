import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import CodeMirror from '@uiw/react-codemirror';
import { EditorState } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { cypher } from '@codemirror/legacy-modes/mode/cypher';
import { oneDark } from '@codemirror/theme-one-dark';
import type { EditorView } from '@codemirror/view';
import { clsx } from 'clsx';
import { AlertCircle, Loader2, Play, Plus, X } from 'lucide-react';
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
import { cypherPreamble, cypherStatementAt, splitCypherStatements } from '../utils/cypherStatements';
import {
  CYPHER_RISK_DESCRIPTION_KEYS,
  cypherMayWrite,
  riskiestCypherStatement,
  type CypherQueryType
} from '../utils/cypherRisk';
import { formatCypherValue, type CypherValue } from '../utils/cypherValue';
import { hasGraphValues } from '../utils/cypherGraph';
import { CypherGraphView } from './CypherGraphView';
import { CypherEntityEditor } from './CypherEntityEditor';
import { PlanTree } from './PlanTree';
import { formatPlanRows, worstEstimate, type QueryPlan } from '../utils/planInsights';
import {
  degreeStatement,
  deleteStatement,
  removeEntity,
  replaceEntity,
  type EditableEntity
} from '../utils/cypherEdit';
import { requiresConfirmation, type StatementRisk } from '../utils/statementRisk';
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
    /** 以 `EXPLAIN` / `PROFILE` 开头的才有 */
    plan: QueryPlan | null;
  };
}

type CypherRun =
  | { id: number; statement: string; state: 'running' | 'skipped' }
  | { id: number; statement: string; state: 'done'; result: CypherResult; elapsedMs: number }
  | { id: number; statement: string; state: 'failed'; error: string };

/** 看着的值，连同它是从哪个库查出来的：改它、删它要回到那个库上去 */
interface Inspected {
  value: CypherValue;
  database: string | null;
}

/** 要写的一条：改的是哪个实体（`null` 是建节点）、在哪个库上 */
interface EntityEdit {
  statement: string;
  labelsChanged: boolean;
  target: EditableEntity | null;
  database: string | null;
}

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
  const resultsRef = useRef<HTMLDivElement | null>(null);
  // 建出来的那一段接在最后，多半在看不到的地方：渲染出来之后滚到它
  const scrollToRun = useRef<number | null>(null);
  const nextRunId = useRef(0);
  const [runs, setRuns] = useState<CypherRun[]>([]);
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<{ statements: string[]; text: string; risk: StatementRisk } | null>(null);
  const [inspecting, setInspecting] = useState<Inspected | null>(null);
  const [creating, setCreating] = useState(false);
  // 每写成一次加一：编辑框换 `key`，草稿按改完的样子从头来
  const [editRevision, setEditRevision] = useState(0);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = useState<{ edit: EntityEdit; risk: StatementRisk } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ entity: EditableEntity; database: string | null; relationships: number } | null>(null);
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
    closeInspector();
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
          timeoutMs: queryTimeoutMs,
          // 没读完的结果服务端不给 PROFILE 的统计：读完，多出来的在后端丢掉
          readAll: cypherPreamble(statement).mode === 'profile'
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
          // 问法是在前面加 `EXPLAIN`，服务端不接受 `EXPLAIN PROFILE`：`PROFILE` 摘掉再问
          query: cypherPreamble(text).body,
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

  const inspect = (value: CypherValue, database: string | null) => {
    setInspecting({ value, database });
    setCreating(false);
    setEditError(null);
  };

  const closeInspector = () => {
    setInspecting(null);
    setCreating(false);
    setEditError(null);
  };

  const inspectedEntity = inspecting?.value.kind === 'node' || inspecting?.value.kind === 'relationship' ? inspecting.value : null;

  const patchRows = (patch: (rows: CypherValue[][]) => CypherValue[][]) => setRuns((previous) => previous.map((run) => (
    run.state === 'done' ? { ...run, result: { ...run.result, rows: patch(run.result.rows) } } : run
  )));

  /** 编辑框里点了保存：改的是一个实体，建的是一个节点，按这两个等级过「危险语句确认」 */
  const saveEntity = (statement: string, labelsChanged: boolean) => {
    const edit: EntityEdit = creating
      ? { statement, labelsChanged, target: null, database: null }
      : { statement, labelsChanged, target: inspectedEntity, database: inspecting?.database ?? null };
    if (!creating && !edit.target) return;
    const risk: StatementRisk = edit.target ? 'scoped-write' : 'append';
    if (requiresConfirmation(risk, connection.environment, confirmationPolicy)) {
      setPendingEdit({ edit, risk });
      return;
    }
    void writeEntity(edit);
  };

  /** 跑改或建的那一条，拿回来的样子换进结果里（建的另起一段） */
  const writeEntity = async ({ statement, labelsChanged, target, database }: EntityEdit) => {
    if (!connectionString) return;
    setEditBusy(true);
    setEditError(null);
    const started = performance.now();
    try {
      const result = await invoke<CypherResult>('neo4j_run', {
        connectionString,
        database,
        query: statement,
        limit: 1,
        timeoutMs: queryTimeoutMs
      });
      const written = result.rows[0]?.[0];
      if (written?.kind !== 'node' && written?.kind !== 'relationship') {
        setEditError(t('cypher.edit.gone'));
        return;
      }
      if (target) {
        patchRows((rows) => replaceEntity(rows, written));
      } else {
        const id = nextRunId.current++;
        const elapsedMs = Math.round(performance.now() - started);
        setRuns((previous) => [...previous, { id, statement, state: 'done', result, elapsedMs }]);
        setCreating(false);
        scrollToRun.current = id;
      }
      setInspecting({ value: written, database: result.summary.database ?? database });
      setEditRevision((revision) => revision + 1);
      if (labelsChanged) markSchemaChanged();
    } catch (caught) {
      setEditError(describeError(caught));
    } finally {
      setEditBusy(false);
    }
  };

  /** 删之前先数连着几条关系，确认框里说清楚要一起删掉多少 */
  const askDelete = async () => {
    const entity = inspectedEntity;
    const database = inspecting?.database ?? null;
    if (!entity || !connectionString) return;
    if (entity.kind === 'relationship') {
      setPendingDelete({ entity, database, relationships: 0 });
      return;
    }
    setEditBusy(true);
    setEditError(null);
    try {
      const result = await invoke<CypherResult>('neo4j_run', {
        connectionString,
        database,
        query: degreeStatement(entity),
        limit: 1,
        timeoutMs: queryTimeoutMs
      });
      const count = result.rows[0]?.[0];
      if (count?.kind !== 'integer') {
        setEditError(t('cypher.edit.gone'));
        return;
      }
      setPendingDelete({ entity, database, relationships: Number(count.value) });
    } catch (caught) {
      setEditError(describeError(caught));
    } finally {
      setEditBusy(false);
    }
  };

  const deleteEntity = async ({ entity, database, relationships }: { entity: EditableEntity; database: string | null; relationships: number }) => {
    if (!connectionString) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const result = await invoke<CypherResult>('neo4j_run', {
        connectionString,
        database,
        query: deleteStatement(entity, relationships > 0),
        limit: 1,
        timeoutMs: queryTimeoutMs
      });
      if (result.summary.counters.length === 0) {
        setEditError(t('cypher.edit.gone'));
        return;
      }
      patchRows((rows) => removeEntity(rows, entity));
      closeInspector();
      markSchemaChanged();
    } catch (caught) {
      setEditError(describeError(caught));
    } finally {
      setEditBusy(false);
    }
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

  useEffect(() => {
    const section = resultsRef.current?.querySelector<HTMLElement>(`[data-run-id="${scrollToRun.current}"]`);
    if (!section) return;
    scrollToRun.current = null;
    // 不用 scrollIntoView：它会连外层能滚的祖先一起滚
    resultsRef.current?.scrollTo({ top: section.offsetTop });
  }, [runs]);

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
            onClick={() => {
              setInspecting(null);
              setCreating(true);
              setEditError(null);
            }}
            disabled={!connectionString}
            className="flex items-center gap-1 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover disabled:opacity-50"
          >
            <Plus size={14} />
            <span>{t('cypher.newNode')}</span>
          </button>
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

      <div ref={resultsRef} className="relative min-h-0 flex-1 overflow-y-auto px-3 py-2">
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
            selectedId={inspectedEntity?.elementId ?? null}
            onInspect={inspect}
          />
        ))}
      </div>

      {(creating || inspectedEntity) && (
        // 高度固定：语句预览、提示随着输入出现消失时，输入框不在光标底下挪位置
        <div className="h-80 max-h-[50%] shrink-0 overflow-y-auto border-t border-line bg-surface-sunken px-3 py-2">
          <CypherEntityEditor
            key={creating ? `new:${editRevision}` : `${inspectedEntity?.elementId}:${editRevision}`}
            entity={creating ? null : inspectedEntity}
            busy={editBusy}
            error={editError}
            onSave={saveEntity}
            onDelete={() => void askDelete()}
            onClose={closeInspector}
          />
        </div>
      )}
      {!creating && inspecting && !inspectedEntity && (
        <div className="max-h-[40%] shrink-0 overflow-y-auto border-t border-line bg-surface-sunken px-3 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-fg-muted">{t('cypher.value')}</span>
            <button type="button" onClick={closeInspector} aria-label={t('common.close')} className="text-fg-muted hover:text-fg">
              <X size={14} />
            </button>
          </div>
          <pre className="select-text whitespace-pre-wrap break-all font-mono text-[13px] text-fg">
            {formatCypherValue(inspecting.value)}
          </pre>
        </div>
      )}

      {pendingEdit && (
        <DestructiveStatementPrompt
          sql={pendingEdit.edit.statement}
          risk={pendingEdit.risk}
          statementCount={1}
          connectionName={connection.name}
          environment={connection.environment}
          databaseLabel="Neo4j"
          reversibility={{ kind: 'autocommit' }}
          onConfirm={() => {
            const { edit } = pendingEdit;
            setPendingEdit(null);
            void writeEntity(edit);
          }}
          onCancel={() => setPendingEdit(null)}
        />
      )}

      {pendingDelete && (
        <DestructiveStatementPrompt
          sql={deleteStatement(pendingDelete.entity, pendingDelete.relationships > 0)}
          risk="scoped-write"
          statementCount={1}
          connectionName={connection.name}
          environment={connection.environment}
          databaseLabel="Neo4j"
          reversibility={{ kind: 'autocommit' }}
          alwaysAsks
          impacts={pendingDelete.entity.kind === 'node'
            ? [
              t('cypher.edit.impact.node', { node: formatCypherValue(pendingDelete.entity) }),
              ...(pendingDelete.relationships > 0 ? [t('cypher.edit.impact.relationships', { count: pendingDelete.relationships })] : [])
            ]
            : [t('cypher.edit.impact.relationship', { relationship: formatCypherValue(pendingDelete.entity) })]}
          onConfirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            void deleteEntity(target);
          }}
          onCancel={() => setPendingDelete(null)}
        />
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
  onInspect: (value: CypherValue, database: string | null) => void;
}) {
  const t = useLanguageStore((state) => state.t);
  return (
    <section className="mb-4" data-run-id={run.id}>
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

const VIEW_OPTIONS = ['plan', 'planText', 'graph', 'table'] as const;
type ResultViewOption = (typeof VIEW_OPTIONS)[number];
const VIEW_LABEL_KEYS: Record<ResultViewOption, TranslationKey> = {
  plan: 'cypher.view.plan',
  planText: 'cypher.view.planText',
  graph: 'cypher.view.graph',
  table: 'cypher.view.table'
};

function ResultView({
  result,
  elapsedMs,
  selectedId,
  onInspect
}: {
  result: CypherResult;
  elapsedMs: number;
  selectedId: string | null;
  onInspect: (value: CypherValue, database: string | null) => void;
}) {
  const t = useLanguageStore((state) => state.t);
  const inspect = (value: CypherValue) => onInspect(value, result.summary.database);
  const graphable = useMemo(() => hasGraphValues(result.rows), [result.rows]);
  const { summary } = result;
  const { plan } = summary;
  const explainedOnly = plan !== null && !plan.analyzed;
  // 有计划的先看计划，有节点、关系的先看图。`EXPLAIN` 没有行，不给一张空表
  const views = VIEW_OPTIONS.filter((option) => {
    switch (option) {
      case 'plan':
        return plan !== null;
      case 'planText':
        return plan !== null && plan.raw !== '';
      case 'graph':
        return graphable;
      case 'table':
        return result.columns.length > 0 && !explainedOnly;
    }
  });
  const [chosen, setView] = useState<ResultViewOption | null>(null);
  const view = chosen !== null && views.includes(chosen) ? chosen : views[0] ?? 'table';
  const worst = plan ? worstEstimate(plan) : null;
  const facts = [
    explainedOnly ? t('cypher.explainedOnly') : null,
    result.columns.length > 0 && !explainedOnly ? t('cypher.rows', { count: result.rows.length }) : null,
    // `PROFILE` 的多余行是读完才丢的（不读完服务端不给统计），不能说「没有读」
    result.truncated ? t(plan?.analyzed ? 'cypher.truncatedProfiled' : 'cypher.truncated') : null,
    ...summary.counters.map(([key, count]) => (COUNTER_KEYS[key] ? t(COUNTER_KEYS[key], { count }) : `${key}: ${count}`)),
    summary.database ? t('cypher.ranOn', { database: summary.database }) : null,
    t('cypher.elapsed', { ms: elapsedMs })
  ].filter((fact): fact is string => fact !== null);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className={clsx('text-xs', result.truncated ? 'text-warning' : 'text-fg-muted')}>{facts.join(' · ')}</p>
        {views.length > 1 && (
          <div className="flex shrink-0 overflow-hidden rounded-control border border-line text-xs" role="group">
            {views.map((option) => (
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
                {t(VIEW_LABEL_KEYS[option])}
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
      {view === 'plan' && plan && (
        <div className="rounded-control border border-line px-3 py-2">
          {worst && (
            <p className="mb-2 text-xs text-warning">
              {t('plan.worstHint', {
                operation: worst.target ? `${worst.operation} (${worst.target})` : worst.operation,
                estimated: formatPlanRows(worst.estimatedRows),
                actual: formatPlanRows(worst.actualRows)
              })}
            </p>
          )}
          <PlanTree roots={plan.roots} />
        </div>
      )}
      {view === 'planText' && plan && (
        <pre className="select-text overflow-x-auto rounded-control border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-fg">
          {plan.raw}
        </pre>
      )}
      {view === 'graph' && <CypherGraphView rows={result.rows} selectedId={selectedId} onInspect={inspect} />}
      {view === 'table' && result.columns.length > 0 && (
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
                      onClick={() => inspect(value)}
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
