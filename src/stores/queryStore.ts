import { create } from 'zustand';
import Database from '@tauri-apps/plugin-sql';
import { assertSingleRowAffected } from '../utils/executeResult';
import { quoteSqlIdentifier, type SqlIdentifierDialect } from '../utils/sqlIdentifiers';
import { isSelectStatement, splitSqlStatements } from '../utils/sqlStatements';

// 查询结果接口
export interface QueryResult {
  columns: string[];
  rows: any[][];
  affected_rows: number;
  execution_time: number;
  table_name?: string; // 表名，用于支持数据操作
  primary_key?: string; // 主键列名，用于更新和删除操作
}

// SQL语句接口
export interface SqlStatement {
  id: string;
  sql: string;
  isExecuting: boolean;
  result?: QueryResult;
  error?: string;
  executedAt?: string;
}

// SQL历史缓存接口
export interface SqlHistory {
  connectionId: string;
  sqlInput: string;
  statements: SqlStatement[];
  lastUpdated: string;
}

// 查询状态
export interface QueryState {
  connectionString: string | null;
  connectionId: string | null; // 用于标识唯一连接的ID
  database: Database | null;
  sqlInput: string;
  statements: SqlStatement[];
  isConnecting: boolean;
  error: string | null;
}

// Store Actions
interface QueryActions {
  // 数据库连接
  connectToDatabase: (connectionString: string, connectionId: string) => Promise<void>;
  disconnect: () => Promise<void>;
  
  // SQL 编辑
  setSqlInput: (sql: string) => void;
  parseStatements: () => void;
  
  // SQL 执行
  executeStatement: (statementId: string) => Promise<void>;
  executeAllStatements: () => Promise<void>;
  
  // 结果管理
  clearResults: () => void;
  removeStatement: (statementId: string) => void;
  
  // 错误处理
  setError: (error: string | null) => void;

  // SQL历史缓存
  saveSqlHistory: () => void;
  loadSqlHistory: (connectionId: string) => void;
  clearSqlHistory: (connectionId?: string) => void;
  getAllSqlHistories: () => SqlHistory[];

  // 数据操作
  updateRowData: (statementId: string, rowIndex: number, columnName: string, newValue: any) => Promise<void>;
  deleteRowData: (statementId: string, rowIndex: number) => Promise<void>;
  insertRowData: (statementId: string, newRowData: Record<string, any>) => Promise<void>;
}

// 完整的Store类型
type QueryStore = QueryState & QueryActions;

// 解析SQL语句的工具函数
const parseSqlStatements = (sqlText: string): SqlStatement[] => {
  const statements = splitSqlStatements(sqlText)
    .map((sql, index) => ({
      id: `stmt_${Date.now()}_${index}`,
      sql: sql + ';', // 添加回分号
      isExecuting: false,
    }));
  
  return statements;
};

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

const getSqlDialect = (connectionString: string | null): SqlIdentifierDialect => {
  if (connectionString?.startsWith('mysql://')) {
    return 'mysql';
  }
  if (connectionString?.startsWith('postgres://')) {
    return 'postgresql';
  }
  return 'sqlite';
};

// localStorage键名常量
const STORAGE_KEY_PREFIX = 'dataomni_sql_history_';
const STORAGE_KEY_LIST = 'dataomni_sql_history_list';

// 保存SQL历史到localStorage
const saveSqlHistoryToStorage = (history: SqlHistory): void => {
  try {
    // 清理不必要的执行状态和结果（减少存储空间）
    const cleanStatements = history.statements.map(stmt => ({
      id: stmt.id,
      sql: stmt.sql,
      isExecuting: false, // 重置执行状态
      // 不保存result和error，因为这些在重新连接时应该清空
    }));

    const cleanHistory: SqlHistory = {
      ...history,
      statements: cleanStatements,
      lastUpdated: new Date().toISOString(),
    };

    localStorage.setItem(
      `${STORAGE_KEY_PREFIX}${history.connectionId}`, 
      JSON.stringify(cleanHistory)
    );

    // 更新历史列表
    const existingList = JSON.parse(localStorage.getItem(STORAGE_KEY_LIST) || '[]');
    const updatedList = [...existingList.filter((id: string) => id !== history.connectionId), history.connectionId];
    localStorage.setItem(STORAGE_KEY_LIST, JSON.stringify(updatedList));

    console.log('💾 SQL历史已保存:', history.connectionId);
  } catch (error) {
    console.error('❌ 保存SQL历史失败:', error);
  }
};

// 从localStorage加载SQL历史
const loadSqlHistoryFromStorage = (connectionId: string): SqlHistory | null => {
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${connectionId}`);
    if (!stored) return null;

    const history: SqlHistory = JSON.parse(stored);
    console.log('📂 SQL历史已加载:', connectionId);
    return history;
  } catch (error) {
    console.error('❌ 加载SQL历史失败:', error);
    return null;
  }
};

// 清除SQL历史
const clearSqlHistoryFromStorage = (connectionId?: string): void => {
  try {
    if (connectionId) {
      // 清除特定连接的历史
      localStorage.removeItem(`${STORAGE_KEY_PREFIX}${connectionId}`);
      
      // 从列表中移除
      const existingList = JSON.parse(localStorage.getItem(STORAGE_KEY_LIST) || '[]');
      const updatedList = existingList.filter((id: string) => id !== connectionId);
      localStorage.setItem(STORAGE_KEY_LIST, JSON.stringify(updatedList));
      
      console.log('🗑️ 已清除SQL历史:', connectionId);
    } else {
      // 清除所有历史
      const existingList = JSON.parse(localStorage.getItem(STORAGE_KEY_LIST) || '[]');
      existingList.forEach((id: string) => {
        localStorage.removeItem(`${STORAGE_KEY_PREFIX}${id}`);
      });
      localStorage.removeItem(STORAGE_KEY_LIST);
      
      console.log('🗑️ 已清除所有SQL历史');
    }
  } catch (error) {
    console.error('❌ 清除SQL历史失败:', error);
  }
};

// 获取所有SQL历史
const getAllSqlHistoriesFromStorage = (): SqlHistory[] => {
  try {
    const historyList = JSON.parse(localStorage.getItem(STORAGE_KEY_LIST) || '[]');
    const histories: SqlHistory[] = [];
    
    historyList.forEach((connectionId: string) => {
      const history = loadSqlHistoryFromStorage(connectionId);
      if (history) {
        histories.push(history);
      }
    });
    
    // 按最后更新时间排序
    return histories.sort((a, b) => 
      new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
    );
  } catch (error) {
    console.error('❌ 获取SQL历史列表失败:', error);
    return [];
  }
};

// 创建Zustand Store
export const useQueryStore = create<QueryStore>((set, get) => ({
  // 初始状态
  connectionString: null,
  connectionId: null,
  database: null,
  sqlInput: '',
  statements: [],
  isConnecting: false,
  error: null,

  // Actions
  connectToDatabase: async (connectionString: string, connectionId: string) => {
    const currentState = get();
    
    // 如果连接ID相同，且已经有正常的连接，则直接返回
    if (currentState.connectionId === connectionId && currentState.database && !currentState.error) {
      console.log('✅ 使用现有数据库连接:', connectionId);
      return;
    }
    
    // 在连接新数据库前，保存当前的SQL历史
    if (currentState.connectionId && currentState.connectionId !== connectionId && (currentState.sqlInput.trim() || currentState.statements.length > 0)) {
      console.log('💾 保存旧连接的SQL历史:', currentState.connectionId);
      const { saveSqlHistory } = get();
      saveSqlHistory();
    }
    
    // 关闭旧连接
    if (currentState.database) {
      try {
        await currentState.database.close();
        console.log('🔌 旧数据库连接已关闭');
      } catch (error) {
        console.warn('⚠️ 关闭旧连接失败:', error);
      }
    }

    set({ 
      isConnecting: true, 
      error: null,
      database: null, // 清空旧连接
      sqlInput: '',   // 清空旧SQL输入
      statements: []  // 清空旧语句
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
          throw new Error(`端口兼容性错误：端口 ${port} 超出了Tauri SQL插件支持的范围（最大32767）。请使用SSH端口转发或联系管理员使用标准端口范围。`);
        }
      }
      
      const db = await Database.load(connectionString);
      
      set({ 
        database: db, 
        connectionString,
        connectionId,
        isConnecting: false,
        error: null 
      });
      
      // 尝试加载该连接的SQL历史
      const { loadSqlHistory } = get();
      loadSqlHistory(connectionId);
      
      console.log('✅ 数据库连接成功:', connectionId);
    } catch (error) {
      console.error('❌ 数据库连接失败:', error);
      
      // 处理端口错误的特殊情况
      let errorMessage = error instanceof Error ? error.message : '数据库连接失败';
      if (errorMessage.includes('invalid port number')) {
        // 尝试从连接字符串中提取端口号
        const portMatch = connectionString.match(/:(\d+)\//);
        const port = portMatch ? parseInt(portMatch[1]) : 0;
        if (port > 32767) {
          errorMessage = `端口号兼容性问题: ${port}。当前数据库驱动不支持大于32767的端口号。这是已知限制，建议联系数据库管理员使用标准端口范围内的端口，或检查是否有端口映射方案。`;
        } else {
          errorMessage = `端口号无效: ${port || '未知'}。可能的原因：1) 端口超出有效范围(1-65535)，2) 端口被防火墙阻止，3) 数据库服务未在此端口运行。`;
        }
      }
      
      set({ 
        error: errorMessage,
        isConnecting: false,
        database: null,
        connectionString: null,
        connectionId: null
      });
      throw new Error(errorMessage);
    }
  },

  disconnect: async () => {
    // 在断开连接前保存SQL历史
    const currentState = get();
    if (currentState.connectionId && (currentState.sqlInput.trim() || currentState.statements.length > 0)) {
      const { saveSqlHistory } = get();
      saveSqlHistory();
    }

    if (currentState.database) {
      try {
        await currentState.database.close();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '关闭数据库连接失败';
        set({ error: errorMessage });
        throw new Error(errorMessage);
      }
    }

    set({
      database: null,
      connectionString: null,
      connectionId: null,
      sqlInput: '',
      statements: [],
      error: null
    });
    console.log('🔌 已断开数据库连接');
  },

  setSqlInput: (sql: string) => {
    set({ sqlInput: sql });
  },

  parseStatements: () => {
    const { sqlInput } = get();
    if (!sqlInput.trim()) {
      set({ statements: [] });
      return;
    }
    
    const statements = parseSqlStatements(sqlInput);
    set({ statements });
  },

  executeStatement: async (statementId: string) => {
    const { database, statements } = get();
    if (!database) {
      set({ error: '数据库未连接' });
      return;
    }

    const statement = statements.find(s => s.id === statementId);
    if (!statement) return;

    // 更新执行状态
    set({
      statements: statements.map(s => 
        s.id === statementId 
          ? { ...s, isExecuting: true, error: undefined }
          : s
      )
    });

    try {
      const startTime = Date.now();
      console.log('🔍 执行SQL:', statement.sql);
      const { connectionString } = get();
      const safeConnectionString = connectionString?.replace(/:([^:@]+)@/, ':***@') || 'unknown';
      console.log('🔗 当前连接字符串:', safeConnectionString);
      
      // 执行SQL查询
      let queryResult: QueryResult;
      const sql = statement.sql.trim();
      
      if (isSelectStatement(sql)) {
        // SELECT查询使用select方法
        const selectResult = await database.select(statement.sql);
        const executionTime = Date.now() - startTime;
        
        // 处理SELECT结果
        console.log('📊 原始查询结果:', selectResult);
        console.log('📊 结果类型:', typeof selectResult, '是否为数组:', Array.isArray(selectResult));
        
        if (Array.isArray(selectResult) && selectResult.length > 0) {
          const columns = Object.keys(selectResult[0]);
          const rows = selectResult.map(row => columns.map(col => row[col]));
          
          console.log('📋 解析的列名:', columns);
          console.log('📊 解析的行数:', rows.length);
          
          // 尝试从SQL语句中提取表名和主键信息
          const tableName = extractEditableTableName(sql);
          const primaryKey = await detectPrimaryKey(database, tableName, columns, connectionString);
          
          queryResult = {
            columns,
            rows,
            affected_rows: selectResult.length,
            execution_time: executionTime,
            table_name: tableName,
            primary_key: primaryKey,
          };
        } else {
          console.log('⚠️ 查询结果为空或格式不正确');
          queryResult = {
            columns: [],
            rows: [],
            affected_rows: 0,
            execution_time: executionTime,
          };
        }
      } else {
        // 非SELECT查询使用execute方法
        const execResult = await database.execute(statement.sql);
        const executionTime = Date.now() - startTime;
        
        queryResult = {
          columns: [],
          rows: [],
          affected_rows: (execResult as any).rowsAffected || 0,
          execution_time: executionTime,
        };
      }

      // 更新结果
      set({
        statements: statements.map(s => 
          s.id === statementId 
            ? { 
                ...s, 
                isExecuting: false, 
                result: queryResult,
                executedAt: new Date().toLocaleTimeString(),
                error: undefined
              }
            : s
        )
      });

      console.log(`✅ SQL执行成功，耗时: ${formatExecutionTime(queryResult.execution_time)}`);
    } catch (error) {
      console.error('❌ SQL执行失败:', error);
      const errorMessage = error instanceof Error ? error.message : 'SQL执行失败';
      
      // 更新错误状态
      set({
        statements: statements.map(s => 
          s.id === statementId 
            ? { 
                ...s, 
                isExecuting: false, 
                error: errorMessage,
                result: undefined
              }
            : s
        )
      });
    }
  },

  executeAllStatements: async () => {
    const { statements } = get();
    const { executeStatement } = get();
    
    // 按顺序执行所有语句
    for (const statement of statements) {
      if (!statement.isExecuting) {
        await executeStatement(statement.id);
      }
    }
  },

  clearResults: () => {
    const { statements } = get();
    set({
      statements: statements.map(s => ({
        ...s,
        result: undefined,
        error: undefined,
        executedAt: undefined
      }))
    });
  },

  removeStatement: (statementId: string) => {
    const { statements } = get();
    set({
      statements: statements.filter(s => s.id !== statementId)
    });
  },

  setError: (error: string | null) => {
    set({ error });
  },

  // SQL历史缓存方法
  saveSqlHistory: () => {
    const { connectionId, sqlInput, statements } = get();
    if (!connectionId) return;

    const history: SqlHistory = {
      connectionId,
      sqlInput,
      statements,
      lastUpdated: new Date().toISOString(),
    };

    saveSqlHistoryToStorage(history);
  },

  loadSqlHistory: (connectionId: string) => {
    const history = loadSqlHistoryFromStorage(connectionId);
    if (history) {
      set({
        sqlInput: history.sqlInput,
        statements: history.statements,
      });
      console.log('📂 已恢复SQL历史:', connectionId);
    }
  },

  clearSqlHistory: (connectionId?: string) => {
    clearSqlHistoryFromStorage(connectionId);
  },

  getAllSqlHistories: () => {
    return getAllSqlHistoriesFromStorage();
  },

  // 数据操作方法
  updateRowData: async (statementId: string, rowIndex: number, columnName: string, newValue: any) => {
    const { database, statements, connectionString } = get();
    if (!database) {
      set({ error: '数据库未连接' });
      return;
    }

    const statement = statements.find(s => s.id === statementId);
    if (!statement?.result) return;

    const result = statement.result;
    if (!result.table_name || !result.primary_key) {
      set({ error: '无法更新数据：缺少表名或主键信息' });
      return;
    }

    try {
      // 获取主键值
      const primaryKeyIndex = result.columns.indexOf(result.primary_key);
      if (primaryKeyIndex === -1) {
        throw new Error('找不到主键列');
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
      assertSingleRowAffected(updateResult, '更新');

      // 更新本地数据
      const columnIndex = result.columns.indexOf(columnName);
      if (columnIndex !== -1) {
        const updatedRows = [...result.rows];
        updatedRows[rowIndex] = [...updatedRows[rowIndex]];
        updatedRows[rowIndex][columnIndex] = newValue;

        set({
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
        });
      }

      console.log('✅ 数据更新成功');
    } catch (error) {
      console.error('❌ 数据更新失败:', error);
      const errorMessage = error instanceof Error ? error.message : '数据更新失败';
      set({ error: errorMessage });
    }
  },

  deleteRowData: async (statementId: string, rowIndex: number) => {
    const { database, statements, connectionString } = get();
    if (!database) {
      set({ error: '数据库未连接' });
      return;
    }

    const statement = statements.find(s => s.id === statementId);
    if (!statement?.result) return;

    const result = statement.result;
    if (!result.table_name || !result.primary_key) {
      set({ error: '无法删除数据：缺少表名或主键信息' });
      return;
    }

    try {
      // 获取主键值
      const primaryKeyIndex = result.columns.indexOf(result.primary_key);
      if (primaryKeyIndex === -1) {
        throw new Error('找不到主键列');
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
      assertSingleRowAffected(deleteResult, '删除');

      // 更新本地数据
      const updatedRows = result.rows.filter((_, index) => index !== rowIndex);

      set({
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
      });

      console.log('✅ 数据删除成功');
    } catch (error) {
      console.error('❌ 数据删除失败:', error);
      const errorMessage = error instanceof Error ? error.message : '数据删除失败';
      set({ error: errorMessage });
    }
  },

  insertRowData: async (statementId: string, newRowData: Record<string, any>) => {
    const { database, statements, connectionString } = get();
    if (!database) {
      set({ error: '数据库未连接' });
      return;
    }

    const statement = statements.find(s => s.id === statementId);
    if (!statement?.result) return;

    const result = statement.result;
    if (!result.table_name) {
      set({ error: '无法新增数据：缺少表名信息' });
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
        
        set({
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
        });
      }

      console.log('✅ 数据新增成功');
    } catch (error) {
      console.error('❌ 数据新增失败:', error);
      const errorMessage = error instanceof Error ? error.message : '数据新增失败';
      set({ error: errorMessage });
    }
  },
})); 
