import { DatabaseType, type ConnectionConfig } from '../contracts/connection';

/** 与后端 `REDIS_MODE_OPTION` 一致：`options` 里这一项为 `sentinel` / `cluster`，不设就是单机 */
export const REDIS_MODE_OPTION = 'redisMode';
export const REDIS_SENTINEL = 'sentinel';
export const REDIS_CLUSTER = 'cluster';
/** 哨兵里登记的主节点名（`sentinel monitor <name> …`） */
export const REDIS_SENTINEL_MASTER_OPTION = 'sentinelMaster';

export type RedisMode = 'standalone' | typeof REDIS_SENTINEL | typeof REDIS_CLUSTER;

const REDIS_PORT = 6379;
const SENTINEL_PORT = 26379;

type ModeFields = Pick<ConnectionConfig, 'db_type' | 'options'>;
type ModeToggled = Partial<Pick<ConnectionConfig, 'options' | 'port' | 'database'>>;

export function redisMode(config: Partial<ModeFields>): RedisMode {
  if (config.db_type !== DatabaseType.Redis) return 'standalone';
  const mode = config.options?.[REDIS_MODE_OPTION];
  return mode === REDIS_SENTINEL || mode === REDIS_CLUSTER ? mode : 'standalone';
}

/**
 * 换部署方式。端口只换没改过的默认值（数据节点 6379、哨兵 26379）；集群只有 0 号库，
 * 换过去时库号改成 0（填别的后端会拒）
 */
export function withRedisMode(config: ModeToggled, mode: RedisMode): ModeToggled {
  const rest = Object.fromEntries(
    Object.entries(config.options ?? {}).filter(([name]) => name !== REDIS_MODE_OPTION)
  );
  const options = mode === 'standalone' ? rest : { ...rest, [REDIS_MODE_OPTION]: mode };
  const port = mode === REDIS_SENTINEL
    ? (config.port === REDIS_PORT ? SENTINEL_PORT : config.port)
    : (config.port === SENTINEL_PORT ? REDIS_PORT : config.port);
  return mode === REDIS_CLUSTER ? { options, port, database: '0' } : { options, port };
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
