/**
 * 主题偏好的读写与落地。
 *
 * 只有三种偏好，其中 `system` 需要在运行期跟随系统变化，所以「偏好」和
 * 「当前生效的主题」是两个值，不能合并成一个。
 */
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'dataomni_theme';
const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** 读不到、读坏、localStorage 不可用时一律回落到跟随系统 */
export function loadThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // 存储被禁用时主题仍然生效，只是重启后回到跟随系统
  }
}

export function prefersDarkScheme(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(DARK_SCHEME_QUERY).matches;
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }
  return preference;
}

/** 写到 <html data-theme>，index.css 的变量按这个属性切换 */
export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
}

/** 订阅系统主题变化；返回取消订阅函数。环境不支持 matchMedia 时是个空订阅。 */
export function watchSystemTheme(onChange: (systemPrefersDark: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }

  const media = window.matchMedia(DARK_SCHEME_QUERY);
  const handleChange = (event: MediaQueryListEvent) => onChange(event.matches);
  media.addEventListener('change', handleChange);
  return () => media.removeEventListener('change', handleChange);
}

/**
 * 首屏渲染前调用，避免先闪一帧浅色再切到深色。
 * 返回读到的偏好，交给 store 作为初始值。
 */
export function initializeTheme(): ThemePreference {
  const preference = loadThemePreference();
  applyTheme(resolveTheme(preference, prefersDarkScheme()));
  return preference;
}
