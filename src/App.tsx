import { useEffect, useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Sidebar } from './components/Sidebar';
import { SqlWorkbench } from './components/SqlWorkbench';
import TableDataViewer from './components/TableDataViewer';
import { WelcomeScreen } from './components/WelcomeScreen';
import { CloseTabPrompt, type CloseTabChoice } from './components/CloseTabPrompt';
import { OfflineTabView } from './components/OfflineTabView';
import { WorkspaceTabMenu } from './components/WorkspaceTabMenu';
import { WorkspaceTabBar } from './components/WorkspaceTabBar';
import { useAppStore } from './stores/appStore';
import { useConnectionStore } from './stores/connectionStore';
import { selectSqlDocumentHasUnsavedContent, useQueryStore } from './stores/queryStore';
import { useWorkspaceStore } from './stores/workspaceStore';
import {
  createSqlWorkspaceTab,
  createTableWorkspaceTab,
  workspaceTabId
} from './contracts/workspace';
import { useSessionManager } from './utils/stateSync';
import { saveWorkspaceSnapshot } from './utils/workspacePersistence';

function App() {
  const { activeConnection, selectedTable, openConnectionForm } = useAppStore();
  const {
    tabs,
    activeTabId,
    closedTabs,
    registerTab,
    activateTab,
    closeTab,
    toggleTabPinned,
    retainClosedTab,
    reopenLastClosedTab
  } = useWorkspaceStore();
  const { openDocument, closeDocument, setActiveDocument, setSqlInput } = useQueryStore();
  // 等待用户在三选一里做决定的标签
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<
    { tabId: string; position: { x: number; y: number } } | null
  >(null);
  const documents = useQueryStore((state) => state.documents);
  const connections = useConnectionStore((state) => state.connections);

  const unsavedTabIds = useMemo(
    () => new Set(
      Object.keys(documents).filter(
        (documentId) => selectSqlDocumentHasUnsavedContent({ documents }, documentId)
      )
    ),
    [documents]
  );

  const sessionManager = useSessionManager();
  const activeProfileId = activeConnection?.config.id ?? null;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const pendingCloseTab = pendingCloseTabId
    ? tabs.find((tab) => tab.id === pendingCloseTabId) ?? null
    : null;
  const menuTab = tabMenu ? tabs.find((tab) => tab.id === tabMenu.tabId) ?? null : null;

  // 标签、最后活动标签和草稿的任一变化都写回快照
  // （恢复发生在 main.tsx 首次渲染之前，这里不会覆盖掉上次的内容）
  useEffect(() => {
    const drafts: Record<string, string> = {};
    for (const tab of tabs) {
      const draft = documents[tab.id];
      if (tab.kind === 'sql' && draft) {
        drafts[tab.id] = draft.sqlInput;
      }
    }

    saveWorkspaceSnapshot({ tabs, activeTabId, drafts, closedTabs });
  }, [tabs, activeTabId, documents, closedTabs]);

  // 活动标签决定当前编辑的是哪一份 SQL 文档；非 SQL 标签不改变它，
  // 这样在表标签里看数据不会影响后台仍在执行的查询写回哪个文档。
  useEffect(() => {
    if (activeTab?.kind === 'sql') {
      openDocument(activeTab.id);
    }
  }, [activeTab?.id, activeTab?.kind, openDocument]);

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
    if (!activeConnection) {
      setActiveDocument(null);
    }
  }, [activeConnection, setActiveDocument]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        reopenClosedTab();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

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

  /** 真正执行关闭；retainDraft 决定草稿是进「最近关闭」还是被删掉 */
  const finishCloseTab = (tabId: string, retainDraft: boolean) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (!tab) {
      return;
    }

    if (retainDraft) {
      retainClosedTab(tab, useQueryStore.getState().documents[tabId]?.sqlInput ?? '');
    }

    closeTab(tabId);
    if (tab.kind === 'sql') {
      closeDocument(tabId);
    }
  };

  const closeWorkspaceTab = (tabId: string) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);

    // 关闭标签会连草稿一起从工作区快照里抹掉，所以带内容时先问一次。
    // 三个选项各自做不同的事：保留草稿（进「最近关闭」，可重新打开）、
    // 丢弃（永久删除）、取消（不关）。
    if (tab?.kind === 'sql' && selectSqlDocumentHasUnsavedContent(useQueryStore.getState(), tabId)) {
      setPendingCloseTabId(tabId);
      return;
    }

    finishCloseTab(tabId, false);
  };

  const handleCloseChoice = (choice: CloseTabChoice) => {
    const tabId = pendingCloseTabId;
    setPendingCloseTabId(null);

    if (!tabId || choice === 'cancel') {
      return;
    }

    finishCloseTab(tabId, choice === 'retain');
  };

  const duplicateSqlTab = (tabId: string) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (tab?.kind !== 'sql') {
      return;
    }

    // 新 id 由 createSqlWorkspaceTab 生成，不走 workspaceTabId 的确定性身份：
    // 那是用来去重的，复制出来的标签本就要和原标签共存。
    const duplicate = createSqlWorkspaceTab(tab.binding.profileId, {
      title: `${tab.title} 副本`
    });

    registerTab(duplicate);
    openDocument(duplicate.id);
    setSqlInput(useQueryStore.getState().documents[tabId]?.sqlInput ?? '');
  };

  const reopenClosedTab = () => {
    const reopened = reopenLastClosedTab();
    if (!reopened) {
      return;
    }

    if (reopened.tab.kind === 'sql') {
      // 先建文档再灌草稿：openDocument 对新 id 会建一份空的
      openDocument(reopened.tab.id);
      setSqlInput(reopened.draft);
    }
  };

  const openSqlTab = () => {
    if (!activeConnection) {
      return;
    }

    const profileId = activeConnection.config.id;
    const sqlTabCount = tabs.filter(
      (tab) => tab.kind === 'sql' && tab.binding.profileId === profileId
    ).length;

    registerTab(
      createSqlWorkspaceTab(profileId, {
        title: `查询 ${sqlTabCount + 1} · ${activeConnection.config.name}`
      })
    );
  };

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
        <WelcomeScreen onConnect={openConnectionForm} />
      );
    }

    // 标签永久绑定到打开它的连接。只有一个活跃会话，所以绑定到别的连接的
    // 标签不执行任何查询，而不是静默改到当前连接上执行；草稿仍然可以离线查看。
    if (activeTab.binding.profileId !== activeProfileId) {
      return (
        <OfflineTabView
          tab={activeTab}
          profileName={
            connections.find(
              (connection) => connection.id === activeTab.binding.profileId
            )?.name ?? null
          }
          draft={documents[activeTab.id]?.sqlInput ?? ''}
        />
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
        onClose={() => closeWorkspaceTab(activeTab.id)}
      />
    );
  };

  return (
    <div className="h-screen flex bg-canvas text-fg">
      {/* 左侧侧边栏 - 包含连接选择和数据库浏览器 */}
      <div className="w-80 bg-surface border-r border-line flex flex-col">
        <Sidebar
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
            unsavedTabIds={unsavedTabIds}
            onClose={closeWorkspaceTab}
            onContextMenu={(tabId, position) => setTabMenu({ tabId, position })}
            onNewSqlTab={activeConnection ? openSqlTab : undefined}
            onReopenClosedTab={closedTabs.length > 0 ? reopenClosedTab : undefined}
            closedTabCount={closedTabs.length}
          />
        )}
        <div className="flex-1 flex flex-col overflow-hidden">
          {renderActiveTab()}
        </div>
      </div>

      {menuTab && tabMenu && (
        <WorkspaceTabMenu
          tab={menuTab}
          position={tabMenu.position}
          onTogglePinned={() => {
            toggleTabPinned(menuTab.id);
            setTabMenu(null);
          }}
          onDuplicate={menuTab.kind === 'sql'
            ? () => {
                duplicateSqlTab(menuTab.id);
                setTabMenu(null);
              }
            : undefined}
          onClose={() => {
            setTabMenu(null);
            closeWorkspaceTab(menuTab.id);
          }}
          onDismiss={() => setTabMenu(null)}
        />
      )}

      {pendingCloseTab && (
        <CloseTabPrompt tabTitle={pendingCloseTab.title} onChoose={handleCloseChoice} />
      )}
    </div>
  );
}

export default App;
