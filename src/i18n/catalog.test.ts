import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from './en';
import { zh } from './zh';
import { translate } from './translate';

const KEYS = Object.keys(zh) as Array<keyof typeof zh>;

function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort();
}

/** 遍历 src 下所有 .ts / .tsx，测试文件除外（那里的键是随手编的） */
function sourceFiles(): Array<[string, string]> {
  const root = new URL('../..', import.meta.url).pathname;
  const found: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push([path.slice(root.length), readFileSync(path, 'utf8')]);
      }
    }
  };
  walk(join(root, 'src'));
  return found;
}

describe('翻译目录', () => {
  it('两种语言的键完全一致', () => {
    // 类型上已经保证了（en 声明成 Translations），这条守住「类型被 any 绕过去」
    expect(Object.keys(en).sort()).toEqual(KEYS.slice().sort());
  });

  it('每条文案的占位符在两种语言里一致', () => {
    // 漏掉一个 {count}，界面上那个数字就凭空消失了，而文案读起来仍然通顺
    for (const key of KEYS) {
      expect(placeholders(en[key]), `${key} 的占位符对不上`).toEqual(placeholders(zh[key]));
    }
  });

  it('调用点传的参数名和文案里的占位符对得上', () => {
    // `translate` 故意保留没被替换掉的占位符，所以传错名字的后果是界面上
    // 明晃晃地印着 `{count}`。这不会让任何测试变红——只有把界面渲染出来看才
    // 发现得了，而一轮改动里同一个错犯了三次。这条门把它变成编译期之外的一次断言。
    const problems: string[] = [];
    for (const [file, source] of sourceFiles()) {
      // 只认字面量键加字面量参数对象的调用；动态键或展开参数跳过——
      // 猜一个可能对不上的东西，比不查更糟
      const calls = source.matchAll(/\bt\(\s*'([\w.]+)'\s*,\s*\{([^{}]*)\}\s*\)/g);
      for (const call of calls) {
        const key = call[1] as keyof typeof zh;
        if (!(key in zh)) {
          continue;
        }
        if (call[2].includes('...')) {
          continue;
        }
        // `{ count }` 简写和 `{ count: n }` 都要认出来
        const passed = new Set(
          [...call[2].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(:|,|$)/g)].map(match => match[1])
        );
        const expected = placeholders(zh[key]);
        const missing = expected.filter(name => !passed.has(name));
        // `count` 可以多传：它不出现在文案里也仍然决定取不取 `.one`。
        // 其余的多余参数多半是占位符被改了名，而那正是会在界面上留下 `{x}` 的那种。
        const extra = [...passed].filter(name => name !== 'count' && !expected.includes(name));
        if (missing.length > 0) {
          problems.push(`${file}: t('${key}') 没传 [${missing}]，界面上会直接印出占位符`);
        }
        if (extra.length > 0) {
          problems.push(`${file}: t('${key}') 多传了 [${extra}]，文案要的是 [${expected}]`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('英文文案里不残留中日韩字符', () => {
    // 「加了键、把中文原样粘过去」是最常见的一种漏翻，而它不会引发任何报错
    const CJK = /[一-鿿぀-ヿ]/;
    // 语言名字按惯例用它自己的文字写（中文 / English），不随界面语言翻译——
    // 否则在英文界面里那一档会变成「Chinese」，而看得懂它的人未必读英文
    const INTENTIONAL: string[] = ['app.language.zh', 'palette.action.languageZh'];
    for (const key of KEYS) {
      if (INTENTIONAL.includes(key)) {
        continue;
      }
      expect(CJK.test(en[key]), `${key} 的英文文案里还有中文: ${en[key]}`).toBe(false);
    }
  });

  it('没有空文案', () => {
    for (const key of KEYS) {
      expect(zh[key].trim(), `${key} 的中文为空`).not.toBe('');
      expect(en[key].trim(), `${key} 的英文为空`).not.toBe('');
    }
  });
});

describe('translate', () => {
  it('按语言取文案', () => {
    expect(translate('zh', 'common.copy')).toBe('复制');
    expect(translate('en', 'common.copy')).toBe('Copy');
  });

  it('替换占位符', () => {
    expect(translate('zh', 'connection.deleteConfirm', { name: 'T1' }))
      .toBe('确定要删除连接 "T1" 吗？');
    expect(translate('en', 'connection.deleteConfirm', { name: 'T1' }))
      .toBe('Delete the connection "T1"?');
  });

  it('数字参数被转成字符串', () => {
    expect(translate('zh', 'connection.deleteConfirm', { name: 42 })).toContain('42');
  });

  it('缺参数时保留占位符原样，不替换成空字符串', () => {
    // 界面上留着 {name} 一眼看得出是 bug；一个消失的词看上去只是文案含糊
    expect(translate('zh', 'connection.deleteConfirm', {})).toContain('{name}');
  });

  it('不传参数时原样返回，不做无谓的正则替换', () => {
    expect(translate('en', 'explorer.title')).toBe('Database');
  });
});

describe('单复数', () => {
  it('count 为 1 时取 .one，其余取原键', () => {
    expect(translate('en', 'history.rows', { count: 1 })).toBe('1 row');
    expect(translate('en', 'history.rows', { count: 0 })).toBe('0 rows');
    expect(translate('en', 'history.rows', { count: 12 })).toBe('12 rows');
  });

  it('中文两档同文', () => {
    expect(translate('zh', 'history.rows', { count: 1 })).toBe('1 行');
    expect(translate('zh', 'history.rows', { count: 12 })).toBe('12 行');
  });

  it('没有 .one 的键不受影响', () => {
    expect(translate('en', 'editor.seconds', { count: 1 })).toBe('1s');
  });

  it('count 不是 1 或缺席时不去找 .one', () => {
    // 字符串 '1' 不算：真要算的话，任何一个恰好是 "1" 的文本参数都会改变选词
    expect(translate('en', 'history.rows', { count: '1' })).toBe('1 rows');
    expect(translate('en', 'history.rows')).toBe('{count} rows');
  });

  it('每个 .one 键都有对应的原键', () => {
    // 原键被改名而 .one 留在原地的话，它就永远不会被取到，而且不报错
    for (const key of KEYS) {
      if (!key.endsWith('.one')) {
        continue;
      }
      expect(KEYS, `${key} 没有对应的原键`).toContain(key.slice(0, -'.one'.length));
    }
  });

  it('英文里每个带 {count} 的复数文案都有单数形式', () => {
    // 漏掉一个不会报错，只会在界面上显示「1 rows」
    const PLURAL_NOUN =
      /\{count\}[^{]*\b(rows|entries|statements|tabs|items|matches|days|files|columns|tables|bytes|characters)\b/;
    // 调用点用 `statementCount > 1` 守着，count 永远不会是 1。补一个单数形式
    // 只会多出一条永远取不到的文案，而下一个人读到它会以为它在用
    const NEVER_ONE = ['risk.batchNote'];
    for (const key of KEYS) {
      if (key.endsWith('.one') || NEVER_ONE.includes(key) || !PLURAL_NOUN.test(en[key])) {
        continue;
      }
      expect(KEYS, `${key} 是「{count} 复数名词」但没有 ${key}.one`).toContain(`${key}.one`);
    }
  });
  it('两份目录里没有被编码弄坏的文案', () => {
    // 真的发生过：一次批量改文案把 UTF-8 当 latin-1 解了一遍，
    // 「—」变成「â€"」写进了 en.ts。typecheck、lint、i18n 的其余检查
    // 全绿，只有把界面渲染出来才看得见——这条门把它变成一次编译期失败。
    //
    // U+FFFD 是解码失败留下的替换字符；`Â` 与 `â€` 是 UTF-8 被按 latin-1
    // 读了一遍之后必然出现的两个前缀。
    const MOJIBAKE = /\uFFFD|\u00C2[\u00A0-\u00BF]|\u00E2\u20AC/;
    for (const catalog of [zh, en]) {
      for (const key of Object.keys(catalog) as Array<keyof typeof zh>) {
        expect(MOJIBAKE.test(catalog[key]), `${key}: ${catalog[key]}`).toBe(false);
      }
    }
  });
});
