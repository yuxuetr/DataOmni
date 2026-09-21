import { create } from 'zustand';
import type {
  CachedCompletionCatalog,
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

  /**
   * SQL 补全目录：整库的关系与列。由编辑器按需加载，对象树不需要它。
   * 与 `databaseMetadata` 同生共死——两者描述的是同一个库的结构。
   */
  completionCatalogs: Record<string, CachedCompletionCatalog>;
  
  // 连接状态监听
  connectionReady: boolean;

  /**
   * 库结构的版本号。每执行一条改结构的语句就 +1。
   *
   * 数据库不会推送「结构变了」这件事（PostgreSQL 的 LISTEN/NOTIFY 要自己
   * 装事件触发器，MySQL 干脆没有），所以做不到真正的推送式实时。能做到的是：
   * **我们自己执行的 DDL** 立刻反映出来——这也是绝大多数场景。
   * 外部改动靠刷新按钮或重新激活标签页时重新拉取。
   */
  schemaVersion: number;
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
  /** 忘掉这个连接（不给 id 就是所有连接）的库结构：对象目录与补全目录一起清 */
  clearDatabaseMetadata: (connectionId?: string) => void;
  setCompletionCatalog: (connectionId: string, catalog: CachedCompletionCatalog) => void;
  
  // 连接状态管理
  setConnectionReady: (ready: boolean) => void;

  /** 执行过改结构的语句后调用，订阅了 schemaVersion 的视图会重新拉取 */
  markSchemaChanged: () => void;
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
  completionCatalogs: {},
  connectionReady: false,
  schemaVersion: 0,

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
        const newCatalogs = { ...state.completionCatalogs };
        delete newMetadata[connectionId];
        delete newCatalogs[connectionId];
        return { databaseMetadata: newMetadata, completionCatalogs: newCatalogs };
      });
    } else {
      console.log('🗑️ 清除所有数据库元数据');
      set({ databaseMetadata: {}, completionCatalogs: {} });
    }
  },

  setCompletionCatalog: (connectionId: string, catalog: CachedCompletionCatalog) => {
    set(state => ({
      completionCatalogs: { ...state.completionCatalogs, [connectionId]: catalog }
    }));
  },

  setConnectionReady: (ready: boolean) => {
    console.log('🔄 设置连接状态:', ready ? '已准备就绪' : '未准备就绪');
    set({ connectionReady: ready });
  },

  markSchemaChanged: () => {
    set((state) => ({ schemaVersion: state.schemaVersion + 1 }));
  }
})); 
