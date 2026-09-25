import { describe, expect, it } from 'vitest';
import { DatabaseType } from '../contracts/connection';
import { MONGO_SRV_OPTION, isMongoSrv, serverAddress, withMongoSrv } from './mongoSrv';
import { createDefaultSshTunnel } from './sshTunnel';

const tunnel = createDefaultSshTunnel();

describe('mongoSrv', () => {
  it('只有 MongoDB 认这个选项', () => {
    const options = { [MONGO_SRV_OPTION]: 'true' };
    expect(isMongoSrv({ db_type: DatabaseType.MongoDB, options })).toBe(true);
    expect(isMongoSrv({ db_type: DatabaseType.MySQL, options })).toBe(false);
    expect(isMongoSrv({ db_type: DatabaseType.MongoDB, options: {} })).toBe(false);
  });

  it('打开时去掉隧道、不加密升到完整校验，已选的加密档位不动', () => {
    const on = withMongoSrv({ options: { keep: '1' }, ssl: false, ssh_tunnel: tunnel }, true);
    expect(on).toEqual({
      options: { keep: '1', [MONGO_SRV_OPTION]: 'true' },
      ssh_tunnel: null,
      tls_mode: 'verify-full',
      ssl: true
    });
    expect(withMongoSrv({ options: {}, tls_mode: 'required', ssl: true }, true).tls_mode).toBe('required');
  });

  it('关掉时只摘掉这个键', () => {
    const off = withMongoSrv({ options: { keep: '1', [MONGO_SRV_OPTION]: 'true' }, tls_mode: 'verify-full', ssl: true }, false);
    expect(off).toEqual({ options: { keep: '1' }, tls_mode: 'verify-full', ssl: true });
  });

  it('SRV 的地址不印端口', () => {
    const base = { db_type: DatabaseType.MongoDB, host: 'cluster0.example.net', port: 27017 };
    expect(serverAddress({ ...base, options: { [MONGO_SRV_OPTION]: 'true' } })).toBe('cluster0.example.net');
    expect(serverAddress({ ...base, options: {} })).toBe('cluster0.example.net:27017');
  });
});
