import { describe, expect, it } from 'vitest';
import { tabTitle } from './tabTitle';

const t = (key: string, params?: Record<string, string | number>) =>
  `${key}${params ? `(${Object.values(params).join(',')})` : ''}`;

describe('tabTitle', () => {
  it('没有文案键时用存下来的标题——表名不该被翻译', () => {
    expect(tabTitle({ title: 'users', titleKey: undefined, titleParams: undefined }, t as never))
      .toBe('users');
  });

  it('有文案键时按当前语言翻译，忽略存下来的旧标题', () => {
    // 存下来的是换语言之前的字符串；用它就会一半中文一半英文
    expect(
      tabTitle(
        { title: '查询 · T1', titleKey: 'tab.queryTitle', titleParams: { connection: 'T1' } },
        t as never
      )
    ).toBe('tab.queryTitle(T1)');
  });

  it('有键无参数时也能翻译', () => {
    expect(tabTitle({ title: 'x', titleKey: 'tab.newQuery', titleParams: undefined }, t as never))
      .toBe('tab.newQuery');
  });
});
