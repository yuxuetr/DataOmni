import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DatabaseType } from './connection';
import {
  PENDING_FEATURES,
  SQLX_DRIVER_FEATURES,
  STANDALONE_DRIVER_CRATES,
  supportsFeature,
  SUPPORTED_DATABASE_TYPES,
  isDatabaseTypeSupported,
  speaksSql
} from './databaseSupport';

/**
 * 「哪些数据库能用」有两份记录：后端 Cargo.toml 里 sqlx 编了哪些驱动，和前端
 * 这份 SUPPORTED_DATABASE_TYPES。两边各改各的，界面就会重新开始许兑现不了的
 * 承诺——而且是静默的，只有用户选中后才会发现连不上。
 */
const CARGO_TOML = readFileSync(
  fileURLToPath(new URL('../../src-tauri/Cargo.toml', import.meta.url)),
  'utf8'
);

function sqlxDriverFeatures(): Set<string> {
  const declaration = CARGO_TOML.split('\n').find((line) => line.startsWith('sqlx'));
  if (!declaration) {
    throw new Error('Cargo.toml 里找不到 sqlx 依赖声明');
  }

  const features = declaration.match(/features\s*=\s*\[([^\]]*)\]/);
  if (!features) {
    throw new Error('sqlx 依赖没有 features 列表');
  }

  const declared = features[1]
    .split(',')
    .map((feature) => feature.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);

  return new Set(declared.filter((feature) => feature in SQLX_DRIVER_FEATURES));
}

/** `[dependencies]` 里声明了哪些独立驱动 */
function standaloneDrivers(): DatabaseType[] {
  return Object.entries(STANDALONE_DRIVER_CRATES)
    .filter(([crate]) => CARGO_TOML.split('\n').some((line) => line.startsWith(`${crate} =`)))
    .map(([, type]) => type);
}

describe('数据库类型支持范围', () => {
  it('与后端实际编进去的驱动完全一致', () => {
    const fromBackend = [
      ...[...sqlxDriverFeatures()].map((feature) => SQLX_DRIVER_FEATURES[feature]),
      ...standaloneDrivers()
    ].sort();

    expect([...SUPPORTED_DATABASE_TYPES].sort()).toEqual(fromBackend);
  });

  it('三种关系型数据库可用', () => {
    expect(isDatabaseTypeSupported(DatabaseType.SQLite)).toBe(true);
    expect(isDatabaseTypeSupported(DatabaseType.MySQL)).toBe(true);
    expect(isDatabaseTypeSupported(DatabaseType.PostgreSQL)).toBe(true);
  });

  it('没有驱动的类型一律不可用', () => {
    for (const type of [
      DatabaseType.Redis,
      DatabaseType.Neo4j,
      DatabaseType.DuckDB,
      DatabaseType.ClickHouse,
      DatabaseType.Elasticsearch
    ]) {
      expect(isDatabaseTypeSupported(type)).toBe(false);
    }
  });
});

describe('分阶段接入的类型', () => {
  const README = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');
  const MATRIX_NAMES: Partial<Record<DatabaseType, string>> = {
    [DatabaseType.SqlServer]: 'SQL Server',
    [DatabaseType.Oracle]: 'Oracle'
  };

  it('README 兼容性矩阵把它们标成「有缺口」，全都做完之后就不再是', () => {
    for (const [type, name] of Object.entries(MATRIX_NAMES)) {
      const row = README.split('\n').find((line) => line.startsWith(`| ${name} |`));
      expect(row, `README 兼容性矩阵里没有 ${name}`).toBeDefined();
      const verdict = row?.split('|')[4]?.trim() ?? '';
      const pending = PENDING_FEATURES[type as DatabaseType]?.length ?? 0;
      expect(verdict.startsWith('⚠️'), `${name}: 还缺 ${pending} 项，矩阵写的是「${verdict}」`)
        .toBe(pending > 0);
    }
  });

  it('只有列在清单里的功能才被挡住', () => {
    for (const [type, features] of Object.entries(PENDING_FEATURES)) {
      for (const feature of features ?? []) {
        expect(supportsFeature(type, feature)).toBe(false);
      }
    }
    for (const type of [
      DatabaseType.MySQL,
      DatabaseType.PostgreSQL,
      DatabaseType.SQLite,
      DatabaseType.SqlServer
    ]) {
      expect(supportsFeature(type, 'explain')).toBe(true);
      expect(supportsFeature(type, 'dataEditing')).toBe(true);
    }
  });
});

describe('走不走 SQL', () => {
  it('MongoDB 能连，但不走 SQL；其余能连的都走', () => {
    for (const type of SUPPORTED_DATABASE_TYPES) {
      expect(speaksSql(type), type).toBe(type !== DatabaseType.MongoDB);
    }
    // 连不上的类型谈不上走不走
    expect(speaksSql(DatabaseType.Redis)).toBe(false);
  });
});
