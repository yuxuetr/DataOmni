import { create } from 'zustand';
import type {
  CachedDatabaseMetadata,
  ConnectionProfile
} from '../contracts';

// 应用状态接口
export interface AppState {
  // 当前活跃的数据库连接
  activeConnection: {
    config: ConnectionProfile;
    connectionString: string;
  } | null;
  
  // 选中的表（用于SQL工作台）
  selectedTable: {
    name: string;
    schema?: string;
  } | null;
  
  // 数据库元数据缓存
  databaseMetadata: Record<string, CachedDatabaseMetadata>;
  
  // 连接状态监听
  connectionReady: boolean;
}

// 应用操作接口
export interface AppActions {
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
export const useAppStore = create<AppStore>((set) => ({
  // 初始状态
  activeConnection: null,
  selectedTable: null,
  databaseMetadata: {},
  connectionReady: false,

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
