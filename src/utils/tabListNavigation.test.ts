import { describe, expect, it } from 'vitest';
import {
  activatesFocusedTab,
  nextTabIndex,
  workspaceTabDomId,
  WORKSPACE_PANEL_DOM_ID
} from './tabListNavigation';

describe('标签栏的方向键', () => {
  it('左右各走一格', () => {
    expect(nextTabIndex('ArrowRight', 0, 4)).toBe(1);
    expect(nextTabIndex('ArrowLeft', 2, 4)).toBe(1);
  });

  it('两头都回绕，不撞墙', () => {
    expect(nextTabIndex('ArrowRight', 3, 4)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 4)).toBe(3);
  });

  it('向左回绕不能算出负数——JS 的 % 对负数返回负数', () => {
    // 少写那个 `+ count` 就会得到 -1，焦点落到不存在的标签上
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextTabIndex('ArrowLeft', 0, 1)).toBe(0);
  });

  it('Home / End 跳到两端', () => {
    expect(nextTabIndex('Home', 3, 5)).toBe(0);
    expect(nextTabIndex('End', 1, 5)).toBe(4);
  });

  it('不归标签栏管的键返回 null，调用方才知道不要吃掉它', () => {
    // 吃掉一个自己不处理的键，等于把它从别处偷走
    for (const key of ['ArrowUp', 'ArrowDown', 'a', 'Tab', 'Escape', 'PageDown']) {
      expect(nextTabIndex(key, 0, 4), key).toBeNull();
    }
  });

  it('一个标签都没有时什么都不做', () => {
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
      expect(nextTabIndex(key, 0, 0), key).toBeNull();
    }
  });

  it('只有一个标签时原地不动', () => {
    expect(nextTabIndex('ArrowRight', 0, 1)).toBe(0);
    expect(nextTabIndex('End', 0, 1)).toBe(0);
  });

  it('Enter 与空格才是「切到这个标签」', () => {
    expect(activatesFocusedTab('Enter')).toBe(true);
    expect(activatesFocusedTab(' ')).toBe(true);
    expect(activatesFocusedTab('ArrowRight')).toBe(false);
    expect(activatesFocusedTab('Spacebar')).toBe(false);
  });
});

describe('标签与内容区互相指', () => {
  /**
   * 两边分属 `WorkspaceTabBar` 与 `App`，各写一遍字符串迟早写岔。写岔了界面上
   * 看不出任何异样——只有读屏会报不出「这块内容属于哪个标签」，所以钉在这里。
   */
  it('同一个标签 id 永远算出同一个 DOM id', () => {
    expect(workspaceTabDomId('c1:sql:7')).toBe(workspaceTabDomId('c1:sql:7'));
    expect(workspaceTabDomId('c1:sql:7')).not.toBe(workspaceTabDomId('c1:sql:8'));
  });

  it('DOM id 带前缀，不会和页面上别的 id 撞', () => {
    // 标签 id 是 `连接:类型:对象` 这种，直接拿来当 DOM id 容易撞上别处
    expect(workspaceTabDomId('x')).toBe('workspace-tab-x');
    expect(WORKSPACE_PANEL_DOM_ID).toBe('workspace-panel');
  });
});
