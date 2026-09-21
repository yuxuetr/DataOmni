import { create } from 'zustand';
import {
  historyEntryFromExecution,
  type QueryHistoryContext,
  type QueryHistoryEntry
} from '../contracts/queryHistory';
import type { QueryExecution } from '../contracts/queryExecution';
import {
  DEFAULT_HISTORY_RETENTION,
  loadQueryHistory,
  pruneHistory,
  saveQueryHistory,
  type HistoryRetention
} from '../utils/queryHistoryStorage';

interface HistoryState {
  /** 最新的在前 */
  entries: QueryHistoryEntry[];
  retention: HistoryRetention;
  record: (execution: QueryExecution, context: QueryHistoryContext) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useHistoryStore = create<HistoryState>((set) => ({
  // 启动时就按当前策略淘汰一遍：保留期是从「现在」算的，不能等到下次执行
  // 才生效——一个只读不跑查询的会话里，过期记录会一直摆在那
  entries: pruneHistory(loadQueryHistory(), DEFAULT_HISTORY_RETENTION),
  retention: DEFAULT_HISTORY_RETENTION,

  record: (execution, context) => {
    const entry = historyEntryFromExecution(execution, context);
    if (!entry) {
      return;
    }
    set((state) => {
      const entries = pruneHistory([entry, ...state.entries], state.retention);
      saveQueryHistory(entries);
      return { entries };
    });
  },

  remove: (id) => {
    set((state) => {
      const entries = state.entries.filter((entry) => entry.id !== id);
      saveQueryHistory(entries);
      return { entries };
    });
  },

  clear: () => {
    saveQueryHistory([]);
    return set({ entries: [] });
  }
}));
