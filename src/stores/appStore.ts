import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { ConnectionConfig } from './connectionStore';
import { useQueryStore } from './queryStore';

// 视图模式类型
export type ViewMode = 'workbench' | 'table-viewer';

// 表查看器状态
export interface TableViewerState {
  connection: ConnectionConfig;
  tableName: string;
  schema?: string;
}

// 应用状态接口
export interface AppState {
  // 当前活跃的数据库连接
  activeConnection: {
    config: ConnectionConfig;
    connectionString: string;
  } | null;
  
  // 当前视图模式
  viewMode: ViewMode;
  
  // 表数据查看器状态
  tableViewerState: TableViewerState | null;
  
  // 选中的表（用于SQL工作台）
  selectedTable: {
    name: string;
    schema?: string;
  } | null;
  
  // 数据库元数据缓存
  databaseMetadata: {
    [connectionId: string]: {
      schemas: Array<{
        name: string;
        tables: Array<{ name: string; type: string }>;
      }>;
      lastUpdated: number;
    };
  };
  
  // 连接状态监听
  connectionReady: boolean;
}

// 应用操作接口
export interface AppActions {
  // 数据库连接管理
  setActiveConnection: (connection: ConnectionConfig, connectionString: string) => void;
  clearActiveConnection: () => void;
  
  // 视图模式管理
  setViewMode: (mode: ViewMode) => void;
  
  // 表数据查看器管理
  openTableViewer: (connection: ConnectionConfig, tableName: string, schema?: string) => Promise<void>;
  closeTableViewer: () => void;
  
  // 表选择管理
  selectTable: (tableName: string, schema?: string) => void;
  clearSelectedTable: () => void;
  
  // 数据库元数据管理
  setDatabaseMetadata: (connectionId: string, metadata: AppState['databaseMetadata'][string]) => void;
  clearDatabaseMetadata: (connectionId?: string) => void;
  
  // 连接删除处理
  handleConnectionDeleted: (deletedConnectionId: string) => void;
  
  // 连接状态管理
  setConnectionReady: (ready: boolean) => void;
}

// 应用Store类型
export type AppStore = AppState & AppActions;

// 创建应用Store
export const useAppStore = create<AppStore>((set, get) => ({
  // 初始状态
  activeConnection: null,
  viewMode: 'workbench',
  tableViewerState: null,
  selectedTable: null,
  databaseMetadata: {},
  connectionReady: false,

  // Actions
  setActiveConnection: async (connection: ConnectionConfig, connectionString: string) => {
    console.log('🔄 设置活跃连接:', connection.name);
    
    const currentState = get();
    const previousConnectionId = currentState.activeConnection?.config.id;
    
    // 先断开旧连接并保存历史
    if (previousConnectionId && previousConnectionId !== connection.id) {
      console.log('🔌 断开旧连接并保存历史:', previousConnectionId);
      const { disconnect, saveSqlHistory } = useQueryStore.getState();
      saveSqlHistory(); // 保存当前SQL历史
      disconnect(); // 断开旧连接
      get().clearDatabaseMetadata(previousConnectionId);
    }
    
    // 设置连接状态为连接中
    set({ 
      activeConnection: { config: connection, connectionString },
      selectedTable: null,
      connectionReady: false
    });
    
    // 建立数据库连接
    try {
      console.log('🔗 正在建立数据库连接...');
      const { connectToDatabase } = useQueryStore.getState();
      
      // 等待连接完成
      await connectToDatabase(connectionString, connection.id);
      
      // 验证连接状态
      const { database } = useQueryStore.getState();
      if (!database) {
        throw new Error('数据库连接对象为空');
      }
      
      // 连接成功后设置状态为准备就绪
      console.log('✅ 数据库连接成功，设置状态为准备就绪');
      set({ connectionReady: true });
    } catch (error) {
      console.error('❌ 数据库连接失败:', error);
      set({ 
        activeConnection: null,
        connectionReady: false
      });
      throw error;
    }
  },

  clearActiveConnection: () => {
    console.log('🔌 清除活跃连接');
    
    // 断开数据库连接
    const { disconnect } = useQueryStore.getState();
    disconnect();
    
    set({ 
      activeConnection: null,
      selectedTable: null,
      tableViewerState: null,
      viewMode: 'workbench',
      connectionReady: false
    });
  },

  setViewMode: (mode: ViewMode) => {
    console.log('📋 切换视图模式:', mode);
    set({ viewMode: mode });
  },

  openTableViewer: async (connection: ConnectionConfig, tableName: string, schema?: string) => {
    console.log('🖱️ 打开表数据查看器:', tableName, 'schema:', schema);
    
    // 确保连接是活跃的
    const currentState = get();
    if (!currentState.activeConnection || currentState.activeConnection.config.id !== connection.id) {
      // 如果连接不同，需要设置新的连接
      console.log('🔄 切换到新的数据库连接:', connection.name);
      
      // 使用后端的test_connection来获取正确的连接字符串(包含SSL参数)
      let connectionString = '';
      try {
        // 调用后端生成带SSL参数的连接字符串
        connectionString = await invoke<string>('test_connection', { config: connection });
        console.log('✅ 获取到带SSL参数的连接字符串:', connectionString.replace(/:([^:@]+)@/, ':***@'));
      } catch (error) {
        console.error('❌ 获取连接字符串失败，使用简化版本:', error);
        // 如果后端调用失败，使用简化的连接字符串生成
        switch (connection.db_type) {
          case 'sqlite':
            const dbPath = connection.database || 'data.db';
            connectionString = `sqlite:${dbPath}`;
            break;
          case 'mysql':
            // 为MySQL连接添加基本的SSL参数，并对用户名和密码进行URL编码
            const encodedUsername = encodeURIComponent(connection.username);
            const encodedPassword = encodeURIComponent(connection.password);
            const mysqlBase = `mysql://${encodedUsername}:${encodedPassword}@${connection.host}:${connection.port}/${connection.database}`;
            // 对于MySQL 5.7容器环境，统一使用DISABLED模式以避免SSL握手失败
            connectionString = `${mysqlBase}?ssl-mode=DISABLED&connectTimeout=30000`;
            break;
          case 'postgresql':
            const encodedUsernamePg = encodeURIComponent(connection.username);
            const encodedPasswordPg = encodeURIComponent(connection.password);
            const pgBase = `postgres://${encodedUsernamePg}:${encodedPasswordPg}@${connection.host}:${connection.port}/${connection.database}`;
            connectionString = connection.ssl || connection.port > 32767
              ? `${pgBase}?sslmode=require&connect_timeout=30`
              : `${pgBase}?sslmode=disable&connect_timeout=30`;
            break;
        }
      }
      
      set({ 
        activeConnection: { config: connection, connectionString },
        tableViewerState: { connection, tableName, schema },
        viewMode: 'table-viewer',
        selectedTable: null
      });
    } else {
      // 使用现有连接
      console.log('✅ 使用现有连接');
      set({ 
        tableViewerState: { connection, tableName, schema },
        viewMode: 'table-viewer',
        selectedTable: null
      });
    }
  },

  closeTableViewer: () => {
    console.log('❌ 关闭表数据查看器');
    set({ 
      viewMode: 'workbench',
      tableViewerState: null
    });
  },

  selectTable: (tableName: string, schema?: string) => {
    console.log('📋 选择表:', tableName, 'schema:', schema);
    set({ selectedTable: { name: tableName, schema } });
  },

  clearSelectedTable: () => {
    console.log('🗑️ 清除表选择');
    set({ selectedTable: null });
  },

  setDatabaseMetadata: (connectionId: string, metadata: AppState['databaseMetadata'][string]) => {
    console.log('💾 缓存数据库元数据:', connectionId);
    set(state => ({
      databaseMetadata: {
        ...state.databaseMetadata,
        [connectionId]: {
          ...metadata,
          lastUpdated: Date.now()
        }
      }
    }));
  },

  clearDatabaseMetadata: (connectionId?: string) => {
    if (connectionId) {
      console.log('🗑️ 清除特定数据库元数据:', connectionId);
      set(state => {
        const newMetadata = { ...state.databaseMetadata };
        delete newMetadata[connectionId];
        return { databaseMetadata: newMetadata };
      });
    } else {
      console.log('🗑️ 清除所有数据库元数据');
      set({ databaseMetadata: {} });
    }
  },

  handleConnectionDeleted: (deletedConnectionId: string) => {
    console.log('🗑️ 处理连接删除:', deletedConnectionId);
    const currentState = get();
    
    // 如果删除的是当前活跃连接，清除活跃连接状态
    if (currentState.activeConnection && currentState.activeConnection.config.id === deletedConnectionId) {
      set({ 
        activeConnection: null,
        selectedTable: null,
        tableViewerState: null,
        viewMode: 'workbench'
      });
    }
    
    // 清除相关的元数据缓存
    get().clearDatabaseMetadata(deletedConnectionId);
  },

  setConnectionReady: (ready: boolean) => {
    console.log('🔄 设置连接状态:', ready ? '已准备就绪' : '未准备就绪');
    set({ connectionReady: ready });
  }
})); 
