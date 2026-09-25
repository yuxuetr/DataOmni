import { serverLabel } from '../utils/serverPresets';
import React, { useEffect, useState, useMemo, useRef } from 'react';
import { clsx } from 'clsx';
import {
  Play,
  Network,
  PlayCircle,
  Trash2,
  RotateCcw,
  Clock,
  AlertCircle,
  CheckCircle,
  Loader,
  Square,
  AlignLeft,
  Save,
  PanelTopClose,
  PanelTopOpen
} from 'lucide-react';
import { selectActiveSqlDocument, useQueryStore, SqlStatement } from '../stores/queryStore';
import type { QueryExecution } from '../contracts/queryExecution';
import CodeMirror from '@uiw/react-codemirror';
import { EditorState } from '@codemirror/state';
import { sql } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import { QueryResultScrollTable } from './QueryResultScrollTable';
import { QueryErrorPanel } from './QueryErrorPanel';
import type { EditorView } from '@codemirror/view';
import { useThemeStore } from '../stores/themeStore';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { PanelResizeHandle } from './PanelResizeHandle';
import { SHORTCUTS, formatShortcut, matchesShortcut } from '../utils/shortcuts';
import { DestructiveStatementPrompt } from './DestructiveStatementPrompt';
import { QueryPlanDialog } from './QueryPlanDialog';
import { highestRiskNeedingConfirmation, type StatementRisk } from '../utils/statementRisk';
import { statementReversibility } from '../utils/statementReversibility';
import { identifierDialectFor } from '../utils/sqlIdentifiers';
import { useSettingsStore } from '../stores/settingsStore';
import type { ConnectionProfile } from '../contracts';
import {
  findSqlStatementAtOffset,
  getSqlStatementRanges,
  splitSqlStatements
} from '../utils/sqlStatements';
import { planFormat, sqlFormatterLanguage } from '../utils/formatSql';
import { SQL_FILE_FILTER, suggestSqlFileName } from '../utils/sqlFile';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { describeError } from '../utils/describeError';
import { appEditorTheme } from '../utils/editorTheme';
import { runShortcutKeymap, type RunShortcutHandlers } from '../utils/runShortcutKeymap';
import { editorPhrases } from '../utils/editorPhrases';
import { supportsFeature } from '../contracts/databaseSupport';
import { useLanguageStore } from '../stores/languageStore';
import { useCompletionCatalog } from '../hooks/useCompletionCatalog';
import {
  buildCompletionSchema,
  sqlDialectFor
} from '../utils/sqlCompletionSchema';

interface SqlEditorProps {
  /** 补全要方言与库名，确认框要把「在哪个库上执行」说清楚 */
  connection: ConnectionProfile;
  /** 当前标签的标题，用来给另存出去的 `.sql` 猜个文件名 */
  documentTitle?: string;
}

export const SqlEditor: React.FC<SqlEditorProps> = ({ connection, documentTitle }) => {
  const t = useLanguageStore((state) => state.t);
  const environment = connection.environment;
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const { relations, error: catalogError } = useCompletionCatalog(connection);
  // 确认门槛按环境可配，默认等于可配置之前的固定行为
  const confirmationPolicy = useSettingsStore((state) => state.confirmationPolicy);
  // 文档随活动 SQL 标签切换，单独订阅
  const { sqlInput, statements, latestExecutionIdByStatement } =
    useQueryStore(selectActiveSqlDocument);
  const {
    executions,
    queryTimeoutMs,
    queryResultRowLimit,
    isConnecting,
    error,
    setSqlInput,
    parseStatements,
    executeSql,
    executeStatement,
    executeAllStatements,
    cancelExecution,
    setQueryTimeoutMs,
    setQueryResultRowLimit,
    clearResults,
    removeStatement,
    setError,
    autocommit,
    setAutocommit,
    session
  } = useQueryStore();

  const [autoParseEnabled, setAutoParseEnabled] = useState(true);
  // 切语句要按方言：SQL Server 的 `GO`、`#临时表` 与 `[标识符]`
  const statementDialect = identifierDialectFor(connection.db_type);

  // 等待确认的一次执行。run 留着原本要做的事，确认后原样放行。
  const [pendingRun, setPendingRun] = useState<
    { sql: string; risk: StatementRisk; statements: string[]; run: () => void } | null
  >(null);

  /**
   * 所有执行入口都要过这道闸，漏掉一个这道闸就是装饰。
   * 不需要确认时直接执行，不额外加一次点击。
   */
  const runGuarded = (candidates: string[], run: () => void) => {
    const worst = highestRiskNeedingConfirmation(
      candidates,
      environment,
      confirmationPolicy,
      statementDialect
    );
    if (!worst) {
      run();
      return;
    }

    setPendingRun({ ...worst, statements: candidates, run });
  };
  // 编辑器高度此前写死 200px，结果区再长也抢不到空间
  const editorPanel = useResizablePanel({
    storageKey: 'sql-editor-height',
    defaultSize: 200,
    minSize: 96,
    maxSize: 640,
    axis: 'y'
  });
  const [hasSelection, setHasSelection] = useState(false);
  // 正在看执行计划的那条语句
  const [explaining, setExplaining] = useState<string | null>(null);
  const [formatError, setFormatError] = useState<string | null>(null);
  const formatterLanguage = sqlFormatterLanguage(connection.db_type);
  const editorViewRef = useRef<EditorView | null>(null);
  const runShortcuts = useRef<RunShortcutHandlers>({ runCurrent: () => {}, runAll: () => {} });

  /**
   * 补全交给 `@codemirror/lang-sql` 自己的 schema 补全源：它按真实的语法树
   * 判断位置，`FROM orders o` 之后 `o.` 能补出 orders 的列——这件事用正则
   * 认前缀是做不对的。我们负责的是喂给它**真的**库结构。
   */
  const extensions = useMemo(() => {
    const { schema, defaultSchema } = buildCompletionSchema(relations, connection.db_type, {
      table: t('objectKind.table'),
      view: t('objectKind.view'),
      schema: t('completion.schema')
    }, connection.username);

    return [
      runShortcutKeymap(runShortcuts),
      sql({
        dialect: sqlDialectFor(connection.db_type),
        schema,
        defaultSchema,
        // 关键字补成大写，和手写 SQL 的惯例一致
        upperCaseKeywords: true
      }),
      // 查找 / 替换 / 跳转面板的文字，跟着界面语言走
      EditorState.phrases.of(editorPhrases(t)),
      appEditorTheme
    ];
  }, [relations, connection.db_type, connection.username, t]);

  // 编辑器跟随应用主题。此前这里有个只管 CodeMirror 的「深色模式」勾选框，
  // 勾上以后只有代码框变深、其余界面仍是浅色——它表达的不是用户想要的那件事。
  // 语句在文档里的位置。出错位置是相对语句的，要加上它才能跳
  const statementRanges = useMemo(
    () => getSqlStatementRanges(sqlInput, statementDialect),
    [sqlInput, statementDialect]
  );

  const resolvedTheme = useThemeStore((state) => state.resolved);
  const theme = resolvedTheme === 'dark' ? oneDark : undefined;

  // 自动解析SQL语句
  useEffect(() => {
    if (autoParseEnabled) {
      const debounceTimer = setTimeout(() => {
        parseStatements();
      }, 500); // 500ms防抖

      return () => clearTimeout(debounceTimer);
    }
  }, [sqlInput, autoParseEnabled, parseStatements]);

  // 手动解析
  const handleManualParse = () => {
    parseStatements();
  };

  // 清除错误
  const clearError = () => {
    setError(null);
  };

  const executeCurrentStatement = () => {
    const view = editorViewRef.current;
    const cursor = view?.state.selection.main.head ?? 0;
    const current = findSqlStatementAtOffset(sqlInput, cursor, statementDialect);
    if (!current) {
      return;
    }

    runGuarded([current.sql], () => {
      const parsedStatement = statements[current.index];
      void (parsedStatement?.sql === current.sql
        ? executeStatement(parsedStatement.id)
        : executeSql(current.sql));
    });
  };

  /**
   * 解释光标所在的那条语句。
   *
   * 和执行走同一套定位逻辑——解释的必须是**将要执行的那一条**，否则看到的
   * 计划是另一条语句的。
   *
   * 不走 `runGuarded`：普通 EXPLAIN 什么也不执行，为它弹一次确认，弹到第三次
   * 就没人看了。真正会执行的是对话框里那个「真的执行一遍」，确认在那里。
   */
  const explainCurrentStatement = () => {
    const view = editorViewRef.current;
    const cursor = view?.state.selection.main.head ?? 0;
    const current = findSqlStatementAtOffset(sqlInput, cursor, statementDialect);
    setExplaining(current?.sql ?? statements[0]?.sql ?? null);
  };

  const executeSelectedSql = () => {
    const selection = editorViewRef.current?.state.selection.main;
    if (!selection || selection.empty) {
      return;
    }

    const selectedStatements = splitSqlStatements(
      sqlInput.slice(selection.from, selection.to),
      statementDialect
    );

    runGuarded(selectedStatements, () => {
      void (async () => {
        for (const statement of selectedStatements) {
          const succeeded = await executeSql(statement);
          if (!succeeded) {
            break;
          }
        }
      })();
    });
  };

  /** 另存为 `.sql`。写完把路径显示出来——只说「已保存」，用户不知道存去了哪 */
  const saveSqlToFile = async () => {
    setFileError(null);
    try {
      const path = await save({
        defaultPath: suggestSqlFileName(documentTitle ?? ''),
        filters: [SQL_FILE_FILTER]
      });
      // 取消保存对话框不是错误，不该留下任何提示
      if (!path) {
        return;
      }
      await invoke<number>('write_text_file', { path, contents: sqlInput });
      setSavedPath(path);
    } catch (error) {
      setFileError(describeError(error, t('editor.saveFailed')));
    }
  };

  const handleEditorKeyDown = (event: React.KeyboardEvent) => {
    if (matchesShortcut(event, SHORTCUTS.saveToFile)) {
      event.preventDefault();
      void saveSqlToFile();
      return;
    }

    if (matchesShortcut(event, SHORTCUTS.formatSql)) {
      event.preventDefault();
      formatEditorContent();
      return;
    }

  };

  /** 运行的两个快捷键在编辑器的键位表里（`runShortcutKeymap`），见那里为什么不在 onKeyDown */
  const runCurrentFromShortcut = () => {
    const selection = editorViewRef.current?.state.selection.main;
    if (selection && !selection.empty) {
      executeSelectedSql();
    } else {
      executeCurrentStatement();
    }
  };

  const runAllGuarded = () => {
    runGuarded(statements.map((statement) => statement.sql), () => {
      void executeAllStatements();
    });
  };
  runShortcuts.current = { runCurrent: runCurrentFromShortcut, runAll: runAllGuarded };

  /**
   * 排版当前选区；没有选区就排整份。
   *
   * 改动走 `view.dispatch` 而不是 `setSqlInput`：受控地整份换掉文本会重置
   * CodeMirror 的编辑历史，那样格式化就**撤不回来**了——而它恰恰是个随手
   * 会按、按错了想立刻撤回的动作。
   */
  const formatEditorContent = () => {
    const view = editorViewRef.current;
    if (!view || !formatterLanguage) {
      return;
    }

    const { from, to, head } = view.state.selection.main;
    const plan = planFormat(view.state.doc.toString(), { from, to, head }, formatterLanguage);

    if (plan.kind === 'failed') {
      setFormatError(plan.message);
      return;
    }

    setFormatError(null);
    if (plan.kind === 'unchanged') {
      return;
    }

    view.dispatch({
      changes: { from: plan.from, to: plan.to, insert: plan.insert },
      selection: { anchor: plan.anchor, head: plan.head }
    });
  };

  /** 把光标移到出错处并滚过去。选中一个字符，让它在编辑器里看得见 */
  const jumpToOffset = (offset: number) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }
    const target = Math.max(0, Math.min(offset, view.state.doc.length));
    view.dispatch({
      selection: { anchor: target },
      scrollIntoView: true
    });
    view.focus();
  };

  // 格式化执行时间
  const formatExecutionTime = (ms: number): string => {
    if (ms < 1000) {
      return `${ms}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(2)}s`;
    } else {
      return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(2)}s`;
    }
  };

  return (
    <div className="h-full flex flex-col bg-surface">
      {pendingRun && (
        <DestructiveStatementPrompt
          sql={pendingRun.sql}
          risk={pendingRun.risk}
          statementCount={pendingRun.statements.length}
          connectionName={connection.name}
          environment={environment}
          databaseLabel={serverLabel(connection)}
          reversibility={statementReversibility(
            pendingRun.statements,
            identifierDialectFor(connection.db_type),
            autocommit,
            session?.transaction.status ?? 'idle'
          )}
          onCancel={() => setPendingRun(null)}
          onConfirm={() => {
            const run = pendingRun.run;
            setPendingRun(null);
            run();
          }}
          onRunInTransaction={() => {
            const run = pendingRun.run;
            setPendingRun(null);
            // 开关一关，后端的 begin_if_needed 就会在这条语句前补上 BEGIN。
            // 不关回去：关回去等于在事务还开着的时候谎报状态
            setAutocommit(false);
            run();
          }}
        />
      )}

      {explaining !== null && (
        <QueryPlanDialog
          sql={explaining}
          connectionId={connection.id}
          dbType={connection.db_type}
          databaseLabel={serverLabel(connection)}
          onClose={() => setExplaining(null)}
        />
      )}
      {/* SQL编辑器头部 */}
      <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-sunken px-3 py-1.5">
        <div className="flex shrink-0 items-center gap-2">
          {/* 折叠按钮放这里而不是分隔条上：折叠之后分隔条就不渲染了，
              入口得留在一直看得见的头部 */}
          <button
            type="button"
            onClick={() => editorPanel.toggleCollapsed()}
            aria-label={editorPanel.collapsed ? t('panel.expandEditor') : t('panel.collapseEditor')}
            title={editorPanel.collapsed ? t('panel.expandEditor') : t('panel.collapseEditor')}
            className="rounded-control p-1 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
          >
            {editorPanel.collapsed ? <PanelTopOpen size={15} /> : <PanelTopClose size={15} />}
          </button>
          {/* 不再用「SQL编辑器」大标题：标签栏已经标明这是查询标签 */}
          <span className="text-xs text-fg-subtle">
            {statements.length > 0
              ? t('editor.statementCount', { count: statements.length })
              : t('editor.noStatements')}
          </span>
          {/* 补全退化成只有关键字时要说出来：否则「它不认识我的表」和
              「它还在加载」长得一模一样。原始错误放在 title 里 */}
          {catalogError && (
            <span
              className="flex items-center gap-1 text-xs text-warning"
              title={catalogError}
            >
              <AlertCircle size={12} />
              {t('completion.catalogFailed')}
            </span>
          )}
        </div>
        
        {/* 允许换行：这一行已经有两个下拉、一个勾选和六个按钮，窄窗口下
            不换行就会把「执行全部」整个挤出可视区，而它没有别的入口 */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <label className="flex items-center space-x-2 text-sm text-fg-muted">
            <span>{t('editor.rowLimit')}</span>
            <select
              value={queryResultRowLimit}
              onChange={(event) => setQueryResultRowLimit(Number(event.target.value))}
              className="px-2 py-1.5 border border-line-strong rounded-control bg-surface text-sm"
              aria-label={t('editor.rowLimitLabel')}
            >
              <option value={100}>{t('editor.rowsOption', { count: 100 })}</option>
              <option value={500}>{t('editor.rowsOption', { count: 500 })}</option>
              <option value={1000}>{t('editor.rowsOption', { count: '1,000' })}</option>
              <option value={5000}>{t('editor.rowsOption', { count: '5,000' })}</option>
              <option value={10000}>{t('editor.rowsOption', { count: '10,000' })}</option>
            </select>
          </label>

          <label className="flex items-center space-x-2 text-sm text-fg-muted">
            <span>{t('editor.timeout')}</span>
            <select
              value={queryTimeoutMs}
              onChange={(event) => setQueryTimeoutMs(Number(event.target.value))}
              className="px-2 py-1.5 border border-line-strong rounded-control bg-surface text-sm"
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

          {/* 自动解析开关 */}
          <label className="flex items-center space-x-2 text-sm text-fg-muted">
            <input
              type="checkbox"
              checked={autoParseEnabled}
              onChange={(e) => setAutoParseEnabled(e.target.checked)}
              className="h-4 w-4 text-accent focus:ring-accent border-line-strong rounded-control"
            />
            <span>{t('editor.autoParse')}</span>
          </label>

          {/* 手动解析按钮 */}
          {!autoParseEnabled && (
            <button
              onClick={handleManualParse}
              className="flex items-center space-x-1 px-3 py-1.5 text-sm text-fg-muted border border-line-strong rounded-control hover:bg-surface-hover transition-colors"
            >
              <RotateCcw size={14} />
              <span>{t('editor.parse')}</span>
            </button>
          )}

          {/* 另存为 .sql。和格式化一样只给图标——头部已经很挤 */}
          <button
            onClick={() => void saveSqlToFile()}
            disabled={sqlInput.trim() === ''}
            aria-label={t('editor.saveToFile')}
            title={t('editor.saveToFileTitle', { shortcut: formatShortcut(SHORTCUTS.saveToFile) })}
            className="flex items-center rounded-control border border-line-strong p-1.5 text-fg-muted transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:border-line disabled:text-fg-subtle"
          >
            <Save size={14} />
          </button>

          {/* 格式化。头部已经很挤，这里只给图标，说明放在 title 里 */}
          <button
            onClick={formatEditorContent}
            disabled={!formatterLanguage}
            aria-label={t('editor.format')}
            title={t('editor.formatTitle', { shortcut: formatShortcut(SHORTCUTS.formatSql) })}
            className="flex items-center rounded-control border border-line-strong p-1.5 text-fg-muted transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:border-line disabled:text-fg-subtle"
          >
            <AlignLeft size={14} />
          </button>

          {/* 清除结果 */}
          <button
            onClick={clearResults}
            disabled={statements.length === 0}
            className={clsx(
              "flex items-center space-x-1 px-3 py-1.5 text-sm border rounded-control transition-colors",
              statements.length === 0
                ? "text-fg-subtle border-line cursor-not-allowed"
                : "text-fg-muted border-line-strong hover:bg-surface-hover"
            )}
          >
            <Trash2 size={14} />
            <span>{t('editor.clearResults')}</span>
          </button>

          <button
            onClick={executeSelectedSql}
            disabled={!hasSelection || isConnecting}
            className="flex items-center space-x-1 px-3 py-1.5 text-sm text-fg-muted border border-line-strong rounded-control hover:bg-surface-hover transition-colors disabled:text-fg-subtle disabled:border-line disabled:cursor-not-allowed"
            title={t('editor.runSelectionTitle')}
          >
            <Play size={14} />
            <span>{t('editor.runSelection')}</span>
          </button>

          {supportsFeature(connection.db_type, 'explain') && (
          <button
            onClick={explainCurrentStatement}
            disabled={statements.length === 0 || isConnecting}
            className="flex items-center space-x-1 px-3 py-1.5 text-sm text-fg-muted border border-line-strong rounded-control hover:bg-surface-hover transition-colors disabled:text-fg-subtle disabled:border-line disabled:cursor-not-allowed"
            title={t('plan.buttonTitle')}
          >
            <Network size={14} />
            <span>{t('plan.button')}</span>
          </button>
          )}

          <button
            onClick={executeCurrentStatement}
            disabled={statements.length === 0 || isConnecting}
            className="flex items-center space-x-1 px-3 py-1.5 text-sm text-fg-muted border border-line-strong rounded-control hover:bg-surface-hover transition-colors disabled:text-fg-subtle disabled:border-line disabled:cursor-not-allowed"
            title={t('editor.runCurrentTitle', { shortcut: formatShortcut(SHORTCUTS.runCurrent) })}
          >
            <Play size={14} />
            <span>{t('editor.runCurrent')}</span>
          </button>

          {/* 执行所有语句 */}
          {/* 多语句的执行规则原本是编辑器下方一行常驻说明；挪进按钮提示里——
              这件事只在要按它的时候才需要知道 */}
          <button
            onClick={runAllGuarded}
            disabled={statements.length === 0 || isConnecting}
            title={t('editor.runAllTitle', { shortcut: formatShortcut(SHORTCUTS.runAll) })}
            className={clsx(
              "flex items-center space-x-2 px-4 py-1.5 text-sm rounded-control transition-colors",
              statements.length === 0 || isConnecting
                ? "bg-surface-active text-fg-subtle cursor-not-allowed"
                : "bg-accent text-fg-on-accent hover:bg-accent-hover"
            )}
          >
            <PlayCircle size={16} />
            <span>{isConnecting ? t('editor.connecting') : t('editor.runAll')}</span>
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="p-4 bg-danger-soft border-b border-danger-line">
          <div className="flex items-center space-x-2">
            <AlertCircle className="text-danger" size={16} />
            <span className="text-danger text-sm flex-1">{error}</span>
            <button
              onClick={clearError}
              className="text-danger hover:text-danger"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* 排版失败。解析器给的行号列号原样显示——「格式化失败」四个字
          说不出是哪里写错了 */}
      {formatError && (
        <div className="flex items-start gap-2 border-b border-warning-line bg-warning-soft p-3">
          <AlertCircle className="mt-0.5 shrink-0 text-warning" size={16} />
          <div className="min-w-0 flex-1">
            <h4 className="mb-1 text-sm font-medium text-warning">{t('editor.formatFailed')}</h4>
            <p className="whitespace-pre-wrap break-words font-mono text-xs text-warning">
              {formatError}
            </p>
          </div>
          <button
            onClick={() => setFormatError(null)}
            aria-label={t('common.close')}
            className="shrink-0 text-warning hover:opacity-80"
          >
            ✕
          </button>
        </div>
      )}

      {/* 存文件的结果。成功要带上路径——只说「已保存」的话，用户不知道存去了哪 */}
      {savedPath && (
        <div className="flex items-center gap-2 border-b border-success-line bg-success-soft px-3 py-2">
          <CheckCircle className="shrink-0 text-success" size={16} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-success">{savedPath}</span>
          <button
            onClick={() => setSavedPath(null)}
            aria-label={t('common.close')}
            className="shrink-0 text-success hover:opacity-80"
          >
            ✕
          </button>
        </div>
      )}

      {fileError && (
        <div className="flex items-start gap-2 border-b border-danger-line bg-danger-soft px-3 py-2">
          <AlertCircle className="mt-0.5 shrink-0 text-danger" size={16} />
          <span className="min-w-0 flex-1 break-words text-xs text-danger">{fileError}</span>
          <button
            onClick={() => setFileError(null)}
            aria-label={t('common.close')}
            className="shrink-0 text-danger hover:opacity-80"
          >
            ✕
          </button>
        </div>
      )}

      {/* SQL输入区域 - 使用CodeMirror */}
      {/* 折叠用 display:none 而不是卸载：卸载会连撤销历史和光标一起丢掉，
          而这正是「恢复」该保住的东西。本来还加了一个展开时 `requestMeasure()`
          的 effect，去掉之后实测行为不变——CodeMirror 自己的 ResizeObserver
          会在 0 高度变回来时重量，展开后点击落点仍然准确（565px 点下、
          光标落在 565px） */}
      <div
        className={clsx(
          'shrink-0 px-3 pb-2 pt-3',
          editorPanel.collapsed && 'hidden'
        )}
      >
        <div className="overflow-hidden rounded-control border border-line-strong">
          <CodeMirror
            value={sqlInput}
            onChange={(value) => setSqlInput(value)}
            onCreateEditor={(view) => {
              editorViewRef.current = view;
            }}
            onUpdate={(update) => {
              if (update.selectionSet || update.docChanged) {
                setHasSelection(!update.state.selection.main.empty);
              }
            }}
            onKeyDown={handleEditorKeyDown}
            theme={theme}
            extensions={extensions}
            placeholder={t('editor.placeholder')}
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              dropCursor: false,
              allowMultipleSelections: false,
              indentOnInput: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: true,
              highlightSelectionMatches: true,
              searchKeymap: true,
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

      {/* SQL语句列表和结果 */}
      {/* `query-result-pane` 是给结果表量可用空间用的锚点：它要知道自己
          底下还剩多少地方，而那取决于这块区域有多高。见 resultTableHeight */}
      <div className="query-result-pane flex-1 overflow-y-auto">
        {statements.length === 0 ? (
          /* 空状态：保持安静。编辑器占位文字已经说明了怎么写，
             结果区在有结果之前不需要占据视线 */
          <div className="px-4 py-3 text-sm text-fg-subtle">
            {t('editor.resultsPlaceholder')}
          </div>
        ) : (
          /* 语句列表 */
          <div className="space-y-2 p-3">
            {statements.map((statement, index) => {
              const executionId = latestExecutionIdByStatement[statement.id];
              // 卡片上的位置是相对这条语句的；跳转要的是整份文档里的位置
              const statementOffset = statementRanges[index]?.from;
              const execution = executions.find(
                (candidate) => candidate.id === executionId
              );
              return (
                <SqlStatementCard
                  key={statement.id}
                  ordinal={index + 1}
                  statement={statement}
                  execution={execution}
                  onExecute={() => runGuarded(
                    [statement.sql],
                    () => void executeStatement(statement.id)
                  )}
                  onCancel={() => execution && cancelExecution(execution.id)}
                  onRemove={() => removeStatement(statement.id)}
                  formatExecutionTime={formatExecutionTime}
                  statementOffset={statementOffset}
                  onJumpToError={jumpToOffset}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

// SQL语句卡片组件
interface SqlStatementCardProps {
  /** 从 1 开始的序号。此前是从 id 字符串里切出来的，既脆弱又从 0 开始 */
  ordinal: number;
  statement: SqlStatement;
  execution?: QueryExecution;
  onExecute: () => void;
  onCancel: () => void;
  onRemove: () => void;
  formatExecutionTime: (ms: number) => string;
  /** 这条语句在整份文档里的起始偏移，用来把数据库给的相对位置换成可跳转的位置 */
  statementOffset?: number;
  onJumpToError?: (offset: number) => void;
}

// 查询结果表格组件已移至单独的文件 QueryResultScrollTable.tsx

const SqlStatementCard: React.FC<SqlStatementCardProps> = ({
  ordinal,
  statement,
  execution,
  onExecute,
  onCancel,
  onRemove,
  formatExecutionTime,
  statementOffset,
  onJumpToError
}) => {
  const t = useLanguageStore((state) => state.t);

  return (
    <div className="border border-line rounded-panel overflow-hidden">
      {/* 语句头部 */}
      <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-sunken px-2.5 py-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-xs font-medium text-fg-muted">#{ordinal}</span>
          {/* 语句原文折成一行：完整内容就在上面的编辑器里，这里只是用来认
              「这份结果是哪条语句的」 */}
          <span className="min-w-0 truncate font-mono text-xs text-fg" title={statement.sql}>
            {statement.sql.replace(/\s+/g, ' ').trim()}
          </span>
          {statement.executedAt && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-fg-subtle">
              <Clock size={11} />
              {statement.executedAt}
            </span>
          )}
        </div>
        
        <div className="flex items-center space-x-2">
          {/* 执行状态指示器 */}
          {statement.isExecuting && (
            <Loader className="animate-spin text-accent" size={16} />
          )}
          {statement.result && !statement.error && (
            <CheckCircle className="text-success" size={16} />
          )}
          {statement.error && (
            <AlertCircle className="text-danger" size={16} />
          )}
          
          {/* 操作按钮 */}
          <button
            onClick={statement.isExecuting ? onCancel : onExecute}
            disabled={execution?.status === 'cancel-requested'}
            className={clsx(
              'flex items-center gap-1 rounded-control px-2 py-0.5 text-xs transition-colors',
              execution?.status === 'cancel-requested'
                ? 'cursor-wait bg-warning-soft text-warning'
                : statement.isExecuting
                  // 停止是紧急动作，保持实心；单条执行是次要动作，用描边——
                  // 主操作是头部那个「执行全部」，这里不该跟它抢视觉重量
                  ? 'bg-danger-solid text-fg-on-solid hover:opacity-90'
                  : 'border border-line-strong text-fg-muted hover:bg-surface-hover'
            )}
          >
            {statement.isExecuting ? <Square size={14} /> : <Play size={14} />}
            <span>
              {execution?.status === 'cancel-requested'
                ? t('editor.cancelling')
                : statement.isExecuting
                  ? t('editor.stop')
                  : execution?.status === 'cancelled'
                    ? t('editor.rerun')
                    : t('editor.run')}
            </span>
          </button>
          
          <button
            onClick={onRemove}
            className="p-1 text-fg-subtle hover:text-danger transition-colors"
            title={t('editor.deleteStatement')}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* 执行结果 */}
      {statement.result && (
        <>
          {statement.resultSql && statement.resultSql !== statement.sql && (
            <div className="px-3 py-2 text-xs text-warning bg-warning-soft border-t border-warning-line">
              {t('editor.staleResult')}
            </div>
          )}
          <QueryResultScrollTable
            result={statement.result}
            statementId={statement.id}
            resultSql={statement.resultSql}
            formatExecutionTime={formatExecutionTime}
          />
        </>
      )}

      {/* 错误信息 */}
      {statement.error && (
        <QueryErrorPanel
          message={statement.error}
          details={statement.errorDetails}
          sql={statement.sql}
          statementOffset={statementOffset}
          onJumpToError={onJumpToError}
        />
      )}
    </div>
  );
}; 
