import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Sidebar } from './components/Sidebar';
import { SqlWorkbench } from './components/SqlWorkbench';
import TableDataViewer from './components/TableDataViewer';
import { WelcomeScreen } from './components/WelcomeScreen';
import { WorkspaceTabBar } from './components/WorkspaceTabBar';
import { useAppStore } from './stores/appStore';
import { useWorkspaceStore } from './stores/workspaceStore';
import {
  createSqlWorkspaceTab,
  createTableWorkspaceTab,
  workspaceTabId
} from './contracts/workspace';
import { useSessionManager } from './utils/stateSync';

function App() {
  const { activeConnection, selectedTable } = useAppStore();
  const { tabs, activeTabId, registerTab, activateTab, closeTab } = useWorkspaceStore();

  const sessionManager = useSessionManager();
  const activeProfileId = activeConnection?.config.id ?? null;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  // 每个连接有一个 SQL 标签，连接就绪后按需创建；id 由连接决定，重复注册会被去重
  useEffect(() => {
    if (!activeConnection) {
      return;
    }

    const profileId = activeConnection.config.id;
    registerTab(
      createSqlWorkspaceTab(profileId, {
        id: workspaceTabId(profileId, 'sql'),
        title: `查询 · ${activeConnection.config.name}`
      })
    );
  }, [activeConnection, registerTab]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let closing = false;
    let unlisten: (() => void) | undefined;

    void appWindow.onCloseRequested(async (event) => {
      event.preventDefault();

      if (closing) {
        return;
      }

      closing = true;

      try {
        await sessionManager.shutdown();
        await appWindow.destroy();
      } catch (error) {
        closing = false;
        console.error('关闭数据库会话失败，应用退出已取消:', error);
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, [sessionManager]);

  useEffect(() => {
    const handleOffline = () => {
      sessionManager.reportConnectionLost('network', '设备网络连接已断开');
    };
    const handleOnline = () => {
      void sessionManager.handleNetworkRestored().catch((error) => {
        console.error('网络恢复后重新连接失败:', error);
      });
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [sessionManager]);

  const openTableTab = (tableName: string, schema?: string) => {
    if (!activeConnection) {
      return;
    }

    const profileId = activeConnection.config.id;
    const object = { schema: schema ?? null, table: tableName };

    registerTab(
      createTableWorkspaceTab(profileId, tableName, {
        id: workspaceTabId(profileId, 'table-data', object),
        schema: schema ?? null,
        title: schema ? `${schema}.${tableName}` : tableName
      })
    );
  };

  const renderActiveTab = () => {
    if (!activeTab) {
      return (
        <WelcomeScreen onConnect={() => {
          // 这里可以触发显示连接表单的逻辑
          console.log('用户点击了连接按钮');
        }} />
      );
    }

    // 标签永久绑定到打开它的连接。只有一个活跃会话，所以绑定到别的连接的
    // 标签不执行任何查询，而不是静默改到当前连接上执行。
    if (activeTab.binding.profileId !== activeProfileId) {
      return (
        <div className="flex-1 flex items-center justify-center p-8 text-center">
          <div className="max-w-md">
            <p className="text-gray-700">
              标签「{activeTab.title}」绑定的连接
              {activeTab.availability === 'profile-deleted' ? '已被删除' : '当前未激活'}。
            </p>
            <p className="mt-2 text-sm text-gray-500">
              {activeTab.availability === 'profile-deleted'
                ? '该连接的配置已删除，此标签只能查看，无法执行查询。'
                : '请在左侧重新选择该连接后再操作，本标签不会改到当前连接上执行。'}
            </p>
          </div>
        </div>
      );
    }

    if (activeTab.kind === 'sql') {
      if (!activeConnection) {
        return null;
      }

      return (
        <SqlWorkbench
          connection={activeConnection.config}
          onDisconnect={() => sessionManager.disconnect()}
          onReconnect={() => sessionManager.manualReconnect(
            activeConnection.config,
            activeConnection.connectionString
          )}
          selectedTable={selectedTable || undefined}
        />
      );
    }

    if (!activeConnection) {
      return null;
    }

    return (
      <TableDataViewer
        key={activeTab.id}
        connection={activeConnection.config}
        tableName={activeTab.object.table}
        schema={activeTab.object.schema ?? undefined}
        initialTab={activeTab.kind === 'table-structure' ? 'schema' : 'data'}
        onClose={() => closeTab(activeTab.id)}
      />
    );
  };

  return (
    <div className="h-screen flex bg-gray-100">
      {/* 左侧侧边栏 - 包含连接选择和数据库浏览器 */}
      <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
        <Sidebar
          onConnect={async (connection, connectionString) => {
            try {
              await sessionManager.switchConnection(connection, connectionString);
            } catch (error) {
              console.error('连接失败:', error);
              throw error;
            }
          }}
          activeConnectionId={activeConnection?.config.id}
          onConnectionDeleted={(connectionId) => sessionManager.handleConnectionDeleted(connectionId)}
          onTableSelect={openTableTab}
        />
      </div>

      {/* 右侧主内容区域 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {tabs.length > 0 && (
          <WorkspaceTabBar
            tabs={tabs}
            activeTabId={activeTabId}
            activeProfileId={activeProfileId}
            onActivate={activateTab}
            onClose={closeTab}
          />
        )}
        <div className="flex-1 flex flex-col overflow-hidden">
          {renderActiveTab()}
        </div>
      </div>
    </div>
  );
}

export default App;
