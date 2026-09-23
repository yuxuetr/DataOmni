import { DatabaseType } from './connection';

/**
 * 真正能连上的数据库类型。
 *
 * 唯一的依据是后端编进了哪几个驱动：sqlx 的 features，加上不走 sqlx 的独立驱动
 * （SQL Server 的 tiberius）——都在 `src-tauri/Cargo.toml` 里。
 * 其余类型在界面上可见但不可选——留着是说明路线，选中它只会存下一个永远连不上
 * 的配置。`databaseSupport.test.ts` 直接读 Cargo.toml 比对，防止两边各改各的。
 */
export const SUPPORTED_DATABASE_TYPES: ReadonlySet<DatabaseType> = new Set([
  DatabaseType.SQLite,
  DatabaseType.MySQL,
  DatabaseType.PostgreSQL,
  DatabaseType.SqlServer,
  DatabaseType.Oracle
]);

/** sqlx 的 driver feature 名到本项目类型的对应 */
export const SQLX_DRIVER_FEATURES: Readonly<Record<string, DatabaseType>> = {
  sqlite: DatabaseType.SQLite,
  mysql: DatabaseType.MySQL,
  postgres: DatabaseType.PostgreSQL
};

/** 不走 sqlx 的驱动：`Cargo.toml` 里有这个依赖，对应的类型就连得上 */
export const STANDALONE_DRIVER_CRATES: Readonly<Record<string, DatabaseType>> = {
  tiberius: DatabaseType.SqlServer,
  oracle: DatabaseType.Oracle
};

export function isDatabaseTypeSupported(type: DatabaseType): boolean {
  return SUPPORTED_DATABASE_TYPES.has(type);
}

/**
 * 能连上、但还没接完的功能。只有分阶段接入的类型会出现在这里。
 *
 * 一处声明、三处消费：界面上对应的按钮据此不出现（而不是点了才报错），
 * 会话的能力标记据此给出，连接表单那一格的「有缺口」说明据此逐项列出——
 * 三处读的是同一份清单，不会一处说能做、另一处说不能。
 */
export type PendingFeature =
  | 'dataEditing'
  | 'transactions'
  | 'explain'
  | 'structureEditing'
  | 'import'
  | 'streamingExport';

/** SQL Server 的四个阶段已经全部接上；Oracle 在第一阶段（TODOs 4.2） */
export const PENDING_FEATURES: Readonly<Partial<Record<DatabaseType, readonly PendingFeature[]>>> = {
  [DatabaseType.Oracle]: [
    'structureEditing',
    'import'
  ]
};

/** `dbType` 收字符串：调用方手里常常只有方言名（`'sqlserver'`），它与类型值同形 */
export function supportsFeature(dbType: string, feature: PendingFeature): boolean {
  return !PENDING_FEATURES[dbType as DatabaseType]?.includes(feature);
}
