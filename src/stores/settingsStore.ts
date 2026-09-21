import { create } from 'zustand';
import type { ConnectionEnvironment } from '../contracts';
import {
  loadConfirmationPolicy,
  saveConfirmationPolicy,
  type ConfirmationPolicy,
  type ConfirmationThreshold
} from '../utils/confirmationPolicy';

interface SettingsState {
  /** 每个环境从哪一级风险开始要确认 */
  confirmationPolicy: ConfirmationPolicy;
  setConfirmationThreshold: (
    environment: ConnectionEnvironment,
    threshold: ConfirmationThreshold
  ) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  confirmationPolicy: loadConfirmationPolicy(),
  setConfirmationThreshold: (environment, threshold) => {
    set((state) => {
      const confirmationPolicy = { ...state.confirmationPolicy, [environment]: threshold };
      saveConfirmationPolicy(confirmationPolicy);
      return { confirmationPolicy };
    });
  }
}));
