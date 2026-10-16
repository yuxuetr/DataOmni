import { DatabaseType, type ConnectionConfig } from '../contracts/connection';

/** 与后端 `ES_AUTH_OPTION` / `ES_API_KEY` 一致：`options` 里这一项为 `apiKey` 就拿 API Key 登录 */
export const ES_AUTH_OPTION = 'auth';
export const ES_API_KEY = 'apiKey';

type AuthFields = Pick<ConnectionConfig, 'db_type' | 'options'>;
type AuthToggled = Partial<Pick<ConnectionConfig, 'options' | 'username' | 'password'>>;

export function isEsApiKey(config: Partial<AuthFields>): boolean {
  return config.db_type === DatabaseType.Elasticsearch && config.options?.[ES_AUTH_OPTION] === ES_API_KEY;
}

/**
 * 换成 API Key 或换回用户名与口令。key 存在口令那一格（同样进钥匙串），所以两头切换时
 * 那一格都清空：口令被当成 key 发出去、key 被当成口令发出去，都只会换来一次 401。
 * 用户名在 API Key 下不用，也清掉，免得存档里留着一个看起来在用的用户名
 */
export function withEsApiKey(config: AuthToggled, enabled: boolean): AuthToggled {
  const rest = Object.fromEntries(Object.entries(config.options ?? {}).filter(([name]) => name !== ES_AUTH_OPTION));
  return {
    ...config,
    options: enabled ? { ...rest, [ES_AUTH_OPTION]: ES_API_KEY } : rest,
    username: enabled ? '' : config.username,
    password: ''
  };
}
