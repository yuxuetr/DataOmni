import type { ConnectionEnvironment } from './connection';
import type { TranslationKey } from '../i18n/translate';

export interface EnvironmentBadge {
  /**
   * 常驻显示文字的文案键，不是文字本身：这是模块级常量，用不了 hook，
   * 而文案要跟着语言走。不能只用颜色区分——色觉障碍和灰度截图下颜色都会失效。
   */
  labelKey: TranslationKey;
  tone: 'danger' | 'warning' | 'info' | 'neutral';
  /** 完整说明的文案键，挂在 title 上 */
  descriptionKey: TranslationKey;
}

/**
 * 每种环境的常驻标识。
 *
 * 四种都标：没有牌子的连接分不出是「开发」还是「忘了设」。危险程度靠色调区分——
 * 生产红、预发黄、测试蓝、开发灰，越危险越醒目。
 *
 * 类型写成完整的 Record，新增环境时这里编译不过——不会悄悄漏掉一种。
 */
const BADGES: Record<ConnectionEnvironment, EnvironmentBadge> = {
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
  testing: {
    labelKey: 'environment.testing',
    tone: 'info',
    descriptionKey: 'environment.testing.description'
  },
  development: {
    labelKey: 'environment.development',
    tone: 'neutral',
    descriptionKey: 'environment.development.description'
  }
};

export function environmentBadge(environment: ConnectionEnvironment): EnvironmentBadge | null {
  return BADGES[environment] ?? null;
}

/** 全部环境，按危险程度从低到高——设置里的阈值表和连接表单的选项都按这个顺序 */
export const ENVIRONMENTS: readonly ConnectionEnvironment[] = [
  'development',
  'testing',
  'staging',
  'production'
];

/**
 * 环境全名，不是徽标上那个短标签。
 *
 * 借用 `environment.staging` 会让设置里那一行显示成「预发 [预发]」——名字和徽标
 * 是同一个词，重复一遍不提供任何信息。
 */
export const ENVIRONMENT_NAME_KEYS: Record<ConnectionEnvironment, TranslationKey> = {
  development: 'environment.name.development',
  testing: 'environment.name.testing',
  staging: 'environment.name.staging',
  production: 'environment.name.production'
};
