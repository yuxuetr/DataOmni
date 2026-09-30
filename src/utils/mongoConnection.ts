import { DatabaseType, type ConnectionConfig, type TlsMode } from '../contracts/connection';
import { isFileDatabase } from './databaseFiles';

/** 与后端 `MONGO_SRV_OPTION` 一致：`options` 里这个键为 `"true"` 就按 SRV 记录连 */
export const MONGO_SRV_OPTION = 'srv';
/** 与后端 `MONGO_AUTH_MECHANISM_OPTION` / `MONGO_X509` 一致：拿客户端证书登录 */
export const MONGO_AUTH_MECHANISM_OPTION = 'authMechanism';
export const MONGO_X509 = 'MONGODB-X509';

type SrvFields = Pick<ConnectionConfig, 'db_type' | 'options'>;
type SrvToggled = Partial<Pick<ConnectionConfig, 'options' | 'tls_mode' | 'ssl' | 'ssh_tunnel'>>;

export function isMongoSrv(config: Partial<SrvFields>): boolean {
  return config.db_type === DatabaseType.MongoDB && config.options?.[MONGO_SRV_OPTION] === 'true';
}

export function isMongoX509(config: Partial<SrvFields>): boolean {
  return config.db_type === DatabaseType.MongoDB
    && config.options?.[MONGO_AUTH_MECHANISM_OPTION] === MONGO_X509;
}

/** 「不加密」升到完整校验；已选的加密档位不动 */
function atLeastEncrypted(config: SrvToggled): Pick<ConnectionConfig, 'tls_mode' | 'ssl'> {
  const tlsMode: TlsMode = config.tls_mode ?? (config.ssl ? 'required' : 'disabled');
  return { tls_mode: tlsMode === 'disabled' ? 'verify-full' : tlsMode, ssl: true };
}

function withoutOption(options: Record<string, string> | undefined, key: string): Record<string, string> {
  return Object.fromEntries(Object.entries(options ?? {}).filter(([name]) => name !== key));
}

/**
 * 打开或关掉 SRV 要一起改的几项。
 *
 * 打开时：去掉隧道（隧道只转发一个地址，SRV 给的是一组成员，后端也会拒）；
 * TLS 是「不加密」的话升到完整校验——规范里 SRV 默认开 TLS，Atlas 也只收
 * TLS，留着「不加密」只会换来一次看不懂的超时。关掉时什么都不回退：
 * 那几项此刻的值就是用户要的
 */
export function withMongoSrv(config: SrvToggled, enabled: boolean): SrvToggled {
  const rest = withoutOption(config.options, MONGO_SRV_OPTION);
  if (!enabled) {
    return { ...config, options: rest };
  }
  return {
    ...config,
    options: { ...rest, [MONGO_SRV_OPTION]: 'true' },
    ssh_tunnel: null,
    ...atLeastEncrypted(config)
  };
}

/**
 * 换成拿证书登录（X.509）或换回口令。换成证书时同样把「不加密」升到完整校验：
 * 证书是在 TLS 握手里发出去的，不加密就没有地方发，而客户端证书那一格也只在
 * 开着 TLS 时出现
 */
export function withMongoX509(config: SrvToggled, enabled: boolean): SrvToggled {
  const rest = withoutOption(config.options, MONGO_AUTH_MECHANISM_OPTION);
  if (!enabled) {
    return { ...config, options: rest };
  }
  return { ...config, options: { ...rest, [MONGO_AUTH_MECHANISM_OPTION]: MONGO_X509 }, ...atLeastEncrypted(config) };
}

/** 界面上写「连到哪」：SRV 只有一个 DNS 名字，端口不用，印出来反而误导 */
export function serverAddress(profile: SrvFields & Pick<ConnectionConfig, 'host' | 'port'>): string {
  return isMongoSrv(profile) ? profile.host : `${profile.host}:${profile.port}`;
}

/**
 * 连接列表的一行上写「连的是什么」：文件库写路径，其余写地址加库名。
 * MongoDB 那一格是认证库（`authSource`，常见的是 `admin`），树里照样列出全部库，
 * 写成 `host:port/admin` 会被读成「连的是 admin 库」
 */
export function connectionTarget(
  profile: SrvFields & Pick<ConnectionConfig, 'db_type' | 'host' | 'port' | 'database'>
): string {
  if (isFileDatabase(profile.db_type)) {
    return profile.database || ':memory:';
  }
  const target = serverAddress(profile);
  return profile.database && profile.db_type !== DatabaseType.MongoDB ? `${target}/${profile.database}` : target;
}

/**
 * 窄处（侧边栏的连接菜单）用的写法。文件路径从尾部截断时，留下的是人人相同的
 * `/home/<user>/…`，把区分两个同名文件的那一段截掉了——只留上级目录与文件名
 */
export function compactConnectionTarget(
  profile: SrvFields & Pick<ConnectionConfig, 'db_type' | 'host' | 'port' | 'database'>
): string {
  const target = connectionTarget(profile);
  if (!isFileDatabase(profile.db_type)) {
    return target;
  }
  const separator = target.includes('\\') && !target.includes('/') ? '\\' : '/';
  const segments = target.split(separator);
  return segments.length > 3 ? `…${separator}${segments.slice(-2).join(separator)}` : target;
}
