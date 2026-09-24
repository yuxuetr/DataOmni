import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';

/**
 * 前端跑目录查询用的句柄。
 *
 * 只有 SQLite 还是插件的 `Database`。MySQL / PostgreSQL 的池子由后端开，目录
 * 查询和关池子也走后端命令：插件的 `select` / `close` 持着它那张池子表的锁等网络，
 * 一个库断了就把所有连接一起卡住（见 `sqlx_pool::shared`）。SQL Server / Oracle
 * 的池子本来就在后端。消费方只用得到这两个方法，不需要知道是哪一种。
 */
export interface DatabaseHandle {
  select<T>(sql: string, params?: unknown[]): Promise<T>;
  close(): Promise<boolean>;
}

/** 与后端 `SQL_SERVER_SCHEME` 一致：连接串以它开头就是 SQL Server */
export const SQL_SERVER_SCHEME = 'sqlserver://';
/** 与后端 `ORACLE_SCHEME` 一致 */
export const ORACLE_SCHEME = 'oracle://';

export async function openDatabase(connectionString: string): Promise<DatabaseHandle> {
  if (connectionString.startsWith(SQL_SERVER_SCHEME)) {
    return backendHandle(connectionString, 'sql_server_select', 'close_sql_server');
  }
  if (connectionString.startsWith(ORACLE_SCHEME)) {
    return backendHandle(connectionString, 'oracle_select', 'close_oracle');
  }
  if (opensOwnPool(connectionString)) {
    // 不用插件的 load：它给空闲连接留 10 分钟（经 VPN / NAT 会被悄悄丢掉），
    // 库不存在时还会替你建一个
    await invoke('open_database_pool', { connectionString });
    return backendHandle(connectionString, 'sqlx_select', 'close_sqlx_pool');
  }
  return Database.load(connectionString);
}

/** 与后端 `sqlx_pool::handles` 一致：MySQL / PostgreSQL 的池子由后端开 */
export function opensOwnPool(connectionString: string): boolean {
  return /^(mysql|mariadb|postgres|postgresql):\/\//.test(connectionString);
}

function backendHandle(connectionString: string, select: string, close: string): DatabaseHandle {
  return {
    select: <T,>(sql: string, params: unknown[] = []) =>
      invoke<T>(select, { connectionString, sql, params }),
    close: () => invoke<boolean>(close, { connectionString })
  };
}
