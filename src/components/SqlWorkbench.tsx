import React, { useEffect, useState } from 'react';
import { 
  Database, 
  Wifi, 
  WifiOff, 
  X, 
  RefreshCw,
  Info,
} from 'lucide-react';
import { clsx } from 'clsx';
import { ConnectionConfig } from '../stores/connectionStore';
import { useQueryStore } from '../stores/queryStore';
import { useAppStore } from '../stores/appStore';
import { SqlEditor } from './SqlEditor';

interface SqlWorkbenchProps {
  connection: ConnectionConfig;
  onDisconnect: () => Promise<void>;
  onReconnect: () => Promise<void>;
  selectedTable?: { name: string; schema?: string };
}

export const SqlWorkbench: React.FC<SqlWorkbenchProps> = ({ 
  connection, 
  onDisconnect,
  onReconnect,
  selectedTable
}) => {
  const {
    database,
    connectionId,
    sessionId,
    isConnecting,
    error,
    setError,
    setSqlInput,
    parseStatements,
    executeStatement,
  } = useQueryStore();

  const { selectTable, clearSelectedTable } = useAppStore();

  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('disconnected');

  // 监听连接状态
  useEffect(() => {
    if (isConnecting) {
      setConnectionStatus('connecting');
    } else if (database) {
      setConnectionStatus('connected');
    } else if (error) {
      setConnectionStatus('error');
    } else {
      setConnectionStatus('disconnected');
    }
  }, [isConnecting, database, error]);

  // 处理选中的表格
  useEffect(() => {
    if (selectedTable && database && connectionStatus === 'connected') {
      // 更新全局状态
      selectTable(selectedTable.name, selectedTable.schema);
      
      // 生成查询表格数据的SQL
      const query = selectedTable.schema 
        ? `SELECT * FROM ${selectedTable.schema}.${selectedTable.name} LIMIT 100;`
        : `SELECT * FROM ${selectedTable.name} LIMIT 100;`;
      
      setSqlInput(query);
      parseStatements();
      
      // 延迟执行，确保语句已经解析
      setTimeout(() => {
        const parsedStatements = useQueryStore.getState().statements;
        if (parsedStatements.length > 0) {
          executeStatement(parsedStatements[0].id);
        }
      }, 100);
    } else if (!selectedTable) {
      // 清除表选择
      clearSelectedTable();
    }
  }, [selectedTable, database, connectionStatus]);

  // 重新连接
  const handleReconnect = async () => {
    setError(null);
    await onReconnect();
  };

  // 关闭工作台
  const handleClose = async () => {
    await onDisconnect();
  };

  // 获取连接状态显示
  const getConnectionStatusDisplay = () => {
    switch (connectionStatus) {
      case 'connecting':
        return {
          icon: <RefreshCw className="animate-spin text-blue-500" size={16} />,
          text: '连接中',
          color: 'text-blue-600',
          bg: 'bg-blue-50'
        };
      case 'connected':
        return {
          icon: <Wifi className="text-green-500" size={16} />,
          text: '已连接',
          color: 'text-green-600',
          bg: 'bg-green-50'
        };
      case 'error':
        return {
          icon: <WifiOff className="text-red-500" size={16} />,
          text: '连接失败',
          color: 'text-red-600',
          bg: 'bg-red-50'
        };
      default:
        return {
          icon: <WifiOff className="text-gray-500" size={16} />,
          text: '未连接',
          color: 'text-gray-600',
          bg: 'bg-gray-50'
        };
    }
  };

  const statusDisplay = getConnectionStatusDisplay();

  return (
    <div className="h-full flex flex-col bg-white">
      {/* 工作台头部 */}
      <div className="flex items-center justify-between p-4 border-b bg-gray-50">
        <div className="flex items-center space-x-3">
          <Database className="text-blue-600" size={20} />
          <div>
            <h1 className="text-lg font-semibold text-gray-900">
              {connection.name}
            </h1>
            <div className="flex items-center space-x-3 text-sm text-gray-600">
              <span>
                {connection.db_type} • {connection.host}:{connection.port}
              </span>
              <div className={clsx(
                "flex items-center space-x-1 px-2 py-1 rounded-full text-xs",
                statusDisplay.bg,
                statusDisplay.color
              )}>
                {statusDisplay.icon}
                <span>{statusDisplay.text}</span>
              </div>
              {connectionId && sessionId && (
                <div className="text-xs text-gray-500">
                  配置: {connectionId} · Session: {sessionId.slice(0, 8)}
                </div>
              )}
            </div>
          </div>
        </div>
        
        <div className="flex items-center space-x-2">
          {/* 连接信息按钮 */}
          <button
            className="flex items-center space-x-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            title="连接信息"
          >
            <Info size={14} />
            <span>信息</span>
          </button>

          {/* 重新连接按钮 */}
          {connectionStatus === 'error' && (
            <button
              onClick={handleReconnect}
              className="flex items-center space-x-1 px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50 transition-colors"
            >
              <RefreshCw size={14} />
              <span>重新连接</span>
            </button>
          )}

          {/* 关闭按钮 */}
          <button
            onClick={handleClose}
            className="flex items-center space-x-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            title="关闭SQL工作台"
          >
            <X size={14} />
            <span>关闭工作台</span>
          </button>
        </div>
      </div>

      {/* 连接错误提示 */}
      {error && connectionStatus === 'error' && (
        <div className="p-4 bg-red-50 border-b border-red-200">
          <div className="flex items-start space-x-2">
            <WifiOff className="text-red-500 mt-0.5" size={16} />
            <div className="flex-1">
              <h4 className="text-sm font-medium text-red-800 mb-1">数据库连接失败</h4>
              <p className="text-sm text-red-700">{error}</p>
              <div className="mt-2">
                <button
                  onClick={handleReconnect}
                  className="text-sm text-red-600 hover:text-red-800 underline"
                >
                  点击重试
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 连接成功提示 */}
      {connectionStatus === 'connected' && (
        <div className="p-3 bg-green-50 border-b border-green-200">
          <div className="flex items-center space-x-2">
            <Wifi className="text-green-500" size={16} />
            <span className="text-sm text-green-700">
              数据库连接成功，可以开始执行SQL查询
            </span>
            {connectionId && (
              <span className="text-xs text-green-600 bg-green-100 px-2 py-1 rounded">
                📝 SQL历史已恢复
              </span>
            )}
          </div>
        </div>
      )}

      {/* SQL编辑器主体 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <SqlEditor />
      </div>
    </div>
  );
}; 
