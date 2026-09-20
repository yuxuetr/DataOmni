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
  
  // 连接表单弹窗。放在应用级状态里，好让欢迎页等非侧边栏入口也能打开它
  connectionForm:
    | { mode: 'create' }
    | { mode: 'edit'; connection: ConnectionProfile }
    | null;
  
  // 数据库元数据缓存
  databaseMetadata: Record<string, CachedDatabaseMetadata>;
  
  // 连接状态监听
  connectionReady: boolean;
}

// 应用操作接口
export interface AppActions {
  // 连接表单管理
  openConnectionForm: (connection?: ConnectionProfile) => void;
  closeConnectionForm: () => void;
  
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
  connectionForm: null,
  databaseMetadata: {},
  connectionReady: false,

  openConnectionForm: (connection?: ConnectionProfile) => {
    // 只认真正的配置对象。把这个动作直接挂到 onClick 上时，React 传进来的是
    // MouseEvent——它是真值，会让表单以「编辑」模式打开一个事件对象，
    // 而 TypeScript 拦不住：`() => void` 的调用点允许多传实参。
    const editing = typeof connection === 'object'
      && connection !== null
      && typeof (connection as ConnectionProfile).id === 'string';

    set({
      connectionForm: editing
        ? { mode: 'edit', connection: connection as ConnectionProfile }
        : { mode: 'create' }
    });
  },

  closeConnectionForm: () => {
    set({ connectionForm: null });
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
