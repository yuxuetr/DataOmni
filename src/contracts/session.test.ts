import { describe, expect, it } from 'vitest';
import { DatabaseType, type ConnectionProfile } from './connection';
import { createDatabaseSession } from './session';

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Local PostgreSQL',
  db_type: DatabaseType.PostgreSQL,
  host: 'localhost',
  port: 5432,
  database: 'postgres',
  username: 'postgres',
  password: '',
  ssl: false,
  options: {},
  tags: [],
  environment: 'development',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z'
};

describe('createDatabaseSession', () => {
  it('binds runtime state to the saved profile', () => {
    const session = createDatabaseSession(profile, 'session-1');

    expect(session.id).toBe('session-1');
    expect(session.profileId).toBe(profile.id);
    expect(session.database).toBe('postgres');
    expect(session.transaction.status).toBe('idle');
    expect(session.capabilities).toMatchObject({
      schemas: true,
      transactions: true,
      cancellation: false,
      explain: true,
      dataEditing: true
    });
  });
});
