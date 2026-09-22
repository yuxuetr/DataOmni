/**
 * 分栏尺寸的读写。
 *
 * 和工作区快照同一类：属于本机的界面状态，存 localStorage。
 * 读出来一律再夹一次上下限——窗口可能比上次小，存的值也可能是旧版本留下的。
 */
const STORAGE_PREFIX = 'dataomni_panel:';
const COLLAPSE_SUFFIX = ':collapsed';

export function clampPanelSize(size: number, min: number, max: number): number {
  // 只有 NaN 是真的没法用；±Infinity 按边界夹就行
  if (Number.isNaN(size)) {
    return min;
  }
  // min 比 max 大时以 min 为准，避免返回一个两边都不满足的数
  return Math.round(Math.min(Math.max(size, min), Math.max(min, max)));
}

export function loadPanelSize(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) {
      return clampPanelSize(fallback, min, max);
    }

    const parsed = Number(raw);
    return clampPanelSize(Number.isFinite(parsed) ? parsed : fallback, min, max);
  } catch {
    return clampPanelSize(fallback, min, max);
  }
}

export function savePanelSize(key: string, size: number): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, String(Math.round(size)));
  } catch {
    // 存储不可用时分栏仍然能拖，只是重启后回到默认值
  }
}

/**
 * 折叠状态和尺寸分开存。
 *
 * 分开的理由就是「恢复」这两个字：折叠时**不动**尺寸，展开时拿回的是折叠前
 * 那一个数，而不是默认值。把折叠写成「尺寸 = 0」会把用户拖出来的宽度抹掉。
 */
export function loadPanelCollapsed(key: string): boolean {
  try {
    // 只认 '1'。存储里是旧版本留下的别的东西时按展开处理——
    // 一个面板莫名其妙不见了，比一个没折叠成功的面板难排查得多
    return localStorage.getItem(STORAGE_PREFIX + key + COLLAPSE_SUFFIX) === '1';
  } catch {
    return false;
  }
}

export function savePanelCollapsed(key: string, collapsed: boolean): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key + COLLAPSE_SUFFIX, collapsed ? '1' : '0');
  } catch {
    // 存储不可用时折叠仍然能用，只是重启后回到展开
  }
}
