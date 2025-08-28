import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

// 数据库类型枚举
export enum DatabaseType {
  // 关系型数据库
  MySQL = 'mysql',
  PostgreSQL = 'postgresql',
  SQLite = 'sqlite',
  
  // 非关系型数据库
  MongoDB = 'mongodb',
  Redis = 'redis',
  Neo4j = 'neo4j',
  
  // 分析平台
  DuckDB = 'duckdb',
  ClickHouse = 'clickhouse',
  Elasticsearch = 'elasticsearch',
}

// 连接配置接口
export interface ConnectionConfig {
  id: string;
  name: string;
  db_type: DatabaseType;
  host: string;
  port: number;
  database?: string;
  username: string;
  password: string;
  ssl: boolean;
  options: Record<string, string>;
  tags: string[];
  created_at: string;
  updated_at: string;
}

// 连接状态
export interface ConnectionState {
  connections: ConnectionConfig[];
  selectedConnectionId: string | null;
  isLoading: boolean;
  error: string | null;
  testResult: string | null;
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
export const createDefaultConfig = (type: DatabaseType = DatabaseType.SQLite): Partial<ConnectionConfig> => {
  const baseConfig = {
    name: '',
    db_type: type,
    host: 'localhost',
    port: getDefaultPort(type),
    database: '',
    username: '',
    password: '',
        ssl: false,
    options: {},
    tags: [],
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
        error: error instanceof Error ? error.message : '加载连接配置失败', 
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
        error: error instanceof Error ? error.message : '创建连接失败', 
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
        error: error instanceof Error ? error.message : '更新连接失败', 
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
        error: error instanceof Error ? error.message : '删除连接失败', 
        isLoading: false 
      });
      throw error;
    }
  },

  testConnection: async (config) => {
    set({ isLoading: true, error: null, testResult: null });
    try {
      // 前端预验证
      if (config.port > 65535 || config.port < 1) {
        throw new Error(`端口号无效: ${config.port}。端口号必须在1-65535范围内。`);
      }
      
      // 检查Tauri SQL插件的端口限制（适用于所有数据库类型）
      if (config.port > 32767) {
        const errorMessage = `端口兼容性错误：端口 ${config.port} 超出了Tauri SQL插件支持的范围（最大32767）。这是由于底层驱动使用16位有符号整数的限制。

解决方案：
1. 联系数据库管理员使用标准端口范围（1-32767）
2. 使用SSH端口转发：ssh -L 3306:${config.host}:${config.port} user@jump-server
3. 使用本地代理服务（如socat）进行端口转发
4. 请求数据库管理员配置负载均衡器或代理`;
        
        console.error(`❌ ${errorMessage}`);
        throw new Error(errorMessage);
      }
      
      // 先进行后端验证
      const connectionString = await invoke<string>('test_connection', { config });
      
      // 然后尝试实际连接数据库
      try {
        const Database = (await import('@tauri-apps/plugin-sql')).default;
        const db = await Database.load(connectionString);
        await db.close();
        
        set({ 
          testResult: `连接测试成功！数据库连接正常`, 
          isLoading: false 
        });
        return connectionString;
      } catch (dbError) {
        console.error('数据库连接失败:', dbError);
        const dbErrorMessage = dbError instanceof Error ? dbError.message : '数据库连接失败';
        
        // 特殊处理端口错误
        let finalErrorMessage = dbErrorMessage;
        if (dbErrorMessage.includes('invalid port number')) {
          if (config.port > 32767) {
            finalErrorMessage = `端口号兼容性问题: ${config.port}。当前数据库驱动可能不支持大于32767的端口号。建议：1) 联系数据库管理员使用标准端口范围，2) 检查是否存在端口映射或代理服务。`;
          } else {
            finalErrorMessage = `端口号无效: ${config.port}。请检查：1) 端口是否在有效范围内(1-65535)，2) 端口是否被防火墙阻止，3) 数据库服务是否在此端口运行。`;
          }
        }
        
        set({ 
          error: finalErrorMessage,
          testResult: `连接测试失败: ${finalErrorMessage}`,
          isLoading: false 
        });
        throw new Error(finalErrorMessage);
      }
    } catch (error) {
      console.error('连接配置验证失败:', error);
      const errorMessage = error instanceof Error ? error.message : '连接配置验证失败';
      set({ 
        error: errorMessage,
        testResult: `连接测试失败: ${errorMessage}`,
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
