/**
 * 这个文件需要 DOM：applyTheme 写 <html data-theme>，watchSystemTheme 用 matchMedia。
 * 只给这一个文件换环境，其余纯逻辑测试仍跑在更快的 node 环境里。
 *
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  initializeTheme,
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
  watchSystemTheme
} from './theme';

const STORAGE_KEY = 'dataomni_theme';

function installMemoryStorage(): Map<string, string> {
  const store = new Map<string, string>();

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    }
  });

  return store;
}

/** 装一个可控的 matchMedia，并返回触发系统主题变化的函数 */
function installMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' ? matches : false,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }
  }));

  return {
    emit: (nextMatches: boolean) => {
      for (const listener of listeners) {
        listener({ matches: nextMatches } as MediaQueryListEvent);
      }
    },
    listenerCount: () => listeners.size
  };
}

describe('主题偏好', () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    storage = installMemoryStorage();
    document.documentElement.removeAttribute('data-theme');
  });

  it('没存过时跟随系统', () => {
    expect(loadThemePreference()).toBe('system');
  });

  it('往返保存与读取', () => {
    saveThemePreference('dark');
    expect(loadThemePreference()).toBe('dark');
  });

  it('存着不认识的值时回落到跟随系统', () => {
    storage.set(STORAGE_KEY, 'solarized');
    expect(loadThemePreference()).toBe('system');
  });

  it('localStorage 抛错时读取回落、写入不抛', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('quota exceeded');
      }
    });

    expect(loadThemePreference()).toBe('system');
    expect(() => saveThemePreference('dark')).not.toThrow();
  });

  it('显式偏好不受系统偏好影响', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('跟随系统时由系统偏好决定', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('生效主题写到 <html data-theme>', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('初始化时按已存偏好直接落地，不经过一帧浅色', () => {
    storage.set(STORAGE_KEY, 'dark');
    installMatchMedia(false);

    expect(initializeTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('跟随系统且系统为深色时初始化为深色', () => {
    installMatchMedia(true);

    expect(initializeTheme()).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('系统主题变化会通知订阅者，取消订阅后不再通知', () => {
    const media = installMatchMedia(false);
    const onChange = vi.fn();

    const unsubscribe = watchSystemTheme(onChange);
    media.emit(true);
    expect(onChange).toHaveBeenCalledWith(true);

    unsubscribe();
    expect(media.listenerCount()).toBe(0);
  });

  it('环境没有 matchMedia 时不抛，订阅是空操作', () => {
    vi.stubGlobal('matchMedia', undefined);

    expect(() => watchSystemTheme(() => {})).not.toThrow();
    expect(() => watchSystemTheme(() => {})()).not.toThrow();
  });
});
