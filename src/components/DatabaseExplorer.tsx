import { useState, useEffect, useRef } from 'react';
import { PLAIN_TEXT_INPUT } from './FormControls';
import {
  Database,
  ChevronDown,
  ChevronRight,
  Table,
  View,
  FunctionSquare,
  GitBranch,
  Hash,
  Plus,
  FolderPlus,
  Table2,
  RefreshCw,
  Loader,
  AlertCircle,
  Info,
  Search,
  X
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { speaksSql, supportsFeature } from '../contracts/databaseSupport';
import { useLanguageStore } from '../stores/languageStore';
import {
  buildObjectTree,
  filterObjects,
  KIND_LABEL_KEYS,
  isBrowsableKind,
  normalizeObjectRows,
  renderedTreeObjects,
  showsSchemaLevel,
  trailingSchemas,
  type DatabaseObject,
  type DatabaseObjectKind,
  type ObjectTreeNode
} from '../utils/databaseObjects';
import { ObjectDefinitionDialog } from './ObjectDefinitionDialog';
import { CreateTableDialog } from './CreateTableDialog';
import { CreateSchemaDialog } from './CreateSchemaDialog';
import { identifierDialectFor } from '../utils/sqlIdentifiers';
import { ObjectContextMenu } from './ObjectContextMenu';
import { qualifiedObjectName, type ObjectMenuAction } from '../utils/objectMenu';
import {
  CREATES_SCHEMAS,
  dropObjectSql,
  isDroppableKind,
  truncateTableSql,
  type DroppableKind
} from '../utils/objectDdl';
import { batchReversibility } from '../utils/statementReversibility';
import { serverLabel } from '../utils/serverPresets';
import { tabsShowingTable } from '../contracts/workspace';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { DestructiveStatementPrompt } from './DestructiveStatementPrompt';
import { describeError } from '../utils/describeError';
import {
  flattenVisibleTree,
  objectNodeKey,
  treeKeyAction,
  type FlatTreeNode
} from '../utils/treeNavigation';
import { useConnectionStore } from '../stores/connectionStore';
import { useContextMenu } from '../hooks/useContextMenu';
import { useQueryStore } from '../stores/queryStore';
import { MongoCreateCollectionDialog } from './MongoCreateCollectionDialog';
import { dropCollectionCommand } from '../utils/mongoCommandText';
import { METADATA_TTL_MS, useAppStore } from '../stores/appStore';
import { validateDatabaseConnection } from '../utils/stateSync';
import { clsx } from 'clsx';
import type { TranslationKey } from '../i18n/translate';
import { connectionHealth, type ConnectionHealth } from '../utils/connectionHealth';

/** 确认框里「会丢什么」那一行。视图不存数据，只说删了它 */
const DROP_IMPACT_KEYS: Record<DroppableKind, TranslationKey> = {
  table: 'object.impact.dropTable',
  view: 'object.impact.dropView',
  'materialized-view': 'object.impact.dropMaterializedView'
};

/** 等着确认的那一条改库动作。语句在弹框之前就定下来，确认框里给人看的就是要跑的 */
interface PendingObjectChange {
  object: DatabaseObject;
  action: 'drop' | 'truncate';
  sql: string;
}

interface DatabaseExplorerProps {
  connectionId: string;
  onTableSelect?: (tableName: string, schema?: string) => void;
  /** 直接打开结构页。此前没有任何入口造得出 `table-structure` 标签 */
  onOpenStructure?: (tableName: string, schema?: string) => void;
  onOpenErDiagram?: () => void;
}

/** `get_object_catalog_queries` 的返回；字段名按 Rust 侧的 snake_case */
export interface ObjectCatalogQueries {
  objects: string;
  routine_definition: string;
  sequence_properties: string | null;
  object_parameter_count: number;
}

/**
 * 连接状态 → 那个小标记长什么样。
 *
 * 写成完整的 Record：多一种连接状态时这里编译不过，而不是继续用旧的两分法
 * 把「断了」画成「连接中」——那正是它此前做的事。
 */
const HEALTH_BADGE: Record<ConnectionHealth, { labelKey: TranslationKey; className: string }> = {
  connected: { labelKey: 'explorer.connected', className: 'text-success bg-success-soft' },
  connecting: { labelKey: 'explorer.connecting', className: 'text-warning bg-warning-soft' },
  lost: { labelKey: 'explorer.connectionLost', className: 'text-danger bg-danger-soft' },
  failed: { labelKey: 'explorer.connectFailed', className: 'text-danger bg-danger-soft' },
  disconnected: { labelKey: 'explorer.notConnected', className: 'text-fg-muted bg-surface-sunken' }
};

export default function DatabaseExplorer({
  connectionId,
  onTableSelect,
  onOpenStructure,
  onOpenErDiagram
}: DatabaseExplorerProps) {
  const { connections } = useConnectionStore();
  const {
    database,
    connectionString,
    isConnecting,
    connectionLost,
    // 局部的 error 是「对象列表没读出来」，和连接死没死是两回事
    error: connectionError
  } = useQueryStore();
  const {
    databaseMetadata,
    setDatabaseMetadata,
    connectionReady,
    schemaVersion
  } = useAppStore();
  
  const health = connectionHealth({
    isConnecting,
    connectionLost,
    hasSession: database !== null,
    connectionReady,
    error: connectionError
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 展开状态按节点 key 存；schema 与类型分组共用一套
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [inspecting, setInspecting] = useState<DatabaseObject | null>(null);
  const [creatingTable, setCreatingTable] = useState(false);
  const [creatingSchema, setCreatingSchema] = useState(false);
  const [creatingCollection, setCreatingCollection] = useState(false);
  const queryTimeoutMs = useQueryStore((state) => state.queryTimeoutMs);
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(null);
  /**
   * 刚建好的 schema。树上的 schema 来自对象，空的那个不会出现，建表框的
   * 下拉里也就没有它——所以建完直接进建表，把它补进下拉并选中
   */
  const [newSchema, setNewSchema] = useState<string | null>(null);
  const [objectMenu, setObjectMenu] = useState<
    { object: DatabaseObject; position: { x: number; y: number } } | null
  >(null);
  // 复制失败与删表 / 清空失败共用这一条：都是「右键菜单那一下没成」
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingChange, setPendingChange] = useState<PendingObjectChange | null>(null);
  const markSchemaChanged = useAppStore((state) => state.markSchemaChanged);
  /**
   * 键盘焦点落在哪个节点上。整棵树只有一个 Tab 停靠点（roving tabindex），
   * 进来之后用方向键走——此前每个对象都是独立的停靠点，单组上限 200，
   * 意味着最多按 200 次 Tab 才走得过这一组
   */
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  // 筛选词。不进 store——它属于「此刻正在找什么」，换个连接就该没了
  const [filter, setFilter] = useState('');

  const t = useLanguageStore((state) => state.t);
  const kindLabel = (kind: DatabaseObjectKind) => t(KIND_LABEL_KEYS[kind]);

  const connection = connections.find(c => c.id === connectionId);

  // 检查是否有缓存的元数据
  const cachedMetadata = databaseMetadata[connectionId];
  const isMetadataStale = cachedMetadata && (Date.now() - cachedMetadata.lastUpdated) > METADATA_TTL_MS;

  // 加载数据库元数据
  const loadDatabaseMetadata = async (forceRefresh = false) => {
    if (!database || !connection) return;
    
    // 验证连接状态
    if (!validateDatabaseConnection()) {
      console.warn('⚠️ DatabaseExplorer: 连接状态不一致，跳过元数据加载');
      return;
    }
    
    // 如果是强制刷新或者没有缓存，直接加载
    if (forceRefresh || !cachedMetadata || isMetadataStale) {
      console.log('🔄 加载数据库元数据:', connectionId, forceRefresh ? '(强制刷新)' : '');
    } else {
      console.log('📋 使用缓存的数据库元数据:', connectionId);
      const cachedTree = buildObjectTree(
        cachedMetadata.objects,
        showsSchemaLevel(connection.db_type),
        kindLabel,
        trailingSchemas(connection.db_type)
      );
      if (cachedTree.length > 0) {
        setExpandedNodes(new Set(defaultExpandedKeys(cachedTree)));
      }
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
      // MongoDB 没有目录 SQL：后端直接给出同一形状的行（库名在 object_schema）
      if (!speaksSql(connection.db_type)) {
        const rows = await invoke<Record<string, unknown>[]>('mongodb_list_collections', {
          connectionString
        });
        const objects = normalizeObjectRows(rows);
        setDatabaseMetadata(connectionId, { objects, lastUpdated: Date.now() });
        setExpandedNodes(new Set(defaultExpandedKeys(
          buildObjectTree(objects, showsSchemaLevel(connection.db_type), kindLabel, trailingSchemas(connection.db_type))
        )));
        return;
      }

      const queries = await invoke<ObjectCatalogQueries>('get_object_catalog_queries', {
        dbType: connection.db_type
      });

      // 没有库名时 `table_schema = NULL` 恒不匹配，会安静地查出 0 行，
      // 让人以为库是空的。这里直接说清楚。
      if (queries.object_parameter_count > 0 && !connection.database) {
        throw new Error(t('explorer.noDatabaseName'));
      }
      // MySQL 的 UNION 两边各要绑一次库名，个数由后端声明，不在这里猜
      const params = Array.from(
        { length: queries.object_parameter_count },
        () => connection.database
      );

      const rows = await database.select(queries.objects, params);
      const objects = normalizeObjectRows(Array.isArray(rows) ? rows : []);

      setDatabaseMetadata(connectionId, { objects, lastUpdated: Date.now() });

      const tree = buildObjectTree(objects, showsSchemaLevel(connection.db_type), kindLabel, trailingSchemas(connection.db_type));
      setExpandedNodes(new Set(defaultExpandedKeys(tree)));
    } catch (err) {
      console.error('加载数据库元数据失败:', err);
      // 原始错误必须可见：只说「失败」等于没说，用户和我们都无从下手
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  // 组件挂载时加载数据
  useEffect(() => {
    if (connectionId && database && connectionReady) {
      console.log('🔄 DatabaseExplorer: 连接准备就绪，重新加载元数据:', connectionId);
      // 添加短暂延时确保数据库连接对象已完全同步
      const timeoutId = setTimeout(() => {
        loadDatabaseMetadata(true); // 强制刷新，确保获取最新数据
      }, 100);
      
      return () => clearTimeout(timeoutId);
    }
    // schemaVersion：我们自己执行过 DDL 之后重新拉一遍，新建的表立刻出现在树里
  }, [connectionId, connectionReady, schemaVersion]);
  
  // 过期的那一刻不会自己触发渲染；下一次渲染发现过期了就重新拉，旧列表在拉的
  // 过程中照常显示。失败时显示错误，而 isMetadataStale 不再变化，不会反复重试
  useEffect(() => {
    if (isMetadataStale && connectionReady && !loading) {
      loadDatabaseMetadata(true);
    }
    // 故意不依赖 loading：失败后 loading 落回 false 而过期还在，依赖它就会无限重试
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMetadataStale, connectionReady]);

  // 添加额外的连接ID变化监听，确保连接切换时清理旧状态
  useEffect(() => {
    console.log('🔄 DatabaseExplorer: 连接ID变化，清理旧状态:', connectionId);
    setError(null);
    setExpandedNodes(new Set());
    setFilter('');
  }, [connectionId]);

  // 调试：监控连接状态变化
  useEffect(() => {
    console.log('🔍 DatabaseExplorer 连接状态变化:', {
      connectionId,
      hasDatabase: !!database,
      hasConnection: !!connection,
      connectionReady,
      cachedMetadata: !!cachedMetadata,
      isMetadataStale
    });
  }, [connectionId, database, connection, connectionReady, cachedMetadata, isMetadataStale]);

  if (!connection) {
    return (
      <div className="h-full flex items-center justify-center text-fg-muted">
        {t('explorer.connectionMissing')}
      </div>
    );
  }

  const createLabel = !speaksSql(connection.db_type)
    ? t('mongo.collection.new')
    : CREATES_SCHEMAS.has(identifierDialectFor(connection.db_type))
      ? t('explorer.createMenu')
      : t('ddl.createTable');

  // 过期只决定「该重新拉了」，不决定「不给看」。此前两件事是同一个条件：
  // 连上五分钟之后随便点一下，整棵树就变成「没有数据库对象」，而且没有
  // 任何东西去重新加载，只能自己想到去点刷新
  const objects = cachedMetadata ? cachedMetadata.objects : [];
  // 先筛再建树：分组是按筛完的结果分的，所以标题上的计数就是命中数，
  // 而一个都没命中的类型根本不会出现——不用再画一行「函数 0」
  const matching = filterObjects(objects, filter);
  const filtering = filter.trim().length > 0;
  const tree = buildObjectTree(matching, showsSchemaLevel(connection.db_type), kindLabel, trailingSchemas(connection.db_type));

  const toggleNode = (key: string) => {
    setExpandedNodes(current => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  /**
   * 表、视图、物化视图有行，用表视图打开；函数与序列没有行，
   * 打开表视图只会查询失败，改为弹出定义。
   */
  const handleObjectClick = (object: DatabaseObject) => {
    if (!isBrowsableKind(object.kind)) {
      setInspecting(object);
      return;
    }
    onTableSelect?.(object.name, object.schema ?? undefined);
  };

  // Tab 进来时停在哪一个。焦点还没落下、或者落在一个已经收起来/被筛掉的节点上时
  // 回到第一个——把 tabIndex=0 留在一个画不出来的节点上，整棵树就 Tab 不进去了
  const visibleNodes: FlatTreeNode[] = flattenVisibleTree(
    tree,
    (key) => filtering || expandedNodes.has(key)
  );
  const rovingKey = visibleNodes.some((node) => node.key === focusedKey)
    ? focusedKey
    : visibleNodes[0]?.key ?? null;

  const focusNode = (key: string) => {
    setFocusedKey(key);
    // 等这一帧画完再聚焦：展开之后那个节点才存在
    requestAnimationFrame(() => nodeRefs.current.get(key)?.focus());
  };

  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const flat = visibleNodes;
    const action = treeKeyAction(event.key, flat, rovingKey);
    if (!action) {
      // 不归对象树管的键原样放过去，不要 preventDefault
      return;
    }
    event.preventDefault();

    if (action.kind === 'focus') {
      focusNode(action.key);
      return;
    }
    if (action.kind === 'expand' || action.kind === 'collapse') {
      toggleNode(action.key);
      setFocusedKey(action.key);
      return;
    }

    const node = flat.find((candidate) => candidate.key === action.key);
    if (node?.object) {
      handleObjectClick(node.object);
    } else {
      toggleNode(action.key);
    }
  };

  const runObjectAction = (action: ObjectMenuAction, object: DatabaseObject) => {
    const schema = object.schema ?? undefined;
    if (action === 'open-data') {
      onTableSelect?.(object.name, schema);
      return;
    }
    if (action === 'open-structure') {
      onOpenStructure?.(object.name, schema);
      return;
    }
    if (action === 'view-definition') {
      setInspecting(object);
      return;
    }

    // MongoDB 删集合或视图发 `drop` 命令；确认框里给人看的是等价的 mongosh 写法
    if (connection && !speaksSql(connection.db_type) && action === 'drop') {
      setActionError(null);
      setPendingChange({ object, action, sql: dropCollectionCommand(object.schema ?? '', object.name) });
      return;
    }

    // MongoDB 复制的是命名空间 `库.集合`：mongosh 的 `use` 与各家工具认的都是它
    if (connection && !speaksSql(connection.db_type)) {
      navigator.clipboard
        .writeText(object.schema ? `${object.schema}.${object.name}` : object.name)
        .then(() => setActionError(null))
        .catch((cause) => setActionError(describeError(cause, t('common.copyFailed'))));
      return;
    }

    const dialect = connection ? identifierDialectFor(connection.db_type) : 'sqlite';
    if (action === 'drop' || action === 'truncate') {
      const { kind } = object;
      if (action === 'drop' && !isDroppableKind(kind)) {
        return;
      }
      setActionError(null);
      setPendingChange({
        object,
        action,
        sql: action === 'drop' && isDroppableKind(kind)
          ? dropObjectSql({ ...object, kind }, dialect)
          : truncateTableSql(object, dialect)
      });
      return;
    }

    navigator.clipboard
      .writeText(qualifiedObjectName(object, dialect))
      .then(() => setActionError(null))
      // 剪贴板会被权限或非安全上下文拒绝。静默失败的后果是以为复制成功了，
      // 粘出来却是上一次的东西
      .catch((cause) => setActionError(describeError(cause, t('common.copyFailed'))));
  };

  const runObjectChange = async ({ object, action, sql }: PendingObjectChange) => {
    try {
      if (connection && !speaksSql(connection.db_type)) {
        await invoke('mongodb_drop_collection', {
          connectionString,
          database: object.schema ?? '',
          collection: object.name,
          timeoutMs: queryTimeoutMs
        });
      } else {
        await invoke<number[]>('execute_write_batch', {
          connectionId,
          statements: [{ sql, params: [], expectRows: null }]
        });
      }
    } catch (cause) {
      setActionError(describeError(cause));
      return;
    }
    if (action === 'drop') {
      // 删掉的表还开着的标签留着只会显示旧数据，下次刷新再报「表不存在」
      const { tabs, closeTab } = useWorkspaceStore.getState();
      tabsShowingTable(tabs, connectionId, { schema: object.schema, table: object.name })
        .forEach((tab) => closeTab(tab.id));
    }
    markSchemaChanged();
  };

  const changeImpact = ({ object, action }: PendingObjectChange): string => {
    const name = object.schema ? `${object.schema}.${object.name}` : object.name;
    if (action === 'truncate') {
      return connection && identifierDialectFor(connection.db_type) === 'sqlite'
        ? t('object.impact.truncateSqlite', { name })
        : t('object.impact.truncate', { name });
    }
    if (object.kind === 'collection') {
      return t('object.impact.dropCollection', { name });
    }
    return isDroppableKind(object.kind)
      ? t(DROP_IMPACT_KEYS[object.kind], { name })
      : name;
  };

  return (
    <div className="h-full flex flex-col bg-surface">
      {/* 头部 */}
      <div className="flex items-center justify-between p-3 border-b bg-surface-sunken">
        <div className="flex min-w-0 items-center space-x-2 overflow-hidden">
          <Database className="shrink-0 text-accent" size={16} />
          <h2 className="text-sm font-semibold text-fg">{t('explorer.title')}</h2>
          {/* 和工作台头部同一个纯函数：两处各判各的时候它们真的会说不一样的话 */}
          <span className={clsx('text-xs px-2 py-0.5 rounded-control', HEALTH_BADGE[health].className)}>
            {t(HEALTH_BADGE[health].labelKey)}
          </span>
        </div>
        
        {/* 按钮不让位：窄的时候宁可截掉左边的状态标记，也不能让「+」与刷新消失 */}
        <div className="flex shrink-0 items-center gap-1">
          {onOpenErDiagram && speaksSql(connection.db_type) && (
            <button
              onClick={onOpenErDiagram}
              className="p-1 text-fg-muted hover:text-accent transition-colors"
              title={t('er.open')}
              aria-label={t('er.open')}
            >
              <GitBranch size={14} />
            </button>
          )}
          {(!speaksSql(connection.db_type) || supportsFeature(connection.db_type, 'structureEditing')) && (
          <button
            onClick={(event) => {
              if (!speaksSql(connection.db_type)) {
                setCreatingCollection(true);
                return;
              }
              // 能建 schema 的方言上「+」是一个两项的小菜单，而不是再加一个图标：
              // 侧边栏默认宽度下多一个图标，「+」与刷新就被挤出头部了
              if (CREATES_SCHEMAS.has(identifierDialectFor(connection.db_type))) {
                const box = event.currentTarget.getBoundingClientRect();
                setCreateMenu({ x: box.left, y: box.bottom + 4 });
                return;
              }
              setCreatingTable(true);
            }}
            disabled={!connectionReady}
            className="p-1 text-fg-muted transition-colors hover:text-accent disabled:opacity-40"
            title={createLabel}
            aria-label={createLabel}
          >
            <Plus size={14} />
          </button>
          )}
          <button
            onClick={() => loadDatabaseMetadata(true)}
            disabled={loading}
            className="p-1 text-fg-muted hover:text-accent transition-colors"
            // 「已缓存」此前是头部的一个标记，和按钮挤在侧边栏默认宽度里，刷新按钮
            // 被挤出了头部。它说的正是「点这里会重新读」，放进这里的提示
            title={cachedMetadata && !isMetadataStale ? t('explorer.refreshCached') : t('explorer.refresh')}
            aria-label={t('explorer.refresh')}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* 筛选框。一个几千个对象的库里，滚动不是找东西的方式——实测一组 5000 张表
          在侧边栏里要滚 185 屏，而后面的「视图」「函数」两组连标题都看不见 */}
      {objects.length > 0 && (
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Search size={13} className="shrink-0 text-fg-subtle" />
          <input
            type="text"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t('explorer.filterPlaceholder')}
            aria-label={t('explorer.filter')}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
            {...PLAIN_TEXT_INPUT}
          />
          {filtering && (
            <button
              type="button"
              onClick={() => setFilter('')}
              title={t('explorer.filterClear')}
              aria-label={t('explorer.filterClear')}
              className="shrink-0 text-fg-subtle transition-colors hover:text-fg"
            >
              <X size={13} />
            </button>
          )}
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="p-3 bg-danger-soft border-b border-danger-line">
          <div className="flex items-center space-x-2">
            <AlertCircle className="text-danger" size={14} />
            <span className="text-danger text-sm">{error}</span>
          </div>
        </div>
      )}

      {/* 内容区域 */}
      <div className="flex-1 overflow-y-auto">
        {/* 手头已经有一棵树时重新拉不清掉它：刷新按钮本身在转，
            整片换成转圈只是让人在这几百毫秒里什么也点不了 */}
        {loading && objects.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <Loader className="animate-spin text-fg-subtle" size={16} />
            <span className="ml-2 text-fg-muted text-sm">{t('explorer.loading')}</span>
          </div>
        ) : error ? (
          // 出错时不再同时显示「暂无数据库对象」：那会让人以为库是空的，
          // 而真实情况是我们根本没读到
          <div className="p-4 text-center text-fg-muted text-sm">
            <p>{t('explorer.loadFailed')}</p>
            <button
              onClick={() => loadDatabaseMetadata(true)}
              className="mt-2 text-accent hover:underline"
            >
              {t('explorer.retry')}
            </button>
          </div>
        ) : tree.length === 0 ? (
          <div className="p-4 text-center text-fg-muted text-sm">
            <Info className="mx-auto mb-2" size={16} />
            {/* 三句话要分清楚：筛没了、库是空的、没连上。都写成「暂无对象」，
                会让一个打错字的人去找一个根本不存在的空库问题 */}
            <p>
              {filtering
                ? t('explorer.filterEmpty', { query: filter.trim() })
                : database
                  ? t('explorer.empty')
                  : t('explorer.notConnected')}
            </p>
          </div>
        ) : (
          <div
            role="tree"
            aria-label={t('explorer.title')}
            onKeyDown={handleTreeKeyDown}
            className="p-2"
          >
            {tree.map(node => (
              <ObjectTreeGroup
                key={node.key}
                node={node}
                depth={0}
                expandedNodes={expandedNodes}
                rovingKey={rovingKey}
                nodeRefs={nodeRefs}
                onFocusNode={setFocusedKey}
                // 筛选时一律展开：筛完还要自己一层层点开，等于没筛
                forceExpand={filtering}
                onToggle={toggleNode}
                onSelect={handleObjectClick}
                onContextMenu={(object, position) => setObjectMenu({ object, position })}
              />
            ))}
          </div>
        )}
      </div>

      {actionError && (
        <div className="flex items-start gap-2 border-t border-danger-line bg-danger-soft px-3 py-2 text-xs text-danger">
          <span className="min-w-0 flex-1 select-text break-words">{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            aria-label={t('common.close')}
            className="shrink-0 text-danger hover:opacity-70"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* 不看确认策略，一律确认：敲出来的 DROP 是意图，右键点错一行不是 */}
      {pendingChange && (
        <DestructiveStatementPrompt
          sql={pendingChange.sql}
          risk="destructive"
          statementCount={1}
          connectionName={connection.name}
          environment={connection.environment}
          databaseLabel={serverLabel(connection)}
          alwaysAsks
          // MongoDB 的 drop 发出去就生效，没有事务可言；一条命令，说「执行即生效」
          reversibility={speaksSql(connection.db_type)
            ? batchReversibility([pendingChange.sql], identifierDialectFor(connection.db_type))
            : { kind: 'atomic-batch' }}
          impacts={[changeImpact(pendingChange)]}
          onCancel={() => setPendingChange(null)}
          onConfirm={() => {
            const change = pendingChange;
            setPendingChange(null);
            void runObjectChange(change);
          }}
        />
      )}

      {objectMenu && (
        <ObjectContextMenu
          object={objectMenu.object}
          position={objectMenu.position}
          speaksSql={speaksSql(connection.db_type)}
          onRun={(action) => runObjectAction(action, objectMenu.object)}
          onDismiss={() => setObjectMenu(null)}
        />
      )}

      {inspecting && (
        <ObjectDefinitionDialog
          object={inspecting}
          connection={connection}
          onClose={() => setInspecting(null)}
        />
      )}

      {createMenu && (
        <CreateMenu
          position={createMenu}
          onDismiss={() => setCreateMenu(null)}
          onCreateTable={() => setCreatingTable(true)}
          onCreateSchema={() => setCreatingSchema(true)}
        />
      )}

      {creatingSchema && (
        <CreateSchemaDialog
          connectionId={connectionId}
          dialect={identifierDialectFor(connection.db_type)}
          onClose={() => setCreatingSchema(false)}
          onCreated={(schema) => {
            setCreatingSchema(false);
            setNewSchema(schema);
            setCreatingTable(true);
          }}
        />
      )}

      {creatingCollection && connectionString && (
        <MongoCreateCollectionDialog
          connectionString={connectionString}
          databases={[...new Set(
            objects.map((object) => object.schema).filter((name): name is string => !!name)
          )].sort()}
          timeoutMs={queryTimeoutMs}
          onClose={() => setCreatingCollection(false)}
          onCreated={() => {
            setCreatingCollection(false);
            void loadDatabaseMetadata(true);
          }}
        />
      )}

      {creatingTable && (
        <CreateTableDialog
          connectionId={connectionId}
          dialect={identifierDialectFor(connection.db_type)}
          // schema 取自已经读到的对象，不另发一次目录查询：能建表的 schema
          // 就是树里那几个，而凭空让用户手打一个名字只会打错
          schemas={[...new Set([
            ...objects.map((object) => object.schema).filter((name): name is string => !!name),
            ...(newSchema ? [newSchema] : [])
          ])].sort()}
          initialSchema={newSchema}
          username={connection.username}
          onClose={() => {
            setCreatingTable(false);
            setNewSchema(null);
          }}
          onCreated={(table, schema) => {
            void loadDatabaseMetadata(true);
            onTableSelect?.(table, schema ?? undefined);
          }}
        />
      )}
    </div>
  );
}

/** 头部「+」在能建 schema 的方言上展开的两项 */
function CreateMenu({
  position,
  onDismiss,
  onCreateTable,
  onCreateSchema
}: {
  position: { x: number; y: number };
  onDismiss: () => void;
  onCreateTable: () => void;
  onCreateSchema: () => void;
}) {
  const t = useLanguageStore((state) => state.t);
  const { ref, style } = useContextMenu<HTMLDivElement>(position, onDismiss);
  const items = [
    { key: 'table', label: t('ddl.createTable'), Icon: Table2, run: onCreateTable },
    { key: 'schema', label: t('schemaCreate.title'), Icon: FolderPlus, run: onCreateSchema }
  ];
  return (
    <div
      ref={ref}
      role="menu"
      style={style}
      className="fixed z-50 min-w-40 rounded-control border border-line-strong bg-surface py-1 shadow-lg"
    >
      {items.map(({ key, label, Icon, run }) => (
        <button
          key={key}
          type="button"
          role="menuitem"
          onClick={() => {
            run();
            onDismiss();
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-surface-hover"
        >
          <Icon size={14} className="shrink-0 text-fg-muted" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

/** 默认展开：顶层第一组，以及（有 schema 层时）它下面的第一类。 */
function defaultExpandedKeys(tree: ObjectTreeNode[]): string[] {
  const first = tree[0];
  if (!first) {
    return [];
  }
  return [first.key, ...(first.children?.slice(0, 1).map(child => child.key) ?? [])];
}

function ObjectTreeGroup({
  node,
  depth,
  expandedNodes,
  rovingKey,
  nodeRefs,
  onFocusNode,
  forceExpand,
  onToggle,
  onSelect,
  onContextMenu
}: {
  node: ObjectTreeNode;
  depth: number;
  expandedNodes: Set<string>;
  /** 整棵树唯一那个 Tab 停靠点 */
  rovingKey: string | null;
  nodeRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  onFocusNode: (key: string) => void;
  forceExpand: boolean;
  onToggle: (key: string) => void;
  onSelect: (object: DatabaseObject) => void;
  onContextMenu: (object: DatabaseObject, position: { x: number; y: number }) => void;
}) {
  const t = useLanguageStore((state) => state.t);
  const expanded = forceExpand || expandedNodes.has(node.key);
  const { shown, hidden } = renderedTreeObjects(node.objects);

  return (
    <div className="mb-1">
      <button
        ref={(element) => {
          if (element) {
            nodeRefs.current.set(node.key, element);
          } else {
            nodeRefs.current.delete(node.key);
          }
        }}
        role="treeitem"
        aria-expanded={expanded}
        aria-level={depth + 1}
        tabIndex={node.key === rovingKey ? 0 : -1}
        onFocus={() => onFocusNode(node.key)}
        onClick={() => onToggle(node.key)}
        // 焦点不另加底色：渲染验证过，浏览器默认的 outline 在深浅两套主题下
        // 都看得清。而按 `focusedKey` 涂底色的话，焦点离开树之后底色还留着，
        // 看上去像一个并不存在的选中态
        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm font-medium text-fg hover:bg-surface-hover rounded-control transition-colors"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {/* 只有 schema 一层给图标；类型分组的标题本身就说明了类型，再加图标是噪音 */}
        {node.children && <Database size={14} className="text-accent" />}
        <span className="truncate">{node.label}</span>
        <span className="text-xs text-fg-muted">({node.objects.length})</span>
      </button>

      {expanded && node.children && (
        <div className="mt-1">
          {node.children.map(child => (
            <ObjectTreeGroup
              key={child.key}
              node={child}
              depth={depth + 1}
              expandedNodes={expandedNodes}
              rovingKey={rovingKey}
              nodeRefs={nodeRefs}
              onFocusNode={onFocusNode}
              forceExpand={forceExpand}
              onToggle={onToggle}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}

      {expanded && !node.children && (
        <div className="mt-0.5 space-y-0.5">
          {shown.map(object => (
            <button
              key={objectNodeKey(object)}
              ref={(element) => {
                if (element) {
                  nodeRefs.current.set(objectNodeKey(object), element);
                } else {
                  nodeRefs.current.delete(objectNodeKey(object));
                }
              }}
              role="treeitem"
              aria-level={depth + 2}
              tabIndex={objectNodeKey(object) === rovingKey ? 0 : -1}
              onFocus={() => onFocusNode(objectNodeKey(object))}
              onClick={() => onSelect(object)}
              onContextMenu={(event) => {
                event.preventDefault();
                onContextMenu(object, { x: event.clientX, y: event.clientY });
              }}
              className="w-full flex items-center gap-2 px-2 py-1 text-sm text-fg-muted hover:bg-accent-soft hover:text-accent rounded-control transition-colors"
              style={{ paddingLeft: `${28 + depth * 12}px` }}
              title={object.name}
            >
              <ObjectIcon kind={object.kind} />
              <span className="truncate">{object.name}</span>
            </button>
          ))}
          {/* 被上限挡住的部分要说出来。少画几百行是性能取舍，而让人以为
              「这个库里没有这张表」是一个会让他去改连接配置的错误结论 */}
          {hidden > 0 && (
            <p
              className="px-2 py-1 text-xs text-fg-subtle"
              style={{ paddingLeft: `${28 + depth * 12}px` }}
            >
              {t('explorer.moreHidden', { count: hidden })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ObjectIcon({ kind }: { kind: DatabaseObjectKind }) {
  if (kind === 'view' || kind === 'materialized-view') {
    return <View size={14} className="shrink-0" />;
  }
  if (kind === 'function' || kind === 'procedure') {
    return <FunctionSquare size={14} className="shrink-0" />;
  }
  if (kind === 'sequence') {
    return <Hash size={14} className="shrink-0" />;
  }
  return <Table size={14} className="shrink-0" />;
} 
