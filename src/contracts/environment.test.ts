import { describe, expect, it } from 'vitest';
import { environmentBadge } from './environment';

describe('环境标识', () => {
  it('生产环境有常驻文字标识', () => {
    const badge = environmentBadge('production');
    expect(badge?.label).toBe('生产');
    expect(badge?.tone).toBe('danger');
  });

  it('预发环境有常驻文字标识', () => {
    expect(environmentBadge('staging')?.label).toBe('预发');
  });

  it('开发和测试不标', () => {
    // 每个连接都挂牌子就等于没有牌子
    expect(environmentBadge('development')).toBeNull();
    expect(environmentBadge('testing')).toBeNull();
  });

  it('需要标识的环境都带文字，不能只靠颜色', () => {
    for (const environment of ['production', 'staging'] as const) {
      const badge = environmentBadge(environment);
      expect(badge?.label.length).toBeGreaterThan(0);
      expect(badge?.description.length).toBeGreaterThan(0);
    }
  });

  it('认不出的环境值按不标处理，不抛', () => {
    // 后端将来加了新环境而前端还没跟上时，宁可不标也不要崩
    expect(() => environmentBadge('canary' as never)).not.toThrow();
    expect(environmentBadge('canary' as never)).toBeNull();
  });
});
