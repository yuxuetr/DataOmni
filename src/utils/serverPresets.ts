import type { ConnectionProfile, TlsMode } from '../contracts/connection';
import { createDefaultConfig, DatabaseType } from '../stores/connectionStore';

/**
 * 说 MySQL / PostgreSQL 线协议的服务端，在连接表单里的快捷入口。
 *
 * **不是新的数据库类型**：存下来的连接就是 MySQL / PostgreSQL，驱动、方言、
 * 目录查询全都照旧；服务端之间的差异由连上之后读 `VERSION()` 分支处理。
 * 这里只回答两件事——选哪个协议，以及默认值填什么（端口不同最常见，
 * 选成 MySQL 再连 TiDB 会撞在 3306 上）。
 *
 * 选的是哪一个记在 `options.server` 里，只供表单与列表显示；后端不读它。
 */
export type ServerPreset = 'mariadb' | 'tidb' | 'cockroachdb';

export const SERVER_PRESET_OPTION = 'server';

interface ServerPresetSpec {
  name: string;
  dbType: DatabaseType.MySQL | DatabaseType.PostgreSQL;
  port: number;
  database: string;
  username: string;
  /**
   * 「优先使用 TLS」：本地起的 TiDB / CockroachDB 默认没有证书，MySQL 那档
   * 「要求 TLS」会直接连不上；云上开了 TLS 的，优先档照样走加密。
   */
  tlsMode: TlsMode;
}

export const SERVER_PRESETS: Record<ServerPreset, ServerPresetSpec> = {
  mariadb: {
    name: 'MariaDB',
    dbType: DatabaseType.MySQL,
    port: 3306,
    database: '',
    username: 'root',
    tlsMode: 'preferred'
  },
  tidb: {
    name: 'TiDB',
    dbType: DatabaseType.MySQL,
    port: 4000,
    database: 'test',
    username: 'root',
    tlsMode: 'preferred'
  },
  cockroachdb: {
    name: 'CockroachDB',
    dbType: DatabaseType.PostgreSQL,
    port: 26257,
    database: 'defaultdb',
    username: 'root',
    tlsMode: 'preferred'
  }
};

/** 选中一个快捷入口之后的整份默认配置 */
export function serverPresetConfig(
  preset: ServerPreset
): Omit<ConnectionProfile, 'id' | 'created_at' | 'updated_at'> {
  const spec = SERVER_PRESETS[preset];
  return {
    ...createDefaultConfig(spec.dbType),
    port: spec.port,
    database: spec.database,
    username: spec.username,
    tls_mode: spec.tlsMode,
    ssl: spec.tlsMode !== 'disabled',
    options: { [SERVER_PRESET_OPTION]: preset }
  };
}

/**
 * 这个连接是经哪个快捷入口建的。
 *
 * 记录与类型对不上时（比如手改过存档，把类型改成了 PostgreSQL 却留着
 * `tidb`）不认：那一格高亮出来就是在说一件不成立的事。
 */
export function serverPresetOf(
  profile: Partial<Pick<ConnectionProfile, 'db_type' | 'options'>>
): ServerPreset | null {
  const recorded = profile.options?.[SERVER_PRESET_OPTION];
  if (recorded !== 'mariadb' && recorded !== 'tidb' && recorded !== 'cockroachdb') {
    return null;
  }
  return SERVER_PRESETS[recorded].dbType === profile.db_type ? recorded : null;
}

/** 连接列表上那个类型小字：经快捷入口建的写服务端的名字，其余照旧写协议 */
export function serverLabel(profile: Pick<ConnectionProfile, 'db_type' | 'options'>): string {
  const preset = serverPresetOf(profile);
  return preset ? SERVER_PRESETS[preset].name : profile.db_type;
}
