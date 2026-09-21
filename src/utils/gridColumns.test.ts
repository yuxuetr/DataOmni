import { describe, expect, it } from 'vitest';
import {
  DENSITY_CELL_CLASS,
  GRID_DENSITIES,
  frozenLeftOffsets,
  toggleHiddenColumn,
  visibleColumnIndexes
} from './gridColumns';

const COLUMNS = ['id', 'name', 'note'];

describe('visibleColumnIndexes', () => {
  it('返回下标而不是列名', () => {
    expect(visibleColumnIndexes(COLUMNS, new Set(['name']))).toEqual([0, 2]);
  });

  it('没藏任何列时返回全部', () => {
    expect(visibleColumnIndexes(COLUMNS, new Set())).toEqual([0, 1, 2]);
  });

  it('藏一个不存在的列名不影响结果', () => {
    // 换表后旧的隐藏集还在，里面是另一张表的列名
    expect(visibleColumnIndexes(COLUMNS, new Set(['gone']))).toEqual([0, 1, 2]);
  });
});

describe('toggleHiddenColumn', () => {
  it('来回切换', () => {
    const hidden = toggleHiddenColumn(new Set(), COLUMNS, 'name');
    expect([...hidden]).toEqual(['name']);
    expect([...toggleHiddenColumn(hidden, COLUMNS, 'name')]).toEqual([]);
  });

  it('不允许藏掉最后一列', () => {
    // 剩一列时再藏就是一张空表，而「把列找回来」的入口就在那张空表上
    const hidden = new Set(['id', 'name']);
    expect([...toggleHiddenColumn(hidden, COLUMNS, 'note')].sort()).toEqual(['id', 'name']);
  });

  it('只剩一列时仍然可以把别的列放回来', () => {
    const hidden = new Set(['id', 'name']);
    expect([...toggleHiddenColumn(hidden, COLUMNS, 'id')]).toEqual(['name']);
  });

  it('不改传进来的集合', () => {
    const hidden = new Set<string>();
    toggleHiddenColumn(hidden, COLUMNS, 'name');
    expect(hidden.size).toBe(0);
  });
});

describe('frozenLeftOffsets', () => {
  it('按可见列宽累计', () => {
    expect(frozenLeftOffsets([100, 80, 200], 2)).toEqual([0, 100, null]);
  });

  it('没冻结时全是 null', () => {
    expect(frozenLeftOffsets([100, 80], 0)).toEqual([null, null]);
  });

  it('至少留一列能横向滚动', () => {
    // 全冻结等于没冻结，还会让横向滚动彻底失效
    expect(frozenLeftOffsets([100, 80], 2)).toEqual([0, null]);
    expect(frozenLeftOffsets([100, 80], 9)).toEqual([0, null]);
  });

  it('只有一列时冻不了', () => {
    expect(frozenLeftOffsets([100], 1)).toEqual([null]);
  });

  it('偏移用的是传进来的宽度，不是某个假定的等宽', () => {
    // 藏掉第一列后调用方传的是可见列宽；按原列宽算会让冻住的列悬在空白之后
    expect(frozenLeftOffsets([37, 41, 60], 3)).toEqual([0, 37, null]);
  });
});

describe('密度', () => {
  it('每一档都有对应的类名', () => {
    for (const density of GRID_DENSITIES) {
      expect(DENSITY_CELL_CLASS[density]).toBeTruthy();
    }
  });

  it('三档的纵向内边距递增', () => {
    // 三档长得一样的话，这个设置就只是个没有效果的开关
    const padding = GRID_DENSITIES.map((density) => {
      const match = /py-([\d.]+)/.exec(DENSITY_CELL_CLASS[density]);
      return Number(match?.[1] ?? -1);
    });
    expect(padding).toEqual([...padding].sort((left, right) => left - right));
    expect(new Set(padding).size).toBe(padding.length);
  });
});
