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
import { selectActiveSqlDocument, useQueryStore } from '../stores/queryStore';
import { useAppStore } from '../stores/appStore';
import { SqlEditor } from './SqlEditor';
import { ConnectionInfoDialog } from './ConnectionInfoDialog';
import { EnvironmentBadgeTag } from './EnvironmentBadge';
import { useLanguageStore } from '../stores/languageStore';
import { useSessionTarget } from '../hooks/useSessionTarget';

interface SqlWorkbenchProps {
  connection: ConnectionConfig;
  onDisconnect: () => Promise<void>;
  onReconnect: () => Promise<void>;
  selectedTable?: { name: string; schema?: string };
  /** 当前标签的标题，透传给编辑器用来给另存出去的 `.sql` 猜文件名 */
  documentTitle?: string;
}

export const SqlWorkbench: React.FC<SqlWorkbenchProps> = ({ 
  connection, 
  onDisconnect,
  onReconnect,
  selectedTable,
  documentTitle
}) => {
  const t = useLanguageStore((state) => state.t);
  const {
    database,
    session,
    isConnecting,
    error,
    setError,
    setSqlInput,
    parseStatements,
    executeStatement,
  } = useQueryStore();

  const { selectTable, clearSelectedTable } = useAppStore();

  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('disconnected');
  // 服务端说的执行目标。问不出来时退回连接配置里的库名
  const target = useSessionTarget(connection);

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
        const parsedStatements = selectActiveSqlDocument(useQueryStore.getState()).statements;
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
          icon: <RefreshCw className="animate-spin text-accent" size={16} />,
          text: t('workbench.connecting'),
          color: 'text-accent',
          bg: 'bg-accent-soft'
        };
      case 'connected':
        return {
          icon: <Wifi className="text-success" size={16} />,
          text: t('workbench.connected'),
          color: 'text-success',
          bg: 'bg-success-soft'
        };
      case 'error':
        return {
          icon: <WifiOff className="text-danger" size={16} />,
          text: t('workbench.connectFailed'),
          color: 'text-danger',
          bg: 'bg-danger-soft'
        };
      default:
        return {
          icon: <WifiOff className="text-fg-muted" size={16} />,
          text: t('workbench.disconnected'),
          color: 'text-fg-muted',
          bg: 'bg-surface-sunken'
        };
    }
  };

  const statusDisplay = getConnectionStatusDisplay();
  const targetDatabase = target.database ?? connection.database;
  const [showConnectionInfo, setShowConnectionInfo] = useState(false);

  return (
    <div className="h-full flex flex-col bg-surface">
      {showConnectionInfo && (
        <ConnectionInfoDialog
          connection={connection}
          session={session}
          onClose={() => setShowConnectionInfo(false)}
        />
      )}
      {/* 工作台头部 */}
      {/* 压成一行：连接名在标签页和侧边栏已各出现一次，这里不再用大标题重复 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-line bg-surface-sunken">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Database className="shrink-0 text-fg-subtle" size={16} />
          <span className="font-medium text-fg">{connection.name}</span>
          <EnvironmentBadgeTag environment={connection.environment} />
          {target.readOnly && (
            <span
              title={t('workbench.readOnlyHint')}
              className="shrink-0 rounded-control border border-warning-line bg-warning-soft px-1.5 py-0.5 text-[11px] font-medium text-warning"
            >
              {t('workbench.readOnly')}
            </span>
          )}
          <span className="truncate text-fg-muted">
            {connection.db_type} · {connection.host}:{connection.port}
            {/* 库名优先用服务端报的，问不出来才退回配置里那个 */}
            {targetDatabase ? ` / ${targetDatabase}` : t('workbench.noDatabase')}
            {/* Schema 只有 PostgreSQL 有。它回答的是「不带前缀的 CREATE TABLE
                会落到哪」，在一个连接横跨多个 schema 时是必要信息 */}
            {target.schema ? ` · ${target.schema}` : ''}
          </span>
          <span className={clsx('flex shrink-0 items-center gap-1 text-xs', statusDisplay.color)}>
            {statusDisplay.icon}
            <span>{statusDisplay.text}</span>
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* 连接信息按钮 */}
          <button
            onClick={() => setShowConnectionInfo(true)}
            className="flex items-center space-x-1 px-3 py-1.5 text-sm text-fg-muted border border-line-strong rounded-control hover:bg-surface-hover transition-colors"
            title={t('workbench.connectionInfo')}
          >
            <Info size={14} />
            <span>{t('workbench.info')}</span>
          </button>

          {/* 重新连接按钮 */}
          {connectionStatus === 'error' && (
            <button
              onClick={handleReconnect}
              className="flex items-center space-x-1 px-3 py-1.5 text-sm text-accent border border-accent-line rounded-control hover:bg-accent-soft transition-colors"
            >
              <RefreshCw size={14} />
              <span>{t('workbench.reconnect')}</span>
            </button>
          )}

          {/* 关闭按钮 */}
          <button
            onClick={handleClose}
            className="flex items-center space-x-1 px-3 py-1.5 text-sm text-fg-muted border border-line-strong rounded-control hover:bg-surface-hover transition-colors"
            title={t('workbench.disconnectTitle')}
          >
            <X size={14} />
            <span>{t('workbench.disconnect')}</span>
          </button>
        </div>
      </div>

      {/* 连接错误提示 */}
      {error && connectionStatus === 'error' && (
        <div className="p-4 bg-danger-soft border-b border-danger-line">
          <div className="flex items-start space-x-2">
            <WifiOff className="text-danger mt-0.5" size={16} />
            <div className="flex-1">
              <h4 className="text-sm font-medium text-danger mb-1">{t('workbench.connectFailedTitle')}</h4>
              <p className="text-sm text-danger">{error}</p>
              <div className="mt-2">
                <button
                  onClick={handleReconnect}
                  className="text-sm text-danger hover:text-danger underline"
                >
                  {t('workbench.clickToRetry')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 连接成功提示 */}

      {/* SQL编辑器主体 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <SqlEditor connection={connection} documentTitle={documentTitle} />
      </div>
    </div>
  );
}; 
