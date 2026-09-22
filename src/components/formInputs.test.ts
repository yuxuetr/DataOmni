import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 每一个文本框都要关掉系统的自动大写与自动更正。
 *
 * macOS 会替 WebView 里的文本框做这件事，而这里填的都是**原样要用**的东西。
 * 三种后果按严重程度排：SSH 用户名被改成 `Root`，报出来是一句「认证失败」；
 * 筛选框被改掉，一条都匹配不上；而表格里那一格是**要写回数据库的值**，
 * 改掉之后不报任何错——存进去的和敲进去的不是一个东西。
 *
 * 这道门存在的理由是：这三个属性此前零散写在四五个格子上，有人踩过一次只修了
 * 当时那一处，新加的 SSH 那几格又漏了。不靠记性，靠它。
 */

const COMPONENTS = join(process.cwd(), 'src/components');

/** 会被系统改写的输入类型。`number` / `date` / `checkbox` 这些没有这个问题 */
const TEXT_LIKE = ['text', 'search', 'password'];

interface InputTag {
  file: string;
  line: number;
  source: string;
}

/**
 * 揪出每一个 `<input …>`。
 *
 * 自己扫而不是用正则一把梭：属性值里有 `{}` 和 `>`（三元式、箭头函数），
 * `/<input[^>]*>/` 会在第一个箭头处截断，于是后半截属性看不见——那种门会
 * 把带 `onChange={(e) => …}` 的输入框全部漏掉，而那是所有输入框。
 */
function inputTags(): InputTag[] {
  const tags: InputTag[] = [];
  for (const name of readdirSync(COMPONENTS).filter(file => file.endsWith('.tsx'))) {
    const source = readFileSync(join(COMPONENTS, name), 'utf8');
    for (let at = source.indexOf('<input'); at >= 0; at = source.indexOf('<input', at + 1)) {
      let depth = 0;
      let end = at;
      while (end < source.length) {
        const char = source[end];
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
        else if (char === '>' && depth === 0) break;
        end += 1;
      }
      tags.push({
        file: name,
        line: source.slice(0, at).split('\n').length,
        source: source.slice(at, end + 1)
      });
    }
  }
  return tags;
}

function inputType(tag: InputTag): string {
  const quoted = tag.source.match(/type="([^"]+)"/);
  if (quoted) return quoted[1];
  const expression = tag.source.match(/type=\{([^}]+)\}/);
  // 三元式里出现过 text 就当成文本类；写 `type` 的表达式只有「显示/隐藏密码」那一处
  if (expression) return expression[1].includes('text') ? 'text' : 'expression';
  // 不写 type 的 input 就是 text，这是最容易漏的一种
  return 'text';
}

describe('文本框不被系统改写', () => {
  it('扫得到输入框——门自己先得有东西可扫', () => {
    // 解析写歪时这道门会「一个都没找到」然后全绿，那是最坏的一种绿
    expect(inputTags().length).toBeGreaterThan(20);
  });

  it('每个文本类输入框都带上 PLAIN_TEXT_INPUT', () => {
    const missing = inputTags()
      .filter(tag => TEXT_LIKE.includes(inputType(tag)))
      .filter(tag => !tag.source.includes('PLAIN_TEXT_INPUT'))
      .map(tag => `${tag.file}:${tag.line}`);

    expect(missing, '这些文本框会被 macOS 自动大写/自动更正，填进去的和敲进去的不是一个东西').toEqual([]);
  });

  it('同一件事不再写第二份字面量', () => {
    // 四处零散的字面量正是这道门的由来：改一处不会提醒另外三处
    const literals = readdirSync(COMPONENTS)
      .filter(file => file.endsWith('.tsx'))
      .filter(file => /autoCapitalize="(none|off)"/.test(readFileSync(join(COMPONENTS, file), 'utf8')))
      .filter(file => file !== 'FormControls.tsx');

    expect(literals, 'autoCapitalize 只该出现在 FormControls 的 PLAIN_TEXT_INPUT 里').toEqual([]);
  });
});
