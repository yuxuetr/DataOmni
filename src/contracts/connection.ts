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
  options: Record<string, string>;
  tags: string[];
  environment: ConnectionEnvironment;
  credential_ref?: string;
  created_at: string;
  updated_at: string;
}

/** @deprecated Use ConnectionProfile. */
export type ConnectionConfig = ConnectionProfile;
