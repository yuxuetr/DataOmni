/**
 * 分栏尺寸的读写。
 *
 * 和工作区快照同一类：属于本机的界面状态，存 localStorage。
 * 读出来一律再夹一次上下限——窗口可能比上次小，存的值也可能是旧版本留下的。
 */
const STORAGE_PREFIX = 'dataomni_panel:';

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
