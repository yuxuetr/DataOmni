import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';

/**
 * 前端跑目录查询用的句柄。
 *
 * sqlx 那三家是插件的 `Database`：`Database.load` 在插件里开池子，`select` 走
 * 插件的解码器。SQL Server 不归插件管——池子是后端 `test_connection` 开的——
 * 所以同样两个方法改走后端命令。消费方只用得到这两个方法，不需要知道是哪一种。
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
  return Database.load(connectionString);
}

function backendHandle(connectionString: string, select: string, close: string): DatabaseHandle {
  return {
    select: <T,>(sql: string, params: unknown[] = []) =>
      invoke<T>(select, { connectionString, sql, params }),
    close: () => invoke<boolean>(close, { connectionString })
  };
}
