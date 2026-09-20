import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clampPanelSize, loadPanelSize, savePanelSize } from './panelLayout';

function installMemoryStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    }
  });
  return store;
}

describe('分栏尺寸夹取', () => {
  it('区间内取整返回', () => {
    expect(clampPanelSize(240.6, 200, 500)).toBe(241);
  });

  it('低于下限抬到下限，高于上限压到上限', () => {
    expect(clampPanelSize(50, 200, 500)).toBe(200);
    expect(clampPanelSize(9999, 200, 500)).toBe(500);
  });

  it('非数值回落到下限，不产生 NaN 宽度', () => {
    expect(clampPanelSize(Number.NaN, 200, 500)).toBe(200);
    expect(clampPanelSize(Number.POSITIVE_INFINITY, 200, 500)).toBe(500);
  });

  it('上限比下限还小时以下限为准', () => {
    // 窗口被缩得比面板下限还窄时会出现，返回值至少要满足一边
    expect(clampPanelSize(300, 200, 100)).toBe(200);
  });
});

describe('分栏尺寸存取', () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    storage = installMemoryStorage();
  });

  it('没存过时返回默认值', () => {
    expect(loadPanelSize('sidebar', 320, 200, 500)).toBe(320);
  });

  it('往返保存与读取', () => {
    savePanelSize('sidebar', 420);
    expect(loadPanelSize('sidebar', 320, 200, 500)).toBe(420);
  });

  it('存着的值超出当前上下限时被夹回来', () => {
    // 上次窗口更宽，这次装不下
    savePanelSize('sidebar', 900);
    expect(loadPanelSize('sidebar', 320, 200, 500)).toBe(500);
  });

  it('存着的内容不是数字时回落到默认值', () => {
    storage.set('dataomni_panel:sidebar', '很宽');
    expect(loadPanelSize('sidebar', 320, 200, 500)).toBe(320);
  });

  it('不同面板互不影响', () => {
    savePanelSize('sidebar', 420);
    savePanelSize('editor', 260);
    expect(loadPanelSize('sidebar', 320, 200, 500)).toBe(420);
    expect(loadPanelSize('editor', 200, 120, 600)).toBe(260);
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

    expect(loadPanelSize('sidebar', 320, 200, 500)).toBe(320);
    expect(() => savePanelSize('sidebar', 400)).not.toThrow();
  });
});
