import { describe, expect, it } from 'vitest';
import { activatesFocusedTab, nextTabIndex } from './tabListNavigation';

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
