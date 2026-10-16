import { DatabaseType, type ConnectionConfig } from '../contracts/connection';

/** 与后端 `REDIS_MODE_OPTION` / `REDIS_SENTINEL` 一致：`options` 里这一项为 `sentinel` 就经哨兵连 */
export const REDIS_MODE_OPTION = 'redisMode';
export const REDIS_SENTINEL = 'sentinel';
/** 哨兵里登记的主节点名（`sentinel monitor <name> …`） */
export const REDIS_SENTINEL_MASTER_OPTION = 'sentinelMaster';

const REDIS_PORT = 6379;
const SENTINEL_PORT = 26379;

type ModeFields = Pick<ConnectionConfig, 'db_type' | 'options'>;
type ModeToggled = Partial<Pick<ConnectionConfig, 'options' | 'port'>>;

export function isRedisSentinel(config: Partial<ModeFields>): boolean {
  return config.db_type === DatabaseType.Redis && config.options?.[REDIS_MODE_OPTION] === REDIS_SENTINEL;
}

/** 换成经哨兵连或换回单机。端口只换没改过的默认值（数据节点 6379、哨兵 26379） */
export function withRedisSentinel(config: ModeToggled, enabled: boolean): ModeToggled {
  const rest = Object.fromEntries(
    Object.entries(config.options ?? {}).filter(([name]) => name !== REDIS_MODE_OPTION)
  );
  if (enabled) {
    return {
      options: { ...rest, [REDIS_MODE_OPTION]: REDIS_SENTINEL },
      port: config.port === REDIS_PORT ? SENTINEL_PORT : config.port
    };
  }
  return { options: rest, port: config.port === SENTINEL_PORT ? REDIS_PORT : config.port };
}

export function withRedisSentinelMaster(
  options: Record<string, string> | undefined,
  master: string
): Record<string, string> {
  const rest = Object.fromEntries(
    Object.entries(options ?? {}).filter(([name]) => name !== REDIS_SENTINEL_MASTER_OPTION)
  );
  return master === '' ? rest : { ...rest, [REDIS_SENTINEL_MASTER_OPTION]: master };
}
