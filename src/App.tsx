import { Sidebar } from './components/Sidebar';
import { SqlWorkbench } from './components/SqlWorkbench';
import TableDataViewer from './components/TableDataViewer';
import { WelcomeScreen } from './components/WelcomeScreen';
import { useAppStore } from './stores/appStore';
import { useConnectionStateManager } from './utils/stateSync';

function App() {
  const { 
    activeConnection, 
    viewMode, 
    tableViewerState, 
    selectedTable,
    handleConnectionDeleted,
    closeTableViewer
  } = useAppStore();
  
  const connectionManager = useConnectionStateManager();

  return (
    <div className="h-screen flex bg-gray-100">
      {/* 左侧侧边栏 - 包含连接选择和数据库浏览器 */}
      <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
        <Sidebar 
          onConnect={async (connection, connectionString) => {
            try {
              await connectionManager.switchConnection(connection, connectionString);
            } catch (error) {
              console.error('连接失败:', error);
              throw error;
            }
          }}
          activeConnectionId={activeConnection?.config.id}
          onConnectionDeleted={handleConnectionDeleted}
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
              onDisconnect={() => useAppStore.getState().clearActiveConnection()}
              onReconnect={() => connectionManager.switchConnection(
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
