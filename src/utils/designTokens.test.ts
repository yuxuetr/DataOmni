import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
      // 分类色板第 6 槽的绿在浅底与深底上都落在目标亮度带内，两套主题同值
      // 是验过之后的选择：再挪一次只会让它离相邻槽位更近
      .filter(([name]) => name !== '--dm-series-6')
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

/**
 * 层级不是靠 token 管的，是靠一套**只有五档**的约定管的。量过一次：32 处
 * z-index 里 21 处是 `z-50`，其余是 10/20/30/40。也就是说对话框、菜单、命令
 * 面板彼此之间的先后完全由 DOM 顺序决定——而它们不会同时开着，所以今天是对的。
 *
 * 真正会坏的是**跨层**那一条：任务中心是常驻的，它和模态可以同时在屏幕上。
 * 它要是爬到模态之上，确认框上就会压着一个任务提示，而「确定」按不到。
 *
 * 所以这道门只守两件事，不去 token 化 1192 处间距那种没有消费者的事：
 * 档位不许变多（`z-[9999]` 这种「先盖住再说」的写法挡在这里），
 * 以及常驻层必须严格低于模态层。
 */
const LAYERS = [10, 20, 30, 40, 50];
const OVERLAY_LAYER = 50;

function tsxFiles(): string[] {
  const root = fileURLToPath(new URL('..', import.meta.url));
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.tsx'))
    .map((entry) => join(root, entry));
}

function layersIn(source: string): number[] {
  return [...source.matchAll(/\bz-\[?(\d+)\]?\b/g)].map(([, value]) => Number(value));
}

describe('层级', () => {
  it('只有约定的那几档，没有人靠加大数字压过别人', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles()) {
      for (const layer of layersIn(readFileSync(file, 'utf8'))) {
        if (!LAYERS.includes(layer)) {
          offenders.push(`${file.split('/src/')[1]}: z-${layer}`);
        }
      }
    }
    expect(offenders, '新档位要先想清楚它排在谁上面、谁下面').toEqual([]);
  });

  it('任务中心是常驻的，必须严格低于模态层', () => {
    // 这两者可以同时在屏幕上。任务提示压住确认框的话，「确定」就按不到
    const root = fileURLToPath(new URL('..', import.meta.url));
    const taskCenter = readFileSync(join(root, 'components/TaskCenter.tsx'), 'utf8');
    const used = layersIn(taskCenter);

    expect(used.length, '任务中心没有层级了？这条门就失效了').toBeGreaterThan(0);
    for (const layer of used) {
      expect(layer, `任务中心用了 z-${layer}`).toBeLessThan(OVERLAY_LAYER);
    }
  });
});

/**
 * 语义色的含义不许被稀释。
 *
 * 量过一次：「只读」在三处出现，主语各不相同——连接只读（副本或 SQLite 的
 * `query_only`）、这张表不能就地改、这份结果不能就地改。前者写进去**会被
 * 数据库拒绝**，是真风险；后两者不带任何风险，只是一句能力说明。
 *
 * 而它们原来一个黄、一个黄、一个灰。给不带风险的事涂黄，是在教人忽略黄色，
 * 而黄色同时还用在「未提交事务」上——那是真会丢东西的。
 *
 * 所以规则是：**警告色只给「做下去会被拒绝或会丢东西」的状态。**
 * 这道门只守住其中可机械判定的那一半：两张数据网格的「不能就地编辑」
 * 不许是警告色。
 */
describe('语义色的含义', () => {
  const GRIDS = ['components/TableDataViewer.tsx', 'components/QueryResultScrollTable.tsx'];

  it('两张网格的「不能就地编辑」都不是警告色', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const offenders: string[] = [];

    for (const file of GRIDS) {
      const lines = readFileSync(join(root, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        // 只看画「只读」那几行：readOnly 的文案键或 Lock 图标所在的一小段
        if (!/readOnly|<Lock\b/.test(line)) {
          return;
        }
        const around = lines.slice(Math.max(0, index - 3), index + 4).join('\n');
        if (/warning/.test(around)) {
          offenders.push(`${file}:${index + 1}`);
        }
      });
    }

    expect(
      offenders,
      '「不能就地编辑」不带风险，涂成警告色会稀释警告色本身的含义'
    ).toEqual([]);
  });
});
