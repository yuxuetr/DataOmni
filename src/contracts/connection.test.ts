import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DatabaseType,
  type ConnectionEnvironment,
  type ConnectionProfile
} from './connection';

describe('ConnectionProfile contract', () => {
  it('matches the snake_case IPC payload', () => {
    const profile: ConnectionProfile = {
      id: 'profile-1',
      name: 'Local PostgreSQL',
      db_type: DatabaseType.PostgreSQL,
      host: 'localhost',
      port: 5432,
      database: 'postgres',
      username: 'postgres',
      password: 'secret',
      ssl: true,
      options: {},
      tags: ['local'],
      environment: 'development',
      credential_ref: 'keychain://profile-1',
      created_at: '2026-09-17T00:00:00.000Z',
      updated_at: '2026-09-17T00:00:00.000Z'
    };

    expect(JSON.parse(JSON.stringify(profile))).toEqual(profile);
    expect(Object.keys(profile)).toEqual([
      'id',
      'name',
      'db_type',
      'host',
      'port',
      'database',
      'username',
      'password',
      'ssl',
      'options',
      'tags',
      'environment',
      'credential_ref',
      'created_at',
      'updated_at'
    ]);
    expectTypeOf(profile.environment).toEqualTypeOf<ConnectionEnvironment>();
  });
});
