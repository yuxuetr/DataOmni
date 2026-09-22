export enum DatabaseType {
  MySQL = 'mysql',
  PostgreSQL = 'postgresql',
  SQLite = 'sqlite',
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
 * 第一个增量只支持无口令私钥——口令要放进钥匙串，而钥匙串的键现在是一个
 * 连接一份，得先改命名方案。见 `rfcs/ssh-tunnel.md`。
 */
export interface SshTunnelConfig {
  host: string;
  port: number;
  username: string;
  private_key_path: string;
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
