import { create } from 'zustand';
import type { ConnectionEnvironment } from '../contracts';
import {
  loadGridDensity,
  saveGridDensity,
  type GridDensity
} from '../utils/gridColumns';
import {
  loadConfirmationPolicy,
  saveConfirmationPolicy,
  type ConfirmationPolicy,
  type ConfirmationThreshold
} from '../utils/confirmationPolicy';
import { loadAiSettings, saveAiSettings, type AiSettings } from '../utils/aiSettings';

interface SettingsState {
  /** 每个环境从哪一级风险开始要确认 */
  confirmationPolicy: ConfirmationPolicy;
  setConfirmationThreshold: (
    environment: ConnectionEnvironment,
    threshold: ConfirmationThreshold
  ) => void;
  /** 两张网格共用一档行高。放在这里而不是各自的组件里，是为了它们不会打架 */
  gridDensity: GridDensity;
  setGridDensity: (density: GridDensity) => void;
  /** AI 设计的开关与模型服务。Key 不在这里，在系统钥匙串 */
  ai: AiSettings;
  setAi: (patch: Partial<AiSettings>) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  confirmationPolicy: loadConfirmationPolicy(),
  setConfirmationThreshold: (environment, threshold) => {
    set((state) => {
      const confirmationPolicy = { ...state.confirmationPolicy, [environment]: threshold };
      saveConfirmationPolicy(confirmationPolicy);
      return { confirmationPolicy };
    });
  },
  gridDensity: loadGridDensity(),
  setGridDensity: (gridDensity) => {
    saveGridDensity(gridDensity);
    set({ gridDensity });
  },
  ai: loadAiSettings(),
  setAi: (patch) => {
    set((state) => {
      const ai = { ...state.ai, ...patch };
      saveAiSettings(ai);
      return { ai };
    });
  }
}));
