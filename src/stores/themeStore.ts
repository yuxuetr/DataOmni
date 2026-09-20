import { create } from 'zustand';
import {
  applyTheme,
  initializeTheme,
  prefersDarkScheme,
  resolveTheme,
  saveThemePreference,
  watchSystemTheme,
  type ResolvedTheme,
  type ThemePreference
} from '../utils/theme';

interface ThemeState {
  preference: ThemePreference;
  /** 当前真正生效的主题；preference 为 system 时随系统变化 */
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

// initializeTheme 已在 main.tsx 里跑过并写好了 data-theme；这里只是把同一份
// 偏好读进 store 作为初始值，不会造成第二次闪烁。
const initialPreference = initializeTheme();

export const useThemeStore = create<ThemeState>((set) => ({
  preference: initialPreference,
  resolved: resolveTheme(initialPreference, prefersDarkScheme()),
  setPreference: (preference) => {
    const resolved = resolveTheme(preference, prefersDarkScheme());
    saveThemePreference(preference);
    applyTheme(resolved);
    set({ preference, resolved });
  }
}));

// 系统主题变化只在「跟随系统」时改变生效主题。订阅与应用同生命周期，
// 不做解绑：解绑的时机只有应用退出。
watchSystemTheme((systemPrefersDark) => {
  const { preference } = useThemeStore.getState();
  if (preference !== 'system') {
    return;
  }

  const resolved = resolveTheme('system', systemPrefersDark);
  applyTheme(resolved);
  useThemeStore.setState({ resolved });
});
