import { create } from 'zustand';
import type { DesignMessages } from '../utils/aiDesign';
import type { SchemaDraft } from '../utils/schemaDraft';

/** 一个设计标签的全部状态。放在 store 而不是组件里：切到别的标签时组件会卸掉 */
export interface AiDesignState {
  requirement: string;
  draft: SchemaDraft | null;
  /** 上一次发出去的内容，原样给人看 */
  sent: DesignMessages | null;
  /** 回复读不成设计时留着原文，好让人看它到底回了什么 */
  rawReply: string | null;
  error: string | null;
}

const EMPTY: AiDesignState = { requirement: '', draft: null, sent: null, rawReply: null, error: null };

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
