import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDefaultConfig, DatabaseType } from '../stores/connectionStore';
import {
  SERVER_PRESETS,
  serverLabel,
  serverPresetConfig,
  serverPresetOf,
  type ServerPreset
} from './serverPresets';

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

/**
 * 表单上的「有缺口」标记和 README 兼容性矩阵说的是同一件事，两边各改各的，
 * 界面就会把一个有缺口的服务端画得和完全支持的一样（或者反过来）。
 */
describe('gap markers', () => {
  const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');

  function matrixVerdict(serverName: string): string {
    const row = readme.split('\n').find((line) => line.startsWith(`| ${serverName} |`));
    if (!row) {
      throw new Error(`README 兼容性矩阵里没有 ${serverName} 这一行`);
    }
    return row.split('|')[4].trim();
  }

  it.each(Object.keys(SERVER_PRESETS) as ServerPreset[])(
    '%s is marked with gaps exactly when the README matrix says so',
    (preset) => {
      const spec = SERVER_PRESETS[preset];
      const readmeSaysGaps = matrixVerdict(spec.name).startsWith('⚠️');
      expect(spec.gapsKey !== null).toBe(readmeSaysGaps);
    }
  );
});
