import type { ConnectionEnvironment } from './connection';

export interface EnvironmentBadge {
  /** 常驻显示的文字。不能只用颜色区分——色觉障碍和灰度截图下颜色都会失效 */
  label: string;
  tone: 'danger' | 'warning';
  /** 完整说明，挂在 title 上 */
  description: string;
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
  production: { label: '生产', tone: 'danger', description: '生产环境连接，改动会影响线上数据' },
  staging: { label: '预发', tone: 'warning', description: '预发环境连接，改动可能影响发布验证' },
  testing: null,
  development: null
};

export function environmentBadge(environment: ConnectionEnvironment): EnvironmentBadge | null {
  return BADGES[environment] ?? null;
}
