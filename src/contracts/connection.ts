export enum DatabaseType {
  MySQL = 'mysql',
  PostgreSQL = 'postgresql',
  SQLite = 'sqlite',
  SqlServer = 'sqlserver',
  Oracle = 'oracle',
  MongoDB = 'mongodb',
  Redis = 'redis',
  Neo4j = 'neo4j',
  DuckDB = 'duckdb',
  ClickHouse = 'clickhouse',
  Elasticsearch = 'elasticsearch',
}

export type ConnectionEnvironment = 'development' | 'testing' | 'staging' | 'production';
export type TlsMode = 'disabled' | 'preferred' | 'required' | 'verify-ca' | 'verify-full';

/**
 * SSH 隧道。对应 Rust 的 `SshTunnelConfig`。
 *
 * `remote_host` / `remote_port` 是**从跳板机看过去**的库地址；留空就用
 * profile 自己的 host / port，那是最常见的填法。
 *
 * `secret` 按 `auth` 决定含义：私钥的解锁口令，或登录口令。它只在**提交的
 * 那一次**有值，后端存进钥匙串（键 `{id}#ssh`）之后清空，留下 `secret_ref`。
 * 界面不会把存着的口令回填，所以「这一格是空的」不等于「没有口令」——
 * 判断有没有要看 `secret_ref`。见 `rfcs/ssh-tunnel.md`。
 */
export type SshAuthMethod = 'private-key' | 'password';

export interface SshTunnelConfig {
  host: string;
  port: number;
  username: string;
  private_key_path: string;
  auth: SshAuthMethod;
  /** 提交时填，存住之后为空 */
  secret: string;
  /** 钥匙串里已经有一份的标记 */
  secret_ref?: string | null;
  remote_host?: string;
  remote_port?: number;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  db_type: DatabaseType;
  host: string;
  port: number;
  database?: string;
  username: string;
  password: string;
  ssl: boolean;
  tls_mode?: TlsMode;
  ca_certificate_path?: string;
  client_certificate_path?: string;
  client_key_path?: string;
  save_password: boolean;
  options: Record<string, string>;
  tags: string[];
  environment: ConnectionEnvironment;
  credential_ref?: string;
  /** 没有隧道时是 null / undefined，那时后端整条隧道代码都不会被碰到 */
  ssh_tunnel?: SshTunnelConfig | null;
  created_at: string;
  updated_at: string;
}

/** @deprecated Use ConnectionProfile. */
export type ConnectionConfig = ConnectionProfile;
