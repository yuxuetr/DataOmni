import { describe, expect, it } from 'vitest';
import { DEFAULT_FONT_SETTINGS, fontStack, normalizeFontSettings } from './fontSettings';

describe('字体名写成 CSS 的 font-family', () => {
  it('空着就是用默认', () => {
    expect(fontStack('')).toBeNull();
    expect(fontStack('  ,  ')).toBeNull();
  });

  it('每个名字加引号，逗号分开的按顺序', () => {
    expect(fontStack('JetBrains Mono')).toBe('"JetBrains Mono"');
    expect(fontStack('Fira Code, Menlo')).toBe('"Fira Code", "Menlo"');
  });

  // 用户照着别处抄来的 `'Source Code Pro', monospace`
  it('自带的引号去掉；通用族名不加引号，加了就成了一个叫 monospace 的字体', () => {
    expect(fontStack(`'Source Code Pro', monospace`)).toBe('"Source Code Pro", monospace');
    expect(fontStack('"PingFang SC", system-ui, sans-serif')).toBe('"PingFang SC", system-ui, sans-serif');
  });

  // 落到 setProperty 里：分号、花括号、反斜杠能把这一条声明截断或者转义掉
  it('能截断声明的字符去掉', () => {
    expect(fontStack('Menlo; color: red')).toBe('"Menlo color: red"');
    expect(fontStack('a}b{c\\d')).toBe('"abcd"');
  });
});

describe('读存着的字体设置', () => {
  it('读不出来或不是对象时整份用默认', () => {
    expect(normalizeFontSettings(null)).toEqual(DEFAULT_FONT_SETTINGS);
    expect(normalizeFontSettings('x')).toEqual(DEFAULT_FONT_SETTINGS);
  });

  it('坏一项只退那一项', () => {
    expect(normalizeFontSettings({ codeFontSize: 99, codeFont: 'Menlo', uiZoom: 1.25, uiFont: 3 })).toEqual({
      ...DEFAULT_FONT_SETTINGS,
      codeFont: 'Menlo',
      uiZoom: 1.25
    });
  });
});
