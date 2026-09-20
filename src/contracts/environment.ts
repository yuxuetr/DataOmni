import type { ConnectionEnvironment } from './connection';
import type { TranslationKey } from '../i18n/translate';

export interface EnvironmentBadge {
  /**
   * 常驻显示文字的文案键，不是文字本身：这是模块级常量，用不了 hook，
   * 而文案要跟着语言走。不能只用颜色区分——色觉障碍和灰度截图下颜色都会失效。
   */
  labelKey: TranslationKey;
  tone: 'danger' | 'warning';
  /** 完整说明的文案键，挂在 title 上 */
  descriptionKey: TranslationKey;
}

/**
 * 哪些环境需要常驻标识。
 *
 * 开发和测试不标：每个连接都挂一个牌子就等于没有牌子，真正危险的那个反而
 * 淹没在里面。只标改坏了会真出事的两种。
 *
 * 类型写成完整的 Record，新增环境时这里编译不过——不会悄悄漏掉一种。
 */
const BADGES: Record<ConnectionEnvironment, EnvironmentBadge | null> = {
  production: {
    labelKey: 'environment.production',
    tone: 'danger',
    descriptionKey: 'environment.production.description'
  },
  staging: {
    labelKey: 'environment.staging',
    tone: 'warning',
    descriptionKey: 'environment.staging.description'
  },
  testing: null,
  development: null
};

export function environmentBadge(environment: ConnectionEnvironment): EnvironmentBadge | null {
  return BADGES[environment] ?? null;
}
