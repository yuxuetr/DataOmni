import { useState, useEffect } from 'react';
import { 
  Database, 
  ChevronDown, 
  ChevronRight, 
  Table, 
  View,
  RefreshCw,
  Loader,
  AlertCircle,
  Info
} from 'lucide-react';
import { describeError } from '../utils/describeError';
import { useConnectionStore } from '../stores/connectionStore';
import { useQueryStore } from '../stores/queryStore';
import { useAppStore } from '../stores/appStore';
import { validateDatabaseConnection } from '../utils/stateSync';

interface DatabaseExplorerProps {
  connectionId: string;
  onTableSelect?: (tableName: string, schema?: string) => void;
}

// interface DatabaseMetadata {
//   schemas: Array<{
//     name: string;
//     tables: Array<{ name: string; type: string }>;
//   }>;
// }

export default function DatabaseExplorer({ connectionId, onTableSelect }: DatabaseExplorerProps) {
  const { connections } = useConnectionStore();
  const { database } = useQueryStore();
  const { 
    databaseMetadata, 
    setDatabaseMetadata, 
    connectionReady
  } = useAppStore();
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());

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
      // 默认展开第一个schema
      if (cachedMetadata.schemas.length > 0) {
        setExpandedSchemas(new Set([cachedMetadata.schemas[0].name]));
      }
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
      let schemas: Array<{ name: string; tables: Array<{ name: string; type: string }> }> = [];
      
      switch (connection.db_type) {
        case 'postgresql':
          // PostgreSQL: 获取所有schema和表
          const schemaResult = await database.select(`
            SELECT 
              table_schema::text AS table_schema,
              table_name::text AS table_name,
              table_type::text AS table_type
            FROM information_schema.tables 
            WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
            ORDER BY table_schema, table_name
          `);
          
          // 按schema分组
          const schemaMap = new Map<string, Array<{ name: string; type: string }>>();
          if (Array.isArray(schemaResult)) {
            schemaResult.forEach((row: any) => {
              const schemaName = row.table_schema || 'public';
              if (!schemaMap.has(schemaName)) {
                schemaMap.set(schemaName, []);
              }
              schemaMap.get(schemaName)!.push({
                name: row.table_name,
                type: row.table_type
              });
            });
          }
          
          schemas = Array.from(schemaMap.entries()).map(([name, tables]) => ({
            name,
            tables
          }));
          break;
          
        case 'mysql':
          // CAST 不是装饰：MySQL 8 的 information_schema 以 VARBINARY 返回标识符列，
          // 而 tauri-plugin-sql 的解码器类型表里没有 VARBINARY，会直接报
          // 「unsupported datatype: VARBINARY」。转成 CHAR 才落在它认识的范围内。
          // 没有库名时 `table_schema = NULL` 恒不匹配，会安静地查出 0 行，
          // 让人以为库是空的。这里直接说清楚。
          if (!connection.database) {
            throw new Error('该连接没有指定数据库名，无法列出表。请在连接配置中填写数据库。');
          }

          // MySQL: 获取当前数据库的所有表
          const tableResult = await database.select(`
            SELECT 
              CAST(table_name AS CHAR) AS table_name,
              CAST(table_type AS CHAR) AS table_type
            FROM information_schema.tables 
            WHERE table_schema = ?
            ORDER BY table_name
          `, [connection.database]);
          
          if (Array.isArray(tableResult)) {
            schemas = [{
              name: connection.database || 'default',
              tables: tableResult.map((row: any) => ({
                name: row.table_name,
                type: row.table_type
              }))
            }];
          }
          break;
          
        case 'sqlite':
          // SQLite: 获取所有表
          const sqliteResult = await database.select(`
            SELECT 
              name as table_name,
              type as table_type
            FROM sqlite_master 
            WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
            ORDER BY name
          `);
          
          if (Array.isArray(sqliteResult)) {
            schemas = [{
              name: 'default',
              tables: sqliteResult.map((row: any) => ({
                name: row.table_name,
                type: row.table_type
              }))
            }];
          }
          break;
      }
      
      // 缓存元数据
      setDatabaseMetadata(connectionId, { schemas, lastUpdated: Date.now() });
      
      // 默认展开第一个schema
      if (schemas.length > 0) {
        setExpandedSchemas(new Set([schemas[0].name]));
      }
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
  }, [connectionId, connectionReady]); // 监听连接ID和连接状态变化
  
  // 添加额外的连接ID变化监听，确保连接切换时清理旧状态
  useEffect(() => {
    console.log('🔄 DatabaseExplorer: 连接ID变化，清理旧状态:', connectionId);
    setError(null);
    setExpandedSchemas(new Set());
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
        连接不存在
      </div>
    );
  }

  // 使用缓存的数据或空数据
  const metadata = cachedMetadata && !isMetadataStale ? cachedMetadata : { schemas: [] };

  // 切换schema展开状态
  const toggleSchema = (schemaName: string) => {
    const newExpanded = new Set(expandedSchemas);
    if (newExpanded.has(schemaName)) {
      newExpanded.delete(schemaName);
    } else {
      newExpanded.add(schemaName);
    }
    setExpandedSchemas(newExpanded);
  };

  // 处理表点击
  const handleTableClick = (tableName: string, schema?: string) => {
    if (onTableSelect) {
      onTableSelect(tableName, schema);
    }
  };

  // 获取表图标
  const getTableIcon = (type: string) => {
    return type === 'VIEW' ? <View size={14} /> : <Table size={14} />;
  };

  return (
    <div className="h-full flex flex-col bg-surface">
      {/* 头部 */}
      <div className="flex items-center justify-between p-3 border-b bg-surface-sunken">
        <div className="flex items-center space-x-2">
          <Database className="text-accent" size={16} />
          <h2 className="text-sm font-semibold text-fg">数据库浏览器</h2>
          {connectionReady ? (
            <span className="text-xs text-success bg-success-soft px-2 py-0.5 rounded-control">
              已连接
            </span>
          ) : (
            <span className="text-xs text-warning bg-warning-soft px-2 py-0.5 rounded-control">
              连接中...
            </span>
          )}
          {cachedMetadata && !isMetadataStale && (
            <span className="text-xs text-accent bg-accent-soft px-2 py-0.5 rounded-control">
              已缓存
            </span>
          )}
        </div>
        
        <button
          onClick={() => loadDatabaseMetadata(true)}
          disabled={loading}
          className="p-1 text-fg-muted hover:text-accent transition-colors"
          title="刷新"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
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
            <span className="ml-2 text-fg-muted text-sm">加载中...</span>
          </div>
        ) : error ? (
          // 出错时不再同时显示「暂无数据库对象」：那会让人以为库是空的，
          // 而真实情况是我们根本没读到
          <div className="p-4 text-center text-fg-muted text-sm">
            <p>未能读取数据库对象。</p>
            <button
              onClick={() => loadDatabaseMetadata(true)}
              className="mt-2 text-accent hover:underline"
            >
              重试
            </button>
          </div>
        ) : metadata.schemas.length === 0 ? (
          <div className="p-4 text-center text-fg-muted text-sm">
            <Info className="mx-auto mb-2" size={16} />
            <p>暂无数据库对象</p>
          </div>
        ) : (
          <div className="p-2">
            {metadata.schemas.map((schema) => (
              <div key={schema.name} className="mb-2">
                {/* Schema 标题 */}
                <button
                  onClick={() => toggleSchema(schema.name)}
                  className="w-full flex items-center justify-between px-2 py-1.5 text-sm font-medium text-fg hover:bg-surface-hover rounded-control transition-colors"
                >
                  <div className="flex items-center space-x-2">
                    {expandedSchemas.has(schema.name) ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                    <Database size={14} className="text-accent" />
                    <span>{schema.name}</span>
                    <span className="text-xs text-fg-muted">({schema.tables.length})</span>
                  </div>
                </button>
                
                {/* Schema 下的表 */}
                {expandedSchemas.has(schema.name) && (
                  <div className="ml-6 mt-1 space-y-1">
                    {schema.tables.map((table) => (
                      <button
                        key={table.name}
                        onClick={() => handleTableClick(table.name, schema.name === 'default' ? undefined : schema.name)}
                        className="w-full flex items-center space-x-2 px-2 py-1 text-sm text-fg-muted hover:bg-accent-soft hover:text-accent rounded-control transition-colors"
                      >
                        {getTableIcon(table.type)}
                        <span className="truncate">{table.name}</span>
                        {table.type === 'VIEW' && (
                          <span className="text-xs text-fg-subtle">(视图)</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
} 
