import { describe, expect, it } from 'vitest';
import { FALLBACK_RESULT_TABLE_HEIGHT, resultTableHeight } from './resultTableHeight';

/** 写死 600 的那一版：内容矮就按内容，否则封顶 600 */
function fixedHeight(content: number): number {
  return Math.min(content, FALLBACK_RESULT_TABLE_HEIGHT);
}

describe('结果表的高度', () => {
  it('内容装得下就按内容，不撑空盒子', () => {
    expect(resultTableHeight(1000, 120)).toBe(120);
  });

  it('装不下但有地方，就用满可用空间——这一段是净赚的', () => {
    // 实测的那个场景：结果区 1000，内容 750，此前只给 600
    expect(resultTableHeight(1000, 750)).toBe(750);
    expect(resultTableHeight(800, 2000)).toBe(800);
  });

  it('地方不够时停在 600，让外层自己滚，而不是把表压成两行', () => {
    // 回退掉的那一版在这里给 80
    expect(resultTableHeight(80, 750)).toBe(FALLBACK_RESULT_TABLE_HEIGHT);
  });

  it('地方不够、但内容本来就矮时按内容，不撑到 600', () => {
    expect(resultTableHeight(80, 120)).toBe(120);
  });

  it('还没量到可用空间时就是今天的行为，所以首帧不会闪', () => {
    expect(resultTableHeight(0, 750)).toBe(fixedHeight(750));
    expect(resultTableHeight(0, 120)).toBe(fixedHeight(120));
  });

  /**
   * 这一条是整个改动的依据：**在任何一组输入上都不比写死 600 矮**。
   * 矮了就意味着某个窗口尺寸下看得见的行变少了，那是回归。
   */
  it('任何输入都不比写死 600 的那一版矮', () => {
    for (let available = 0; available <= 1600; available += 40) {
      for (let content = 0; content <= 3000; content += 60) {
        const now = resultTableHeight(available, content);
        expect(
          now,
          `可用 ${available} / 内容 ${content}：${now} 比写死的 ${fixedHeight(content)} 还矮`
        ).toBeGreaterThanOrEqual(fixedHeight(content));
      }
    }
  });

  it('也从不超过内容本身的高度', () => {
    for (let available = 0; available <= 1600; available += 40) {
      for (let content = 0; content <= 3000; content += 60) {
        expect(resultTableHeight(available, content)).toBeLessThanOrEqual(
          Math.max(content, 0)
        );
      }
    }
  });
});
