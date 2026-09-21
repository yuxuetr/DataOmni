import { create } from 'zustand';
import {
  annotateEntry,
  historyEntryFromExecution,
  type QueryHistoryContext,
  type QueryHistoryEntry
} from '../contracts/queryHistory';
import type { QueryExecution } from '../contracts/queryExecution';
import {
  loadHistoryRetention,
  loadQueryHistory,
  pruneHistory,
  saveHistoryRetention,
  saveQueryHistory,
  type HistoryRetention
} from '../utils/queryHistoryStorage';

const INITIAL_RETENTION = loadHistoryRetention();

interface HistoryState {
  /** 最新的在前 */
  entries: QueryHistoryEntry[];
  retention: HistoryRetention;
  record: (execution: QueryExecution, context: QueryHistoryContext) => void;
  /** 改保留策略。立刻按新策略淘汰一遍，见实现处的说明 */
  setRetention: (retention: Partial<HistoryRetention>) => void;
  /** 收藏 / 命名 / 打标签。只传要改的那几项 */
  annotate: (id: string, annotation: { favorite?: boolean; name?: string; tags?: string[] }) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useHistoryStore = create<HistoryState>((set) => ({
  // 启动时就按当前策略淘汰一遍：保留期是从「现在」算的，不能等到下次执行
  // 才生效——一个只读不跑查询的会话里，过期记录会一直摆在那
  entries: pruneHistory(loadQueryHistory(), INITIAL_RETENTION),
  retention: INITIAL_RETENTION,

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

  setRetention: (change) => {
    set((state) => {
      const retention = { ...state.retention, ...change };
      saveHistoryRetention(retention);
      // 立刻执行而不是等下次执行查询：调小上限多半就是为了腾地方，
      // 设完什么也没发生会让人以为没生效，再去调一次更小的
      const entries = pruneHistory(state.entries, retention);
      saveQueryHistory(entries);
      return { retention, entries };
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
