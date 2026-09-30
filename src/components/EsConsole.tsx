import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import CodeMirror from '@uiw/react-codemirror';
import { EditorState } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { json } from '@codemirror/legacy-modes/mode/javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import type { EditorView } from '@codemirror/view';
import { clsx } from 'clsx';
import { AlertCircle, Copy, Loader2, Play, X } from 'lucide-react';
import type { ConnectionProfile } from '../contracts/connection';
import { selectActiveSqlDocument, useQueryStore } from '../stores/queryStore';
import { useLanguageStore } from '../stores/languageStore';
import { useThemeStore } from '../stores/themeStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useAppStore } from '../stores/appStore';
import { takeCypherAutorun } from '../stores/cypherAutorun';
import { useHistoryStore } from '../stores/historyStore';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { PanelResizeHandle } from './PanelResizeHandle';
import { DestructiveStatementPrompt } from './DestructiveStatementPrompt';
import { EsDocumentEditor } from './EsDocumentEditor';
import { documentAddress, type DocumentAddress } from '../utils/esDocument';
import { appEditorTheme } from '../utils/editorTheme';
import { runShortcutKeymap, type RunShortcutHandlers } from '../utils/runShortcutKeymap';
import { editorPhrases } from '../utils/editorPhrases';
import { describeError } from '../utils/describeError';
import { SHORTCUTS, formatShortcut } from '../utils/shortcuts';
import { MAX_UNVIRTUALIZED_ROWS } from '../utils/gridPagination';
import {
  ES_RISK_DESCRIPTION_KEYS,
  classifyEsRisk,
  esRequestAt,
  parseEsConsole,
  reachableRequests,
  riskiestEsRequest,
  type EsConsoleRequest
} from '../utils/esConsole';
import {
  MISSING,
  bulkFailures,
  formatJsonCell,
  parseJson,
  searchFacts,
  stringifyJson,
  toEsTable,
  type JsonValue
} from '../utils/esJson';
import type { StatementRisk } from '../utils/statementRisk';
import type { TranslationKey } from '../i18n/translate';
import { toAggTables, type AggTable } from '../utils/esAggregations';
import { HighlightedCode } from './HighlightedCode';

/** 与后端 `EsResponse` 一致 */
interface EsResponse {
  status: number;
  body: string;
  elapsedMs: number;
}

type EsRun =
  | { id: number; request: EsConsoleRequest; state: 'running' | 'skipped' }
  | { id: number; request: EsConsoleRequest; state: 'done'; response: EsResponse }
  | { id: number; request: EsConsoleRequest; state: 'failed'; error: string };

/** 一段 JSON 最多画这么多字符。32 MB 的回答整段塞进一个 `<pre>`，WebView 要卡上好几秒 */
const MAX_RENDERED_JSON_CHARS = 200_000;

interface EsConsoleProps {
  connection: ConnectionProfile;
}

/**
 * Elasticsearch 的控制台标签：写 Dev Tools 那样的请求、发、看回答。
 *
 * 草稿存在查询标签的文档里（与 SQL、Cypher 标签同一份）。多条依次发，一条失败就停——
 * 失败包括状态码 4xx / 5xx：后面的请求多半依赖前面那条建出来的东西。
 * 会写的按「设置 → 危险语句确认」的门槛先确认；判断只看方法与路径（`utils/esConsole.ts`）。
 */
export function EsConsole({ connection }: EsConsoleProps) {
  const t = useLanguageStore((state) => state.t);
  const { sqlInput } = useQueryStore(selectActiveSqlDocument);
  const documentId = useQueryStore((state) => state.activeDocumentId);
  const connectionString = useQueryStore((state) => state.connectionString);
  const queryTimeoutMs = useQueryStore((state) => state.queryTimeoutMs);
  const setSqlInput = useQueryStore((state) => state.setSqlInput);
  const setQueryTimeoutMs = useQueryStore((state) => state.setQueryTimeoutMs);
  const confirmationPolicy = useSettingsStore((state) => state.confirmationPolicy);
  const markSchemaChanged = useAppStore((state) => state.markSchemaChanged);
  const resolvedTheme = useThemeStore((state) => state.resolved);
  const editorViewRef = useRef<EditorView | null>(null);
  const nextRunId = useRef(0);
  const [runs, setRuns] = useState<EsRun[]>([]);
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<{ requests: EsConsoleRequest[]; text: string; risk: StatementRisk } | null>(null);
  const [inspecting, setInspecting] = useState<JsonValue | null>(null);
  // 点了命中的 `_id`：改的是哪一份，是哪一段结果里的（写完重发那一条）
  const [editing, setEditing] = useState<{ address: DocumentAddress; runId: number } | null>(null);
  const editorPanel = useResizablePanel({
    storageKey: 'es-editor-height',
    defaultSize: 220,
    minSize: 96,
    maxSize: 640,
    axis: 'y'
  });

  const shortcuts = useRef<RunShortcutHandlers>({ runCurrent: () => {}, runAll: () => {} });
  const extensions = useMemo(
    () => [
      runShortcutKeymap(shortcuts),
      StreamLanguage.define(json),
      EditorState.phrases.of(editorPhrases(t)),
      appEditorTheme
    ],
    [t]
  );

  /**
   * 发出去的一条记进查询历史：写成控制台的写法（方法、路径、请求体），从历史里打开就能再发。
   * 请求体写错、没发出去的不记
   */
  const remember = (request: EsConsoleRequest, started: number, status: 'succeeded' | 'failed' | 'timed-out', errorMessage?: string) => {
    useHistoryStore.getState().recordConsole({
      id: crypto.randomUUID(),
      language: 'elasticsearch',
      profileId: connection.id,
      connectionName: connection.name,
      database: null,
      text: request.body === null ? `${request.method} ${request.path}` : `${request.method} ${request.path}\n${request.body.trimEnd()}`,
      startedAt: started,
      durationMs: Date.now() - started,
      status,
      rowsAffected: null,
      errorMessage
    });
  };

  /** 真的发：依次一条，失败就停，后面的标成没发 */
  const execute = async (requests: EsConsoleRequest[]) => {
    if (!connectionString) return;
    const first = nextRunId.current;
    nextRunId.current += requests.length;
    setRuns(requests.map((request, index) => ({ id: first + index, request, state: 'running' })));
    setInspecting(null);
    setEditing(null);
    setRunning(true);
    let wrote = false;
    const stopAfter = (id: number) => setRuns((previous) => previous.map((run) => (
      run.id > id ? { id: run.id, request: run.request, state: 'skipped' } : run
    )));
    for (const [index, request] of requests.entries()) {
      const id = first + index;
      if (request.problem) {
        const error = t('es.bodyProblem', { line: request.problem.line, message: request.problem.message });
        setRuns((previous) => previous.map((run) => (run.id === id ? { id, request, state: 'failed', error } : run)));
        stopAfter(id);
        break;
      }
      const started = Date.now();
      try {
        const response = await invoke<EsResponse>('elasticsearch_run', {
          connectionString,
          method: request.method,
          path: request.path,
          body: request.body,
          ndjson: request.ndjson,
          timeoutMs: queryTimeoutMs
        });
        setRuns((previous) => previous.map((run) => (run.id === id ? { id, request, state: 'done', response } : run)));
        // 一批里有条目没写成，状态码照样是 200：也算失败，后面的多半依赖它
        const bulk = response.status < 400 && request.path.includes('_bulk') ? bulkFailures(parseJson(response.body)) : null;
        const problem = response.status >= 400 ? `HTTP ${response.status}` : bulk ? t('es.bulkFailed', bulk) : undefined;
        remember(request, started, problem === undefined ? 'succeeded' : 'failed', problem);
        if (problem !== undefined) {
          stopAfter(id);
          break;
        }
        wrote ||= classifyEsRisk(request.method, request.path) !== 'read';
      } catch (caught) {
        const error = describeError(caught);
        setRuns((previous) => previous.map((run) => (run.id === id ? { id, request, state: 'failed', error } : run)));
        remember(request, started, String(caught).startsWith('DATAOMNI_ES_TIMEOUT') ? 'timed-out' : 'failed', error);
        stopAfter(id);
        break;
      }
    }
    setRunning(false);
    // 建了、删了索引，对象树可能多了或少了：让它重新拉一遍
    if (wrote) markSchemaChanged();
  };

  /** 改了、删了一份文档之后，把列出它的那条搜索再发一次：看到的就是服务端现在的样子 */
  const refreshRun = async (runId: number) => {
    const target = runs.find((candidate) => candidate.id === runId);
    if (!target || !connectionString) return;
    const { request } = target;
    try {
      const response = await invoke<EsResponse>('elasticsearch_run', {
        connectionString,
        method: request.method,
        path: request.path,
        body: request.body,
        ndjson: request.ndjson,
        timeoutMs: queryTimeoutMs
      });
      setRuns((previous) => previous.map((run) => (run.id === runId ? { id: runId, request, state: 'done', response } : run)));
    } catch (caught) {
      const error = describeError(caught);
      setRuns((previous) => previous.map((run) => (run.id === runId ? { id: runId, request, state: 'failed', error } : run)));
    }
  };

  const run = (requests: EsConsoleRequest[], source: string) => {
    if (running || requests.length === 0 || !connectionString) return;
    const riskiest = riskiestEsRequest(reachableRequests(requests), connection.environment, confirmationPolicy);
    if (riskiest) {
      const request = requests.find((candidate) => candidate === riskiest.request) ?? requests[0];
      setPending({ requests, text: source.slice(request.from, request.to), risk: riskiest.risk });
      return;
    }
    void execute(requests);
  };

  const runAll = () => run(parseEsConsole(sqlInput), sqlInput);

  /** 有选区发选区里的（可以有多条），没有就发光标所在的那条 */
  const runCurrent = () => {
    const view = editorViewRef.current;
    const selection = view?.state.selection.main;
    if (view && selection && !selection.empty) {
      const selected = view.state.sliceDoc(selection.from, selection.to);
      run(parseEsConsole(selected), selected);
      return;
    }
    const current = esRequestAt(sqlInput, selection?.head ?? 0);
    if (current) run([current], sqlInput);
  };

  // 从对象树点一个索引开出来的标签：进来就发一次
  useEffect(() => {
    if (documentId && sqlInput.trim() && takeCypherAutorun(documentId)) {
      run(parseEsConsole(sqlInput), sqlInput);
    }
    // 只在换了标签、内容到位时看一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, sqlInput === '']);

  shortcuts.current = { runCurrent, runAll };
  const scheme = connection.tls_mode && connection.tls_mode !== 'disabled' ? 'https' : connection.ssl ? 'https' : 'http';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{connection.name}</p>
          <p className="truncate text-xs text-fg-muted">{`Elasticsearch · ${scheme}://${connection.host}:${connection.port}`}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
            <span>{t('es.runCurrent')}</span>
          </button>
          <button
            type="button"
            onClick={runAll}
            disabled={running || sqlInput.trim() === ''}
            title={formatShortcut(SHORTCUTS.runAll)}
            className="flex items-center gap-1 rounded-control bg-accent px-3 py-1.5 text-sm text-accent-fg hover:opacity-90 disabled:opacity-50"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            <span>{t('es.runAll')}</span>
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
            placeholder={t('es.placeholder')}
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

      <div className="relative min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {runs.length === 0 && (
          <p className="text-sm text-fg-muted">
            {t('es.empty', { current: formatShortcut(SHORTCUTS.runCurrent), all: formatShortcut(SHORTCUTS.runAll) })}
          </p>
        )}
        {runs.map((run) => (
          <RunSection
            key={run.id}
            run={run}
            onInspect={(value) => {
              setEditing(null);
              setInspecting(value);
            }}
            // 只有读的请求才能在写完之后重发一遍：写的那条再发一次就是再写一次
            onEditDocument={classifyEsRisk(run.request.method, run.request.path) === 'read'
              ? (address) => {
                setInspecting(null);
                setEditing({ address, runId: run.id });
              }
              : undefined}
          />
        ))}
      </div>

      {editing && (
        <div className="h-80 max-h-[50%] shrink-0 border-t border-line bg-surface-sunken px-3 py-2">
          <EsDocumentEditor
            key={`${editing.address.index}/${editing.address.id}`}
            connection={connection}
            address={editing.address}
            onWritten={() => void refreshRun(editing.runId)}
            onClose={() => setEditing(null)}
          />
        </div>
      )}
      {inspecting && (
        <div className="max-h-[40%] shrink-0 overflow-y-auto border-t border-line bg-surface-sunken px-3 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-fg-muted">{t('es.value')}</span>
            <button type="button" onClick={() => setInspecting(null)} aria-label={t('common.close')} className="text-fg-muted hover:text-fg">
              <X size={14} />
            </button>
          </div>
          {inspecting.kind === 'string'
            ? <pre className="select-text whitespace-pre-wrap break-all font-mono text-[13px] text-fg">{inspecting.value}</pre>
            : <pre className="select-text whitespace-pre-wrap break-all font-mono text-[13px] text-fg"><HighlightedCode code={stringifyJson(inspecting, 2)} language="json" /></pre>}
        </div>
      )}

      {pending && (
        <DestructiveStatementPrompt
          language="json"
          sql={pending.text}
          risk={pending.risk}
          statementCount={pending.requests.length}
          connectionName={connection.name}
          environment={connection.environment}
          databaseLabel="Elasticsearch"
          reversibility={{ kind: 'no-transaction' }}
          riskDescription={ES_RISK_DESCRIPTION_KEYS[pending.risk] && t(ES_RISK_DESCRIPTION_KEYS[pending.risk]!)}
          onConfirm={() => {
            const requests = pending.requests;
            setPending(null);
            void execute(requests);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

function RunSection({
  run,
  onInspect,
  onEditDocument
}: {
  run: EsRun;
  onInspect: (value: JsonValue) => void;
  onEditDocument?: (address: DocumentAddress) => void;
}) {
  const t = useLanguageStore((state) => state.t);
  const { request } = run;
  return (
    <section className="mb-4">
      <p className="mb-1 flex items-center gap-2 truncate font-mono text-xs text-fg-muted" title={`${request.method} ${request.path}`}>
        {run.state === 'done' && <StatusBadge status={run.response.status} />}
        <span className="truncate">{`${request.method} ${request.path}`}</span>
      </p>
      {run.state === 'running' && (
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 size={14} className="animate-spin" />
          {t('es.running')}
        </p>
      )}
      {run.state === 'skipped' && <p className="text-sm text-fg-muted">{t('es.skipped')}</p>}
      {run.state === 'failed' && (
        <div className="flex items-start gap-2 rounded-control border border-danger-line bg-danger-soft p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-danger" />
          <pre className="min-w-0 select-text whitespace-pre-wrap break-words font-mono text-xs text-danger">{run.error}</pre>
        </div>
      )}
      {run.state === 'done' && <ResponseView response={run.response} onInspect={onInspect} onEditDocument={onEditDocument} />}
    </section>
  );
}

const VIEW_OPTIONS = ['table', 'aggs', 'json'] as const;
type ResponseViewOption = (typeof VIEW_OPTIONS)[number];
const VIEW_LABEL_KEYS: Record<ResponseViewOption, TranslationKey> = {
  table: 'es.view.table',
  aggs: 'es.view.aggs',
  json: 'es.view.json'
};

/** 一个桶聚合一张表，指标聚合并成一张「名字 | 值」 */
function AggTableView({ table, onInspect }: { table: AggTable; onInspect: (value: JsonValue) => void }) {
  const t = useLanguageStore((state) => state.t);
  const rows = table.rows.slice(0, MAX_UNVIRTUALIZED_ROWS);
  return (
    <div className="mb-3">
      <p className="mb-1 font-mono text-xs text-fg-muted">{table.name ?? t('es.aggs.metrics')}</p>
      <div className="overflow-x-auto rounded-control border border-line">
        <table className="min-w-full border-collapse font-mono text-[13px]">
          <thead className="bg-surface-sunken">
            <tr>
              {table.columns.map((column, index) => (
                <th key={`${column}:${index}`} className="whitespace-nowrap border-b border-line px-2 py-1 text-left font-medium text-fg">{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-surface-hover">
                {row.map((cell, columnIndex) => (
                  <td
                    key={columnIndex}
                    onClick={() => cell !== MISSING && onInspect(cell)}
                    className={clsx('max-w-[32rem] truncate border-b border-line px-2 py-1', cell === MISSING ? '' : 'cursor-pointer text-fg')}
                    title={cell === MISSING ? undefined : formatJsonCell(cell)}
                  >
                    {cell === MISSING ? '' : formatJsonCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length > rows.length && (
        <p className="mt-1 text-xs text-fg-muted">{t('es.tableCapped', { shown: rows.length, total: table.rows.length })}</p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: number }) {
  return (
    <span
      className={clsx(
        'shrink-0 rounded px-1.5 py-px font-medium',
        status >= 500 ? 'bg-danger-soft text-danger' : status >= 400 ? 'bg-warning-soft text-warning' : 'bg-success-soft text-success'
      )}
    >
      {status}
    </span>
  );
}

function ResponseView({
  response,
  onInspect,
  onEditDocument
}: {
  response: EsResponse;
  onInspect: (value: JsonValue) => void;
  onEditDocument?: (address: DocumentAddress) => void;
}) {
  const t = useLanguageStore((state) => state.t);
  const parsed = useMemo(() => parseJson(response.body), [response.body]);
  const table = useMemo(() => toEsTable(parsed), [parsed]);
  const pretty = useMemo(() => (parsed === null ? response.body : stringifyJson(parsed, 2)), [parsed, response.body]);
  const aggTables = useMemo(() => toAggTables(parsed), [parsed]);
  const [chosen, setView] = useState<ResponseViewOption | null>(null);
  const [copied, setCopied] = useState(false);
  const views = VIEW_OPTIONS.filter((option) => (
    option === 'json' || (option === 'table' ? table !== null : aggTables.length > 0)
  ));
  // 有命中先看命中；`size: 0` 只要聚合的，先看聚合
  const view = chosen ?? (table && table.rows.length > 0 ? 'table' : aggTables.length > 0 ? 'aggs' : 'json');
  const search = searchFacts(parsed);
  const bulk = useMemo(() => bulkFailures(parsed), [parsed]);
  const facts = [
    search?.total ? t(search.atLeast ? 'es.hitsAtLeast' : 'es.hits', { count: Number(search.total) }) : null,
    search?.tookMs ? t('es.took', { ms: search.tookMs }) : null,
    t('es.elapsed', { ms: response.elapsedMs })
  ].filter((fact): fact is string => fact !== null);
  const shownRows = table ? table.rows.slice(0, MAX_UNVIRTUALIZED_ROWS) : [];

  const copy = () => {
    navigator.clipboard.writeText(pretty).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => setCopied(false));
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-xs text-fg-muted">
          {facts.join(' · ')}
          {search?.timedOut && <span className="ml-2 text-warning">{t('es.timedOut')}</span>}
          {bulk && <span className="ml-2 text-warning">{t('es.bulkFailed', bulk)}</span>}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {view === 'json' && pretty !== '' && (
            <button type="button" onClick={copy} className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
              <Copy size={12} />
              <span>{copied ? t('common.copied') : t('es.copyJson')}</span>
            </button>
          )}
          {views.length > 1 && (
            <div className="flex overflow-hidden rounded-control border border-line text-xs" role="group">
              {views.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setView(option)}
                  aria-pressed={view === option}
                  className={clsx('px-2 py-0.5', view === option ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-hover')}
                >
                  {t(VIEW_LABEL_KEYS[option])}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {view === 'json' && pretty !== '' && (
        <>
          <pre className="max-h-[32rem] select-text overflow-auto rounded-control border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-fg"><HighlightedCode code={pretty.length > MAX_RENDERED_JSON_CHARS ? pretty.slice(0, MAX_RENDERED_JSON_CHARS) : pretty} language="json" /></pre>
          {pretty.length > MAX_RENDERED_JSON_CHARS && (
            <p className="mt-1 text-xs text-warning">{t('es.jsonCapped', { shown: MAX_RENDERED_JSON_CHARS.toLocaleString() })}</p>
          )}
        </>
      )}
      {view === 'aggs' && aggTables.map((aggTable, index) => (
        <AggTableView key={`${aggTable.name ?? ''}:${index}`} table={aggTable} onInspect={onInspect} />
      ))}
      {view === 'table' && table && (
        <>
          <div className="overflow-x-auto rounded-control border border-line">
            <table className="min-w-full border-collapse font-mono text-[13px]">
              <thead className="bg-surface-sunken">
                <tr>
                  {table.columns.map((column, index) => (
                    <th key={`${column}:${index}`} className="whitespace-nowrap border-b border-line px-2 py-1 text-left font-medium text-fg">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownRows.map((row, rowIndex) => {
                  // 命中的 `_id` 那一格点开是这份文档的编辑框
                  const hit = table.hits?.[rowIndex];
                  const address = hit && onEditDocument ? documentAddress(hit) : null;
                  return (
                  <tr key={rowIndex} className="hover:bg-surface-hover">
                    {row.map((cell, columnIndex) => {
                      const editsDocument = address !== null && table.columns[columnIndex] === '_id' && columnIndex < 2;
                      return (
                      <td
                        key={columnIndex}
                        onClick={() => {
                          if (editsDocument && address) onEditDocument?.(address);
                          else if (cell !== MISSING) onInspect(cell);
                        }}
                        className={clsx(
                          'max-w-[32rem] truncate border-b border-line px-2 py-1',
                          cell === MISSING ? 'text-fg-subtle' : 'cursor-pointer',
                          editsDocument ? 'text-accent underline decoration-dotted underline-offset-2'
                            : cell?.kind === 'null' ? 'italic text-fg-subtle' : 'text-fg'
                        )}
                        title={cell === MISSING ? undefined : formatJsonCell(cell)}
                      >
                        {cell === MISSING ? '' : formatJsonCell(cell)}
                      </td>
                      );
                    })}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {table.rows.length > shownRows.length && (
            <p className="mt-1 text-xs text-fg-muted">{t('es.tableCapped', { shown: shownRows.length, total: table.rows.length })}</p>
          )}
        </>
      )}
    </div>
  );
}
