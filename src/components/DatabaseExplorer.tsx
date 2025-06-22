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
import { useConnectionStore } from '../stores/connectionStore';
import { useQueryStore } from '../stores/queryStore';
import { useAppStore } from '../stores/appStore';

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
              table_schema,
              table_name,
              table_type
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
          // MySQL: 获取当前数据库的所有表
          const tableResult = await database.select(`
            SELECT 
              table_name,
              table_type
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
            WHERE type IN ('table', 'view')
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
      setError('加载数据库元数据失败');
    } finally {
      setLoading(false);
    }
  };

  // 组件挂载时加载数据
  useEffect(() => {
    if (connectionId && database && connectionReady) {
      console.log('🔄 DatabaseExplorer: 连接准备就绪，重新加载元数据:', connectionId);
      loadDatabaseMetadata(true); // 强制刷新，确保获取最新数据
    }
  }, [connectionId, connectionReady]); // 监听连接ID和连接状态变化

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
      <div className="h-full flex items-center justify-center text-gray-500">
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
    <div className="h-full flex flex-col bg-white">
      {/* 头部 */}
      <div className="flex items-center justify-between p-3 border-b bg-gray-50">
        <div className="flex items-center space-x-2">
          <Database className="text-blue-600" size={16} />
          <h2 className="text-sm font-semibold text-gray-900">数据库浏览器</h2>
          {connectionReady ? (
            <span className="text-xs text-green-600 bg-green-100 px-2 py-0.5 rounded">
              已连接
            </span>
          ) : (
            <span className="text-xs text-yellow-600 bg-yellow-100 px-2 py-0.5 rounded">
              连接中...
            </span>
          )}
          {cachedMetadata && !isMetadataStale && (
            <span className="text-xs text-blue-600 bg-blue-100 px-2 py-0.5 rounded">
              已缓存
            </span>
          )}
        </div>
        
        <button
          onClick={() => loadDatabaseMetadata(true)}
          disabled={loading}
          className="p-1 text-gray-500 hover:text-blue-600 transition-colors"
          title="刷新"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="p-3 bg-red-50 border-b border-red-200">
          <div className="flex items-center space-x-2">
            <AlertCircle className="text-red-500" size={14} />
            <span className="text-red-700 text-sm">{error}</span>
          </div>
        </div>
      )}

      {/* 内容区域 */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader className="animate-spin text-gray-400" size={16} />
            <span className="ml-2 text-gray-600 text-sm">加载中...</span>
          </div>
        ) : metadata.schemas.length === 0 ? (
          <div className="p-4 text-center text-gray-500 text-sm">
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
                  className="w-full flex items-center justify-between px-2 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded transition-colors"
                >
                  <div className="flex items-center space-x-2">
                    {expandedSchemas.has(schema.name) ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                    <Database size={14} className="text-blue-500" />
                    <span>{schema.name}</span>
                    <span className="text-xs text-gray-500">({schema.tables.length})</span>
                  </div>
                </button>
                
                {/* Schema 下的表 */}
                {expandedSchemas.has(schema.name) && (
                  <div className="ml-6 mt-1 space-y-1">
                    {schema.tables.map((table) => (
                      <button
                        key={table.name}
                        onClick={() => handleTableClick(table.name, schema.name === 'default' ? undefined : schema.name)}
                        className="w-full flex items-center space-x-2 px-2 py-1 text-sm text-gray-600 hover:bg-blue-50 hover:text-blue-600 rounded transition-colors"
                      >
                        {getTableIcon(table.type)}
                        <span className="truncate">{table.name}</span>
                        {table.type === 'VIEW' && (
                          <span className="text-xs text-gray-400">(视图)</span>
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
