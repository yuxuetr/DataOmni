import { DatabaseType, type ConnectionConfig, type TlsMode } from '../contracts/connection';

/** 与后端 `MONGO_SRV_OPTION` 一致：`options` 里这个键为 `"true"` 就按 SRV 记录连 */
export const MONGO_SRV_OPTION = 'srv';

type SrvFields = Pick<ConnectionConfig, 'db_type' | 'options'>;

export function isMongoSrv(config: Partial<SrvFields>): boolean {
  return config.db_type === DatabaseType.MongoDB && config.options?.[MONGO_SRV_OPTION] === 'true';
}

/**
 * 打开或关掉 SRV 要一起改的几项。
 *
 * 打开时：去掉隧道（隧道只转发一个地址，SRV 给的是一组成员，后端也会拒）；
 * TLS 是「不加密」的话升到完整校验——规范里 SRV 默认开 TLS，Atlas 也只收
 * TLS，留着「不加密」只会换来一次看不懂的超时。关掉时什么都不回退：
 * 那几项此刻的值就是用户要的
 */
type SrvToggled = Partial<Pick<ConnectionConfig, 'options' | 'tls_mode' | 'ssl' | 'ssh_tunnel'>>;

export function withMongoSrv(config: SrvToggled, enabled: boolean): SrvToggled {
  const rest = Object.fromEntries(
    Object.entries(config.options ?? {}).filter(([key]) => key !== MONGO_SRV_OPTION)
  );
  if (!enabled) {
    return { ...config, options: rest };
  }
  const tlsMode: TlsMode = config.tls_mode ?? (config.ssl ? 'required' : 'disabled');
  return {
    ...config,
    options: { ...rest, [MONGO_SRV_OPTION]: 'true' },
    ssh_tunnel: null,
    tls_mode: tlsMode === 'disabled' ? 'verify-full' : tlsMode,
    ssl: true
  };
}

/** 界面上写「连到哪」：SRV 只有一个 DNS 名字，端口不用，印出来反而误导 */
export function serverAddress(profile: SrvFields & Pick<ConnectionConfig, 'host' | 'port'>): string {
  return isMongoSrv(profile) ? profile.host : `${profile.host}:${profile.port}`;
}
