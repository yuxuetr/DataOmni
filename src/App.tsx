import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Sidebar } from './components/Sidebar';
import { SqlWorkbench } from './components/SqlWorkbench';
import TableDataViewer from './components/TableDataViewer';
import { WelcomeScreen } from './components/WelcomeScreen';
import { useAppStore } from './stores/appStore';
import { useSessionManager } from './utils/stateSync';

function App() {
  const { 
    activeConnection, 
    viewMode, 
    tableViewerState, 
    selectedTable,
    closeTableViewer
  } = useAppStore();
  
  const sessionManager = useSessionManager();

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
          onTableSelect={(tableName, schema) => {
            if (activeConnection) {
              useAppStore.getState().openTableViewer(activeConnection.config, tableName, schema);
            }
          }}
        />
      </div>

      {/* 右侧主内容区域 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {viewMode === 'workbench' ? (
          activeConnection ? (
            <SqlWorkbench
              connection={activeConnection.config}
              onDisconnect={() => sessionManager.disconnect()}
              onReconnect={() => sessionManager.manualReconnect(
                activeConnection.config,
                activeConnection.connectionString
              )}
              selectedTable={selectedTable || undefined}
            />
          ) : (
            <WelcomeScreen onConnect={() => {
              // 这里可以触发显示连接表单的逻辑
              console.log('用户点击了连接按钮');
            }} />
          )
        ) : viewMode === 'table-viewer' && tableViewerState ? (
          <TableDataViewer
            connection={tableViewerState.connection}
            tableName={tableViewerState.tableName}
            schema={tableViewerState.schema}
            onClose={closeTableViewer}
          />
        ) : null}
      </div>
    </div>
  );
}

export default App;
