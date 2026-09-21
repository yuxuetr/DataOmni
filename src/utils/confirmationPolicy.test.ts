/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIRMATION_POLICY,
  loadConfirmationPolicy,
  saveConfirmationPolicy
} from './confirmationPolicy';
import {
  classifyStatementRisk,
  highestRiskNeedingConfirmation,
  requiresConfirmation
} from './statementRisk';

describe('默认策略等于可配置之前的固定行为', () => {
  // 改成可配置不该顺手改掉任何人已经习惯的行为
  it('批量写入与破坏性语句在每个环境都拦', () => {
    for (const environment of ['development', 'testing', 'staging', 'production'] as const) {
      expect(requiresConfirmation('bulk-write', environment)).toBe(true);
      expect(requiresConfirmation('destructive', environment)).toBe(true);
    }
  });

  it('有界写入只在生产上拦', () => {
    expect(requiresConfirmation('scoped-write', 'production')).toBe(true);
    expect(requiresConfirmation('scoped-write', 'staging')).toBe(false);
    expect(requiresConfirmation('scoped-write', 'development')).toBe(false);
  });

  it('读和追加默认都不拦', () => {
    expect(requiresConfirmation('read', 'production')).toBe(false);
    expect(requiresConfirmation('append', 'production')).toBe(false);
  });
});

describe('自定义策略', () => {
  it('调到 never 之后该环境一律不拦', () => {
    const policy = { ...DEFAULT_CONFIRMATION_POLICY, development: 'never' as const };
    expect(requiresConfirmation('destructive', 'development', policy)).toBe(false);
    expect(requiresConfirmation('destructive', 'production', policy)).toBe(true);
  });

  it('调到 append 之后连 INSERT 都拦', () => {
    const policy = { ...DEFAULT_CONFIRMATION_POLICY, production: 'append' as const };
    expect(requiresConfirmation('append', 'production', policy)).toBe(true);
    // 读永远不拦：给每条 SELECT 弹确认，弹到第三次就没人看了
    expect(requiresConfirmation('read', 'production', policy)).toBe(false);
  });

  it('调到 destructive 之后只拦 DROP / TRUNCATE', () => {
    const policy = { ...DEFAULT_CONFIRMATION_POLICY, production: 'destructive' as const };
    expect(requiresConfirmation('bulk-write', 'production', policy)).toBe(false);
    expect(requiresConfirmation('destructive', 'production', policy)).toBe(true);
  });

  it('策略一路传到「一批里最危险的那条」', () => {
    // 漏传的话，设置界面改了没反应，而界面上看不出任何异常
    const statements = ['DELETE FROM t', 'DROP TABLE t'];
    expect(highestRiskNeedingConfirmation(statements, 'development')).toEqual({
      sql: 'DROP TABLE t',
      risk: classifyStatementRisk('DROP TABLE t')
    });
    expect(
      highestRiskNeedingConfirmation(statements, 'development', {
        ...DEFAULT_CONFIRMATION_POLICY,
        development: 'never'
      })
    ).toBeNull();
  });
});

describe('持久化', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('存下来能原样读回', () => {
    const policy = { ...DEFAULT_CONFIRMATION_POLICY, staging: 'never' as const };
    saveConfirmationPolicy(policy);
    expect(loadConfirmationPolicy()).toEqual(policy);
  });

  it('没存过时给默认值', () => {
    expect(loadConfirmationPolicy()).toEqual(DEFAULT_CONFIRMATION_POLICY);
  });

  it('内容坏掉时回落到默认值而不是抛', () => {
    localStorage.setItem('dataomni.confirmation-policy', '{ 不是 JSON');
    expect(loadConfirmationPolicy()).toEqual(DEFAULT_CONFIRMATION_POLICY);
  });

  it('只存了一部分时逐项回落，不抹掉其余环境的设置', () => {
    // 整份回落会把用户在其余环境上的设置一起丢掉
    localStorage.setItem(
      'dataomni.confirmation-policy',
      JSON.stringify({ production: 'never', staging: '乱写的' })
    );
    expect(loadConfirmationPolicy()).toEqual({
      ...DEFAULT_CONFIRMATION_POLICY,
      production: 'never'
    });
  });

  it('localStorage 不可用时不抛', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('disabled');
    });
    expect(loadConfirmationPolicy()).toEqual(DEFAULT_CONFIRMATION_POLICY);
    getItem.mockRestore();

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('disabled');
    });
    expect(() => saveConfirmationPolicy(DEFAULT_CONFIRMATION_POLICY)).not.toThrow();
    setItem.mockRestore();
  });
});
