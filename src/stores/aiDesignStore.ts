import { create } from 'zustand';
import type { DesignMessages } from '../utils/aiDesign';
import type { GraphDesign } from '../utils/graphDesign';
import type { MongoDesign } from '../utils/mongoDesign';
import type { SchemaDraft } from '../utils/schemaDraft';

/** 一个设计标签的全部状态。放在 store 而不是组件里：切到别的标签时组件会卸掉 */
export interface AiDesignState {
  requirement: string;
  draft: SchemaDraft | null;
  /** MongoDB 连接上的设计。一个标签只属于一个连接，两种不会同时有 */
  mongoDraft: MongoDesign | null;
  /** Neo4j 连接上的图模型 */
  graphDraft: GraphDesign | null;
  /** 上一次发出去的内容，原样给人看 */
  sent: DesignMessages | null;
  /** 回复读不成设计时留着原文，好让人看它到底回了什么 */
  rawReply: string | null;
  error: string | null;
}

const EMPTY: AiDesignState = {
  requirement: '',
  draft: null,
  mongoDraft: null,
  graphDraft: null,
  sent: null,
  rawReply: null,
  error: null
};

interface AiDesignStore {
  designs: Record<string, AiDesignState>;
  update: (tabId: string, patch: Partial<AiDesignState>) => void;
}

export const useAiDesignStore = create<AiDesignStore>((set) => ({
  designs: {},
  update: (tabId, patch) => {
    set((state) => ({
      designs: { ...state.designs, [tabId]: { ...(state.designs[tabId] ?? EMPTY), ...patch } }
    }));
  }
}));

export const selectAiDesign = (tabId: string) => (state: AiDesignStore): AiDesignState =>
  state.designs[tabId] ?? EMPTY;
