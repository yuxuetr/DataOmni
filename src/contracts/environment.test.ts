import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS, environmentBadge } from './environment';
import { zh } from '../i18n/zh';

describe('环境标识', () => {
  it('生产环境有常驻文字标识', () => {
    const badge = environmentBadge('production');
    expect(badge && zh[badge.labelKey]).toBe('生产');
    expect(badge?.tone).toBe('danger');
  });

  it('预发环境有常驻文字标识', () => {
    const badge = environmentBadge('staging');
    expect(badge && zh[badge.labelKey]).toBe('预发');
  });

  it('开发和测试也有标识，色调与生产、预发都不同', () => {
    // 没有牌子的连接分不出是「开发」还是「忘了设」
    expect(zh[environmentBadge('testing')!.labelKey]).toBe('测试');
    expect(zh[environmentBadge('development')!.labelKey]).toBe('开发');
    const tones = ENVIRONMENTS.map((environment) => environmentBadge(environment)?.tone);
    expect(new Set(tones).size).toBe(ENVIRONMENTS.length);
  });

  it('需要标识的环境都带文字，不能只靠颜色', () => {
    for (const environment of ENVIRONMENTS) {
      const badge = environmentBadge(environment);
      // 文案键必须真的存在于目录里，否则界面上是一片空白而不是报错
      expect(badge && zh[badge.labelKey]).toBeTruthy();
      expect(badge && zh[badge.descriptionKey]).toBeTruthy();
    }
  });

  it('认不出的环境值按不标处理，不抛', () => {
    // 后端将来加了新环境而前端还没跟上时，宁可不标也不要崩
    expect(() => environmentBadge('canary' as never)).not.toThrow();
    expect(environmentBadge('canary' as never)).toBeNull();
  });
});
