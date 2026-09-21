import { create } from 'zustand';
import {
  annotateEntry,
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
  /** 收藏 / 命名 / 打标签。只传要改的那几项 */
  annotate: (id: string, annotation: { favorite?: boolean; name?: string; tags?: string[] }) => void;
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

  annotate: (id, annotation) => {
    set((state) => {
      const entries = state.entries.map((entry) =>
        entry.id === id ? annotateEntry(entry, annotation) : entry
      );
      // 不在这里 prune：刚被收藏的记录本来就该留下，而取消收藏的那条如果
      // 立刻因为过期消失，用户会以为自己按错了键把它删掉了
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
