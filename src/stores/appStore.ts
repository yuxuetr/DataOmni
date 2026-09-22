import { create } from 'zustand';
import type {
  CachedCompletionCatalog,
  CachedDatabaseMetadata,
  ColumnInfo,
  ConnectionProfile
} from '../contracts';
import type { SchemaObjects } from '../utils/schemaObjects';

/**
 * 一张表的结构。列先到，索引外键触发器随后补上，所以 `objects` 可以先是 null。
 *
 * **为什么要缓存**：表标签切走就卸载，切回来时列目录、索引、外键、触发器四条
 * 目录查询会原样再发一遍。前端画 200 行只要 109.5ms，而这几条往返在一条 30ms
 * RTT 的远程库上就是几百毫秒——而这期间表结构并没有变。
 */
export interface CachedTableStructure {
  connectionId: string;
  columns: ColumnInfo[];
  objects: SchemaObjects | null;
  /**
   * 写入时的 `schemaVersion`。读的时候对不上就当没有这份缓存——**我们自己**
   * 执行过 DDL 之后这一份立刻作废。
   */
  schemaVersion: number;
  /**
   * 写入时刻。版本号追不上**别人**改的结构，所以还要一个过期时间兜底，
   * 否则一份读岔的列会一直留着，直到用户碰巧去结构页点一下刷新。
   */
  lastUpdated: number;
}

/**
 * 缓存多久算旧。
 *
 * 和对象树用的是同一个数：两者都是「库结构的一份快照」，外部改动都只能靠
 * 重新拉取追上，没有理由各定一个。
 */
export const METADATA_TTL_MS = 5 * 60 * 1000;

/** 表结构缓存的键。和 `tableEditStore` 的键同构，但那边存的是用户没提交的改动 */
export function tableStructureKey(
  connectionId: string,
  schema: string | null | undefined,
  table: string
): string {
  return `${connectionId}:${schema ?? ''}:${table}`;
}

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

  /** 表结构缓存，键见 `tableStructureKey` */
  tableStructures: Record<string, CachedTableStructure>;
  
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
  /** 写入或补齐一份表结构；`schemaVersion` 由 store 自己盖章，调用方不该关心 */
  cacheTableStructure: (
    key: string,
    connectionId: string,
    patch: { columns?: ColumnInfo[]; objects?: SchemaObjects | null }
  ) => void;
  
  // 连接状态管理
  setConnectionReady: (ready: boolean) => void;

  /** 执行过改结构的语句后调用，订阅了 schemaVersion 的视图会重新拉取 */
  markSchemaChanged: () => void;
}

// 应用Store类型
export type AppStore = AppState & AppActions;

function dropConnection(
  structures: Record<string, CachedTableStructure>,
  connectionId: string
): Record<string, CachedTableStructure> {
  return Object.fromEntries(
    Object.entries(structures).filter(([, entry]) => entry.connectionId !== connectionId)
  );
}

/**
 * 读一份还作数的表结构；版本对不上就当没有。
 *
 * 单独写成函数而不是在组件里比一次：「什么算过期」只该有一处定义，
 * 而它同时被加载路径和测试用到。
 */
export function selectTableStructure(
  state: Pick<AppState, 'tableStructures' | 'schemaVersion'>,
  key: string,
  now: number = Date.now()
): CachedTableStructure | null {
  const entry = state.tableStructures[key];
  if (!entry || entry.schemaVersion !== state.schemaVersion) {
    return null;
  }
  return now - entry.lastUpdated <= METADATA_TTL_MS ? entry : null;
}

// 创建应用Store
export const useAppStore = create<AppStore>((set) => ({
  // 初始状态
  activeConnection: null,
  selectedTable: null,
  connectionForm: null,
  databaseMetadata: {},
  tableStructures: {},
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
        return {
          databaseMetadata: newMetadata,
          completionCatalogs: newCatalogs,
          tableStructures: dropConnection(state.tableStructures, connectionId)
        };
      });
    } else {
      console.log('🗑️ 清除所有数据库元数据');
      set({ databaseMetadata: {}, completionCatalogs: {}, tableStructures: {} });
    }
  },

  setCompletionCatalog: (connectionId: string, catalog: CachedCompletionCatalog) => {
    set(state => ({
      completionCatalogs: { ...state.completionCatalogs, [connectionId]: catalog }
    }));
  },

  cacheTableStructure: (key, connectionId, patch) => {
    set(state => {
      const current = state.tableStructures[key];
      // 版本对不上的那一份不拿来合并：它描述的是 DDL 之前的那张表
      const base = current && current.schemaVersion === state.schemaVersion ? current : null;
      const columns = patch.columns ?? base?.columns;
      if (!columns) {
        // 列还没到就不建条目：一份没有列的结构缓存，读出来只会让人以为读过了
        return {};
      }
      return {
        tableStructures: {
          ...state.tableStructures,
          [key]: {
            connectionId,
            columns,
            objects: 'objects' in patch ? patch.objects ?? null : base?.objects ?? null,
            schemaVersion: state.schemaVersion,
            lastUpdated: Date.now()
          }
        }
      };
    });
  },

  setConnectionReady: (ready: boolean) => {
    console.log('🔄 设置连接状态:', ready ? '已准备就绪' : '未准备就绪');
    set({ connectionReady: ready });
  },

  markSchemaChanged: () => {
    set((state) => ({ schemaVersion: state.schemaVersion + 1 }));
  }
})); 
