import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';

/**
 * 前端跑目录查询用的句柄。
 *
 * 只有 SQLite 还是插件的 `Database`。MySQL / PostgreSQL 的池子由后端开，目录
 * 查询和关池子也走后端命令：插件的 `select` / `close` 持着它那张池子表的锁等网络，
 * 一个库断了就把所有连接一起卡住（见 `sqlx_pool::shared`）。SQL Server / Oracle /
 * DuckDB / ClickHouse / MongoDB 的池子本来就在后端。消费方只用得到这两个方法，不需要知道是哪一种。
 */
export interface DatabaseHandle {
  select<T>(sql: string, params?: unknown[]): Promise<T>;
  close(): Promise<boolean>;
}

/** 与后端 `SQL_SERVER_SCHEME` 一致：连接串以它开头就是 SQL Server */
export const SQL_SERVER_SCHEME = 'sqlserver://';
/** 与后端 `ORACLE_SCHEME` 一致 */
export const ORACLE_SCHEME = 'oracle://';
/** 与后端 `DUCKDB_SCHEME` 一致：后面跟的是文件路径 */
export const DUCKDB_SCHEME = 'duckdb:';
/** 与后端 `MONGODB_SCHEME` 一致 */
export const MONGODB_SCHEME = 'mongodb://';
/** 与后端 `REDIS_SCHEME` 一致 */
export const REDIS_SCHEME = 'redis://';
/** 与后端 `NEO4J_SCHEME` 一致 */
export const NEO4J_SCHEME = 'bolt://';
/** 与后端 `CLICKHOUSE_SCHEME` 一致 */
export const CLICKHOUSE_SCHEME = 'clickhouse://';
/** 与后端 `ELASTICSEARCH_SCHEME` 一致 */
export const ELASTICSEARCH_SCHEME = 'elasticsearch://';
/** 与后端 `MONGODB_SRV_SCHEME` 一致：按 SRV 记录连的那种 */
export const MONGODB_SRV_SCHEME = 'mongodb+srv://';

/**
 * MongoDB 连接上没有 SQL 可跑。句柄照样要有——会话、断开、健康标记都认它——
 * 但 `select` 直接拒：走到这里说明某个 SQL 入口没按 `speaksSql` 挡住，
 * 报出来比拿一句 SQL 去问 MongoDB 强
 */
export const MONGO_HANDLE_HAS_NO_SQL = 'DATAOMNI_MONGO_NO_SQL';

export async function openDatabase(connectionString: string): Promise<DatabaseHandle> {
  if (connectionString.startsWith(SQL_SERVER_SCHEME)) {
    return backendHandle(connectionString, 'sql_server_select', 'close_sql_server');
  }
  if (connectionString.startsWith(ORACLE_SCHEME)) {
    return backendHandle(connectionString, 'oracle_select', 'close_oracle');
  }
  if (connectionString.startsWith(DUCKDB_SCHEME)) {
    return backendHandle(connectionString, 'duckdb_select', 'close_duckdb');
  }
  if (connectionString.startsWith(CLICKHOUSE_SCHEME)) {
    return backendHandle(connectionString, 'clickhouse_select', 'close_clickhouse');
  }
  if (connectionString.startsWith(MONGODB_SCHEME) || connectionString.startsWith(MONGODB_SRV_SCHEME)) {
    return {
      select: () => Promise.reject(new Error(MONGO_HANDLE_HAS_NO_SQL)),
      close: () => invoke<boolean>('close_mongodb', { connectionString })
    };
  }
  if (connectionString.startsWith(REDIS_SCHEME)) {
    return {
      select: () => Promise.reject(new Error(MONGO_HANDLE_HAS_NO_SQL)),
      close: () => invoke<boolean>('close_redis', { connectionString })
    };
  }
  if (connectionString.startsWith(NEO4J_SCHEME)) {
    return {
      select: () => Promise.reject(new Error(MONGO_HANDLE_HAS_NO_SQL)),
      close: () => invoke<boolean>('close_neo4j', { connectionString })
    };
  }
  if (connectionString.startsWith(ELASTICSEARCH_SCHEME)) {
    return {
      select: () => Promise.reject(new Error(MONGO_HANDLE_HAS_NO_SQL)),
      close: () => invoke<boolean>('close_elasticsearch', { connectionString })
    };
  }
  if (opensOwnPool(connectionString)) {
    // 不用插件的 load：它给空闲连接留 10 分钟（经 VPN / NAT 会被悄悄丢掉），
    // 库不存在时还会替你建一个
    await invoke('open_database_pool', { connectionString });
    return backendHandle(connectionString, 'sqlx_select', 'close_sqlx_pool');
  }
  return Database.load(connectionString);
}

/**
 * 池子是 `test_connection` 在后端登记的那几家（与 `test_connection` 里的 `registry.insert` 一致）。
 * 登记按连接串，关句柄会把这个串的池子整个摘掉——不管刚才是谁登记的。
 */
function poolRegisteredByTestConnection(connectionString: string): boolean {
  return [
    SQL_SERVER_SCHEME, ORACLE_SCHEME, DUCKDB_SCHEME, CLICKHOUSE_SCHEME, MONGODB_SCHEME,
    MONGODB_SRV_SCHEME, REDIS_SCHEME, NEO4J_SCHEME, ELASTICSEARCH_SCHEME
  ].some((scheme) => connectionString.startsWith(scheme));
}

/**
 * 换句柄时旧的那个能不能关。
 *
 * 新连接的 `test_connection` 先跑，池子已经按串登记好了；两条配置算出同一个串
 * （同主机同用户、只是名字不同），或者同一条断线重连，这时再关旧句柄就是把新池子
 * 摘掉——界面显示「已连接」，每条命令都报会话未连接。
 */
export function sharesRegisteredPool(previous: string | null | undefined, next: string | null | undefined): boolean {
  return Boolean(previous) && previous === next && poolRegisteredByTestConnection(previous as string);
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
