import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GRID_DENSITY,
  DENSITY_CELL_CLASS,
  GRID_DENSITIES,
  frozenLeftOffsets,
  isGridDensity,
  loadGridDensity,
  saveGridDensity,
  toggleHiddenColumn,
  visibleColumnIndexes
} from './gridColumns';
import { COLUMN_WIDTH_DEFAULTS } from './columnWidths';

/** Tailwind 的间距刻度：1 = 0.25rem = 4px */
function spacingToPixels(step: number): number {
  return step * 4;
}

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

describe('密度不许动列宽模型依赖的那几个量', () => {
  it('哪一档都不许带字号', () => {
    // 列宽按 charWidth 7.9 估算，那个数是照 13px 等宽字体量的。
    // 密度改字号 = 每一列都算错，而表现只是「有些列被截断了」，
    // 没人会把它和行高联系起来
    for (const density of GRID_DENSITIES) {
      expect(DENSITY_CELL_CLASS[density]).not.toMatch(/\btext-/);
    }
  });

  it('左右内边距不许超过列宽模型里算的那份', () => {
    // 模型里 padding 是「左右内边距 + 边框」的总和。实际比它大，
    // 列宽就不够放内容——而估算是按字符数算的，看不出这一段差额
    for (const density of GRID_DENSITIES) {
      const match = /px-([\d.]+)/.exec(DENSITY_CELL_CLASS[density]);
      expect(match).not.toBeNull();
      const horizontal = spacingToPixels(Number(match?.[1])) * 2 + 2;
      expect(horizontal).toBeLessThanOrEqual(COLUMN_WIDTH_DEFAULTS.padding);
    }
  });
});

describe('密度的存取', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      }
    });
  });

  it('没存过就是默认档', () => {
    expect(loadGridDensity()).toBe(DEFAULT_GRID_DENSITY);
  });

  it('往返保存与读取', () => {
    saveGridDensity('comfortable');
    expect(loadGridDensity()).toBe('comfortable');
  });

  it('存着的值不是已知的档位时回落到默认，而不是给出一个空的 class', () => {
    // 认了一个不存在的档，DENSITY_CELL_CLASS[density] 会是 undefined，
    // 单元格连内边距都没有
    localStorage.setItem('dataomni.grid-density', 'cozy');
    expect(loadGridDensity()).toBe(DEFAULT_GRID_DENSITY);
    expect(isGridDensity('cozy')).toBe(false);
  });

  it('localStorage 抛错时回落到默认、写入不抛', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('quota exceeded');
      }
    });

    expect(loadGridDensity()).toBe(DEFAULT_GRID_DENSITY);
    expect(() => saveGridDensity('compact')).not.toThrow();
  });
});
