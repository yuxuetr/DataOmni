import { describe, expect, it } from 'vitest';
import { GRID_PAGE_SIZE_OPTIONS, MAX_UNVIRTUALIZED_ROWS } from './gridPagination';

describe('网格分页档位', () => {
  it('档位递增且没有重复', () => {
    const sorted = [...GRID_PAGE_SIZE_OPTIONS].sort((left, right) => left - right);
    expect([...GRID_PAGE_SIZE_OPTIONS]).toEqual(sorted);
    expect(new Set(GRID_PAGE_SIZE_OPTIONS).size).toBe(GRID_PAGE_SIZE_OPTIONS.length);
  });

  it('所有档位都在不做虚拟化仍然流畅的范围内', () => {
    // 这不是一条风格检查，是「暂不做行虚拟化」那个决定的重估触发器：
    // 实测 100 行 × 20 列（2000 格）重渲染中位数 25ms，含两帧 rAF 等待。
    // 加一个更大的档位、或改成无限滚动，都应该先重新测一遍再决定。
    for (const option of GRID_PAGE_SIZE_OPTIONS) {
      expect(option).toBeLessThanOrEqual(MAX_UNVIRTUALIZED_ROWS);
    }
  });

  it('默认档位（第一个）足够小，打开表时不会先卡一下', () => {
    expect(GRID_PAGE_SIZE_OPTIONS[0]).toBeLessThanOrEqual(50);
  });
});
