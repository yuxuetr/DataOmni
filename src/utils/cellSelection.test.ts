import { describe, expect, it } from 'vitest';
import {
  columnSelection,
  isCellMoveKey,
  isWithinSelection,
  moveSelection,
  rowSelection,
  selectAllCells,
  selectionRect,
  selectionToClipboardText,
  type CellSelection
} from './cellSelection';

const bounds = { rowCount: 4, columnCount: 3 };
const at = (row: number, column: number): CellSelection => ({
  anchor: { row, column },
  focus: { row, column }
});

describe('选区矩形', () => {
  it('锚点在焦点右下时仍然得到正的矩形', () => {
    const selection = { anchor: { row: 3, column: 2 }, focus: { row: 1, column: 0 } };
    expect(selectionRect(selection)).toEqual({ top: 1, left: 0, bottom: 3, right: 2 });
  });

  it('矩形内的格子算选中，外面的不算', () => {
    const selection = { anchor: { row: 1, column: 1 }, focus: { row: 2, column: 2 } };
    expect(isWithinSelection(selection, 1, 1)).toBe(true);
    expect(isWithinSelection(selection, 2, 2)).toBe(true);
    expect(isWithinSelection(selection, 0, 1)).toBe(false);
    expect(isWithinSelection(selection, 1, 0)).toBe(false);
  });
});

describe('键盘移动', () => {
  it('没有选区时第一次按方向键落在左上角', () => {
    expect(moveSelection(null, 'ArrowDown', bounds)).toEqual(at(0, 0));
  });

  it('方向键整体移动，锚点跟着走', () => {
    expect(moveSelection(at(1, 1), 'ArrowDown', bounds)).toEqual(at(2, 1));
    expect(moveSelection(at(1, 1), 'ArrowRight', bounds)).toEqual(at(1, 2));
  });

  it('撞到边界时停住，不回绕', () => {
    expect(moveSelection(at(0, 0), 'ArrowUp', bounds)).toEqual(at(0, 0));
    expect(moveSelection(at(3, 2), 'ArrowDown', bounds)).toEqual(at(3, 2));
    expect(moveSelection(at(3, 2), 'ArrowRight', bounds)).toEqual(at(3, 2));
  });

  it('Shift 延伸选区时锚点不动', () => {
    const result = moveSelection(at(1, 1), 'ArrowDown', bounds, { extend: true });
    expect(result).toEqual({ anchor: { row: 1, column: 1 }, focus: { row: 2, column: 1 } });
  });

  it('Shift 反向移动会收缩选区而不是翻面', () => {
    const extended = { anchor: { row: 1, column: 0 }, focus: { row: 3, column: 0 } };
    const result = moveSelection(extended, 'ArrowUp', bounds, { extend: true });
    expect(result).toEqual({ anchor: { row: 1, column: 0 }, focus: { row: 2, column: 0 } });
  });

  it('Home 回到本行行首，End 到本行行尾', () => {
    expect(moveSelection(at(2, 2), 'Home', bounds)).toEqual(at(2, 0));
    expect(moveSelection(at(2, 0), 'End', bounds)).toEqual(at(2, 2));
  });

  it('⌘ 配合方向键跳到整列尽头', () => {
    expect(moveSelection(at(1, 1), 'ArrowDown', bounds, { toEdge: true })).toEqual(at(3, 1));
    expect(moveSelection(at(1, 1), 'ArrowUp', bounds, { toEdge: true })).toEqual(at(0, 1));
  });

  it('⌘ 配合 Home / End 跳到整表两角', () => {
    expect(moveSelection(at(2, 1), 'Home', bounds, { toEdge: true })).toEqual(at(0, 0));
    expect(moveSelection(at(1, 1), 'End', bounds, { toEdge: true })).toEqual(at(3, 2));
  });

  it('翻页键按 pageSize 跨行并夹在边界内', () => {
    expect(moveSelection(at(0, 0), 'PageDown', bounds, { pageSize: 2 })).toEqual(at(2, 0));
    expect(moveSelection(at(0, 0), 'PageDown', bounds, { pageSize: 99 })).toEqual(at(3, 0));
  });

  it('空表格上移动不产生选区', () => {
    expect(moveSelection(null, 'ArrowDown', { rowCount: 0, columnCount: 3 })).toBeNull();
    expect(moveSelection(at(0, 0), 'ArrowDown', { rowCount: 2, columnCount: 0 })).toBeNull();
  });

  it('只认识这几个移动键', () => {
    expect(isCellMoveKey('ArrowUp')).toBe(true);
    expect(isCellMoveKey('End')).toBe(true);
    expect(isCellMoveKey('a')).toBe(false);
    expect(isCellMoveKey('Enter')).toBe(false);
  });
});

describe('全选', () => {
  it('覆盖整张表', () => {
    expect(selectAllCells(bounds)).toEqual({
      anchor: { row: 0, column: 0 },
      focus: { row: 3, column: 2 }
    });
  });

  it('空表格没有可选内容', () => {
    expect(selectAllCells({ rowCount: 0, columnCount: 0 })).toBeNull();
  });
});

describe('复制文本', () => {
  const rows = [
    ['alice', { type: 'bigint' as const, value: '9223372036854775807' }, null],
    ['bob', { type: 'decimal' as const, value: '1.50' }, 'note']
  ];

  it('单格复制原样返回，不加引号', () => {
    expect(selectionToClipboardText(rows, at(0, 0))).toBe('alice');
  });

  it('单格复制的是完整值，不是单元格里折成一行的显示形态', () => {
    expect(selectionToClipboardText(rows, at(0, 1))).toBe('9223372036854775807');

    // 大整数在两种形态下一样，测不出区别；JSON 才能分辨——单元格显示的是折行
    // 后的一行，复制出去应当是展开的完整内容
    const json = [[{ type: 'json' as const, value: '{"a":1}' }]];
    expect(selectionToClipboardText(json, at(0, 0))).toContain('\n');
  });

  it('NULL 写成 NULL，而不是空串', () => {
    // 空串和「空字符串」这个真实值分不开
    expect(selectionToClipboardText(rows, at(0, 2))).toBe('NULL');
  });

  it('多格用制表符分列、换行分行', () => {
    const selection = { anchor: { row: 0, column: 0 }, focus: { row: 1, column: 1 } };
    expect(selectionToClipboardText(rows, selection))
      .toBe('alice\t9223372036854775807\nbob\t1.50');
  });

  it('多格时含制表符或换行的值要加引号，否则粘进表格会串列', () => {
    const tricky = [['a\tb', 'plain'], ['line1\nline2', 'x']];
    const selection = { anchor: { row: 0, column: 0 }, focus: { row: 1, column: 1 } };
    expect(selectionToClipboardText(tricky, selection))
      .toBe('"a\tb"\tplain\n"line1\nline2"\tx');
  });

  it('值里的双引号写两遍', () => {
    const tricky = [['say "hi"', 'x'], ['y', 'z']];
    const selection = { anchor: { row: 0, column: 0 }, focus: { row: 1, column: 1 } };
    expect(selectionToClipboardText(tricky, selection)).toBe('"say ""hi"""\tx\ny\tz');
  });

  it('单格复制不做 TSV 转义，值原样进剪贴板', () => {
    // 单格通常是要贴进 SQL 的，加引号反而破坏它
    const tricky = [['say "hi"']];
    expect(selectionToClipboardText(tricky, at(0, 0))).toBe('say "hi"');
  });

  it('锚点在右下时也能正确取出矩形', () => {
    const selection = { anchor: { row: 1, column: 1 }, focus: { row: 0, column: 0 } };
    expect(selectionToClipboardText(rows, selection))
      .toBe('alice\t9223372036854775807\nbob\t1.50');
  });
});

describe('rowSelection / columnSelection', () => {
  const bounds = { rowCount: 3, columnCount: 4 };

  it('整行覆盖所有列，整列覆盖所有行', () => {
    expect(rowSelection(1, bounds)).toEqual({
      anchor: { row: 1, column: 0 },
      focus: { row: 1, column: 3 }
    });
    expect(columnSelection(2, bounds)).toEqual({
      anchor: { row: 0, column: 2 },
      focus: { row: 2, column: 2 }
    });
  });

  it('越界和空网格都返回 null', () => {
    // 返回一个夹紧过的选区会让用户以为自己选中了别的东西
    expect(rowSelection(3, bounds)).toBeNull();
    expect(rowSelection(-1, bounds)).toBeNull();
    expect(columnSelection(4, bounds)).toBeNull();
    expect(rowSelection(0, { rowCount: 0, columnCount: 0 })).toBeNull();
  });
});

describe('selectionToClipboardText 的表头', () => {
  const rows = [
    ['a', 1],
    ['b', 2]
  ] as const;

  it('只取选中那几列的表头', () => {
    const text = selectionToClipboardText(
      rows,
      { anchor: { row: 0, column: 1 }, focus: { row: 1, column: 1 } },
      { headers: ['name', 'qty'] }
    );
    expect(text).toBe('qty\n1\n2');
  });

  it('带表头时单格也按表格转义，不再原样复制', () => {
    // 已经是两行了，此时还按「单格原样」处理会写出一段串列的文本
    const text = selectionToClipboardText(
      [['a\tb']],
      { anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 } },
      { headers: ['note'] }
    );
    expect(text).toBe('note\n"a\tb"');
  });

  it('不给表头时行为不变', () => {
    const text = selectionToClipboardText(
      [['a\tb']],
      { anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 } }
    );
    expect(text).toBe('a\tb');
  });

  it('表头本身含制表符也要转义', () => {
    const text = selectionToClipboardText(
      [['x']],
      { anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 } },
      { headers: ['a\tb'] }
    );
    expect(text).toBe('"a\tb"\nx');
  });
});
