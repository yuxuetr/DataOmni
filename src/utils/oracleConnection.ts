import { DatabaseType, type ConnectionConfig } from '../contracts/connection';

/** 与后端 `ORACLE_CONNECT_BY_OPTION` / `ORACLE_SID` 一致：`options` 里这一项为 `sid` 就按 SID 连 */
export const ORACLE_CONNECT_BY_OPTION = 'connectBy';
export const ORACLE_SID = 'sid';
/** 新建连接时预填的服务名：Oracle Free / 23ai 的默认 PDB */
export const ORACLE_DEFAULT_SERVICE = 'FREEPDB1';

type ConnectByFields = Pick<ConnectionConfig, 'db_type' | 'options'>;
type ConnectByToggled = Partial<Pick<ConnectionConfig, 'options' | 'database'>>;

export function isOracleSid(config: Partial<ConnectByFields>): boolean {
  return config.db_type === DatabaseType.Oracle && config.options?.[ORACLE_CONNECT_BY_OPTION] === ORACLE_SID;
}

/**
 * 换成按 SID 连或换回服务名。用户填过的值留着：单实例的老库服务名与 SID 常常同名。
 * 只有预填的 FREEPDB1 换成 SID 时清掉——那是个 PDB，PDB 没有 SID；换回来那一格空着就再填上
 */
export function withOracleSid(config: ConnectByToggled, enabled: boolean): ConnectByToggled {
  const rest = Object.fromEntries(
    Object.entries(config.options ?? {}).filter(([name]) => name !== ORACLE_CONNECT_BY_OPTION)
  );
  const database = config.database ?? '';
  if (enabled) {
    return {
      options: { ...rest, [ORACLE_CONNECT_BY_OPTION]: ORACLE_SID },
      database: database === ORACLE_DEFAULT_SERVICE ? '' : database
    };
  }
  return { options: rest, database: database === '' ? ORACLE_DEFAULT_SERVICE : database };
}
