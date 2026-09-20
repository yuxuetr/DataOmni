import { describe, expect, it } from 'vitest';
import { matchFuzzy, rankFuzzy } from './fuzzyMatch';

describe('模糊匹配', () => {
  it('空查询匹配一切，不产生高亮', () => {
    expect(matchFuzzy('', 'users')).toEqual({ score: 0, indices: [] });
  });

  it('子序列命中即可，不要求连续', () => {
    expect(matchFuzzy('ues', 'users')?.indices).toEqual([0, 2, 4]);
  });

  it('顺序不对时不匹配', () => {
    expect(matchFuzzy('sr', 'users')).not.toBeNull();
    // users 里 s 之后没有 u，顺序颠倒就匹配不上
    expect(matchFuzzy('su', 'users')).toBeNull();
  });

  it('目标里没有的字符导致不匹配', () => {
    expect(matchFuzzy('xyz', 'users')).toBeNull();
  });

  it('忽略大小写', () => {
    expect(matchFuzzy('USR', 'users')?.indices).toEqual([0, 1, 3]);
  });

  it('命中之间跨得越远得分越低', () => {
    const consecutive = matchFuzzy('ord', 'orders')?.score ?? 0;
    const scattered = matchFuzzy('ors', 'orders')?.score ?? 0;
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it('命中词首比命中词中得分高', () => {
    // order_items 里 i 在下划线后，是词首
    const wordStart = matchFuzzy('oi', 'order_items')?.score ?? 0;
    const inside = matchFuzzy('oe', 'order_items')?.score ?? 0;
    expect(wordStart).toBeGreaterThan(inside);
  });

  it('会为了更好的命中而换一个起点，不是一路贪心到底', () => {
    // 贪心从 a(0) 开始会停在 a(0)+b(3)；真正该要的是末尾连续的 ab
    expect(matchFuzzy('ab', 'a_xb ab')?.indices).toEqual([5, 6]);
  });

  it('中文按字符匹配', () => {
    expect(matchFuzzy('订单', '订单明细')?.indices).toEqual([0, 1]);
    expect(matchFuzzy('订细', '订单明细')?.indices).toEqual([0, 3]);
  });

  it('查询首尾空白不影响结果', () => {
    expect(matchFuzzy('  usr  ', 'users')?.indices).toEqual([0, 1, 3]);
  });
});

describe('排序', () => {
  const items = [
    { title: 'order_items' },
    { title: 'orders' },
    { title: 'customers_orders_archive' }
  ];

  it('空查询保持原顺序并全部返回', () => {
    expect(rankFuzzy('', items).map((r) => r.item.title))
      .toEqual(['order_items', 'orders', 'customers_orders_archive']);
  });

  it('从头连续命中的排在前面', () => {
    expect(rankFuzzy('ord', items)[0].item.title).toBe('orders');
  });

  it('匹配不上的不出现在结果里', () => {
    expect(rankFuzzy('zzz', items)).toEqual([]);
  });

  it('同分时短的排前面', () => {
    const tied = [{ title: 'aaa_x' }, { title: 'aaa' }];
    expect(rankFuzzy('aaa', tied).map((r) => r.item.title)).toEqual(['aaa', 'aaa_x']);
  });

  it('标题匹配优先于附加文本匹配，即使标题更长、匹配得更勉强', () => {
    // 刻意让标题命中的那条更长：否则同分时的「短的排前面」会顺带给出正确
    // 答案，降权去掉了也测不出来
    const mixed = [
      { title: 'ships', keywords: 'orders' },
      { title: 'customer_order_lines', keywords: 'x' }
    ];
    expect(rankFuzzy('orders', mixed).map((r) => r.item.title))
      .toEqual(['customer_order_lines', 'ships']);
  });

  it('只有附加文本命中时也能被找到', () => {
    const mixed = [{ title: 'shipments', keywords: 'public schema' }];
    expect(rankFuzzy('public', mixed).map((r) => r.item.title)).toEqual(['shipments']);
  });

  it('附加文本命中不产生标题高亮，避免高亮错位置', () => {
    const mixed = [{ title: 'shipments', keywords: 'public' }];
    expect(rankFuzzy('public', mixed)[0].indices).toEqual([]);
  });
});
