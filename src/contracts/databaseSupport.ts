import { DatabaseType } from './connection';

/**
 * 真正能连上的数据库类型。
 *
 * 唯一的依据是后端 sqlx 编进了哪几个驱动（`src-tauri/Cargo.toml` 的 features）。
 * 其余类型在界面上可见但不可选——留着是说明路线，选中它只会存下一个永远连不上
 * 的配置。`databaseSupport.test.ts` 直接读 Cargo.toml 比对，防止两边各改各的。
 */
export const SUPPORTED_DATABASE_TYPES: ReadonlySet<DatabaseType> = new Set([
  DatabaseType.SQLite,
  DatabaseType.MySQL,
  DatabaseType.PostgreSQL
]);

/** sqlx 的 driver feature 名到本项目类型的对应 */
export const SQLX_DRIVER_FEATURES: Readonly<Record<string, DatabaseType>> = {
  sqlite: DatabaseType.SQLite,
  mysql: DatabaseType.MySQL,
  postgres: DatabaseType.PostgreSQL
};

export function isDatabaseTypeSupported(type: DatabaseType): boolean {
  return SUPPORTED_DATABASE_TYPES.has(type);
}
