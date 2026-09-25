import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import {
  CLOSE_TAB_MENU_EVENT,
  SHORTCUTS,
  currentPlatform,
  matchesShortcut,
  tabShortcut
} from './utils/shortcuts';
import { tabIndexForShortcut } from './utils/tabListNavigation';
import { planCloseOthers } from './utils/closeOtherTabs';
import { PanelLeftOpen } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { RenderErrorBoundary } from './components/RenderErrorBoundary';
import { Sidebar } from './components/Sidebar';
import { TaskCenter } from './components/TaskCenter';
import { SqlWorkbench } from './components/SqlWorkbench';
import TableDataViewer from './components/TableDataViewer';
import { MongoCollectionViewer } from './components/MongoCollectionViewer';
import { RedisKeyBrowser } from './components/RedisKeyBrowser';
import { redisDatabaseIndex } from './utils/redisKeys';
import { MongoCollectionStructureView } from './components/MongoCollectionStructureView';
import { DatabaseType } from './contracts/connection';
import { speaksSql } from './contracts/databaseSupport';
import { ErDiagramView } from './components/ErDiagramView';
import { WelcomeScreen } from './components/WelcomeScreen';
import { CloseTabPrompt, type CloseTabChoice } from './components/CloseTabPrompt';
import {
  UncommittedTransactionPrompt,
  type LeaveTransactionChoice
} from './components/UncommittedTransactionPrompt';
import { OfflineTabView } from './components/OfflineTabView';
import { WorkspaceTabMenu } from './components/WorkspaceTabMenu';
import { WorkspaceTabBar } from './components/WorkspaceTabBar';
import { workspaceTabDomId, WORKSPACE_PANEL_DOM_ID } from './utils/tabListNavigation';
import { isBrowsableKind, KIND_LABEL_KEYS } from './utils/databaseObjects';
import { useLanguageStore, translateNow } from './stores/languageStore';
import { tabTitle } from './utils/tabTitle';
import { useAppStore } from './stores/appStore';
import { useConnectionStore } from './stores/connectionStore';
import { selectSqlDocumentHasUnsavedContent, useQueryStore } from './stores/queryStore';
import {
  isLastTabForTable,
  pendingChangeCount,
  tableKeyOfTab,
  useTableEditStore
} from './stores/tableEditStore';
import { useWorkspaceStore } from './stores/workspaceStore';
import {
  createErDiagramWorkspaceTab,
  createSqlWorkspaceTab,
  createTableWorkspaceTab,
  orderWorkspaceTabs,
  tabsShowingTable,
  workspaceTabId
} from './contracts/workspace';
import { useSessionManager } from './utils/stateSync';
import { saveWorkspaceSnapshot } from './utils/workspacePersistence';
import { useResizablePanel } from './hooks/useResizablePanel';
import { PanelResizeHandle } from './components/PanelResizeHandle';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { QueryHistoryDialog } from './components/QueryHistoryDialog';
import { SQL_FILE_FILTER, stripBom, tabTitleFromSqlPath } from './utils/sqlFile';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { describeError } from './utils/describeError';
import { useProfileConnector } from './hooks/useProfileConnector';
import { useThemeStore } from './stores/themeStore';
import { environmentBadge } from './contracts/environment';

/** 只在走 SQL 的连接上有意义的命令面板条目 */
const SQL_ONLY_PALETTE_ACTIONS: ReadonlySet<string> = new Set([
  'action:new-sql',
  'action:open-sql-file',
  'action:er-diagram'
]);

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
  // 事务没结束就要断开时，等用户在三选一里做决定
  const [leavingTransaction, setLeavingTransaction] = useState<
    {
      startedAt: string;
      canCommit: boolean;
      decide: (choice: LeaveTransactionChoice) => void;
    } | null
  >(null);
  const documents = useQueryStore((state) => state.documents);
  const connections = useConnectionStore((state) => state.connections);
  const databaseMetadata = useAppStore((state) => state.databaseMetadata);
  const t = useLanguageStore((state) => state.t);
  const setLanguagePreference = useLanguageStore((state) => state.setPreference);
  const setThemePreference = useThemeStore((state) => state.setPreference);
  const { connect, openSqliteFile } = useProfileConnector();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

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
  // 当前连接能不能跑 SQL。不能的（MongoDB）上，一切「开一个 SQL 标签」的入口都不给
  const activeSpeaksSql = activeConnection ? speaksSql(activeConnection.config.db_type) : false;
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
  //
  // 依赖里必须有 `activeConnection`：断开时下面那个 effect 会把活动文档清成
  // null，而重新连上时**标签 id 没变**，只看 id 的话这个 effect 不会再跑一次，
  // 活动文档就永远是 null 了。恢复工作区正是这条路径——重启应用、点连接、
  // 在编辑器里打字，字能打出来（那是 CodeMirror 自己的状态），但写不进 store，
  // 工具栏一直是「未解析出语句」，执行按钮一直是灰的。
  useEffect(() => {
    if (activeTab?.kind === 'sql' && activeConnection) {
      openDocument(activeTab.id);
    }
  }, [activeTab?.id, activeTab?.kind, activeConnection, openDocument]);

  // 每个连接有一个 SQL 标签，连接就绪后按需创建；id 由连接决定，重复注册会被去重
  useEffect(() => {
    // MongoDB 没有 SQL 编辑器可开；连上之后从对象树点集合
    if (!activeConnection || !speaksSql(activeConnection.config.db_type)) {
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
      if (matchesShortcut(event, SHORTCUTS.reopenClosedTab)) {
        event.preventDefault();
        reopenClosedTab();
        return;
      }

      const tabTarget = tabShortcut(event);
      if (tabTarget) {
        const ordered = orderWorkspaceTabs(tabs);
        const current = ordered.findIndex((tab) => tab.id === activeTabId);
        const index = tabIndexForShortcut(tabTarget, current, ordered.length);
        if (index !== null) {
          event.preventDefault();
          activateTab(ordered[index].id);
        }
        return;
      }

      if (matchesShortcut(event, SHORTCUTS.commandPalette)) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }

      // macOS 上 ⌘W 被原生菜单先接走，这里根本收不到；在这里也认的话，
      // 哪天菜单那一侧没拦住，一次按键会关掉两个标签
      if (currentPlatform() !== 'mac' && matchesShortcut(event, SHORTCUTS.closeTab)) {
        event.preventDefault();
        closeActiveTab();
        return;
      }

      // 折叠侧边栏。不带 shift——带 shift 的 B 在 CodeMirror 里没占用，
      // 但这个组合在别处普遍就是「收起侧栏」，改掉只会让人多试一次
      if (matchesShortcut(event, SHORTCUTS.toggleSidebar)) {
        event.preventDefault();
        sidebar.toggleCollapsed();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  /**
   * 断开之前先问一句事务。
   *
   * 状态**当场重新读一次**，不用界面上那份：用户可能刚在别处提交过，
   * 拿一份旧状态弹框是在为一件已经不存在的事拦人。
   *
   * 返回 false = 用户选择留下，调用方原地停下。
   */
  const mayLeaveTransaction = useCallback(async () => {
    const store = useQueryStore.getState();
    await store.refreshTransaction();
    const transaction = useQueryStore.getState().session?.transaction;
    if (!transaction || transaction.status === 'idle') {
      return true;
    }

    const choice = await new Promise<LeaveTransactionChoice>((resolve) => {
      setLeavingTransaction({
        startedAt: transaction.startedAt
          ? new Date(transaction.startedAt).toLocaleTimeString()
          : '—',
        canCommit: transaction.status === 'active',
        decide: resolve
      });
    });
    setLeavingTransaction(null);

    if (choice === 'cancel') {
      return false;
    }
    // 提交失败就别走：那条事务还在，而用户以为他已经提交了
    return useQueryStore.getState().runTransactionStatement(
      choice === 'commit' ? 'COMMIT' : 'ROLLBACK'
    );
  }, []);

  useEffect(() => {
    sessionManager.setLeaveGuard(mayLeaveTransaction);
    return () => sessionManager.setLeaveGuard(null);
  }, [sessionManager, mayLeaveTransaction]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let closing = false;
    let unlisten: (() => void) | undefined;

    void appWindow.onCloseRequested(async (event) => {
      event.preventDefault();

      if (closing) {
        return;
      }

      // 退出前先问事务：窗口一关，数据库会把没提交的整个回滚掉
      if (!(await mayLeaveTransaction())) {
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
  }, [sessionManager, mayLeaveTransaction]);

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

    // 表标签的待提交改动此前只活在组件里，标签栏这个叉一按就没了——表视图自己
    // 那个「关闭」按钮会问一句，而标签栏上的不会。改动挪进 store 之后两条路都要
    // 问，并且只有这张表的最后一个标签关掉时才清：数据页和结构页是两个标签，
    // 指的是同一张表，共用同一份改动
    const tableKey = tab ? tableKeyOfTab(tab) : null;
    if (tableKey && isLastTabForTable(tabs, tabId)) {
      const count = pendingChangeCount(tableKey);
      if (count > 0 && !confirm(t('changes.discardConfirm', { count }))) {
        return;
      }
      useTableEditStore.getState().clearChanges(tableKey);
    }

    finishCloseTab(tabId, false);
  };

  /** 标签右键菜单的「关闭其他标签」。关哪些、草稿怎么办见 `planCloseOthers` */
  const closeOtherTabs = (keepId: string) => {
    const plan = planCloseOthers(
      tabs,
      keepId,
      (tab) => selectSqlDocumentHasUnsavedContent(useQueryStore.getState(), tab.id),
      (tab) => {
        const tableKey = tableKeyOfTab(tab);
        return tableKey !== null && pendingChangeCount(tableKey) > 0;
      }
    );
    for (const { id, retainDraft } of plan.close) {
      finishCloseTab(id, retainDraft);
    }
  };

  /**
   * ⌘W / Ctrl+W。没有标签开着时什么也不做：关窗口是 ⇧⌘W，
   * 在欢迎页上多按一次 ⌘W 不该把整个应用关掉。
   */
  const closeActiveTab = () => {
    if (activeTabId) {
      closeWorkspaceTab(activeTabId);
    }
  };

  // 菜单事件只订阅一次，通过 ref 调到最新一次渲染的闭包——每次渲染重订一遍
  // 的话，异步的 listen 与 unlisten 交错时会短暂挂着两个监听，一下关两个标签
  const closeActiveTabRef = useRef(closeActiveTab);
  closeActiveTabRef.current = closeActiveTab;
  useEffect(() => {
    const unlisten = listen(CLOSE_TAB_MENU_EVENT, () => closeActiveTabRef.current())
      .catch((error: unknown) => {
        console.warn('订阅菜单的关闭标签事件失败:', error);
        return () => undefined;
      });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

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

  /**
   * 开一个新的 SQL 标签，可带初始内容。
   *
   * 从历史里取回语句走的是「开新标签」而不是「写进当前标签」：后者会把用户
   * 正在写的草稿覆盖掉，而那份草稿没有第二个地方存着。
   */
  const openSqlTab = (initialSql?: string, title?: string) => {
    if (!activeConnection || !activeSpeaksSql) {
      return;
    }

    const profileId = activeConnection.config.id;
    const sqlTabCount = tabs.filter(
      (tab) => tab.kind === 'sql' && tab.binding.profileId === profileId
    ).length;

    const tab = createSqlWorkspaceTab(
      profileId,
      // 从文件打开的标签直接用文件名，不走「查询 N」的编号
      title
        ? { title }
        : {
            titleKey: 'tab.queryNumbered',
            titleParams: { index: sqlTabCount + 1, connection: activeConnection.config.name }
          }
    );
    registerTab(tab);

    if (initialSql) {
      // 先建文档再灌内容：openDocument 对新 id 会建一份空的
      openDocument(tab.id);
      setSqlInput(initialSql);
    }
  };

  /**
   * 把一个 `.sql` 文件读进新标签。
   *
   * 一律开新标签而不是覆盖当前草稿——打开文件是「多一份东西」，不是「换掉
   * 手里这份」。标签名取文件名，这样标签栏上看得出开的是哪个脚本。
   */
  const openSqlFile = async () => {
    if (!activeConnection || !activeSpeaksSql) {
      return;
    }

    const selected = await open({ multiple: false, filters: [SQL_FILE_FILTER] });
    if (typeof selected !== 'string') {
      return;
    }

    try {
      const contents = await invoke<string>('read_text_file', { path: selected });
      // BOM 在编辑器里不可见，却会跟着第一条语句发给数据库，换来一条指着
      // 第 1 行第 1 列的语法错误，而那一行看上去完全正常
      openSqlTab(stripBom(contents), tabTitleFromSqlPath(selected));
    } catch (error) {
      setFileError(describeError(error, t('editor.openFailed')));
    }
  };

  /** ER 图是库级的，一个连接一个标签；重复打开只是激活已有的那个 */
  const openErDiagramTab = () => {
    if (!activeConnection || !activeSpeaksSql) {
      return;
    }
    const profileId = activeConnection.config.id;
    registerTab(
      createErDiagramWorkspaceTab(profileId, { id: workspaceTabId(profileId, 'er-diagram') })
    );
  };

  const openTableTab = (
    tableName: string,
    schema?: string,
    kind: 'table-data' | 'table-structure' = 'table-data'
  ) => {
    if (!activeConnection) {
      return;
    }

    const profileId = activeConnection.config.id;
    const object = { schema: schema ?? null, table: tableName };
    const qualified = schema ? `${schema}.${tableName}` : tableName;

    registerTab(
      createTableWorkspaceTab(profileId, tableName, {
        // 标签 id 带上 kind：数据页和结构页是两个标签，同时开着才有意义
        id: workspaceTabId(profileId, kind, object),
        kind,
        schema: schema ?? null,
        title: qualified,
        // 结构页另带一个文案键：两个标签都叫 `public.users` 的话，
        // 只剩图标能分辨，而图标是要认的，文字是读的
        ...(kind === 'table-structure'
          ? { titleKey: 'tab.structureTitle', titleParams: { table: qualified } }
          : {})
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
        id: 'action:open-sql-file',
        title: t('tab.openSqlFile'),
        group: t('palette.group.action'),
        run: () => void openSqlFile()
      },
      {
        id: 'action:history',
        title: t('history.open'),
        group: t('palette.group.action'),
        run: () => setShowHistory(true)
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
        shortcut: SHORTCUTS.reopenClosedTab,
        run: () => reopenClosedTab()
      },
      ...(activeTab
        ? [{
            id: 'action:close-tab',
            title: t('tab.closeAction'),
            group: t('palette.group.action'),
            shortcut: SHORTCUTS.closeTab,
            run: () => closeActiveTab()
          }]
        : []),
      {
        id: 'action:toggle-sidebar',
        title: t('palette.action.toggleSidebar'),
        group: t('palette.group.action'),
        shortcut: SHORTCUTS.toggleSidebar,
        run: () => sidebar.toggleCollapsed()
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

    // 连着 MongoDB 时，要开 SQL 标签的那几条放出来也只是点了没反应
    return activeConnection && !activeSpeaksSql
      ? items.filter((item) => !SQL_ONLY_PALETTE_ACTIONS.has(item.id))
      : items;
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
          documentTitle={tabTitle(activeTab, t)}
        />
      );
    }

    if (!activeConnection) {
      return null;
    }

    if (activeTab.kind === 'er-diagram') {
      return <ErDiagramView key={activeTab.id} connection={activeConnection.config} />;
    }

    // Redis 的逻辑库同样开在这种标签里（table 那一格是 `db3`），换成键浏览页
    if (activeConnection.config.db_type === DatabaseType.Redis) {
      return <RedisKeyBrowser key={activeTab.id} database={redisDatabaseIndex(activeTab.object.table)} />;
    }

    // MongoDB 的集合开在同一种标签里（schema 那一格是库名），换一个浏览页：
    // 标签的身份、去重、持久化与关系库的表完全一样，不必另起一种标签
    if (!activeSpeaksSql) {
      // 种类来自对象树；树还没读出来时按集合处理：写视图会被服务端拒绝并说明
      const isView = databaseMetadata[activeTab.binding.profileId]?.objects.some((object) => (
        object.kind === 'view'
        && object.schema === activeTab.object.schema
        && object.name === activeTab.object.table
      )) ?? false;
      return activeTab.kind === 'table-structure' ? (
        <MongoCollectionStructureView
          key={activeTab.id}
          database={activeTab.object.schema ?? ''}
          collection={activeTab.object.table}
          isView={isView}
        />
      ) : (
        <MongoCollectionViewer
          key={activeTab.id}
          database={activeTab.object.schema ?? ''}
          collection={activeTab.object.table}
          // 视图不能写
          readOnly={isView}
        />
      );
    }

    return (
      <TableDataViewer
        key={activeTab.id}
        connection={activeConnection.config}
        tableName={activeTab.object.table}
        schema={activeTab.object.schema ?? undefined}
        initialTab={activeTab.kind === 'table-structure' ? 'schema' : 'data'}
        onClose={() => closeWorkspaceTab(activeTab.id)}
        onRenamed={(table) => {
          // 数据页与结构页都钉着旧名字；关掉它们，换一个新名字的结构页
          tabsShowingTable(tabs, activeTab.binding.profileId, activeTab.object)
            .forEach((tab) => finishCloseTab(tab.id, false));
          openTableTab(table, activeTab.object.schema ?? undefined, 'table-structure');
        }}
      />
    );
  };

  return (
    <div className="h-screen flex bg-canvas text-fg">
      {/* 左侧侧边栏 - 包含连接选择和数据库浏览器 */}
      {/* 折叠用 display:none 而不是卸载：对象树的展开节点、滚动位置、已取回的
          元数据全是 DatabaseExplorer 的局部状态，卸载一次「恢复」就名不副实了。
          display 类写成三元而不是叠一个 `hidden`——两个都是单类选择器，
          谁赢取决于 Tailwind 输出的先后，不该赌 */}
      <div
        className={clsx(
          'shrink-0 flex-col bg-surface',
          sidebar.collapsed ? 'hidden' : 'flex'
        )}
        style={{ width: `${sidebar.size}px` }}
      >
        <Sidebar
          activeConnectionId={activeConnection?.config.id}
          onConnectionDeleted={(connectionId) => sessionManager.handleConnectionDeleted(connectionId)}
          onTableSelect={(table, schema) => openTableTab(table, schema)}
          onOpenStructure={(table, schema) => openTableTab(table, schema, 'table-structure')}
          onOpenErDiagram={openErDiagramTab}
          onOpenHistory={() => setShowHistory(true)}
          onCollapse={sidebar.toggleCollapsed}
        />
      </div>

      {/* 折叠后留一条窄轨。折叠的入口只有快捷键的话，按错一次就找不回来了 */}
      {sidebar.collapsed ? (
        <div className="flex shrink-0 flex-col items-center border-r border-line bg-surface-sunken px-1.5 py-2">
          <button
            type="button"
            onClick={sidebar.toggleCollapsed}
            aria-label={t('panel.expandSidebar')}
            title={t('panel.expandSidebar')}
            className="rounded-control p-1.5 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
          >
            <PanelLeftOpen size={16} />
          </button>
        </div>
      ) : (
        <PanelResizeHandle
          axis="x"
          active={sidebar.isResizing}
          onPointerDown={sidebar.startResize}
          onDoubleClick={sidebar.resetSize}
          label={t('tab.resizeSidebar')}
        />
      )}

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
            onNewSqlTab={activeSpeaksSql ? () => openSqlTab() : undefined}
            onOpenSqlFile={activeSpeaksSql ? () => void openSqlFile() : undefined}
            onReopenClosedTab={closedTabs.length > 0 ? reopenClosedTab : undefined}
            closedTabCount={closedTabs.length}
          />
        )}
        {/* 打开文件失败就报在标签栏底下：动作是从这里发起的，
            提示也该出现在这里，而不是挤进某个标签的内容里 */}
        {fileError && (
          <div className="flex items-start gap-2 border-b border-danger-line bg-danger-soft px-3 py-2">
            <span className="min-w-0 flex-1 break-words text-xs text-danger">{fileError}</span>
            <button
              type="button"
              onClick={() => setFileError(null)}
              aria-label={t('common.close')}
              className="shrink-0 text-danger hover:opacity-80"
            >
              ✕
            </button>
          </div>
        )}
        <div
          id={WORKSPACE_PANEL_DOM_ID}
          role="tabpanel"
          aria-labelledby={activeTab ? workspaceTabDomId(activeTab.id) : undefined}
          // **不**给它 tabIndex：ARIA 只在面板里没有可聚焦元素时才要求加，
          // 而这里的面板永远有（编辑器、网格、按钮）。多一个停靠点意味着
          // Tab 过来要先空按一下才进得了编辑器
          className="flex-1 flex flex-col overflow-hidden"
        >
          {/* key 跟着标签走：换一个标签就是一块新的边界，不会带着上一块的错误 */}
          <RenderErrorBoundary key={activeTab?.id ?? 'welcome'} scope="tab">
            {renderActiveTab()}
          </RenderErrorBoundary>
        </div>
      </div>

      <TaskCenter />

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
          onCloseOthers={tabs.some((tab) => tab.id !== menuTab.id && !tab.pinned)
            ? () => {
                setTabMenu(null);
                closeOtherTabs(menuTab.id);
              }
            : undefined}
          onDismiss={() => setTabMenu(null)}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          commands={buildPaletteCommands()}
          onDismiss={() => setPaletteOpen(false)}
        />
      )}

      {showHistory && (
        <QueryHistoryDialog
          onClose={() => setShowHistory(false)}
          onOpenInNewTab={activeSpeaksSql ? (sql) => openSqlTab(sql) : undefined}
        />
      )}

      {pendingCloseTab && (
        <CloseTabPrompt tabTitle={tabTitle(pendingCloseTab, t)} onChoose={handleCloseChoice} />
      )}

      {leavingTransaction && (
        <UncommittedTransactionPrompt
          startedAt={leavingTransaction.startedAt}
          canCommit={leavingTransaction.canCommit}
          onChoose={leavingTransaction.decide}
        />
      )}
    </div>
  );
}

export default App;
