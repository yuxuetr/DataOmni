import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DatabaseType } from './connection';
import {
  SQLX_DRIVER_FEATURES,
  SUPPORTED_DATABASE_TYPES,
  isDatabaseTypeSupported
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

describe('数据库类型支持范围', () => {
  it('与后端实际编进去的 sqlx 驱动完全一致', () => {
    const fromBackend = [...sqlxDriverFeatures()]
      .map((feature) => SQLX_DRIVER_FEATURES[feature])
      .sort();

    expect([...SUPPORTED_DATABASE_TYPES].sort()).toEqual(fromBackend);
  });

  it('三种关系型数据库可用', () => {
    expect(isDatabaseTypeSupported(DatabaseType.SQLite)).toBe(true);
    expect(isDatabaseTypeSupported(DatabaseType.MySQL)).toBe(true);
    expect(isDatabaseTypeSupported(DatabaseType.PostgreSQL)).toBe(true);
  });

  it('没有驱动的类型一律不可用', () => {
    for (const type of [
      DatabaseType.MongoDB,
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
