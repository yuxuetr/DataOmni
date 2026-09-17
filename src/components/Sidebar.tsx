import React, { useState, useEffect } from 'react';
import { Plus, Database, ChevronDown, Edit, Trash2, AlertCircle, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { ConnectionConfig, useConnectionStore } from '../stores/connectionStore';
import DatabaseExplorer from './DatabaseExplorer';
import { ConnectionForm } from './ConnectionForm';
import { confirm } from '@tauri-apps/plugin-dialog';

interface SidebarProps {
  onConnect: (connection: ConnectionConfig, connectionString: string) => Promise<void>;
  activeConnectionId?: string | null;
  onConnectionDeleted?: (deletedConnectionId: string) => void;
  onTableSelect?: (tableName: string, schema?: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  onConnect,
  activeConnectionId,
  onConnectionDeleted,
  onTableSelect
}) => {
  const { connections, loadConnections, deleteConnection } = useConnectionStore();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<ConnectionConfig | null>(null);
  const [showConnectionMenu, setShowConnectionMenu] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // 初始化时加载连接列表
  useEffect(() => {
    loadConnections().catch(err => {
      console.error('加载连接列表失败:', err);
      setConnectionError(err instanceof Error ? err.message : '加载连接列表失败');
    });
  }, []);

  // 处理新建连接
  const handleCreateConnection = () => {
    setConnectionError(null);
    setEditingConnection(null);
    setIsFormOpen(true);
  };

  // 处理表格选择
  const handleTableSelect = (tableName: string, schema?: string) => {
    if (onTableSelect) {
      onTableSelect(tableName, schema);
    }
  };

  // 获取当前连接
  const currentConnection = connections.find(c => c.id === activeConnectionId);

  // 处理连接选择
  const handleConnectionSelect = async (connection: ConnectionConfig) => {
    setConnectionError(null);
    try {
      // 使用后端的test_connection来获取正确的连接字符串(包含SSL参数)
      console.log('🔗 获取连接字符串:', connection.name);
      const connectionString = await invoke<string>('test_connection', { config: connection });
      console.log('✅ 获取到带SSL参数的连接字符串:', connectionString.replace(/:([^:@]+)@/, ':***@'));
      
      await onConnect(connection, connectionString);
      setShowConnectionMenu(false);
    } catch (error) {
      console.error('连接失败:', error);
      setConnectionError(error instanceof Error ? error.message : '数据库连接失败');
    }
  };

  // 处理编辑连接
  const handleEditConnection = (connection: ConnectionConfig) => {
    setEditingConnection(connection);
    setIsFormOpen(true);
    setShowConnectionMenu(false);
  };

  // 处理删除连接
  const handleDeleteConnection = async (connection: ConnectionConfig) => {
    const userConfirmed = await confirm(
      `确定要删除连接 "${connection.name}" 吗？`,
      { title: '确认删除', kind: 'warning' }
    );
    
    if (userConfirmed) {
      try {
        await deleteConnection(connection.id);
        if (activeConnectionId === connection.id && onConnectionDeleted) {
          onConnectionDeleted(connection.id);
        }
      } catch (error) {
        console.error('删除连接失败:', error);
        setConnectionError(error instanceof Error ? error.message : '删除连接失败');
      }
    }
    setShowConnectionMenu(false);
  };

  return (
    <div className="h-full flex flex-col bg-white border-r border-gray-200">
      {/* 头部 - 连接选择器 */}
      <div className="px-4 py-4 border-b border-gray-200 bg-gray-50">
        <div className="relative">
          <button
            onClick={() => setShowConnectionMenu(!showConnectionMenu)}
            className="w-full flex items-center justify-between px-3 py-2.5 text-sm bg-white hover:bg-gray-50 rounded-lg border border-gray-200 transition-colors shadow-sm"
          >
            <div className="flex items-center space-x-2">
              <Database size={16} className="text-gray-600" />
              <span className="font-medium text-gray-900">
                {currentConnection ? currentConnection.name : '选择数据库连接'}
              </span>
            </div>
            <ChevronDown size={16} className="text-gray-500" />
          </button>

          {/* 连接下拉菜单 */}
          {showConnectionMenu && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-lg shadow-lg border border-gray-200 z-50 max-h-64 overflow-y-auto">
              {connections.length === 0 ? (
                <div className="p-4 text-center text-gray-500 text-sm">
                  <Database size={24} className="mx-auto mb-2 text-gray-300" />
                  <p>暂无数据库连接</p>
                  <p className="text-xs mt-1">点击下方按钮创建新连接</p>
                </div>
              ) : (
                connections.map(conn => (
                  <div
                    key={conn.id}
                    className="group flex items-center justify-between px-3 py-2.5 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0"
                    onClick={() => handleConnectionSelect(conn)}
                  >
                    <div className="flex items-center space-x-2">
                      <Database size={14} className="text-gray-500" />
                      <span className="text-sm text-gray-900">{conn.name}</span>
                      {conn.id === activeConnectionId && (
                        <span className="text-xs text-green-600 font-medium">● 已连接</span>
                      )}
                    </div>
                    <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditConnection(conn);
                        }}
                        className="p-1 text-gray-500 hover:text-blue-600 rounded"
                        title="编辑连接"
                      >
                        <Edit size={14} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteConnection(conn);
                        }}
                        className="p-1 text-gray-500 hover:text-red-600 rounded"
                        title="删除连接"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {connectionError && (
                      <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                        <AlertCircle size={14} className="mt-0.5 shrink-0" />
                        <span className="flex-1 break-words">{connectionError}</span>
                        <button
                          type="button"
                          onClick={() => setConnectionError(null)}
                          className="text-red-500 hover:text-red-700"
                          title="关闭错误提示"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
              
              <div className="border-t border-gray-200">
                <button
                  onClick={() => {
                    setShowConnectionMenu(false);
                    handleCreateConnection();
                  }}
                  className="w-full flex items-center space-x-2 px-3 py-2.5 text-sm text-blue-600 hover:bg-blue-50 transition-colors"
                >
                  <Plus size={14} />
                  <span>新建连接</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-hidden">
        {activeConnectionId ? (
          // 显示数据库浏览器
          <DatabaseExplorer 
            connectionId={activeConnectionId}
            onTableSelect={handleTableSelect}
          />
        ) : (
          // 显示提示信息
          <div className="p-6 text-center text-gray-500">
            <Database size={48} className="mx-auto mb-4 text-gray-300" />
            <p className="text-sm font-medium mb-2">欢迎使用 DataOmni</p>
            <p className="text-xs">请从上方菜单选择或创建数据库连接</p>
            <p className="text-xs mt-1">支持 SQLite、MySQL、PostgreSQL 等数据库</p>
          </div>
        )}
      </div>

      {/* 连接表单弹窗 */}
      {isFormOpen && (
        <ConnectionForm
          connection={editingConnection || undefined}
          mode={editingConnection ? 'edit' : 'create'}
          onClose={() => {
            setIsFormOpen(false);
            setEditingConnection(null);
            // 重新加载连接列表
            loadConnections().catch(err => {
              console.error('加载连接列表失败:', err);
              setConnectionError(err instanceof Error ? err.message : '加载连接列表失败');
            });
          }}
        />
      )}
    </div>
  );
}; 
