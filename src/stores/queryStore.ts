import { create } from 'zustand';
import {
  openDatabase,
  ORACLE_SCHEME,
  SQL_SERVER_SCHEME,
  type DatabaseHandle
} from '../utils/databaseHandle';
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
  CONNECTION_LOST_CODE,
  QUERY_CANCELLED_CODE,
  QUERY_TIMEOUT_CODE,
  toQueryExecutionError
} from '../utils/queryError';
import { DatabaseSession, type TransactionContext } from '../contracts/session';
import type {
  DriverQueryResult,
  DriverQueryBatch,
  QueryResult,
  SqlStatement
} from '../contracts/query';
import type { SerializedResultValue } from '../contracts/resultSet';
import {
  clearSqlStatementResult,
  completeSqlStatement,
  failSqlStatement,
  reconcileSqlStatements
} from '../utils/queryStatements';
import { describeResultEditability, parseSingleTableSelect } from '../utils/resultEditability';
import { loadTableMetadata } from '../utils/tableMetadata';
import type { WriteStatementPayload } from '../utils/pendingChanges';
import { executeSequentially } from '../utils/queryExecutionPolicy';
import { transactionStatement, type TransactionCommand } from '../utils/transactionDisplay';
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
  database: DatabaseHandle | null;
  /** 每个 SQL 标签一份独立文档，键为工作区标签 id */
  documents: Record<string, SqlDocument>;
  activeDocumentId: string | null;
  /** 执行记录保持扁平，靠 QueryExecution.tabId 归属到文档 */
  executions: QueryExecution[];
  queryTimeoutMs: number;
  queryResultRowLimit: number;
  /**
   * 关掉之后，不在事务里的语句会先被后端补一条 `BEGIN`。
   *
   * 开关在客户端而不是服务端：PostgreSQL 根本没有服务端的自动提交设置，
   * SQLite 也没有。psql 的 `\set AUTOCOMMIT off` 与 JDBC 的
   * `setAutoCommit(false)` 做的是同一件事。
   */
  autocommit: boolean;
  isConnecting: boolean;
  /**
   * 驱动告诉我们这条连接已经没了（`CONNECTION_LOST`），或者设备掉了网。
   *
   * 不能用 `database` 判：它是 `Database.load` 的返回值，连接死掉之后句柄
   * 照样在那儿。少了这个标记，界面会在连接已经没了的时候印「已连接」，
   * 而 `connectToDatabase` 会因为「已经有正常的连接」直接返回，于是**重连
   * 按钮按下去什么也不会发生**。
   */
  connectionLost: boolean;
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

  // 事务
  setAutocommit: (autocommit: boolean) => void;
  /** 设备掉网那条路用：驱动没说话，但这条连接一样用不了了 */
  reportConnectionLost: () => void;
  /** 从后端读一次事务状态写回 session；后端是权威，这里不自己推 */
  refreshTransaction: () => Promise<void>;
  /** 开始 / 提交 / 回滚。不进文档也不过风险确认——按钮本身就是确认 */
  runTransactionStatement: (command: TransactionCommand) => Promise<boolean>;
  
  // 结果管理
  clearResults: () => void;
  removeStatement: (statementId: string) => void;
  
  // 错误处理
  setError: (error: string | null) => void;

  // 数据操作
  commitRowChanges: (
    statementId: string,
    statements: readonly WriteStatementPayload[]
  ) => Promise<void>;
}

// 完整的Store类型
type QueryStore = QueryState & QueryActions;

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

/** 供组件订阅当前连接的方言：`SET 列 = DEFAULT` 这类差别要在界面上就分开 */
export const selectSqlDialect = (state: QueryState): SqlDialect =>
  getSqlDialect(state.connectionString);

const getSqlDialect = (connectionString: string | null): SqlDialect => {
  if (connectionString?.startsWith('mysql://')) {
    return 'mysql';
  }
  if (connectionString?.startsWith('postgres://')) {
    return 'postgresql';
  }
  if (connectionString?.startsWith(SQL_SERVER_SCHEME)) {
    return 'sqlserver';
  }
  if (connectionString?.startsWith(ORACLE_SCHEME)) {
    return 'oracle';
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
      byteLimit: QUERY_RESULT_BACKEND_BYTE_LIMIT,
      // 目录与表数据的读取一律自动提交：关掉自动提交管的是**用户在编辑器里
      // 跑的语句**，浏览一张表不该让状态栏凭空亮起「事务中」。
      // 事务已经开着时它照样落在同一个事务里——同一条连接，避不开，也正确
      autocommit: true
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
  autocommit: true,
  database: null,
  documents: {},
  activeDocumentId: null,
  executions: [],
  queryTimeoutMs: 30_000,
  queryResultRowLimit: 1_000,
  isConnecting: false,
  connectionLost: false,
  error: null,

  // Actions
  connectToDatabase: async (
    connectionString: string,
    connectionId: string,
    session: DatabaseSession
  ) => {
    const currentState = get();
    
    // 如果连接ID相同，且已经有正常的连接，则直接返回。
    // `connectionLost` 必须算进来：断线之后句柄还在、错误也不在这一层，
    // 少了它这里会直接返回，重连按钮就成了摆设
    if (
      currentState.connectionId === connectionId
      && currentState.database
      && !currentState.error
      && !currentState.connectionLost
    ) {
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
      connectionLost: false,
      database: null // 清空旧连接
    });
    
    try {
      // 隐藏密码的连接字符串用于日志
      const safeConnectionString = connectionString.replace(/:([^:@]+)@/, ':***@');
      console.log('🔗 连接到数据库:', safeConnectionString);
      
      const db = await openDatabase(connectionString);
      
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
        errorMessage = translateNow('error.portOutOfRange', { port: port || '?' });
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

    // 拆掉 SSH 隧道。没有隧道也要调：这里只有 connectionId，不知道那条连接
    // 有没有隧道，让后端判断比在前端再存一份状态可靠
    if (currentState.connectionId) {
      try {
        await invoke('close_ssh_tunnel', { connectionId: currentState.connectionId });
      } catch (error) {
        // 隧道拆不掉不该挡住断开连接：库那边已经关了，这里最多是留一条
        // 空跑的 SSH 会话，下次连同一个 profile 时会被判死重建
        console.warn('关闭 SSH 隧道失败:', error);
      }
    }

    set({
      database: null,
      connectionString: null,
      connectionId: null,
      session: null,
      connectionLost: false,
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

  setAutocommit: (autocommit: boolean) => {
    // 开着的事务不因为开关翻回去就自动提交：它是用户开的，只能由用户结束。
    // psql 的 AUTOCOMMIT 也是这个行为
    set({ autocommit });
  },

  reportConnectionLost: () => {
    // 没连过就没什么可断的。没有这道判断，启动时断一次网会让一个空工作台
    // 显示「连接已断开」
    if (get().database) {
      set({ connectionLost: true });
    }
  },

  refreshTransaction: async () => {
    const { session } = get();
    if (!session) {
      return;
    }
    try {
      const transaction = await invoke<TransactionContext>('get_session_transaction', {
        sessionId: session.id
      });
      set((state) => (
        state.session ? { session: { ...state.session, transaction } } : {}
      ));
    } catch (error) {
      // 读状态失败不该把界面打掉，但也不能假装「没在事务里」——那正是
      // 关连接前最需要说实话的地方。保留上一次读到的值
      console.error('读取事务状态失败:', error);
    }
  },

  runTransactionStatement: async (command) => {
    const { connectionId, connectionString, session, queryTimeoutMs } = get();
    const sql = transactionStatement(command, getSqlDialect(connectionString));
    if (!connectionId || !session) {
      return false;
    }
    set({ error: null });
    try {
      await invoke('execute_query', {
        onBatch: new Channel<DriverQueryBatch>(() => {}),
        request: {
          connectionId,
          sessionId: session.id,
          executionId: crypto.randomUUID(),
          sql,
          timeoutMs: queryTimeoutMs,
          rowLimit: 1,
          byteLimit: QUERY_RESULT_BACKEND_BYTE_LIMIT,
          // 这三条自己就是事务语句，补 BEGIN 没有意义
          autocommit: true
        }
      });
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    } finally {
      // 成功和失败都要刷：失败那一条恰恰是 PostgreSQL 把事务标成废止的时刻
      await get().refreshTransaction();
    }
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
      statements: reconcileSqlStatements(
        sqlInput,
        statements,
        undefined,
        getSqlDialect(get().connectionString)
      )
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
          byteLimit: QUERY_RESULT_BACKEND_BYTE_LIMIT,
          // **必须带上**：不带的话后端 serde 用默认值 true，于是取消勾选
          // 「自动提交」对编辑器里的语句毫无作用——界面显示手动事务模式，
          // 数据库却在自动提交，用户以为能回滚，实际每条都已经落库了。
          // 后端 `begin_if_needed` 正是靠它决定要不要先发 BEGIN
          autocommit: get().autocommit
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
        // 能不能改必须是**证明**：认得出是单表 SELECT，而且键来自目录而不是
        // 「有没有一列叫 id」。目录查询只在认出形态之后才发，复杂查询不付这个代价
        const dialect = getSqlDialect(connectionString);
        const parsed = parseSingleTableSelect(sql, dialect);
        const metadata = parsed
          ? await loadTableMetadata(database, dialect, parsed.table, parsed.schema ?? undefined)
          : null;
        const editability = describeResultEditability(
          parsed,
          metadata?.identity ?? { identity: null, absence: 'no-unique-key' }
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
          editability,
          tableColumns: metadata?.columns ?? []
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
      // 连接断了：数据库一个字都没说过，所以下面不给它挂任何「数据库报的」结构。
      // 界面要说的是「重连」，不是「看看这条语句哪里错了」
      const connectionLost = queryError.code === CONNECTION_LOST_CODE;
      const errorMessage = cancelled
        ? translateNow('error.queryCancelled')
        : timedOut
          ? translateNow('error.queryTimedOut', { duration: formatExecutionTime(queryTimeoutMs) })
          : queryError.message;
      // 超时、取消、断线都是我们自己判出来的，数据库没说过话，不该带上任何结构
      const errorDetails = timedOut || cancelled || connectionLost ? undefined : queryError;
      
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
        ),
        // 驱动说连接没了。这一句是界面知道该显示「已断开」并摆出重连按钮的
        // 唯一来源——在此之前它照样印「已连接」，而下一条语句还是同样的错
        ...(connectionLost ? { connectionLost: true } : {})
      }));
      // 失败、取消、超时一样要记：「那条跑崩的语句到底是什么」正是事后最想
      // 翻出来的一条，只记成功等于历史里永远没有出问题的那次
      recordHistory(finished, null);
      return false;
    } finally {
      // 成功和失败都刷一次。失败那一条尤其重要——它正是 PostgreSQL 把事务
      // 标成废止的时刻，而失败路径上没有结果可以捎带这个状态
      await get().refreshTransaction();
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

  /**
   * 一批变更，一个事务。
   *
   * 三个「改一行就提交一次」的动作合并成这一个：中途失败时数据库里什么都没变，
   * 调用方手上那批待提交的改动原样留着。成功之后重跑原来那条查询——自增键、
   * 默认值和表达式的结果只有数据库算得出来。
   */
  commitRowChanges: async (statementId: string, statements: readonly WriteStatementPayload[]) => {
    const { connectionId } = get();
    if (!connectionId) {
      throw new Error(translateNow('error.notConnected'));
    }
    await invoke<number[]>('execute_write_batch', { connectionId, statements });
    await get().executeStatement(statementId);
  },
})); 
