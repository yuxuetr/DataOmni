import { describe, expect, it } from 'vitest';
import { DatabaseType } from '../contracts';
import { backupName } from './databaseBackup';

const NOW = new Date(2026, 8, 28, 0, 5, 9);

describe('backupName', () => {
  it('SQLite 保留原扩展名，时间戳用本地时间', () => {
    expect(backupName('/data/shop.sqlite', DatabaseType.SQLite, NOW)).toBe('shop-backup-20260928-000509.sqlite');
    expect(backupName('C:\\data\\app.db', DatabaseType.SQLite, NOW)).toBe('app-backup-20260928-000509.db');
    expect(backupName('/data/noext', DatabaseType.SQLite, NOW)).toBe('noext-backup-20260928-000509.db');
  });

  it('DuckDB 的备份是目录，不带扩展名', () => {
    expect(backupName('/data/warehouse.duckdb', DatabaseType.DuckDB, NOW)).toBe('warehouse-backup-20260928-000509');
  });
});
