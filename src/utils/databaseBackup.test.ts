import { describe, expect, it } from 'vitest';
import { DatabaseType } from '../contracts';
import { backupName, backupSupported } from './databaseBackup';

const NOW = new Date(2026, 8, 28, 0, 5, 9);

describe('backupName', () => {
  it('SQLite 保留原扩展名，时间戳用本地时间', () => {
    expect(backupName('/data/shop.sqlite', DatabaseType.SQLite, NOW)).toBe('shop-backup-20260928-000509.sqlite');
    expect(backupName('C:\\data\\app.db', DatabaseType.SQLite, NOW)).toBe('app-backup-20260928-000509.db');
    expect(backupName('/data/noext', DatabaseType.SQLite, NOW)).toBe('noext-backup-20260928-000509.db');
  });

  it('网络库用库名，库名里带点也不当扩展名：PostgreSQL 是 .dump，MySQL 是 .sql', () => {
    expect(backupName('shop', DatabaseType.PostgreSQL, NOW)).toBe('shop-backup-20260928-000509.dump');
    expect(backupName('shop.v2', DatabaseType.PostgreSQL, NOW)).toBe('shop.v2-backup-20260928-000509.dump');
    expect(backupName('shop.v2', DatabaseType.MySQL, NOW)).toBe('shop.v2-backup-20260928-000509.sql');
  });

  it('CockroachDB、TiDB 走兼容的连接类型，但不给备份入口；MySQL 没填库名也不给', () => {
    expect(backupSupported({ db_type: DatabaseType.PostgreSQL, options: {} })).toBe(true);
    expect(backupSupported({ db_type: DatabaseType.PostgreSQL, options: { server: 'cockroachdb' } })).toBe(false);
    expect(backupSupported({ db_type: DatabaseType.MySQL, options: {}, database: 'shop' })).toBe(true);
    expect(backupSupported({ db_type: DatabaseType.MySQL, options: { server: 'mariadb' }, database: 'shop' })).toBe(true);
    expect(backupSupported({ db_type: DatabaseType.MySQL, options: { server: 'tidb' }, database: 'test' })).toBe(false);
    expect(backupSupported({ db_type: DatabaseType.MySQL, options: {}, database: ' ' })).toBe(false);
    expect(backupSupported({ db_type: DatabaseType.MongoDB, options: {}, database: 'shop' })).toBe(false);
    expect(backupSupported({ db_type: DatabaseType.SQLite, options: {} })).toBe(true);
  });

  it('DuckDB 的备份是目录，不带扩展名', () => {
    expect(backupName('/data/warehouse.duckdb', DatabaseType.DuckDB, NOW)).toBe('warehouse-backup-20260928-000509');
  });
});
