import { describe, expect, it } from 'vitest';
import CONTRACT_RAW from '../../fixtures/contract-conformance.json?raw';
import {
  DatabaseType,
  type ConnectionProfile,
  type SshTunnelConfig
} from './connection';
import type { QueryExecutionError } from './queryExecution';
import { toQueryExecutionError } from '../utils/queryError';

/**
 * 双向键集合相等断言：
 * - `Record<keyof Required<T>, true>`：如果 `T` 多了字段而列表没写，编译报错；
 * - 列表里的键如果不在 `keyof T` 中，`satisfies Record<keyof Required<T>, true>` 也会因为多余属性编译报错。
 */
const CONNECTION_PROFILE_KEYS = {
  id: true,
  name: true,
  db_type: true,
  host: true,
  port: true,
  database: true,
  username: true,
  password: true,
  ssl: true,
  tls_mode: true,
  ca_certificate_path: true,
  client_certificate_path: true,
  client_key_path: true,
  save_password: true,
  options: true,
  tags: true,
  environment: true,
  agent_access: true,
  credential_ref: true,
  ssh_tunnel: true,
  created_at: true,
  updated_at: true
} satisfies Record<keyof Required<ConnectionProfile>, true>;

type ExtraConnectionProfileKey = Exclude<keyof typeof CONNECTION_PROFILE_KEYS, keyof ConnectionProfile>;
const NO_EXTRA_CONNECTION_PROFILE_KEY: ExtraConnectionProfileKey extends never ? true : never = true;

const SSH_TUNNEL_KEYS = {
  host: true,
  port: true,
  username: true,
  private_key_path: true,
  auth: true,
  secret: true,
  secret_ref: true,
  remote_host: true,
  remote_port: true
} satisfies Record<keyof Required<SshTunnelConfig>, true>;

type ExtraSshTunnelKey = Exclude<keyof typeof SSH_TUNNEL_KEYS, keyof SshTunnelConfig>;
const NO_EXTRA_SSH_TUNNEL_KEY: ExtraSshTunnelKey extends never ? true : never = true;

const QUERY_ERROR_KEYS = {
  message: true,
  code: true,
  position: true,
  detail: true,
  hint: true,
  constraint: true,
  table: true
} satisfies Record<keyof Required<QueryExecutionError>, true>;

type ExtraQueryErrorKey = Exclude<keyof typeof QUERY_ERROR_KEYS, keyof QueryExecutionError>;
const NO_EXTRA_QUERY_ERROR_KEY: ExtraQueryErrorKey extends never ? true : never = true;

describe('Rust ↔ TS 跨层契约夹具 (fixtures/contract-conformance.json)', () => {
  const fixture = JSON.parse(CONTRACT_RAW) as {
    connection_profile: Record<string, unknown>;
    query_error: Record<string, unknown>;
  };

  it('ConnectionProfile 与 SshTunnelConfig 的字段集合与共用夹具完全一致', () => {
    expect(NO_EXTRA_CONNECTION_PROFILE_KEY).toBe(true);
    expect(NO_EXTRA_SSH_TUNNEL_KEY).toBe(true);

    expect(Object.keys(fixture.connection_profile).sort()).toEqual(
      Object.keys(CONNECTION_PROFILE_KEYS).sort()
    );
    const tunnel = fixture.connection_profile.ssh_tunnel as Record<string, unknown>;
    expect(Object.keys(tunnel).sort()).toEqual(Object.keys(SSH_TUNNEL_KEYS).sort());

    const typed: ConnectionProfile = {
      id: 'profile-contract-1',
      name: 'Orders PG',
      db_type: DatabaseType.PostgreSQL,
      host: 'db.internal',
      port: 5432,
      database: 'orders',
      username: 'readonly_user',
      password: '',
      ssl: true,
      tls_mode: 'verify-full',
      ca_certificate_path: '/etc/ssl/certs/ca.pem',
      client_certificate_path: '/etc/ssl/certs/client.pem',
      client_key_path: '/etc/ssl/private/client.key',
      save_password: true,
      options: { application_name: 'dataomni' },
      tags: ['core', 'reporting'],
      environment: 'staging',
      agent_access: 'read',
      credential_ref: 'keychain:profile-contract-1',
      ssh_tunnel: {
        host: 'bastion.internal',
        port: 2222,
        username: 'ops',
        private_key_path: '/Users/ops/.ssh/id_ed25519',
        auth: 'private-key',
        secret: '',
        secret_ref: 'keychain:profile-contract-1#ssh',
        remote_host: '10.0.1.15',
        remote_port: 5432
      },
      created_at: '2026-11-09T00:00:00Z',
      updated_at: '2026-11-09T01:00:00Z'
    };
    expect(typed).toEqual(fixture.connection_profile);
  });

  it('QueryError / QueryExecutionError 的字段集合与 toQueryExecutionError 解析结果一致', () => {
    expect(NO_EXTRA_QUERY_ERROR_KEY).toBe(true);
    expect(Object.keys(fixture.query_error).sort()).toEqual(Object.keys(QUERY_ERROR_KEYS).sort());

    const parsed = toQueryExecutionError(fixture.query_error);
    expect(parsed).toEqual(fixture.query_error);
  });
});
