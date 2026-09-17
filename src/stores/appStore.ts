import { create } from 'zustand';
import { ConnectionConfig } from './connectionStore';

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
  // 视图模式管理
  setViewMode: (mode: ViewMode) => void;
  
  // 表数据查看器管理
  openTableViewer: (connection: ConnectionConfig, tableName: string, schema?: string) => void;
  closeTableViewer: () => void;
  
  // 表选择管理
  selectTable: (tableName: string, schema?: string) => void;
  clearSelectedTable: () => void;
  
  // 数据库元数据管理
  setDatabaseMetadata: (connectionId: string, metadata: AppState['databaseMetadata'][string]) => void;
  clearDatabaseMetadata: (connectionId?: string) => void;
  
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

  setViewMode: (mode: ViewMode) => {
    console.log('📋 切换视图模式:', mode);
    set({ viewMode: mode });
  },

  openTableViewer: (connection: ConnectionConfig, tableName: string, schema?: string) => {
    console.log('🖱️ 打开表数据查看器:', tableName, 'schema:', schema);
    
    const currentState = get();
    if (
      !currentState.activeConnection ||
      currentState.activeConnection.config.id !== connection.id ||
      !currentState.connectionReady
    ) {
      throw new Error('无法打开数据表：数据库会话未连接或尚未就绪');
    }

    set({
      tableViewerState: { connection, tableName, schema },
      viewMode: 'table-viewer',
      selectedTable: null
    });
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

  setConnectionReady: (ready: boolean) => {
    console.log('🔄 设置连接状态:', ready ? '已准备就绪' : '未准备就绪');
    set({ connectionReady: ready });
  }
})); 
