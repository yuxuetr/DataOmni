import { useEffect, useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Sidebar } from './components/Sidebar';
import { SqlWorkbench } from './components/SqlWorkbench';
import TableDataViewer from './components/TableDataViewer';
import { ErDiagramView } from './components/ErDiagramView';
import { WelcomeScreen } from './components/WelcomeScreen';
import { CloseTabPrompt, type CloseTabChoice } from './components/CloseTabPrompt';
import { OfflineTabView } from './components/OfflineTabView';
import { WorkspaceTabMenu } from './components/WorkspaceTabMenu';
import { WorkspaceTabBar } from './components/WorkspaceTabBar';
import { isBrowsableKind, KIND_LABEL_KEYS } from './utils/databaseObjects';
import { useLanguageStore, translateNow } from './stores/languageStore';
import { tabTitle } from './utils/tabTitle';
import { useAppStore } from './stores/appStore';
import { useConnectionStore } from './stores/connectionStore';
import { selectSqlDocumentHasUnsavedContent, useQueryStore } from './stores/queryStore';
import { useWorkspaceStore } from './stores/workspaceStore';
import {
  createErDiagramWorkspaceTab,
  createSqlWorkspaceTab,
  createTableWorkspaceTab,
  workspaceTabId
} from './contracts/workspace';
import { useSessionManager } from './utils/stateSync';
import { saveWorkspaceSnapshot } from './utils/workspacePersistence';
import { useResizablePanel } from './hooks/useResizablePanel';
import { PanelResizeHandle } from './components/PanelResizeHandle';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { useProfileConnector } from './hooks/useProfileConnector';
import { useThemeStore } from './stores/themeStore';
import { environmentBadge } from './contracts/environment';

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
  const databaseMetadata = useAppStore((state) => state.databaseMetadata);
  const t = useLanguageStore((state) => state.t);
  const setLanguagePreference = useLanguageStore((state) => state.setPreference);
  const setThemePreference = useThemeStore((state) => state.setPreference);
  const { connect, openSqliteFile } = useProfileConnector();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const unsavedTabIds = useMemo(
    () => new Set(
      Object.keys(documents).filter(
        (documentId) => selectSqlDocumentHasUnsavedContent({ documents }, documentId)
      )
    ),
    [documents]
  );

  const sessionManager = useSessionManager();
  const sidebar = useResizablePanel({
    storageKey: 'sidebar',
    defaultSize: 320,
    minSize: 200,
    maxSize: 560,
    axis: 'x'
  });
  const activeProfileId = activeConnection?.config.id ?? null;
  const environmentByProfileId = useMemo(
    () => Object.fromEntries(
      connections.map((connection) => [connection.id, connection.environment])
    ),
    [connections]
  );
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
        titleKey: 'tab.queryTitle',
        titleParams: { connection: activeConnection.config.name }
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
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
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
      // 事件可能在很久以后才触发，读的必须是那一刻的语言，不是挂监听时的
      sessionManager.reportConnectionLost('network', translateNow('session.networkLost'));
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
      title: t('tab.duplicate', { title: tabTitle(tab, t) })
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
        titleKey: 'tab.queryNumbered',
        titleParams: { index: sqlTabCount + 1, connection: activeConnection.config.name }
      })
    );
  };

  /** ER 图是库级的，一个连接一个标签；重复打开只是激活已有的那个 */
  const openErDiagramTab = () => {
    if (!activeConnection) {
      return;
    }
    const profileId = activeConnection.config.id;
    registerTab(
      createErDiagramWorkspaceTab(profileId, { id: workspaceTabId(profileId, 'er-diagram') })
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

  // 命令面板的条目由当前状态现算：已保存的连接、当前连接已加载出来的表，
  // 以及若干全局动作。表只在对象树加载过之后才有——不为了面板再查一次库。
  //
  // 刻意不做 useMemo：条目里的 run 闭包捕获了 tabs、activeConnection 等状态，
  // 缓存住就会执行到旧的那一份（比如新标签的序号算错）。这段只在面板打开时
  // 调用一次，几百个条目的字符串拼接不值得为它承担失效风险。
  const buildPaletteCommands = (): PaletteCommand[] => {
    const items: PaletteCommand[] = [];

    for (const connection of connections) {
      const isActive = connection.id === activeProfileId;
      items.push({
        id: `connect:${connection.id}`,
        title: connection.name,
        keywords: `${connection.db_type} ${connection.host} ${connection.database ?? ''}`,
        group: isActive ? t('palette.group.currentConnection') : t('palette.group.connection'),
        // 环境写成文字拼进说明里：命令面板是切库的快路径，切到生产库这件事
        // 必须在按下 Enter 之前就看得见
        detail: [
          (() => {
            const badge = environmentBadge(connection.environment);
            return badge ? t(badge.labelKey) : '';
          })(),
          connection.db_type === 'sqlite'
            ? connection.database ?? ''
            : `${connection.host}:${connection.port}`
        ].filter(Boolean).join(' · '),
        run: () => {
          if (!isActive) {
            void connect(connection);
          }
        }
      });
    }

    const metadata = activeProfileId ? databaseMetadata[activeProfileId] : undefined;
    // 只收能打开的对象：函数与序列没有行，放进来选中后无事发生
    for (const object of metadata?.objects ?? []) {
      if (!isBrowsableKind(object.kind)) {
        continue;
      }
      items.push({
        id: `object:${object.kind}:${object.schema ?? ''}:${object.name}`,
        title: object.name,
        keywords: object.schema ?? '',
        group: t(KIND_LABEL_KEYS[object.kind]),
        detail: object.schema ?? '',
        run: () => openTableTab(object.name, object.schema ?? undefined)
      });
    }

    items.push(
      {
        id: 'action:new-sql',
        title: t('palette.action.newSql'),
        group: t('palette.group.action'),
        run: () => openSqlTab()
      },
      {
        id: 'action:new-connection',
        title: t('palette.action.newConnection'),
        group: t('palette.group.action'),
        run: () => openConnectionForm()
      },
      {
        id: 'action:open-sqlite',
        title: t('palette.action.openSqlite'),
        group: t('palette.group.action'),
        run: () => void openSqliteFile()
      },
      {
        id: 'action:er-diagram',
        title: t('er.open'),
        group: t('palette.group.action'),
        run: () => openErDiagramTab()
      },
      {
        id: 'action:reopen-tab',
        title: t('palette.action.reopenTab'),
        group: t('palette.group.action'),
        run: () => reopenClosedTab()
      },
      {
        id: 'action:theme-light',
        title: t('palette.action.themeLight'),
        group: t('palette.group.action'),
        run: () => setThemePreference('light')
      },
      {
        id: 'action:theme-dark',
        title: t('palette.action.themeDark'),
        group: t('palette.group.action'),
        run: () => setThemePreference('dark')
      },
      {
        id: 'action:theme-system',
        title: t('palette.action.themeSystem'),
        group: t('palette.group.action'),
        run: () => setThemePreference('system')
      },
      {
        id: 'action:language-zh',
        title: t('palette.action.languageZh'),
        group: t('palette.group.action'),
        run: () => setLanguagePreference('zh')
      },
      {
        id: 'action:language-en',
        title: t('palette.action.languageEn'),
        group: t('palette.group.action'),
        run: () => setLanguagePreference('en')
      },
      {
        id: 'action:language-system',
        title: t('palette.action.languageSystem'),
        group: t('palette.group.action'),
        run: () => setLanguagePreference('system')
      }
    );

    return items;
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

    if (activeTab.kind === 'er-diagram') {
      return <ErDiagramView key={activeTab.id} connection={activeConnection.config} />;
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
      <div
        className="flex shrink-0 flex-col bg-surface"
        style={{ width: `${sidebar.size}px` }}
      >
        <Sidebar
          activeConnectionId={activeConnection?.config.id}
          onConnectionDeleted={(connectionId) => sessionManager.handleConnectionDeleted(connectionId)}
          onTableSelect={openTableTab}
          onOpenErDiagram={openErDiagramTab}
        />
      </div>

      <PanelResizeHandle
        axis="x"
        active={sidebar.isResizing}
        onPointerDown={sidebar.startResize}
        onDoubleClick={sidebar.resetSize}
        label={t('tab.resizeSidebar')}
      />

      {/* 右侧主内容区域 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {tabs.length > 0 && (
          <WorkspaceTabBar
            tabs={tabs}
            activeTabId={activeTabId}
            activeProfileId={activeProfileId}
            onActivate={activateTab}
            unsavedTabIds={unsavedTabIds}
            environmentByProfileId={environmentByProfileId}
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

      {paletteOpen && (
        <CommandPalette
          commands={buildPaletteCommands()}
          onDismiss={() => setPaletteOpen(false)}
        />
      )}

      {pendingCloseTab && (
        <CloseTabPrompt tabTitle={tabTitle(pendingCloseTab, t)} onChoose={handleCloseChoice} />
      )}
    </div>
  );
}

export default App;
