import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import {
  DatabaseType,
  type ConnectionConfig,
  type ConnectionEnvironment,
  type TlsMode
} from '../contracts/connection';
import { isUsablePort } from '../utils/connectionPort';
import { describeError } from '../utils/describeError';
import { translateNow } from './languageStore';

export {
  DatabaseType,
  type ConnectionConfig,
  type ConnectionEnvironment,
  type ConnectionProfile,
  type TlsMode
} from '../contracts/connection';

// 连接状态
export interface ConnectionState {
  connections: ConnectionConfig[];
  selectedConnectionId: string | null;
  isLoading: boolean;
  error: string | null;
  /**
   * 测试结果。`ok` 是独立的布尔值——此前界面靠 `testResult.includes('成功')`
   * 判断成败，那在翻译之后必然失效，而且失效的方式是「一直显示失败」。
   */
  testResult: { ok: boolean; message: string } | null;
}

// Store Actions
interface ConnectionActions {
  // 连接管理
  loadConnections: () => Promise<void>;
  createConnection: (config: Omit<ConnectionConfig, 'id' | 'created_at' | 'updated_at'>) => Promise<string>;
  updateConnection: (id: string, config: ConnectionConfig) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
  testConnection: (config: ConnectionConfig) => Promise<string>;
  
  // UI状态管理
  setSelectedConnection: (id: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clearTestResult: () => void;
}

// 完整的Store类型
type ConnectionStore = ConnectionState & ConnectionActions;

// 创建默认连接配置
// 返回类型收紧为「除 id / 时间戳外样样齐全」：它本来就填满了所有必填字段，
// 声明成 Partial 只是让调用方无法直接拿去建连接，得在外面补一次或者 as 掉。
export const createDefaultConfig = (
  type: DatabaseType = DatabaseType.SQLite
): Omit<ConnectionConfig, 'id' | 'created_at' | 'updated_at'> => {
  const baseConfig = {
    name: '',
    db_type: type,
    host: 'localhost',
    port: getDefaultPort(type),
    database: '',
    username: '',
    password: '',
        ssl: false,
    tls_mode: 'disabled' as TlsMode,
    ca_certificate_path: '',
    client_certificate_path: '',
    client_key_path: '',
    save_password: true,
    options: {},
    tags: [],
    environment: 'development' as ConnectionEnvironment,
    credential_ref: undefined,
  };

  switch (type) {
    case DatabaseType.SQLite:
      return {
        ...baseConfig,
        host: '',
        port: 0,
        database: ':memory:',
        username: '',
      };
    case DatabaseType.MySQL:
      return {
        ...baseConfig,
        database: 'mysql',
        ssl: true, // Enable SSL by default for MySQL due to common cloud database requirements
        tls_mode: 'required',
      };
    case DatabaseType.PostgreSQL:
      return {
        ...baseConfig,
        port: 5432,
        database: 'postgres',
      };
    case DatabaseType.MongoDB:
      return {
        ...baseConfig,
        port: 27017,
        database: 'admin',
      };
    case DatabaseType.Redis:
      return {
        ...baseConfig,
        port: 6379,
        database: '0',
        username: '',
      };
    case DatabaseType.Neo4j:
      return {
        ...baseConfig,
        port: 7687,
        database: 'neo4j',
      };
    case DatabaseType.DuckDB:
      return {
        ...baseConfig,
        host: '',
        port: 0,
        database: ':memory:',
        username: '',
      };
    case DatabaseType.ClickHouse:
      return {
        ...baseConfig,
        port: 9000,
        database: 'default',
      };
    case DatabaseType.Elasticsearch:
      return {
        ...baseConfig,
        port: 9200,
        database: '',
        username: '',
      };
    default:
      return baseConfig;
  }
};

// 获取默认端口
export const getDefaultPort = (type: DatabaseType): number => {
  switch (type) {
    case DatabaseType.MySQL:
      return 3306;
    case DatabaseType.PostgreSQL:
      return 5432;
    case DatabaseType.SQLite:
      return 0;
    case DatabaseType.MongoDB:
      return 27017;
    case DatabaseType.Redis:
      return 6379;
    case DatabaseType.Neo4j:
      return 7687;
    case DatabaseType.DuckDB:
      return 0;
    case DatabaseType.ClickHouse:
      return 9000;
    case DatabaseType.Elasticsearch:
      return 9200;
    default:
      return 0;
  }
};

// 创建Zustand Store
export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  // 初始状态
  connections: [],
  selectedConnectionId: null,
  isLoading: false,
  error: null,
  testResult: null,

  // Actions
  loadConnections: async () => {
    set({ isLoading: true, error: null });
    try {
      const connections = await invoke<ConnectionConfig[]>('get_connections');
      set({ connections, isLoading: false });
    } catch (error) {
      console.error('加载连接配置失败:', error);
      set({ 
        error: describeError(error, translateNow('error.loadProfilesFailed')), 
        isLoading: false 
      });
    }
  },

  createConnection: async (config) => {
    set({ isLoading: true, error: null });
    try {
      const connectionConfig: ConnectionConfig = {
        ...config,
        id: '', // 后端会生成ID
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      
      const id = await invoke<string>('create_connection', { config: connectionConfig });
      
      // 重新加载连接列表
      await get().loadConnections();
      set({ isLoading: false });
      return id;
    } catch (error) {
      console.error('创建连接失败:', error);
      set({ 
        error: describeError(error, translateNow('error.createProfileFailed')), 
        isLoading: false 
      });
      throw error;
    }
  },

  updateConnection: async (id, config) => {
    set({ isLoading: true, error: null });
    try {
      await invoke('update_connection', { id, config });
      
      // 重新加载连接列表
      await get().loadConnections();
      set({ isLoading: false });
    } catch (error) {
      console.error('更新连接失败:', error);
      set({ 
        error: describeError(error, translateNow('error.updateProfileFailed')), 
        isLoading: false 
      });
      throw error;
    }
  },

  deleteConnection: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await invoke('delete_connection', { id });
      
      // 重新加载连接列表
      await get().loadConnections();
      
      // 如果删除的是当前选中的连接，清除选中状态
      const { selectedConnectionId } = get();
      if (selectedConnectionId === id) {
        set({ selectedConnectionId: null });
      }
      
      set({ isLoading: false });
    } catch (error) {
      console.error('删除连接失败:', error);
      set({ 
        error: describeError(error, translateNow('error.deleteProfileFailed')), 
        isLoading: false 
      });
      throw error;
    }
  },

  testConnection: async (config) => {
    set({ isLoading: true, error: null, testResult: null });
    try {
      const requiresNetworkPort = config.db_type !== DatabaseType.SQLite &&
        config.db_type !== DatabaseType.DuckDB;

      // 前端预验证
      if (requiresNetworkPort && !isUsablePort(config.port)) {
        throw new Error(translateNow('error.invalidPort', { port: config.port }));
      }

      // 先进行后端验证
      const connectionString = await invoke<string>('test_connection', { config });
      
      // 然后尝试实际连接数据库
      try {
        const Database = (await import('@tauri-apps/plugin-sql')).default;
        const db = await Database.load(connectionString);
        await db.close();
        
        set({
          testResult: { ok: true, message: translateNow('connect.testSucceeded') },
          isLoading: false
        });
        return connectionString;
      } catch (dbError) {
        console.error('数据库连接失败:', dbError);
        const dbErrorMessage = describeError(dbError, translateNow('error.connectFailed'));
        
        // 特殊处理端口错误
        let finalErrorMessage = dbErrorMessage;
        if (dbErrorMessage.includes('invalid port number')) {
          finalErrorMessage = translateNow('error.portOutOfRange', { port: config.port });
        }
        
        set({ 
          error: finalErrorMessage,
          testResult: {
            ok: false,
            message: translateNow('connect.testFailed', { reason: finalErrorMessage })
          },
          isLoading: false 
        });
        throw new Error(finalErrorMessage);
      }
    } catch (error) {
      console.error('连接配置验证失败:', error);
      const errorMessage = describeError(error, translateNow('error.validateConfigFailed'));
      set({ 
        error: errorMessage,
        testResult: {
          ok: false,
          message: translateNow('connect.testFailed', { reason: errorMessage })
        },
        isLoading: false 
      });
      throw error;
    }
  },

  // UI状态管理
  setSelectedConnection: (id) => set({ selectedConnectionId: id }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  clearTestResult: () => set({ testResult: null }),
})); 
