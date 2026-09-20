import { describe, expect, it } from 'vitest';
import {
  clampColumnWidth,
  displayWidthInChars,
  measureColumnAlignments,
  measureColumnWidths,
  toPositionalRows
} from './columnWidths';

const options = { minWidth: 10, maxWidth: 1000, charWidth: 1, padding: 0 };

describe('显示宽度', () => {
  it('半角字符每个算一位', () => {
    expect(displayWidthInChars('abc123')).toBe(6);
  });

  it('中日韩文字每个算两位', () => {
    expect(displayWidthInChars('用户名')).toBe(6);
  });

  it('中英混排按各自宽度相加', () => {
    expect(displayWidthInChars('用户id')).toBe(6);
  });

  it('全角标点算两位', () => {
    expect(displayWidthInChars('，。')).toBe(4);
  });

  it('emoji 不会被当成两个半角字符', () => {
    // 按 length 算是 2（代理对），按码点算是 1
    expect(displayWidthInChars('🔑')).toBe(1);
  });
});

describe('列宽估算', () => {
  it('没有数据时按表头定宽', () => {
    expect(measureColumnWidths(['name'], [], options)).toEqual([10]);
  });

  it('内容比表头长时按内容定宽', () => {
    const widths = measureColumnWidths(
      ['id'],
      [['a-fairly-long-identifier']],
      options
    );
    expect(widths).toEqual([24]);
  });

  it('表头比内容长时按表头定宽', () => {
    expect(measureColumnWidths(['created_at_timestamp'], [['1']], options))
      .toEqual([20]);
  });

  it('每列各自独立估算', () => {
    const widths = measureColumnWidths(
      ['id', 'description'],
      [['1', '一段挺长的中文描述文字内容']],
      options
    );
    expect(widths[0]).toBe(10);
    expect(widths[1]).toBe(26);
  });

  it('不低于下限', () => {
    expect(measureColumnWidths(['a'], [['b']], { ...options, minWidth: 50 })).toEqual([50]);
  });

  it('不超过上限', () => {
    expect(measureColumnWidths(['a'], [['x'.repeat(500)]], { ...options, maxWidth: 80 }))
      .toEqual([80]);
  });

  it('NULL 按四个字符算，不按空算', () => {
    expect(measureColumnWidths(['a'], [[null]], options)).toEqual([10]);
    expect(measureColumnWidths(['ab'], [[null]], options)).toEqual([10]);
  });

  it('只看前 sampleRows 行', () => {
    const rows = [
      ['short'],
      ...Array.from({ length: 50 }, () => ['x'.repeat(200)])
    ];

    expect(measureColumnWidths(['a'], rows, { ...options, sampleRows: 1 })).toEqual([10]);
  });

  it('JSON 按折成一行后的宽度算，不按展开的缩进形态', () => {
    const json = { type: 'json' as const, value: '{"a":1,"b":2}' };
    // 单元格显示的是折行形态 { "a": 1, "b": 2 }，共 18 个字符
    expect(measureColumnWidths(['payload'], [[json]], options)).toEqual([18]);
  });

  it('二进制值按 0x 前缀后的展示形态算', () => {
    const binary = { type: 'binary' as const, value: 'ff00' };
    expect(measureColumnWidths(['b'], [[binary]], options)).toEqual([10]);
  });

  it('行比列短时该位置不参与加宽', () => {
    const widths = measureColumnWidths(
      ['a', 'b'],
      [['value'], ['x', 'other']],
      options
    );
    expect(widths).toEqual([10, 10]);
  });

  it('像素宽包含内边距', () => {
    expect(measureColumnWidths(['ab'], [], { minWidth: 0, charWidth: 7, padding: 26 }))
      .toEqual([40]);
  });

  it('默认常数能放得下 19 位的 BIGINT', () => {
    // 13px 等宽字体实测每字符 7.83px，加上 px-2 的左右内边距和边框；
    // 之前按 7px 估算，9223372036854775807 会被截成 922337203685477…
    const [width] = measureColumnWidths(['id'], [['9223372036854775807']]);
    expect(width).toBeGreaterThanOrEqual(19 * 7.83 + 17);
  });
});

describe('宽度夹取', () => {
  it('低于下限时抬到下限', () => {
    expect(clampColumnWidth(10, { minWidth: 64 })).toBe(64);
  });

  it('高于上限时压到上限', () => {
    expect(clampColumnWidth(9999, { maxWidth: 360 })).toBe(360);
  });

  it('区间内原样返回，并取整', () => {
    expect(clampColumnWidth(120.4, { minWidth: 64, maxWidth: 360 })).toBe(120);
  });

  it('手动拖动可以给出比自动估算上限更宽的值', () => {
    // 拖动时传入更大的 maxWidth：用户明确要看宽一列，不该被自动估算的上限拦住
    expect(clampColumnWidth(900, { minWidth: 64, maxWidth: 1200 })).toBe(900);
  });
});

describe('按列名索引的行转位置数组', () => {
  it('按 columns 的顺序取值，而不是对象自身的键顺序', () => {
    expect(toPositionalRows(['b', 'a'], [{ a: '1', b: '2' }])).toEqual([['2', '1']]);
  });

  it('缺失的列补 null', () => {
    expect(toPositionalRows(['a', 'missing'], [{ a: '1' }])).toEqual([['1', null]]);
  });

  it('多余的键被丢掉', () => {
    expect(toPositionalRows(['a'], [{ a: '1', extra: '2' }])).toEqual([['1']]);
  });
});

describe('列对齐', () => {
  it('整列都是数值时右对齐', () => {
    expect(measureColumnAlignments(['n'], [[1], [2]])).toEqual(['right']);
  });

  it('bigint 和 decimal 列右对齐', () => {
    const rows = [
      [{ type: 'bigint' as const, value: '1' }],
      [{ type: 'decimal' as const, value: '2.50' }]
    ];
    expect(measureColumnAlignments(['n'], rows)).toEqual(['right']);
  });

  it('NULL 不影响判定，数值列里有空值仍然右对齐', () => {
    expect(measureColumnAlignments(['n'], [[1], [null], [3]])).toEqual(['right']);
  });

  it('出现任一非数值整列就左对齐，不逐格判定', () => {
    // 逐格判定会让同一列左右参差
    expect(measureColumnAlignments(['n'], [[1], ['文本'], [3]])).toEqual(['left']);
  });

  it('整列都是 NULL 时左对齐', () => {
    expect(measureColumnAlignments(['n'], [[null], [null]])).toEqual(['left']);
  });

  it('没有数据时左对齐', () => {
    expect(measureColumnAlignments(['n'], [])).toEqual(['left']);
  });

  it('每列各自判定', () => {
    expect(measureColumnAlignments(['a', 'b'], [[1, 'x'], [2, 'y']])).toEqual(['right', 'left']);
  });
});
