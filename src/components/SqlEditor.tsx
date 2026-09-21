import React, { useEffect, useState, useMemo, useRef } from 'react';
import { clsx } from 'clsx';
import {
  Play,
  PlayCircle,
  Trash2,
  RotateCcw,
  Clock,
  AlertCircle,
  CheckCircle,
  Loader,
  Square
} from 'lucide-react';
import { selectActiveSqlDocument, useQueryStore, SqlStatement } from '../stores/queryStore';
import type { QueryExecution } from '../contracts/queryExecution';
import CodeMirror from '@uiw/react-codemirror';
import { sql } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import { QueryResultScrollTable } from './QueryResultScrollTable';
import { EditorView } from '@codemirror/view';
import { useThemeStore } from '../stores/themeStore';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { PanelResizeHandle } from './PanelResizeHandle';
import { DestructiveStatementPrompt } from './DestructiveStatementPrompt';
import { highestRiskNeedingConfirmation, type StatementRisk } from '../utils/statementRisk';
import type { ConnectionProfile } from '../contracts';
import {
  findSqlStatementAtOffset,
  splitSqlStatements
} from '../utils/sqlStatements';
import { useLanguageStore } from '../stores/languageStore';
import { useCompletionCatalog } from '../hooks/useCompletionCatalog';
import {
  buildCompletionSchema,
  sqlDialectFor
} from '../utils/sqlCompletionSchema';

/**
 * 补全弹窗的选中项用应用自己的强调色。
 *
 * oneDark 给选中项的背景是 #2c313a，压在 #21252b 的弹窗上几乎分辨不出来。
 * 这个列表是用上下键翻的——看不见光标就不知道回车会插入哪一条。
 */
const completionSelectionTheme = EditorView.theme({
  '&.cm-editor .cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--color-accent)',
    color: 'var(--color-fg-on-accent)'
  }
});

interface SqlEditorProps {
  /** 补全要方言与库名，确认框要把「在哪个库上执行」说清楚 */
  connection: ConnectionProfile;
}

export const SqlEditor: React.FC<SqlEditorProps> = ({ connection }) => {
  const t = useLanguageStore((state) => state.t);
  const environment = connection.environment;
  const { relations, error: catalogError } = useCompletionCatalog(connection);
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
    setError
  } = useQueryStore();

  const [autoParseEnabled, setAutoParseEnabled] = useState(true);
  // 等待确认的一次执行。run 留着原本要做的事，确认后原样放行。
  const [pendingRun, setPendingRun] = useState<
    { sql: string; risk: StatementRisk; statementCount: number; run: () => void } | null
  >(null);

  /**
   * 所有执行入口都要过这道闸，漏掉一个这道闸就是装饰。
   * 不需要确认时直接执行，不额外加一次点击。
   */
  const runGuarded = (candidates: string[], run: () => void) => {
    const worst = highestRiskNeedingConfirmation(candidates, environment);
    if (!worst) {
      run();
      return;
    }

    setPendingRun({ ...worst, statementCount: candidates.length, run });
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
  const editorViewRef = useRef<EditorView | null>(null);

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
    });

    return [
      sql({
        dialect: sqlDialectFor(connection.db_type),
        schema,
        defaultSchema,
        // 关键字补成大写，和手写 SQL 的惯例一致
        upperCaseKeywords: true
      }),
      completionSelectionTheme
    ];
  }, [relations, connection.db_type, t]);

  // 编辑器跟随应用主题。此前这里有个只管 CodeMirror 的「深色模式」勾选框，
  // 勾上以后只有代码框变深、其余界面仍是浅色——它表达的不是用户想要的那件事。
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
    const current = findSqlStatementAtOffset(sqlInput, cursor);
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

  const executeSelectedSql = () => {
    const selection = editorViewRef.current?.state.selection.main;
    if (!selection || selection.empty) {
      return;
    }

    const selectedStatements = splitSqlStatements(
      sqlInput.slice(selection.from, selection.to)
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

  const handleEditorKeyDown = (event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') {
      return;
    }

    event.preventDefault();
    if (event.shiftKey) {
      runAllGuarded();
      return;
    }

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
          statementCount={pendingRun.statementCount}
          connectionName={connection.name}
          environment={environment}
          onCancel={() => setPendingRun(null)}
          onConfirm={() => {
            const run = pendingRun.run;
            setPendingRun(null);
            run();
          }}
        />
      )}
      {/* SQL编辑器头部 */}
      <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-sunken px-3 py-1.5">
        <div className="flex shrink-0 items-center gap-2">
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
        
        <div className="flex items-center space-x-2">
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

          <button
            onClick={executeCurrentStatement}
            disabled={statements.length === 0 || isConnecting}
            className="flex items-center space-x-1 px-3 py-1.5 text-sm text-fg-muted border border-line-strong rounded-control hover:bg-surface-hover transition-colors disabled:text-fg-subtle disabled:border-line disabled:cursor-not-allowed"
            title={t('editor.runCurrentTitle')}
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
            title={t('editor.runAllTitle')}
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

      {/* SQL输入区域 - 使用CodeMirror */}
      <div className="shrink-0 px-3 pb-2 pt-3">
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

      <PanelResizeHandle
        axis="y"
        active={editorPanel.isResizing}
        onPointerDown={editorPanel.startResize}
        onDoubleClick={editorPanel.resetSize}
        label={t('editor.resizeHeight')}
      />

      {/* SQL语句列表和结果 */}
      <div className="flex-1 overflow-y-auto">
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
}

// 查询结果表格组件已移至单独的文件 QueryResultScrollTable.tsx

const SqlStatementCard: React.FC<SqlStatementCardProps> = ({
  ordinal,
  statement,
  execution,
  onExecute,
  onCancel,
  onRemove,
  formatExecutionTime
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
            formatExecutionTime={formatExecutionTime}
          />
        </>
      )}

      {/* 错误信息 */}
      {statement.error && (
        <div className="p-3 bg-danger-soft border-t border-danger-line">
          <div className="flex items-start space-x-2">
            <AlertCircle className="text-danger mt-0.5" size={16} />
            <div>
              <h4 className="text-sm font-medium text-danger mb-1">{t('editor.executionError')}</h4>
              <p className="text-sm text-danger">{statement.error}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}; 
