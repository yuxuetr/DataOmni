import React, { useEffect, useState, useMemo, useRef } from 'react';
import { clsx } from 'clsx';
import {
  Play,
  PlayCircle,
  Trash2,
  RotateCcw,
  FileText,
  Clock,
  AlertCircle,
  CheckCircle,
  Loader
} from 'lucide-react';
import { useQueryStore, SqlStatement } from '../stores/queryStore';
import CodeMirror from '@uiw/react-codemirror';
import { sql } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import { autocompletion, CompletionContext } from '@codemirror/autocomplete';
import { QueryResultScrollTable } from './QueryResultScrollTable';
import type { EditorView } from '@codemirror/view';
import {
  findSqlStatementAtOffset,
  splitSqlStatements
} from '../utils/sqlStatements';

// SQL关键字列表
const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
  'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'TABLE', 'DATABASE',
  'INDEX', 'VIEW', 'TRIGGER', 'PROCEDURE', 'FUNCTION', 'SCHEMA',
  'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'UNION',
  'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'EXISTS',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'PRIMARY', 'KEY', 'FOREIGN', 'UNIQUE', 'CHECK', 'DEFAULT', 'AUTO_INCREMENT',
  'VARCHAR', 'CHAR', 'TEXT', 'INT', 'INTEGER', 'BIGINT', 'DECIMAL', 'FLOAT',
  'DOUBLE', 'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'BOOLEAN', 'BOOL',
  'COMMIT', 'ROLLBACK', 'TRANSACTION', 'BEGIN', 'START', 'SAVEPOINT',
  'GRANT', 'REVOKE', 'PRIVILEGES', 'USAGE'
];

// 常用表名和列名补全
const COMMON_TABLE_NAMES = ['users', 'orders', 'products', 'customers', 'categories'];
const COMMON_COLUMN_NAMES = ['id', 'name', 'email', 'created_at', 'updated_at', 'status'];

// 自定义自动补全函数
const sqlCompletions = (context: CompletionContext) => {
  const word = context.matchBefore(/\w*/);
  if (!word) return null;
  if (word.from === word.to && !context.explicit) return null;

  const suggestions = [
    ...SQL_KEYWORDS.map(keyword => ({
      label: keyword,
      type: 'keyword',
      info: `SQL 关键字: ${keyword}`
    })),
    ...COMMON_TABLE_NAMES.map(table => ({
      label: table,
      type: 'variable',
      info: `表名: ${table}`
    })),
    ...COMMON_COLUMN_NAMES.map(column => ({
      label: column,
      type: 'property',
      info: `列名: ${column}`
    }))
  ];

  return {
    from: word.from,
    options: suggestions,
    validFor: /^\w*$/
  };
};

export const SqlEditor: React.FC = () => {
  const {
    sqlInput,
    statements,
    queryTimeoutMs,
    isConnecting,
    error,
    setSqlInput,
    parseStatements,
    executeSql,
    executeStatement,
    executeAllStatements,
    setQueryTimeoutMs,
    clearResults,
    removeStatement,
    setError
  } = useQueryStore();

  const [autoParseEnabled, setAutoParseEnabled] = useState(true);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const editorViewRef = useRef<EditorView | null>(null);

  // CodeMirror扩展配置
  const extensions = useMemo(() => [
    sql(),
    autocompletion({
      override: [sqlCompletions],
      maxRenderedOptions: 20,
      closeOnBlur: true
    })
  ], []);

  // 主题配置
  const theme = isDarkMode ? oneDark : undefined;

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

  const executeCurrentStatement = async () => {
    const view = editorViewRef.current;
    const cursor = view?.state.selection.main.head ?? 0;
    const current = findSqlStatementAtOffset(sqlInput, cursor);
    if (current) {
      const parsedStatement = statements[current.index];
      if (parsedStatement?.sql === current.sql) {
        await executeStatement(parsedStatement.id);
      } else {
        await executeSql(current.sql);
      }
    }
  };

  const executeSelectedSql = async () => {
    const selection = editorViewRef.current?.state.selection.main;
    if (!selection || selection.empty) {
      return;
    }

    const selectedStatements = splitSqlStatements(
      sqlInput.slice(selection.from, selection.to)
    );
    for (const statement of selectedStatements) {
      await executeSql(statement);
    }
  };

  const handleEditorKeyDown = (event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') {
      return;
    }

    event.preventDefault();
    if (event.shiftKey) {
      void executeAllStatements();
      return;
    }

    const selection = editorViewRef.current?.state.selection.main;
    void (selection && !selection.empty
      ? executeSelectedSql()
      : executeCurrentStatement());
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
    <div className="h-full flex flex-col bg-white">
      {/* SQL编辑器头部 */}
      <div className="flex items-center justify-between p-4 border-b bg-gray-50">
        <div className="flex items-center space-x-3">
          <FileText className="text-gray-600" size={20} />
          <h2 className="text-lg font-semibold text-gray-900">SQL编辑器</h2>
          {statements.length > 0 && (
            <span className="bg-blue-100 text-blue-800 text-xs font-medium px-2 py-1 rounded-full">
              {statements.length} 条语句
            </span>
          )}
        </div>
        
        <div className="flex items-center space-x-2">
          <label className="flex items-center space-x-2 text-sm text-gray-600">
            <span>超时</span>
            <select
              value={queryTimeoutMs}
              onChange={(event) => setQueryTimeoutMs(Number(event.target.value))}
              className="px-2 py-1.5 border border-gray-300 rounded-md bg-white text-sm"
              aria-label="查询超时时间"
            >
              <option value={5000}>5 秒</option>
              <option value={15000}>15 秒</option>
              <option value={30000}>30 秒</option>
              <option value={60000}>1 分钟</option>
              <option value={120000}>2 分钟</option>
              <option value={300000}>5 分钟</option>
            </select>
          </label>

          {/* 深色模式开关 */}
          <label className="flex items-center space-x-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={isDarkMode}
              onChange={(e) => setIsDarkMode(e.target.checked)}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
            />
            <span>深色模式</span>
          </label>

          {/* 自动解析开关 */}
          <label className="flex items-center space-x-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={autoParseEnabled}
              onChange={(e) => setAutoParseEnabled(e.target.checked)}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
            />
            <span>自动解析</span>
          </label>

          {/* 手动解析按钮 */}
          {!autoParseEnabled && (
            <button
              onClick={handleManualParse}
              className="flex items-center space-x-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            >
              <RotateCcw size={14} />
              <span>解析</span>
            </button>
          )}

          {/* 清除结果 */}
          <button
            onClick={clearResults}
            disabled={statements.length === 0}
            className={clsx(
              "flex items-center space-x-1 px-3 py-1.5 text-sm border rounded-md transition-colors",
              statements.length === 0
                ? "text-gray-400 border-gray-200 cursor-not-allowed"
                : "text-gray-600 border-gray-300 hover:bg-gray-50"
            )}
          >
            <Trash2 size={14} />
            <span>清除结果</span>
          </button>

          <button
            onClick={executeSelectedSql}
            disabled={!hasSelection || isConnecting}
            className="flex items-center space-x-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:text-gray-400 disabled:border-gray-200 disabled:cursor-not-allowed"
            title="执行选中内容"
          >
            <Play size={14} />
            <span>执行选中</span>
          </button>

          <button
            onClick={executeCurrentStatement}
            disabled={statements.length === 0 || isConnecting}
            className="flex items-center space-x-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:text-gray-400 disabled:border-gray-200 disabled:cursor-not-allowed"
            title="执行光标所在语句 (Cmd/Ctrl+Enter)"
          >
            <Play size={14} />
            <span>执行当前</span>
          </button>

          {/* 执行所有语句 */}
          <button
            onClick={executeAllStatements}
            disabled={statements.length === 0 || isConnecting}
            className={clsx(
              "flex items-center space-x-2 px-4 py-1.5 text-sm rounded-md transition-colors",
              statements.length === 0 || isConnecting
                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                : "bg-blue-600 text-white hover:bg-blue-700"
            )}
          >
            <PlayCircle size={16} />
            <span>{isConnecting ? '连接中...' : '执行全部'}</span>
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="p-4 bg-red-50 border-b border-red-200">
          <div className="flex items-center space-x-2">
            <AlertCircle className="text-red-500" size={16} />
            <span className="text-red-700 text-sm flex-1">{error}</span>
            <button
              onClick={clearError}
              className="text-red-500 hover:text-red-700"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* SQL输入区域 - 使用CodeMirror */}
      <div className="p-4 border-b">
        <div className="border border-gray-300 rounded-md overflow-hidden">
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
            placeholder="在此输入SQL语句... 多个语句请用分号(;)分隔"
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
            height="200px"
            minHeight="120px"
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
          <span>
            Cmd/Ctrl+Enter 执行选中或当前语句，Cmd/Ctrl+Shift+Enter 执行全部
          </span>
          <span>
            支持语法高亮、自动补全和括号匹配
          </span>
        </div>
      </div>

      {/* SQL语句列表和结果 */}
      <div className="flex-1 overflow-y-auto">
        {statements.length === 0 ? (
          /* 空状态 */
          <div className="flex flex-col items-center justify-center h-full p-8 text-center">
            <FileText className="text-gray-300 mb-4" size={48} />
            <h3 className="text-lg font-medium text-gray-900 mb-2">开始编写SQL</h3>
            <p className="text-gray-500 max-w-sm mb-4">
              在上方输入SQL语句，支持多语句执行，每个语句用分号分隔
            </p>
            <div className="text-sm text-gray-400 space-y-1">
              <div>✨ 语法高亮支持</div>
              <div>🚀 智能自动补全</div>
              <div>🔧 实时语法检查</div>
              <div>⌨️  快捷键支持</div>
            </div>
          </div>
        ) : (
          /* 语句列表 */
          <div className="p-4 space-y-4">
            {statements.map((statement) => (
              <SqlStatementCard
                key={statement.id}
                statement={statement}
                onExecute={() => executeStatement(statement.id)}
                onRemove={() => removeStatement(statement.id)}
                formatExecutionTime={formatExecutionTime}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// SQL语句卡片组件
interface SqlStatementCardProps {
  statement: SqlStatement;
  onExecute: () => void;
  onRemove: () => void;
  formatExecutionTime: (ms: number) => string;
}

// 查询结果表格组件已移至单独的文件 QueryResultScrollTable.tsx

const SqlStatementCard: React.FC<SqlStatementCardProps> = ({
  statement,
  onExecute,
  onRemove,
  formatExecutionTime
}) => {
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      {/* 语句头部 */}
      <div className="flex items-center justify-between p-3 bg-gray-50 border-b">
        <div className="flex items-center space-x-2">
          <FileText className="text-gray-500" size={16} />
          <span className="text-sm font-medium text-gray-700">
            SQL语句 #{statement.id.split('_')[2]}
          </span>
          {statement.executedAt && (
            <div className="flex items-center space-x-1 text-xs text-gray-500">
              <Clock size={12} />
              <span>执行于 {statement.executedAt}</span>
            </div>
          )}
        </div>
        
        <div className="flex items-center space-x-2">
          {/* 执行状态指示器 */}
          {statement.isExecuting && (
            <Loader className="animate-spin text-blue-500" size={16} />
          )}
          {statement.result && !statement.error && (
            <CheckCircle className="text-green-500" size={16} />
          )}
          {statement.error && (
            <AlertCircle className="text-red-500" size={16} />
          )}
          
          {/* 操作按钮 */}
          <button
            onClick={onExecute}
            disabled={statement.isExecuting}
            className={clsx(
              "flex items-center space-x-1 px-3 py-1 text-sm rounded-md transition-colors",
              statement.isExecuting
                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                : "bg-green-600 text-white hover:bg-green-700"
            )}
          >
            <Play size={14} />
            <span>{statement.isExecuting ? '执行中' : '执行'}</span>
          </button>
          
          <button
            onClick={onRemove}
            className="p-1 text-gray-400 hover:text-red-500 transition-colors"
            title="删除语句"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* SQL代码 */}
      <div className="p-3 bg-gray-900 text-green-400 font-mono text-sm">
        <pre className="whitespace-pre-wrap">{statement.sql}</pre>
      </div>

      {/* 执行结果 */}
      {statement.result && (
        <>
          {statement.resultSql && statement.resultSql !== statement.sql && (
            <div className="px-3 py-2 text-xs text-amber-700 bg-amber-50 border-t border-amber-200">
              当前结果来自上一次执行，编辑后的 SQL 尚未执行。
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
        <div className="p-3 bg-red-50 border-t border-red-200">
          <div className="flex items-start space-x-2">
            <AlertCircle className="text-red-500 mt-0.5" size={16} />
            <div>
              <h4 className="text-sm font-medium text-red-800 mb-1">执行错误</h4>
              <p className="text-sm text-red-700">{statement.error}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}; 
