import { describe, expect, it } from 'vitest';
import { en } from './en';
import { zh } from './zh';
import { translate } from './translate';

const KEYS = Object.keys(zh) as Array<keyof typeof zh>;

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
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
