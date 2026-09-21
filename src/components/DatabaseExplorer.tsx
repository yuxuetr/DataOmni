import { useState, useEffect } from 'react';
import {
  Database,
  ChevronDown,
  ChevronRight,
  Table,
  View,
  FunctionSquare,
  GitBranch,
  Hash,
  RefreshCw,
  Loader,
  AlertCircle,
  Info
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { describeError } from '../utils/describeError';
import { useLanguageStore } from '../stores/languageStore';
import {
  buildObjectTree,
  KIND_LABEL_KEYS,
  isBrowsableKind,
  normalizeObjectRows,
  showsSchemaLevel,
  type DatabaseObject,
  type DatabaseObjectKind,
  type ObjectTreeNode
} from '../utils/databaseObjects';
import { ObjectDefinitionDialog } from './ObjectDefinitionDialog';
import { useConnectionStore } from '../stores/connectionStore';
import { useQueryStore } from '../stores/queryStore';
import { useAppStore } from '../stores/appStore';
import { validateDatabaseConnection } from '../utils/stateSync';

interface DatabaseExplorerProps {
  connectionId: string;
  onTableSelect?: (tableName: string, schema?: string) => void;
  onOpenErDiagram?: () => void;
}

/** `get_object_catalog_queries` 的返回；字段名按 Rust 侧的 snake_case */
export interface ObjectCatalogQueries {
  objects: string;
  routine_definition: string;
  sequence_properties: string | null;
  object_parameter_count: number;
}

export default function DatabaseExplorer({
  connectionId,
  onTableSelect,
  onOpenErDiagram
}: DatabaseExplorerProps) {
  const { connections } = useConnectionStore();
  const { database } = useQueryStore();
  const {
    databaseMetadata,
    setDatabaseMetadata,
    connectionReady,
    schemaVersion
  } = useAppStore();
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 展开状态按节点 key 存；schema 与类型分组共用一套
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [inspecting, setInspecting] = useState<DatabaseObject | null>(null);

  const t = useLanguageStore((state) => state.t);
  const kindLabel = (kind: DatabaseObjectKind) => t(KIND_LABEL_KEYS[kind]);

  const connection = connections.find(c => c.id === connectionId);

  // 检查是否有缓存的元数据
  const cachedMetadata = databaseMetadata[connectionId];
  const isMetadataStale = cachedMetadata && (Date.now() - cachedMetadata.lastUpdated) > 5 * 60 * 1000; // 5分钟过期

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
        kindLabel
      );
      if (cachedTree.length > 0) {
        setExpandedNodes(new Set(defaultExpandedKeys(cachedTree)));
      }
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
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

      const tree = buildObjectTree(objects, showsSchemaLevel(connection.db_type), kindLabel);
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
  
  // 添加额外的连接ID变化监听，确保连接切换时清理旧状态
  useEffect(() => {
    console.log('🔄 DatabaseExplorer: 连接ID变化，清理旧状态:', connectionId);
    setError(null);
    setExpandedNodes(new Set());
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

  const objects = cachedMetadata && !isMetadataStale ? cachedMetadata.objects : [];
  const tree = buildObjectTree(objects, showsSchemaLevel(connection.db_type), kindLabel);

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

  return (
    <div className="h-full flex flex-col bg-surface">
      {/* 头部 */}
      <div className="flex items-center justify-between p-3 border-b bg-surface-sunken">
        <div className="flex items-center space-x-2">
          <Database className="text-accent" size={16} />
          <h2 className="text-sm font-semibold text-fg">{t('explorer.title')}</h2>
          {connectionReady ? (
            <span className="text-xs text-success bg-success-soft px-2 py-0.5 rounded-control">
              {t('explorer.connected')}
            </span>
          ) : (
            <span className="text-xs text-warning bg-warning-soft px-2 py-0.5 rounded-control">
              {t('explorer.connecting')}
            </span>
          )}
          {cachedMetadata && !isMetadataStale && (
            <span className="text-xs text-accent bg-accent-soft px-2 py-0.5 rounded-control">
              {t('explorer.cached')}
            </span>
          )}
        </div>
        
        <div className="flex items-center gap-1">
          {onOpenErDiagram && (
            <button
              onClick={onOpenErDiagram}
              className="p-1 text-fg-muted hover:text-accent transition-colors"
              title={t('er.open')}
              aria-label={t('er.open')}
            >
              <GitBranch size={14} />
            </button>
          )}
          <button
            onClick={() => loadDatabaseMetadata(true)}
            disabled={loading}
            className="p-1 text-fg-muted hover:text-accent transition-colors"
            title={t('explorer.refresh')}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

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
        {loading ? (
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
            <p>{t('explorer.empty')}</p>
          </div>
        ) : (
          <div className="p-2">
            {tree.map(node => (
              <ObjectTreeGroup
                key={node.key}
                node={node}
                depth={0}
                expandedNodes={expandedNodes}
                onToggle={toggleNode}
                onSelect={handleObjectClick}
              />
            ))}
          </div>
        )}
      </div>

      {inspecting && (
        <ObjectDefinitionDialog
          object={inspecting}
          connection={connection}
          onClose={() => setInspecting(null)}
        />
      )}
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
  onToggle,
  onSelect
}: {
  node: ObjectTreeNode;
  depth: number;
  expandedNodes: Set<string>;
  onToggle: (key: string) => void;
  onSelect: (object: DatabaseObject) => void;
}) {
  const expanded = expandedNodes.has(node.key);

  return (
    <div className="mb-1">
      <button
        onClick={() => onToggle(node.key)}
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
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}

      {expanded && !node.children && (
        <div className="mt-0.5 space-y-0.5">
          {node.objects.map(object => (
            <button
              key={`${object.kind}:${object.id}`}
              onClick={() => onSelect(object)}
              className="w-full flex items-center gap-2 px-2 py-1 text-sm text-fg-muted hover:bg-accent-soft hover:text-accent rounded-control transition-colors"
              style={{ paddingLeft: `${28 + depth * 12}px` }}
              title={object.name}
            >
              <ObjectIcon kind={object.kind} />
              <span className="truncate">{object.name}</span>
            </button>
          ))}
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
