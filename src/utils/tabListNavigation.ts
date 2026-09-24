import type { TabShortcutTarget } from './shortcuts';

/**
 * 标签在 DOM 里的 id，以及内容区那一块的 id。
 *
 * 两个东西要互相指：标签上 `aria-controls` 指着内容区，内容区
 * `aria-labelledby` 指回标签。而它们分属两个组件（`WorkspaceTabBar` 与 `App`），
 * 各写一遍字符串迟早写岔——写岔的后果是读屏报不出「这块内容属于哪个标签」，
 * 而界面上看不出任何异样。
 */
export const WORKSPACE_PANEL_DOM_ID = 'workspace-panel';

export function workspaceTabDomId(tabId: string): string {
  return `workspace-tab-${tabId}`;
}

/**
 * 标签栏上按一次方向键，焦点落到第几个。
 *
 * **只移动焦点，不切换标签。** ARIA 把这叫 manual activation，正是给「切换有
 * 代价」的场景准备的：切到一个表标签要重新打库取数（见 TODOs 5.4），
 * 按住方向键滑过去就是一串查询。移动完按 Enter 或空格才真的切。
 *
 * 左右回绕：标签栏是一圈，从最后一个再按右键回到第一个，比撞墙有用——
 * 和命令面板的上下键是同一个取舍。
 *
 * 返回 `null` 表示这个键不归标签栏管，调用方不要 `preventDefault`：
 * 吃掉一个自己不处理的键，等于把它从别处偷走了。
 */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) {
    return null;
  }

  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count;
    case 'ArrowLeft':
      // 先加 count 再取模：JS 的 % 对负数返回负数，直接取模会得到 -1
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * 切标签的快捷键落到第几个。没有那么多标签就返回 `null`（⌘5 时只开了三个，
 * 什么也不做，和浏览器一样）；前后挪一个时两头回绕，同方向键
 */
export function tabIndexForShortcut(
  target: TabShortcutTarget,
  current: number,
  count: number
): number | null {
  if (count <= 0) {
    return null;
  }
  switch (target.kind) {
    case 'index':
      return target.index < count ? target.index : null;
    case 'last':
      return count - 1;
    case 'step':
      return current < 0 ? 0 : (current + target.delta + count) % count;
  }
}

/** 这个键是不是「就切到当前聚焦的这个标签」 */
export function activatesFocusedTab(key: string): boolean {
  return key === 'Enter' || key === ' ';
}
