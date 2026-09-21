import type { ConnectionEnvironment } from '../contracts';
import type { StatementRisk } from './statementRisk';

/**
 * 从哪一级风险开始要确认。`never` 表示这个环境下一律不拦。
 *
 * 没有 `read` 这一档：给每条 SELECT 弹一次确认，弹到第三次就没人看了，
 * 真正危险的那次也会被顺手点掉——那正是这道闸要避免的事。
 */
export type ConfirmationThreshold = Exclude<StatementRisk, 'read'> | 'never';

export const CONFIRMATION_THRESHOLDS: readonly ConfirmationThreshold[] = [
  'never',
  'destructive',
  'bulk-write',
  'scoped-write',
  'append'
];

export type ConfirmationPolicy = Record<ConnectionEnvironment, ConfirmationThreshold>;

/**
 * 默认值就是这个功能可配置之前的固定行为：有界的写入只在生产上拦，
 * 批量与破坏性到哪都拦。改成可配置不该顺手改掉任何人已经习惯的行为。
 */
export const DEFAULT_CONFIRMATION_POLICY: ConfirmationPolicy = {
  development: 'bulk-write',
  testing: 'bulk-write',
  staging: 'bulk-write',
  production: 'scoped-write'
};

const STORAGE_KEY = 'dataomni.confirmation-policy';

const ENVIRONMENTS: readonly ConnectionEnvironment[] = [
  'development',
  'testing',
  'staging',
  'production'
];

/**
 * 读不到、读坏、localStorage 不可用时逐项回落到默认值。
 *
 * 逐项而不是整份回落：存下来的内容少一个环境（比如以后加了新环境），
 * 整份丢掉会把用户在其余三个环境上的设置一起抹掉。
 */
export function loadConfirmationPolicy(): ConfirmationPolicy {
  let stored: unknown;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    return { ...DEFAULT_CONFIRMATION_POLICY };
  }

  if (typeof stored !== 'object' || stored === null) {
    return { ...DEFAULT_CONFIRMATION_POLICY };
  }

  const source = stored as Record<string, unknown>;
  const policy = { ...DEFAULT_CONFIRMATION_POLICY };
  for (const environment of ENVIRONMENTS) {
    const value = source[environment];
    if (isThreshold(value)) {
      policy[environment] = value;
    }
  }
  return policy;
}

export function saveConfirmationPolicy(policy: ConfirmationPolicy): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(policy));
  } catch {
    // 存不下就只影响下次启动的默认值，不该让设置界面报错
  }
}

function isThreshold(value: unknown): value is ConfirmationThreshold {
  return (
    typeof value === 'string' &&
    (CONFIRMATION_THRESHOLDS as readonly string[]).includes(value)
  );
}
