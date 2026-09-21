import { describe, expect, it } from 'vitest';
import { describeCellDisplay } from './cellDisplay';

describe('describeCellDisplay', () => {
  it('NULL、空字符串和纯空白分成三类，不会都变成一块空白', () => {
    // 这三者在网格里长得一样，而 `col = ''`、`col IS NULL`、`col = '  '`
    // 是三个不同的条件——分不出来就无从判断该写哪一个
    expect(describeCellDisplay(null).kind).toBe('null');
    expect(describeCellDisplay('').kind).toBe('empty');
    expect(describeCellDisplay('   ').kind).toBe('blank');

    const kinds = new Set([
      describeCellDisplay(null).text,
      describeCellDisplay('').text,
      describeCellDisplay('   ').text
    ]);
    expect(kinds.size).toBe(3);
  });

  it('纯空白显示出它的长度', () => {
    expect(describeCellDisplay('   ').text).toBe("'   '");
    expect(describeCellDisplay('\t').text).toBe("'\t'");
  });

  it('字符串 "NULL" 不是 NULL', () => {
    const literal = describeCellDisplay('NULL');
    expect(literal.kind).toBe('value');
    // 文本相同是刻意的——渲染层靠 kind 给不同的样式与 title，
    // 而不是去改用户的值
    expect(literal.text).toBe('NULL');
  });

  it('二进制带上 0x 前缀和字节数', () => {
    const display = describeCellDisplay({ type: 'binary', value: 'deadbeef' });
    expect(display.kind).toBe('binary');
    expect(display.text).toBe('0xdeadbeef');
    expect(display.byteLength).toBe(4);
    expect(display.truncated).toBe(false);
  });

  it('长二进制截断显示，但字节数按全长算', () => {
    // 截断后还报截断后的长度，用户会以为这个 BLOB 只有 32 字节
    const hex = 'ab'.repeat(5000);
    const display = describeCellDisplay({ type: 'binary', value: hex });

    expect(display.truncated).toBe(true);
    expect(display.text.length).toBeLessThan(80);
    expect(display.text.endsWith('…')).toBe(true);
    expect(display.byteLength).toBe(5000);
  });

  it('普通值折成单行', () => {
    const display = describeCellDisplay({ type: 'json', value: '{"a":1}' });
    expect(display.kind).toBe('value');
    expect(display.text).not.toContain('\n');
  });

  it('数字 0 和 false 不当作空值', () => {
    // 用 falsy 判空是这类代码最常见的一处错，0 会被显示成 NULL
    expect(describeCellDisplay(0).kind).toBe('value');
    expect(describeCellDisplay(0).text).toBe('0');
    expect(describeCellDisplay(false).kind).toBe('value');
    expect(describeCellDisplay(false).text).toBe('false');
  });
});
