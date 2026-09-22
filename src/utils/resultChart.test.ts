import { describe, expect, it } from 'vitest';
import type { SerializedResultValue } from '../contracts/resultSet';
import {
  MAX_CHART_POINTS,
  buildChartData,
  chartLabel,
  chartScale,
  chartValue,
  hasSeriesScaleMismatch,
  isChartRejection,
  labelStride,
  suggestChartSpec
} from './resultChart';

type Row = SerializedResultValue[];

describe('chartValue', () => {
  it('读数字、数字字符串和带类型标签的大数 / 定点数', () => {
    expect(chartValue(42)).toBe(42);
    expect(chartValue('3.5')).toBe(3.5);
    expect(chartValue({ type: 'bigint', value: '8123456789' })).toBe(8123456789);
    expect(chartValue({ type: 'decimal', value: '12.75' })).toBe(12.75);
  });

  /** `Number('')` 是 0，直接用会把缺失值画成一个真实的低点 */
  it('空串与空白是缺失值，不是 0', () => {
    expect(chartValue('')).toBeNull();
    expect(chartValue('   ')).toBeNull();
  });

  /** 一列状态位转成 1 / 0 会画出一张看着像数据的图 */
  it('布尔不当数字', () => {
    expect(chartValue(true)).toBeNull();
    expect(chartValue(false)).toBeNull();
  });

  it('日期、JSON 与不是数字的文本都读不出值', () => {
    expect(chartValue({ type: 'datetime', value: '2026-09-22 10:00:00' })).toBeNull();
    expect(chartValue({ type: 'json', value: '{"a":1}' })).toBeNull();
    expect(chartValue('N/A')).toBeNull();
    expect(chartValue(null)).toBeNull();
  });

  it('Infinity 与 NaN 不落到图上', () => {
    expect(chartValue(Number.POSITIVE_INFINITY)).toBeNull();
    expect(chartValue(Number.NaN)).toBeNull();
    expect(chartValue('Infinity')).toBeNull();
  });
});

describe('chartLabel', () => {
  it('null 显示成空，不显示 "null"', () => {
    expect(chartLabel(null)).toBe('');
  });

  it('带类型标签的值取它的字符串原值', () => {
    expect(chartLabel({ type: 'date', value: '2026-09-22' })).toBe('2026-09-22');
  });
});

describe('suggestChartSpec', () => {
  it('把数值列当纵轴、第一个非数值列当横轴', () => {
    const columns = ['region', 'orders', 'revenue'];
    const rows: Row[] = [
      ['north', 12, '980.50'],
      ['south', 8, '640.25']
    ];

    const spec = suggestChartSpec(columns, rows);
    expect(isChartRejection(spec)).toBe(false);
    if (isChartRejection(spec)) return;
    expect(spec).toEqual({ type: 'bar', categoryIndex: 0, valueIndexes: [1, 2] });
  });

  /**
   * 聚合列是最想画的那些，而驱动给的声明类型未必可靠——所以判断看实际值。
   * 这条钉住「不靠 column_metadata」这个选择
   */
  it('值是数字字符串的列也算数值列', () => {
    const spec = suggestChartSpec(['day', 'total'], [['mon', '10'], ['tue', '20']]);
    if (isChartRejection(spec)) throw new Error('应当能画');
    expect(spec.valueIndexes).toEqual([1]);
  });

  it('一列里混进一个非数字就不算数值列', () => {
    const spec = suggestChartSpec(['day', 'total'], [['mon', '10'], ['tue', 'n/a']]);
    expect(spec).toBe('no-numeric-column');
  });

  /** 全是 null 的列画出来是一条空线，不该被当成可画 */
  it('整列为空不算数值列', () => {
    expect(suggestChartSpec(['a', 'b'], [['x', null], ['y', null]])).toBe('no-numeric-column');
  });

  it('没有非数值列时按行号排', () => {
    const spec = suggestChartSpec(['value'], [[1], [2], [3]]);
    if (isChartRejection(spec)) throw new Error('应当能画');
    expect(spec.categoryIndex).toBeNull();
  });

  it('空结果与超过上限的结果都明确说不画', () => {
    expect(suggestChartSpec(['a'], [])).toBe('no-rows');

    const tooMany: Row[] = Array.from({ length: MAX_CHART_POINTS + 1 }, (_, index) => [index]);
    expect(suggestChartSpec(['a'], tooMany)).toBe('too-many-rows');

    const atLimit: Row[] = Array.from({ length: MAX_CHART_POINTS }, (_, index) => [index]);
    expect(isChartRejection(suggestChartSpec(['a'], atLimit))).toBe(false);
  });
});

describe('buildChartData', () => {
  it('每列一条序列，缺失的格子保持为 null', () => {
    const columns = ['region', 'orders'];
    const rows: Row[] = [['north', 12], ['south', null], ['east', 5]];

    const data = buildChartData(
      { type: 'bar', categoryIndex: 0, valueIndexes: [1] },
      columns,
      rows
    );

    expect(data.categories).toEqual(['north', 'south', 'east']);
    expect(data.series).toEqual([{ name: 'orders', points: [12, null, 5] }]);
  });

  it('按行号排时分类从 1 开始', () => {
    const data = buildChartData({ type: 'line', categoryIndex: null, valueIndexes: [0] }, ['v'], [[7], [8]]);
    expect(data.categories).toEqual(['1', '2']);
  });
});

describe('chartScale', () => {
  /** 截断的纵轴会让 1000 和 1010 看起来差一倍 */
  it('全是正数时从 0 起', () => {
    const scale = chartScale({ categories: ['a', 'b'], series: [{ name: 'v', points: [1000, 1010] }] });
    expect(scale.min).toBe(0);
    expect(scale.max).toBeGreaterThanOrEqual(1010);
  });

  it('有负值时下界跟着数据走', () => {
    const scale = chartScale({ categories: ['a', 'b'], series: [{ name: 'v', points: [-30, 60] }] });
    expect(scale.min).toBeLessThanOrEqual(-30);
    expect(scale.max).toBeGreaterThanOrEqual(60);
  });

  /** 0、3.67、7.34 这样的刻度要读图的人先做一次除法 */
  it('刻度取 1 / 2 / 5 × 10ⁿ，且不带浮点尾巴', () => {
    const scale = chartScale({ categories: [], series: [{ name: 'v', points: [0, 37] }] });
    expect(scale.ticks).toEqual([0, 10, 20, 30, 40]);

    const small = chartScale({ categories: [], series: [{ name: 'v', points: [0, 0.4] }] });
    for (const tick of small.ticks) {
      expect(String(tick).length, `${tick} 带了浮点尾巴`).toBeLessThan(6);
    }
  });

  it('所有值相同时给出一个非零跨度', () => {
    const scale = chartScale({ categories: ['a'], series: [{ name: 'v', points: [5, 5] }] });
    expect(scale.max).toBeGreaterThan(scale.min);
  });

  it('一个值都读不出来时也给得出范围，不会除以 0', () => {
    const scale = chartScale({ categories: ['a'], series: [{ name: 'v', points: [null, null] }] });
    expect(scale.max).toBeGreaterThan(scale.min);
  });
});

describe('hasSeriesScaleMismatch', () => {
  /** orders 是十几、revenue 是几千：同轴之下 orders 被压成贴着基线的一条细边 */
  it('量级差到看不见时报出来', () => {
    expect(
      hasSeriesScaleMismatch({
        categories: ['a', 'b'],
        series: [
          { name: 'orders', points: [12, 18] },
          { name: 'revenue', points: [9805, 7640] }
        ]
      })
    ).toBe(true);
  });

  it('量级相近时不报——多报会让提示变成噪音', () => {
    expect(
      hasSeriesScaleMismatch({
        categories: ['a', 'b'],
        series: [
          { name: 'wins', points: [12, 18] },
          { name: 'losses', points: [30, 44] }
        ]
      })
    ).toBe(false);
  });

  it('只有一条序列时无从比较', () => {
    expect(
      hasSeriesScaleMismatch({ categories: ['a'], series: [{ name: 'v', points: [1] }] })
    ).toBe(false);
  });

  /** 全 0 的序列参与比较会得到 Infinity 倍，那是个除以 0 的假警报 */
  it('整列为 0 或为空的序列不参与比较', () => {
    expect(
      hasSeriesScaleMismatch({
        categories: ['a', 'b'],
        series: [
          { name: 'zero', points: [0, 0] },
          { name: 'v', points: [5, 6] }
        ]
      })
    ).toBe(false);
  });

  it('按绝对值比较，负值序列一样算', () => {
    expect(
      hasSeriesScaleMismatch({
        categories: ['a'],
        series: [
          { name: 'small', points: [-2] },
          { name: 'big', points: [-5000] }
        ]
      })
    ).toBe(true);
  });
});

describe('labelStride', () => {
  it('放得下就每个都显示', () => {
    expect(labelStride(8, 10)).toBe(1);
  });

  it('放不下时按比例隔开', () => {
    expect(labelStride(100, 10)).toBe(10);
    expect(labelStride(95, 10)).toBe(10);
  });
});
