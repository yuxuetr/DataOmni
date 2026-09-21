import { create } from 'zustand';
import Database from '@tauri-apps/plugin-sql';
import { Channel, invoke } from '@tauri-apps/api/core';
import {
  completeQueryExecution,
  cancelQueryExecution,
  createQueryExecution,
  failQueryExecution,
  requestQueryExecutionCancellation,
  startQueryExecution,
  type QueryExecution,
  type SqlDialect
} from '../contracts/queryExecution';
import { describeError } from '../utils/describeError';
import {
  QUERY_CANCELLED_CODE,
  QUERY_TIMEOUT_CODE,
  toQueryExecutionError
} from '../utils/queryError';
import { DatabaseSession } from '../contracts/session';
import type {
  DriverQueryResult,
  DriverQueryBatch,
  QueryResult,
  SqlStatement
} from '../contracts/query';
import type { SerializedResultValue } from '../contracts/resultSet';
import { assertSingleRowAffected } from '../utils/executeResult';
import {
  clearSqlStatementResult,
  completeSqlStatement,
  failSqlStatement,
  reconcileSqlStatements
} from '../utils/queryStatements';
import { quoteSqlIdentifier } from '../utils/sqlIdentifiers';
import { executeSequentially } from '../utils/queryExecutionPolicy';
import { translateNow } from './languageStore';
import { changesSchema } from '../utils/schemaChanges';
import { useAppStore } from './appStore';
import { useConnectionStore } from './connectionStore';
import { useHistoryStore } from './historyStore';

export type { QueryResult, SqlStatement } from '../contracts/query';

const QUERY_RESULT_BACKEND_BYTE_LIMIT = 12 * 1024 * 1024;
const QUERY_RESULT_FRONTEND_BYTE_LIMIT = 16 * 1024 * 1024;

/** 一个 SQL 标签的编辑文档：草稿、解析出的语句及其结果 */
export interface SqlDocument {
  sqlInput: string;
  statements: SqlStatement[];
  latestExecutionIdByStatement: Record<string, string>;
}

/** 未知文档统一返回这一个常量，保证选择器的引用相等、不触发重渲染 */
const EMPTY_SQL_DOCUMENT: SqlDocument = Object.freeze({
  sqlInput: '',
  statements: [],
  latestExecutionIdByStatement: {}
});

function createSqlDocument(): SqlDocument {
  return { sqlInput: '', statements: [], latestExecutionIdByStatement: {} };
}

// 查询状态
export interface QueryState {
  connectionString: string | null;
  connectionId: string | null; // 保存的连接配置 ID，用于草稿和元数据
  session: DatabaseSession | null;
  database: Database | null;
  /** 每个 SQL 标签一份独立文档，键为工作区标签 id */
  documents: Record<string, SqlDocument>;
  activeDocumentId: string | null;
  /** 执行记录保持扁平，靠 QueryExecution.tabId 归属到文档 */
  executions: QueryExecution[];
  queryTimeoutMs: number;
  queryResultRowLimit: number;
  isConnecting: boolean;
  error: string | null;
}

// Store Actions
interface QueryActions {
  // 数据库连接
  connectToDatabase: (
    connectionString: string,
    connectionId: string,
    session: DatabaseSession
  ) => Promise<void>;
  disconnect: () => Promise<void>;
  
  // SQL 文档（每个 SQL 标签一份）
  restoreDocuments: (drafts: Record<string, string>) => void;
  openDocument: (documentId: string) => void;
  setActiveDocument: (documentId: string | null) => void;
  closeDocument: (documentId: string) => void;

  // SQL 编辑
  setSqlInput: (sql: string) => void;
  parseStatements: () => void;
  
  // SQL 执行
  executeSql: (sql: string) => Promise<boolean>;
  executeStatement: (statementId: string) => Promise<boolean>;
  executeAllStatements: () => Promise<void>;
  cancelExecution: (executionId: string) => Promise<void>;
  setQueryTimeoutMs: (timeoutMs: number) => void;
  setQueryResultRowLimit: (rowLimit: number) => void;
  
  // 结果管理
  clearResults: () => void;
  removeStatement: (statementId: string) => void;
  
  // 错误处理
  setError: (error: string | null) => void;

  // 数据操作
  updateRowData: (statementId: string, rowIndex: number, columnName: string, newValue: any) => Promise<void>;
  deleteRowData: (statementId: string, rowIndex: number) => Promise<void>;
  insertRowData: (statementId: string, newRowData: Record<string, any>) => Promise<void>;
}

// 完整的Store类型
type QueryStore = QueryState & QueryActions;

// 只有能明确映射到单表完整行的查询结果才允许编辑
const extractEditableTableName = (sql: string): string | undefined => {
  const normalizedSql = sql.trim().replace(/;$/, '').trim();
  const unsupportedClauses = /\b(join|union|intersect|except|group\s+by|having)\b/i;

  if (unsupportedClauses.test(normalizedSql)) {
    return undefined;
  }

  const match = normalizedSql.match(
    /^select\s+\*\s+from\s+([`"]?)([a-zA-Z_][a-zA-Z0-9_$]*)\1(?=\s|$)([\s\S]*)$/i
  );
  if (!match) {
    return undefined;
  }

  const remainder = match[3].trim();
  if (
    remainder &&
    !/^(where\b|order\s+by\b|limit\b|offset\b)/i.test(remainder)
  ) {
    return undefined;
  }

  return match[2];
};

// 检测表的主键
const detectPrimaryKey = async (database: Database, tableName: string | undefined, columns: string[], connectionString: string | null): Promise<string | undefined> => {
  if (!tableName) return undefined;
  
  try {
    // 常见的主键列名
    const commonPrimaryKeys = ['id', 'ID', 'Id', `${tableName}_id`, `${tableName.toLowerCase()}_id`];
    
    // 检查是否有常见的主键列名
    for (const pkName of commonPrimaryKeys) {
      if (columns.includes(pkName)) {
        console.log('🔑 检测到可能的主键:', pkName);
        return pkName;
      }
    }
    
    // 根据连接字符串类型尝试查询数据库schema获取主键信息
    if (connectionString?.startsWith('postgres://')) {
      try {
        // PostgreSQL
        const pgPkQuery = `
          SELECT column_name 
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu 
            ON tc.constraint_name = kcu.constraint_name
          WHERE tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
          LIMIT 1
        `;
        const pgResult = await database.select(pgPkQuery, [tableName]);
        if (Array.isArray(pgResult) && pgResult.length > 0) {
          const pkColumn = pgResult[0].column_name;
          console.log('🔑 从PostgreSQL schema检测到主键:', pkColumn);
          return pkColumn;
        }
      } catch (error) {
        console.warn('⚠️ PostgreSQL主键查询失败:', error);
      }
    } else if (connectionString?.startsWith('sqlite:')) {
      try {
        // SQLite
        const sqlitePkQuery = `PRAGMA table_info(${tableName})`;
        const sqliteResult = await database.select(sqlitePkQuery);
        if (Array.isArray(sqliteResult)) {
          const pkColumn = sqliteResult.find((col: any) => col.pk === 1);
          if (pkColumn) {
            console.log('🔑 从SQLite schema检测到主键:', pkColumn.name);
            return pkColumn.name;
          }
        }
      } catch (error) {
        console.warn('⚠️ SQLite主键查询失败:', error);
      }
    } else if (connectionString?.startsWith('mysql://')) {
      try {
        // MySQL
        const mysqlPkQuery = `
          SELECT COLUMN_NAME 
          FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_NAME = ? AND COLUMN_KEY = 'PRI'
          LIMIT 1
        `;
        const mysqlResult = await database.select(mysqlPkQuery, [tableName]);
        if (Array.isArray(mysqlResult) && mysqlResult.length > 0) {
          const pkColumn = mysqlResult[0].COLUMN_NAME;
          console.log('🔑 从MySQL schema检测到主键:', pkColumn);
          return pkColumn;
        }
      } catch (error) {
        console.warn('⚠️ MySQL主键查询失败:', error);
      }
    }
    
    console.warn('⚠️ 无法检测到主键，数据编辑功能将不可用');
    return undefined;
  } catch (error) {
    console.warn('⚠️ 主键检测失败:', error);
    return undefined;
  }
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

const getSqlDialect = (connectionString: string | null): SqlDialect => {
  if (connectionString?.startsWith('mysql://')) {
    return 'mysql';
  }
  if (connectionString?.startsWith('postgres://')) {
    return 'postgresql';
  }
  return 'sqlite';
};

// 创建Zustand Store
/** 读取文档；未知 id 返回空文档常量 */
function readSqlDocument(
  state: Pick<QueryState, 'documents'>,
  documentId: string | null
): SqlDocument {
  if (!documentId) {
    return EMPTY_SQL_DOCUMENT;
  }

  return state.documents[documentId] ?? EMPTY_SQL_DOCUMENT;
}

/**
 * 把更新写回指定文档。
 *
 * 异步操作在开始时捕获 documentId 再调用这里，所以执行期间用户切到别的
 * 标签时，结果仍然回到发起它的那份文档，而不是落到当前可见的文档上。
 * 文档已被关闭时整个更新丢弃。
 */
function writeSqlDocument(
  state: Pick<QueryState, 'documents'>,
  documentId: string,
  update: (document: SqlDocument) => Partial<SqlDocument>
): Pick<QueryState, 'documents'> {
  const current = state.documents[documentId];
  if (!current) {
    return { documents: state.documents };
  }

  return {
    documents: {
      ...state.documents,
      [documentId]: { ...current, ...update(current) }
    }
  };
}

/** 供组件订阅当前活动文档 */
/**
 * 把一次已结束的执行记进历史。
 *
 * 连接名在这里现取并**存成快照**：连接之后会被改名、会被删掉，而历史要说得出
 * 当时连的是哪个。取不到名字时退回 profileId，总比空着强。
 */
function recordHistory(execution: QueryExecution, rowsAffected: number | null): void {
  const profileId = execution.session.profileId;
  const connection = useConnectionStore
    .getState()
    .connections.find((candidate) => candidate.id === profileId);
  useHistoryStore
    .getState()
    .record(execution, { connectionName: connection?.name ?? profileId, rowsAffected });
}

export const selectActiveSqlDocument = (state: QueryState): SqlDocument =>
  readSqlDocument(state, state.activeDocumentId);

/**
 * 关闭这个 SQL 标签是否会丢掉用户写的内容。
 *
 * 判据取草稿文本而不是执行结果：结果是可以重新跑出来的，用户手写的
 * SQL 关掉就没了（当前还没有任何持久化去处）。
 */
/**
 * 走本项目自建执行器的只读查询。
 *
 * 为什么不用 `database.select()`：tauri-plugin-sql 的解码器类型表是硬编码的，
 * 遇到 MySQL 的 BINARY / DECIMAL 或 PostgreSQL 的 NUMERIC 就直接报
 * 「unsupported datatype」，而表数据是 `SELECT *`，列由用户的表决定，没法靠
 * CAST 绕开。自建执行器覆盖完整且用 tagged value 保住 BigInt / Decimal 精度。
 *
 * 不接受绑定参数：`execute_query` 命令本身还没有参数支持，调用方需自行用
 * `quoteSqlIdentifier` 等方式构造安全的 SQL。
 */
export async function runReadQuery(
  sql: string
): Promise<Record<string, SerializedResultValue>[]> {
  const { connectionId, session, queryTimeoutMs, queryResultRowLimit } = useQueryStore.getState();
  if (!connectionId || !session) {
    throw new Error(translateNow('error.sessionUnavailable'));
  }

  const rows: Record<string, SerializedResultValue>[] = [];
  let expectedBatchCount = 0;
  let batchError: Error | null = null;
  let receivedBytes = 0;
  let resolveBatches: (() => void) | null = null;
  const batchesComplete = new Promise<void>((resolve) => {
    resolveBatches = resolve;
  });

  const onBatch = new Channel<DriverQueryBatch>((batch) => {
    if (batchError) {
      return;
    }
    if (batch.offset !== rows.length) {
      batchError = new Error(
          translateNow('error.batchOutOfOrder', { expected: rows.length, actual: batch.offset })
        );
      resolveBatches?.();
      return;
    }
    receivedBytes += new TextEncoder().encode(JSON.stringify(batch.rows)).byteLength;
    if (receivedBytes > QUERY_RESULT_FRONTEND_BYTE_LIMIT) {
      batchError = new Error(translateNow('error.memoryBudget'));
      resolveBatches?.();
      return;
    }
    rows.push(...batch.rows);
    if (expectedBatchCount > 0 && batch.index + 1 === expectedBatchCount) {
      resolveBatches?.();
    }
  });

  const driverResult = await invoke<DriverQueryResult>('execute_query', {
    onBatch,
    request: {
      connectionId,
      sessionId: session.id,
      executionId: crypto.randomUUID(),
      sql,
      timeoutMs: queryTimeoutMs,
      rowLimit: queryResultRowLimit,
      byteLimit: QUERY_RESULT_BACKEND_BYTE_LIMIT
    }
  });

  if (driverResult.kind !== 'rows') {
    return [];
  }

  expectedBatchCount = driverResult.batch_count;
  if (rows.length < driverResult.row_count && !batchError) {
    await batchesComplete;
  }
  if (batchError) {
    throw batchError;
  }

  return rows;
}

export const selectSqlDocumentHasUnsavedContent = (
  state: Pick<QueryState, 'documents'>,
  documentId: string
): boolean => readSqlDocument(state, documentId).sqlInput.trim().length > 0;

export const useQueryStore = create<QueryStore>((set, get) => ({
  // 初始状态
  connectionString: null,
  connectionId: null,
  session: null,
  database: null,
  documents: {},
  activeDocumentId: null,
  executions: [],
  queryTimeoutMs: 30_000,
  queryResultRowLimit: 1_000,
  isConnecting: false,
  error: null,

  // Actions
  connectToDatabase: async (
    connectionString: string,
    connectionId: string,
    session: DatabaseSession
  ) => {
    const currentState = get();
    
    // 如果连接ID相同，且已经有正常的连接，则直接返回
    if (currentState.connectionId === connectionId && currentState.database && !currentState.error) {
      console.log('✅ 使用现有数据库连接:', connectionId);
      return;
    }
    
    // 在连接新数据库前，保存当前的SQL历史
    // 关闭旧连接
    if (currentState.database) {
      try {
        if (currentState.session) {
          await invoke('release_database_session', {
            sessionId: currentState.session.id
          });
        }
        await currentState.database.close();
        console.log('🔌 旧数据库连接已关闭');
      } catch (error) {
        console.warn('⚠️ 关闭旧连接失败:', error);
      }
    }

    // 文档归属于工作区标签而不是连接，标签还在就不该被清空：
    // 切换连接时属于其它连接的 SQL 标签要保留各自的草稿。
    set({
      isConnecting: true,
      error: null,
      database: null // 清空旧连接
    });
    
    try {
      // 隐藏密码的连接字符串用于日志
      const safeConnectionString = connectionString.replace(/:([^:@]+)@/, ':***@');
      console.log('🔗 连接到数据库:', safeConnectionString);
      
      // 检查Tauri SQL插件端口限制
      const portMatch = connectionString.match(/:(\d+)\//);
      if (portMatch) {
        const port = parseInt(portMatch[1]);
        if (port > 32767) {
          throw new Error(translateNow('error.portTooLargeShort', { port }));
        }
      }
      
      const db = await Database.load(connectionString);
      
      set({ 
        database: db, 
        connectionString,
        connectionId,
        session,
        isConnecting: false,
        error: null 
      });
      
      console.log('✅ 数据库连接成功:', connectionId);
    } catch (error) {
      console.error('❌ 数据库连接失败:', error);
      
      // 处理端口错误的特殊情况
      let errorMessage = describeError(error, translateNow('error.connectFailed'));
      if (errorMessage.includes('invalid port number')) {
        // 尝试从连接字符串中提取端口号
        const portMatch = connectionString.match(/:(\d+)\//);
        const port = portMatch ? parseInt(portMatch[1]) : 0;
        if (port > 32767) {
          errorMessage = translateNow('error.portTooLargeShort', { port });
        } else {
          errorMessage = translateNow('error.portOutOfRange', { port: port || '?' });
        }
      }
      
      set({ 
        error: errorMessage,
        isConnecting: false,
        database: null,
        connectionString: null,
        connectionId: null,
        session: null
      });
      throw new Error(errorMessage);
    }
  },

  disconnect: async () => {
    // 在断开连接前保存SQL历史
    const currentState = get();
    if (currentState.database) {
      try {
        if (currentState.session) {
          await invoke('release_database_session', {
            sessionId: currentState.session.id
          });
        }
        await currentState.database.close();
      } catch (error) {
        const errorMessage = describeError(error, translateNow('error.closeConnectionFailed'));
        set({ error: errorMessage });
        throw new Error(errorMessage);
      }
    }

    set({
      database: null,
      connectionString: null,
      connectionId: null,
      session: null,
      error: null
    });
    console.log('🔌 已断开数据库连接');
  },

  restoreDocuments: (drafts: Record<string, string>) => {
    set({
      documents: Object.fromEntries(
        Object.entries(drafts).map(([documentId, sqlInput]) => [
          documentId,
          // 结果不持久化，恢复出来的文档只有草稿；语句由 parseStatements 重新解析
          { sqlInput, statements: [], latestExecutionIdByStatement: {} }
        ])
      )
    });
  },

  openDocument: (documentId: string) => {
    set((state) => (
      state.documents[documentId]
        ? { activeDocumentId: documentId }
        : {
            documents: { ...state.documents, [documentId]: createSqlDocument() },
            activeDocumentId: documentId
          }
    ));
  },

  setActiveDocument: (documentId: string | null) => {
    set({ activeDocumentId: documentId });
  },

  closeDocument: (documentId: string) => {
    set((state) => {
      if (!state.documents[documentId]) {
        return state;
      }

      const documents = { ...state.documents };
      delete documents[documentId];

      return {
        documents,
        activeDocumentId: state.activeDocumentId === documentId
          ? Object.keys(documents)[0] ?? null
          : state.activeDocumentId,
        // 文档没了，它的执行记录不再有归属，一并丢弃
        executions: state.executions.filter(
          (execution) => execution.tabId !== documentId
        )
      };
    });
  },

  setSqlInput: (sql: string) => {
    const documentId = get().activeDocumentId;
    if (!documentId) {
      return;
    }

    set((state) => writeSqlDocument(state, documentId, () => ({ sqlInput: sql })));
  },

  setQueryTimeoutMs: (queryTimeoutMs: number) => {
    set({ queryTimeoutMs });
  },

  setQueryResultRowLimit: (queryResultRowLimit: number) => {
    set({ queryResultRowLimit });
  },

  parseStatements: () => {
    const documentId = get().activeDocumentId;
    if (!documentId) {
      return;
    }

    const { sqlInput, statements } = readSqlDocument(get(), documentId);
    if (!sqlInput.trim()) {
      set((state) => writeSqlDocument(state, documentId, () => ({
        statements: statements.some((statement) => statement.result)
          ? statements
              .filter((statement) => statement.result)
              .map((statement) => ({ ...statement, sql: '', error: undefined }))
          : []
      })));
      return;
    }

    set((state) => writeSqlDocument(state, documentId, () => ({
      statements: reconcileSqlStatements(sqlInput, statements)
    })));
  },

  executeSql: async (sql: string) => {
    const normalizedSql = sql.trim();
    if (!normalizedSql) {
      return false;
    }

    const documentId = get().activeDocumentId;
    if (!documentId) {
      set({ error: translateNow('error.noActiveSqlTab') });
      return false;
    }

    const existing = readSqlDocument(get(), documentId)
      .statements.find((statement) => statement.sql === normalizedSql);
    if (existing) {
      return get().executeStatement(existing.id);
    }

    const statement: SqlStatement = {
      id: `statement_${Date.now()}_${crypto.randomUUID()}`,
      sql: normalizedSql,
      isExecuting: false
    };
    set((state) => writeSqlDocument(state, documentId, (document) => ({
      statements: [...document.statements, statement]
    })));
    return get().executeStatement(statement.id);
  },

  executeStatement: async (statementId: string) => {
    const {
      connectionId,
      database,
      session,
      queryTimeoutMs,
      queryResultRowLimit
    } = get();
    if (!database || !session || !connectionId) {
      set({ error: translateNow('error.notConnected') });
      return false;
    }

    // 在开始时锁定文档，之后所有写回都指向它：执行期间用户切到别的
    // SQL 标签时，结果仍然落在发起这次执行的标签里。
    const documentId = get().activeDocumentId;
    if (!documentId) {
      set({ error: translateNow('error.noActiveSqlTab') });
      return false;
    }

    const statement = readSqlDocument(get(), documentId)
      .statements.find(s => s.id === statementId);
    if (!statement) return false;
    const dialect = getSqlDialect(get().connectionString);
    const execution = startQueryExecution(
      createQueryExecution(documentId, statement.sql, session, dialect)
    );

    // 更新执行状态
    set((state) => ({
      ...writeSqlDocument(state, documentId, (document) => ({
        statements: document.statements.map(s =>
          s.id === statementId
            ? { ...s, isExecuting: true, error: undefined }
            : s
        ),
        latestExecutionIdByStatement: {
          ...document.latestExecutionIdByStatement,
          [statementId]: execution.id
        }
      })),
      executions: [...state.executions.slice(-99), execution]
    }));

    try {
      const startTime = Date.now();
      console.log('🔍 执行SQL:', statement.sql);
      const { connectionString } = get();
      const safeConnectionString = connectionString?.replace(/:([^:@]+)@/, ':***@') || 'unknown';
      console.log('🔗 当前连接字符串:', safeConnectionString);
      
      // 由数据库驱动返回的列元数据判断语句是否产生结果集
      let queryResult: QueryResult;
      const sql = statement.sql.trim();
      const streamedRows: Record<string, SerializedResultValue>[] = [];
      let expectedBatchCount = 0;
      let batchError: Error | null = null;
      let receivedBytes = 0;
      let resolveBatches: (() => void) | null = null;
      const batchesComplete = new Promise<void>((resolve) => {
        resolveBatches = resolve;
      });
      const onBatch = new Channel<DriverQueryBatch>((batch) => {
        if (batchError) {
          return;
        }
        if (batch.offset !== streamedRows.length) {
          batchError = new Error(
            translateNow('error.batchOutOfOrder', { expected: streamedRows.length, actual: batch.offset })
          );
          resolveBatches?.();
          return;
        }
        receivedBytes += new TextEncoder().encode(JSON.stringify(batch.rows)).byteLength;
        if (receivedBytes > QUERY_RESULT_FRONTEND_BYTE_LIMIT) {
          batchError = new Error(translateNow('error.memoryBudget'));
          resolveBatches?.();
          return;
        }
        streamedRows.push(...batch.rows);
        if (expectedBatchCount > 0 && batch.index + 1 === expectedBatchCount) {
          resolveBatches?.();
        }
      });
      const driverResult = await invoke<DriverQueryResult>('execute_query', {
        onBatch,
        request: {
          connectionId,
          sessionId: session.id,
          executionId: execution.id,
          sql: statement.sql,
          timeoutMs: queryTimeoutMs,
          rowLimit: queryResultRowLimit,
          byteLimit: QUERY_RESULT_BACKEND_BYTE_LIMIT
        }
      });
      const executionTime = Date.now() - startTime;

      if (driverResult.kind === 'rows') {
        expectedBatchCount = driverResult.batch_count;
        if (streamedRows.length < driverResult.row_count && !batchError) {
          await batchesComplete;
        }
        if (batchError) {
          throw batchError;
        }
        if (streamedRows.length !== driverResult.row_count) {
          throw new Error(
            translateNow('error.batchIncomplete', {
            expected: driverResult.row_count,
            actual: streamedRows.length
          })
          );
        }
        const rows = streamedRows.map((row) =>
          driverResult.columns.map((column) => row[column])
        );
        const tableName = extractEditableTableName(sql);
        const primaryKey = await detectPrimaryKey(
          database,
          tableName,
          driverResult.columns,
          connectionString
        );

        queryResult = {
          columns: driverResult.columns,
          column_metadata: driverResult.column_metadata,
          rows,
          affected_rows: rows.length,
          execution_time: executionTime,
          truncated: driverResult.truncated,
          truncation_reason: driverResult.truncation_reason,
          row_limit: driverResult.row_limit,
          byte_limit: driverResult.byte_limit,
          bytes_read: driverResult.bytes_read,
          table_name: tableName,
          primary_key: primaryKey,
        };
      } else {
        queryResult = {
          columns: [],
          rows: [],
          affected_rows: driverResult.rows_affected,
          execution_time: executionTime,
        };
      }

      // 从 state 里取这次执行的**最新**状态再收尾：期间用户可能按过取消，
      // 那条 requestedAt 记在 state 里而不在最初的 execution 上
      const pending = get().executions.find((candidate) => candidate.id === execution.id) ?? execution;
      const finished = completeQueryExecution(
        pending,
        driverResult.kind === 'rows' ? [`result:${execution.id}`] : []
      );

      // 更新结果
      set((state) => ({
        ...writeSqlDocument(state, documentId, (document) => ({
          statements: document.statements.map(s =>
            s.id === statementId
              ? completeSqlStatement(
                  s,
                  queryResult,
                  new Date().toLocaleTimeString(),
                  statement.sql
                )
              : s
          )
        })),
        executions: state.executions.map((candidate) =>
          candidate.id === execution.id ? finished : candidate
        )
      }));
      recordHistory(finished, queryResult.affected_rows);

      console.log(`✅ SQL执行成功，耗时: ${formatExecutionTime(queryResult.execution_time)}`);

      // 改过结构就通知对象树与 ER 图重新拉取。只在**成功之后**加一次：
      // 一条失败的 CREATE TABLE 什么也没改，刷新只是白跑一趟往返。
      if (changesSchema(statement.sql)) {
        useAppStore.getState().markSchemaChanged();
      }

      return true;
    } catch (error) {
      console.error('❌ SQL执行失败:', error);
      const queryError = toQueryExecutionError(error);
      // 按 code 判断而不是按消息前缀：消息要跟着语言变，按前缀匹配等于把
      // 「这是超时」的判断绑在某一种语言上
      const timedOut = queryError.code === QUERY_TIMEOUT_CODE;
      const cancelled = queryError.code === QUERY_CANCELLED_CODE;
      const errorMessage = cancelled
        ? translateNow('error.queryCancelled')
        : timedOut
          ? translateNow('error.queryTimedOut', { duration: formatExecutionTime(queryTimeoutMs) })
          : queryError.message;
      // 超时与取消是我们自己造的错，数据库没说过话，不该带上任何结构
      const errorDetails = timedOut || cancelled ? undefined : queryError;
      
      const pending = get().executions.find((candidate) => candidate.id === execution.id) ?? execution;
      const finished = cancelled
        ? cancelQueryExecution(
            pending.status === 'cancel-requested'
              ? pending
              : requestQueryExecutionCancellation(pending)
          )
        : failQueryExecution(
            pending,
            { ...queryError, message: errorMessage },
            undefined,
            timedOut ? 'timed-out' : 'failed'
          );

      // 更新错误状态
      set((state) => ({
        ...writeSqlDocument(state, documentId, (document) => ({
          statements: document.statements.map(s =>
            s.id === statementId
              ? cancelled
                ? { ...s, isExecuting: false, error: undefined, errorDetails: undefined }
                : failSqlStatement(s, errorMessage, errorDetails)
              : s
          )
        })),
        executions: state.executions.map((candidate) =>
          candidate.id === execution.id ? finished : candidate
        )
      }));
      // 失败、取消、超时一样要记：「那条跑崩的语句到底是什么」正是事后最想
      // 翻出来的一条，只记成功等于历史里永远没有出问题的那次
      recordHistory(finished, null);
      return false;
    }
  },

  cancelExecution: async (executionId: string) => {
    set((state) => ({
      executions: state.executions.map((execution) =>
        execution.id === executionId && execution.status === 'running'
          ? requestQueryExecutionCancellation(execution)
          : execution
      )
    }));

    try {
      const accepted = await invoke<boolean>('cancel_query', { executionId });
      if (!accepted) {
        set((state) => ({
          executions: state.executions.map((execution) =>
            execution.id === executionId && execution.status === 'cancel-requested'
              ? {
                  ...execution,
                  status: 'running',
                  cancellation: {
                    requestedAt: null,
                    acknowledgedAt: null
                  }
                }
              : execution
          )
        }));
      }
    } catch (error) {
      set((state) => ({
        error: describeError(error),
        executions: state.executions.map((execution) =>
          execution.id === executionId && execution.status === 'cancel-requested'
            ? {
                ...execution,
                status: 'running',
                cancellation: {
                  requestedAt: null,
                  acknowledgedAt: null
                }
              }
            : execution
        )
      }));
    }
  },

  executeAllStatements: async () => {
    const { statements } = selectActiveSqlDocument(get());
    const { executeStatement } = get();

    await executeSequentially(
      statements.filter((statement) => !statement.isExecuting),
      (statement) => executeStatement(statement.id)
    );
  },

  clearResults: () => {
    const documentId = get().activeDocumentId;
    if (!documentId) {
      return;
    }

    set((state) => writeSqlDocument(state, documentId, (document) => ({
      statements: document.statements.map(clearSqlStatementResult)
    })));
  },

  removeStatement: (statementId: string) => {
    const documentId = get().activeDocumentId;
    if (!documentId) {
      return;
    }

    set((state) => writeSqlDocument(state, documentId, (document) => ({
      statements: document.statements.filter(s => s.id !== statementId)
    })));
  },

  setError: (error: string | null) => {
    set({ error });
  },

  // 数据操作方法
  updateRowData: async (statementId: string, rowIndex: number, columnName: string, newValue: any) => {
    const documentId = get().activeDocumentId;
    if (!documentId) {
      throw new Error(translateNow('error.noActiveSqlTab'));
    }
    const { database, connectionString } = get();
    const { statements } = readSqlDocument(get(), documentId);
    if (!database) {
      set({ error: translateNow('error.notConnected') });
      return;
    }

    const statement = statements.find(s => s.id === statementId);
    if (!statement?.result) return;

    const result = statement.result;
    if (!result.table_name || !result.primary_key) {
      set({ error: translateNow('error.cannotUpdateNoKey') });
      return;
    }

    try {
      // 获取主键值
      const primaryKeyIndex = result.columns.indexOf(result.primary_key);
      if (primaryKeyIndex === -1) {
        throw new Error(translateNow('error.noPrimaryKeyColumn'));
      }
      const primaryKeyValue = result.rows[rowIndex][primaryKeyIndex];

      // 根据数据库类型构建正确的UPDATE语句
      let updateSql: string;
      let params: any[];
      const dialect = getSqlDialect(connectionString);
      const quotedTable = quoteSqlIdentifier(result.table_name, dialect);
      const quotedColumn = quoteSqlIdentifier(columnName, dialect);
      const quotedPrimaryKey = quoteSqlIdentifier(result.primary_key, dialect);
      
      if (connectionString?.startsWith('postgres://')) {
        // PostgreSQL 使用 $1, $2 占位符
        updateSql = `UPDATE ${quotedTable} SET ${quotedColumn} = $1 WHERE ${quotedPrimaryKey} = $2`;
        params = [newValue, primaryKeyValue];
      } else {
        // MySQL 和 SQLite 使用 ? 占位符
        updateSql = `UPDATE ${quotedTable} SET ${quotedColumn} = ? WHERE ${quotedPrimaryKey} = ?`;
        params = [newValue, primaryKeyValue];
      }
      
      console.log('🔄 执行更新操作:', updateSql, params);
      
      // 执行更新
      const updateResult = await database.execute(updateSql, params);
      assertSingleRowAffected(updateResult, translateNow('table.operation.update'));

      // 更新本地数据
      const columnIndex = result.columns.indexOf(columnName);
      if (columnIndex !== -1) {
        const updatedRows = [...result.rows];
        updatedRows[rowIndex] = [...updatedRows[rowIndex]];
        updatedRows[rowIndex][columnIndex] = newValue;

        set((state) => writeSqlDocument(state, documentId, () => ({
          statements: statements.map(s =>
            s.id === statementId
              ? {
                  ...s,
                  result: {
                    ...result,
                    rows: updatedRows
                  }
                }
              : s
          )
        })));
      }

      console.log('✅ 数据更新成功');
    } catch (error) {
      console.error('❌ 数据更新失败:', error);
      const errorMessage = describeError(error, translateNow('error.updateFailed'));
      set({ error: errorMessage });
    }
  },

  deleteRowData: async (statementId: string, rowIndex: number) => {
    const documentId = get().activeDocumentId;
    if (!documentId) {
      throw new Error(translateNow('error.noActiveSqlTab'));
    }
    const { database, connectionString } = get();
    const { statements } = readSqlDocument(get(), documentId);
    if (!database) {
      set({ error: translateNow('error.notConnected') });
      return;
    }

    const statement = statements.find(s => s.id === statementId);
    if (!statement?.result) return;

    const result = statement.result;
    if (!result.table_name || !result.primary_key) {
      set({ error: translateNow('error.cannotDeleteNoKey') });
      return;
    }

    try {
      // 获取主键值
      const primaryKeyIndex = result.columns.indexOf(result.primary_key);
      if (primaryKeyIndex === -1) {
        throw new Error(translateNow('error.noPrimaryKeyColumn'));
      }
      const primaryKeyValue = result.rows[rowIndex][primaryKeyIndex];

      // 根据数据库类型构建正确的DELETE语句
      let deleteSql: string;
      let params: any[];
      const dialect = getSqlDialect(connectionString);
      const quotedTable = quoteSqlIdentifier(result.table_name, dialect);
      const quotedPrimaryKey = quoteSqlIdentifier(result.primary_key, dialect);
      
      if (connectionString?.startsWith('postgres://')) {
        // PostgreSQL 使用 $1 占位符
        deleteSql = `DELETE FROM ${quotedTable} WHERE ${quotedPrimaryKey} = $1`;
        params = [primaryKeyValue];
      } else {
        // MySQL 和 SQLite 使用 ? 占位符
        deleteSql = `DELETE FROM ${quotedTable} WHERE ${quotedPrimaryKey} = ?`;
        params = [primaryKeyValue];
      }
      
      console.log('🗑️ 执行删除操作:', deleteSql, params);
      
      // 执行删除
      const deleteResult = await database.execute(deleteSql, params);
      assertSingleRowAffected(deleteResult, translateNow('table.operation.delete'));

      // 更新本地数据
      const updatedRows = result.rows.filter((_, index) => index !== rowIndex);

      set((state) => writeSqlDocument(state, documentId, () => ({
        statements: statements.map(s =>
          s.id === statementId
            ? {
                ...s,
                result: {
                  ...result,
                  rows: updatedRows,
                  affected_rows: result.affected_rows - 1
                }
              }
            : s
        )
      })));

      console.log('✅ 数据删除成功');
    } catch (error) {
      console.error('❌ 数据删除失败:', error);
      const errorMessage = describeError(error, translateNow('error.deleteFailed'));
      set({ error: errorMessage });
    }
  },

  insertRowData: async (statementId: string, newRowData: Record<string, any>) => {
    const documentId = get().activeDocumentId;
    if (!documentId) {
      throw new Error(translateNow('error.noActiveSqlTab'));
    }
    const { database, connectionString } = get();
    const { statements } = readSqlDocument(get(), documentId);
    if (!database) {
      set({ error: translateNow('error.notConnected') });
      return;
    }

    const statement = statements.find(s => s.id === statementId);
    if (!statement?.result) return;

    const result = statement.result;
    if (!result.table_name) {
      set({ error: translateNow('error.cannotInsertNoTable') });
      return;
    }

    try {
      // 智能数据类型转换
      const processedData: Record<string, any> = {};
      const isPostgreSQL = connectionString?.startsWith('postgres://');
      
      Object.entries(newRowData).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') {
          // 空值处理
          processedData[key] = null;
        } else if (value === 'NULL' || value === 'null') {
          // 显式NULL值
          processedData[key] = null;
        } else if (key.toLowerCase().includes('time') || 
                   key.toLowerCase().includes('date') || 
                   key.toLowerCase().includes('created') || 
                   key.toLowerCase().includes('updated') ||
                   key.toLowerCase().includes('timestamp')) {
          // 时间字段智能处理
          if (value === 'NOW' || value === 'now' || value === 'CURRENT_TIMESTAMP') {
            // 对于PostgreSQL，使用特殊处理
            if (isPostgreSQL) {
              processedData[key] = 'CURRENT_TIMESTAMP';
            } else {
              processedData[key] = new Date().toISOString();
            }
          } else if (typeof value === 'string' && (value.includes('T') || value.match(/^\d{4}-\d{2}-\d{2}/))) {
            // 看起来像ISO时间格式或日期格式
            try {
              const parsedDate = new Date(value);
              if (!isNaN(parsedDate.getTime())) {
                if (isPostgreSQL) {
                  // PostgreSQL需要特定的时间戳格式
                  processedData[key] = parsedDate.toISOString();
                } else {
                  processedData[key] = parsedDate.toISOString();
                }
              } else {
                processedData[key] = value;
              }
            } catch {
              processedData[key] = value;
            }
          } else {
            // 尝试解析为时间
            try {
              const parsedDate = new Date(value);
              if (!isNaN(parsedDate.getTime())) {
                if (isPostgreSQL) {
                  // PostgreSQL需要特定的时间戳格式
                  processedData[key] = parsedDate.toISOString();
                } else {
                  processedData[key] = parsedDate.toISOString();
                }
              } else {
                processedData[key] = value;
              }
            } catch {
              processedData[key] = value;
            }
          }
        } else if (typeof value === 'string' && !isNaN(Number(value)) && value.trim() !== '') {
          // 数字字段
          processedData[key] = Number(value);
        } else if (typeof value === 'string' && (value.toLowerCase() === 'true' || value.toLowerCase() === 'false')) {
          // 布尔字段
          processedData[key] = value.toLowerCase() === 'true';
        } else {
          // 其他情况保持原值
          processedData[key] = value;
        }
      });

      // 构建INSERT语句
      const columns = Object.keys(processedData);
      const values = Object.values(processedData);
      const dialect = getSqlDialect(connectionString);
      const quotedTable = quoteSqlIdentifier(result.table_name, dialect);
      const quotedColumns = columns.map(column => quoteSqlIdentifier(column, dialect));
      
      let insertSql: string;
      let params: any[];
      
      if (connectionString?.startsWith('postgres://')) {
        // PostgreSQL 使用 $1, $2... 占位符，但对时间字段需要特殊处理
        const placeholders: string[] = [];
        const sqlParams: any[] = [];
        let paramIndex = 1;
        
        columns.forEach((column, index) => {
          const value = values[index];
          const isTimeField = column.toLowerCase().includes('time') || 
                            column.toLowerCase().includes('date') || 
                            column.toLowerCase().includes('created') || 
                            column.toLowerCase().includes('updated') ||
                            column.toLowerCase().includes('timestamp');
          
          if (isTimeField && value === 'CURRENT_TIMESTAMP') {
            // 直接使用SQL函数
            placeholders.push('CURRENT_TIMESTAMP');
          } else if (isTimeField && typeof value === 'string' && value !== null) {
            // 时间字段使用类型转换
            placeholders.push(`$${paramIndex}::timestamptz`);
            sqlParams.push(value);
            paramIndex++;
          } else {
            // 普通字段
            placeholders.push(`$${paramIndex}`);
            sqlParams.push(value);
            paramIndex++;
          }
        });
        
        insertSql = `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES (${placeholders.join(', ')})`;
        params = sqlParams;
      } else {
        // MySQL 和 SQLite 使用 ? 占位符
        const placeholders = values.map(() => '?').join(', ');
        insertSql = `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES (${placeholders})`;
        params = values;
      }
      
      console.log('➕ 执行新增操作:', insertSql, params);
      console.log('📊 处理后的数据:', processedData);
      console.log('🔍 数据库类型:', isPostgreSQL ? 'PostgreSQL' : 'MySQL/SQLite');
      
      // 执行插入操作
      await database.execute(insertSql, params);
      
      // 重新查询数据以获取最新结果（包括自动生成的ID等）
      const refreshSql = `SELECT * FROM ${quotedTable}`;
      const refreshResult = await database.select(refreshSql);
      
      if (Array.isArray(refreshResult) && refreshResult.length > 0) {
        const newColumns = Object.keys(refreshResult[0]);
        const newRows = refreshResult.map(row => newColumns.map(col => row[col]));
        
        set((state) => writeSqlDocument(state, documentId, () => ({
          statements: statements.map(s =>
            s.id === statementId
              ? {
                  ...s,
                  result: {
                    ...result,
                    columns: newColumns,
                    rows: newRows,
                    affected_rows: newRows.length
                  }
                }
              : s
          )
        })));
      }

      console.log('✅ 数据新增成功');
    } catch (error) {
      console.error('❌ 数据新增失败:', error);
      const errorMessage = describeError(error, translateNow('error.insertFailed'));
      set({ error: errorMessage });
    }
  },
})); 
