import { describe, expect, it } from 'vitest';
import { environmentBadge } from './environment';
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

  it('开发和测试不标', () => {
    // 每个连接都挂牌子就等于没有牌子
    expect(environmentBadge('development')).toBeNull();
    expect(environmentBadge('testing')).toBeNull();
  });

  it('需要标识的环境都带文字，不能只靠颜色', () => {
    for (const environment of ['production', 'staging'] as const) {
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
