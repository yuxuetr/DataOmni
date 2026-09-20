import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 这道门看的是样式表本身，不是某个组件。
 *
 * 深色模式靠「同名变量换一套值」实现，所以最容易出的错是：给 :root 加了一个
 * 新 token，忘了在 [data-theme='dark'] 里给值——它不会报错，只会在深色下
 * 保持浅色，肉眼要盯着特定界面才看得出来。
 */
// 先剥掉注释再找块：注释里会出现 `@theme inline` 这样的字面量，
// 按字符串查找会命中说明文字，解析到隔壁的块上，门就永远是绿的。
const CSS = readFileSync(
  fileURLToPath(new URL('../index.css', import.meta.url)),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

function readBlock(selector: string): Map<string, string> {
  const start = CSS.indexOf(selector);
  if (start < 0) {
    throw new Error(`样式表里找不到 ${selector}`);
  }

  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  const body = CSS.slice(open + 1, close);

  const declarations = new Map<string, string>();
  // 同时收 color-scheme 这类普通属性，不只收自定义属性
  for (const match of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1], match[2].trim());
  }
  return declarations;
}

const light = readBlock(':root');
const dark = readBlock("[data-theme='dark']");
const themeLayer = readBlock('@theme inline');

describe('设计 token', () => {
  it('浅色板不是空的', () => {
    expect(light.size).toBeGreaterThan(20);
  });

  it('每个语义色都有深色对应值', () => {
    const missing = [...light.keys()]
      .filter((name) => name.startsWith('--dm-'))
      .filter((name) => !dark.has(name));

    expect(missing).toEqual([]);
  });

  it('深色板不引入浅色板没有的变量', () => {
    const extra = [...dark.keys()]
      .filter((name) => name.startsWith('--dm-'))
      .filter((name) => !light.has(name));

    expect(extra).toEqual([]);
  });

  it('两套主题的同名变量取值不同，否则这个 token 根本没被主题化', () => {
    // color-scheme 两边都要声明，但值本就应该不同，一并覆盖在下面的断言里
    const identical = [...light.entries()]
      .filter(([name]) => name.startsWith('--dm-'))
      .filter(([name, value]) => dark.get(name) === value)
      // 纯白字只用在实心的危险/成功按钮上，两套主题下底色都够深
      .filter(([name]) => name !== '--dm-fg-on-solid')
      .map(([name]) => name);

    expect(identical).toEqual([]);
  });

  it('@theme 暴露的每个颜色都指向真实存在的变量', () => {
    const dangling = [...themeLayer.entries()]
      .filter(([, value]) => value.startsWith('var('))
      .map(([name, value]) => [name, value.replace(/^var\(|\)$/g, '')] as const)
      .filter(([, target]) => !light.has(target))
      .map(([name]) => name);

    expect(dangling).toEqual([]);
  });

  it('两套主题都声明 color-scheme，原生滚动条和表单控件才会跟着变', () => {
    expect(light.get('color-scheme')).toBe('light');
    expect(dark.get('color-scheme')).toBe('dark');
  });
});
