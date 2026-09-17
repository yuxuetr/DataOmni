import { create } from 'zustand';
import type { WorkspaceTab } from '../contracts/workspace';

interface WorkspaceState {
  sidebarProfileId: string | null;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
}

interface WorkspaceActions {
  selectSidebarProfile: (profileId: string | null) => void;
  registerTab: (tab: WorkspaceTab) => void;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
}

export type WorkspaceStore = WorkspaceState & WorkspaceActions;

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  sidebarProfileId: null,
  tabs: [],
  activeTabId: null,

  selectSidebarProfile: (profileId) => {
    set({ sidebarProfileId: profileId });
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
  }
}));
