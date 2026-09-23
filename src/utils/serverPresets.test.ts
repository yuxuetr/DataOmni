import { describe, expect, it } from 'vitest';
import { createDefaultConfig, DatabaseType } from '../stores/connectionStore';
import { serverLabel, serverPresetConfig, serverPresetOf } from './serverPresets';

describe('serverPresetConfig', () => {
  it('keeps the wire protocol and fills in the server’s own port', () => {
    expect(serverPresetConfig('tidb')).toMatchObject({ db_type: DatabaseType.MySQL, port: 4000 });
    expect(serverPresetConfig('mariadb')).toMatchObject({ db_type: DatabaseType.MySQL, port: 3306 });
    expect(serverPresetConfig('cockroachdb')).toMatchObject({
      db_type: DatabaseType.PostgreSQL,
      port: 26257
    });
  });

  it('prefers TLS instead of requiring it, so a local server without certificates connects', () => {
    for (const preset of ['mariadb', 'tidb', 'cockroachdb'] as const) {
      expect(serverPresetConfig(preset)).toMatchObject({ tls_mode: 'preferred', ssl: true });
    }
  });
});

describe('serverPresetOf', () => {
  it('reads back the preset a connection was created with', () => {
    expect(serverPresetOf(serverPresetConfig('tidb'))).toBe('tidb');
    expect(serverPresetOf(serverPresetConfig('cockroachdb'))).toBe('cockroachdb');
  });

  it('is empty for a plain MySQL connection, which is what switching back to MySQL produces', () => {
    expect(serverPresetOf(createDefaultConfig(DatabaseType.MySQL))).toBeNull();
  });

  it('ignores a record that contradicts the connection type', () => {
    expect(serverPresetOf({ db_type: DatabaseType.PostgreSQL, options: { server: 'tidb' } })).toBeNull();
    expect(serverPresetOf({ db_type: DatabaseType.MySQL, options: { server: 'oracle' } })).toBeNull();
  });
});

describe('serverLabel', () => {
  it('names the server for a preset connection and the protocol otherwise', () => {
    expect(serverLabel(serverPresetConfig('tidb'))).toBe('TiDB');
    expect(serverLabel(createDefaultConfig(DatabaseType.PostgreSQL))).toBe('postgresql');
  });
});
