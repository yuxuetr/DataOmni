import { create } from 'zustand';
import {
  markWorkspaceTabProfileDeleted,
  type ClosedWorkspaceTab,
  type WorkspaceTab
} from '../contracts/workspace';

/** 保留多少个最近关闭的标签。超出的最旧的一个被挤掉 */
const CLOSED_TAB_LIMIT = 10;

interface WorkspaceState {
  sidebarProfileId: string | null;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  /** 最近关闭且要求保留的标签，最新的在前 */
  closedTabs: ClosedWorkspaceTab[];
}

interface WorkspaceActions {
  selectSidebarProfile: (profileId: string | null) => void;
  restoreTabs: (
    tabs: WorkspaceTab[],
    activeTabId: string | null,
    closedTabs?: ClosedWorkspaceTab[]
  ) => void;
  /** 关闭标签但保留它，之后可以重新打开 */
  retainClosedTab: (tab: WorkspaceTab, draft: string) => void;
  /** 取回最近关闭的标签；没有可取回的返回 null */
  reopenLastClosedTab: () => ClosedWorkspaceTab | null;
  registerTab: (tab: WorkspaceTab) => void;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  handleProfileDeleted: (profileId: string, tabIdsWithDrafts?: ReadonlySet<string>) => void;
}

export type WorkspaceStore = WorkspaceState & WorkspaceActions;

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  sidebarProfileId: null,
  tabs: [],
  activeTabId: null,
  closedTabs: [],

  selectSidebarProfile: (profileId) => {
    set({ sidebarProfileId: profileId });
  },

  restoreTabs: (tabs, activeTabId, closedTabs = []) => {
    set({
      tabs,
      activeTabId: activeTabId && tabs.some((tab) => tab.id === activeTabId)
        ? activeTabId
        : tabs[0]?.id ?? null,
      closedTabs
    });
  },

  retainClosedTab: (tab, draft) => {
    set((state) => ({
      closedTabs: [
        { tab, draft, closedAt: new Date().toISOString() },
        // 同一个标签重复关闭时只留最新的一条
        ...state.closedTabs.filter((closed) => closed.tab.id !== tab.id)
      ].slice(0, CLOSED_TAB_LIMIT)
    }));
  },

  reopenLastClosedTab: () => {
    const [mostRecent] = get().closedTabs;
    if (!mostRecent) {
      return null;
    }

    set((state) => ({
      closedTabs: state.closedTabs.filter((closed) => closed.tab.id !== mostRecent.tab.id),
      tabs: state.tabs.some((tab) => tab.id === mostRecent.tab.id)
        ? state.tabs
        : [...state.tabs, mostRecent.tab],
      activeTabId: mostRecent.tab.id
    }));

    return mostRecent;
  },

  registerTab: (tab) => {
    set((state) => {
      const existingTab = state.tabs.find((candidate) => candidate.id === tab.id);

      return {
        tabs: existingTab ? state.tabs : [...state.tabs, tab],
        activeTabId: tab.id
      };
    });
  },

  activateTab: (tabId) => {
    set((state) => ({
      activeTabId: state.tabs.some((tab) => tab.id === tabId)
        ? tabId
        : state.activeTabId
    }));
  },

  closeTab: (tabId) => {
    set((state) => {
      const tabIndex = state.tabs.findIndex((tab) => tab.id === tabId);
      if (tabIndex === -1) {
        return state;
      }

      const tabs = state.tabs.filter((tab) => tab.id !== tabId);
      let activeTabId = state.activeTabId;

      if (activeTabId === tabId) {
        activeTabId = tabs[Math.min(tabIndex, tabs.length - 1)]?.id ?? null;
      }

      return { tabs, activeTabId };
    });
  },

  /**
   * 连接被删除时清理它的标签，但保留还有内容的 SQL 草稿供离线查看。
   *
   * 「有没有内容」由调用方以 `tabIdsWithDrafts` 传入：草稿正文住在
   * queryStore 的文档里，`tab.dirty` 只在创建标签时按初始 SQL 设过一次、
   * 之后从不更新，单看它会把带草稿的标签一起删掉。
   */
  handleProfileDeleted: (profileId, tabIdsWithDrafts) => {
    set((state) => {
      const tabs = state.tabs.flatMap((tab) => {
        if (tab.binding.profileId !== profileId) {
          return [tab];
        }

        if (tab.kind === 'sql' && (tab.dirty || tabIdsWithDrafts?.has(tab.id))) {
          return [markWorkspaceTabProfileDeleted(tab)];
        }

        return [];
      });
      const activeTabId = state.activeTabId
        && tabs.some((tab) => tab.id === state.activeTabId)
        ? state.activeTabId
        : tabs[0]?.id ?? null;

      return {
        sidebarProfileId: state.sidebarProfileId === profileId
          ? null
          : state.sidebarProfileId,
        tabs,
        activeTabId
      };
    });
  }
}));
