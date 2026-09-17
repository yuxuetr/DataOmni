import { ConnectionProfile, DatabaseType } from '../stores/connectionStore';

export interface SessionCapabilities {
  schemas: boolean;
  transactions: boolean;
  cancellation: boolean;
  explain: boolean;
  dataEditing: boolean;
}

export interface TransactionContext {
  status: 'idle' | 'active' | 'failed';
  startedAt: string | null;
}

export interface DatabaseSession {
  id: string;
  profileId: string;
  database: string | null;
  connectedAt: string;
  capabilities: SessionCapabilities;
  transaction: TransactionContext;
}

export function createDatabaseSession(
  profile: ConnectionProfile,
  id: string = crypto.randomUUID()
): DatabaseSession {
  const isSupportedRelationalDatabase = [
    DatabaseType.MySQL,
    DatabaseType.PostgreSQL,
    DatabaseType.SQLite
  ].includes(profile.db_type);

  return {
    id,
    profileId: profile.id,
    database: profile.database ?? null,
    connectedAt: new Date().toISOString(),
    capabilities: {
      schemas: profile.db_type === DatabaseType.MySQL || profile.db_type === DatabaseType.PostgreSQL,
      transactions: isSupportedRelationalDatabase,
      cancellation: false,
      explain: isSupportedRelationalDatabase,
      dataEditing: isSupportedRelationalDatabase
    },
    transaction: {
      status: 'idle',
      startedAt: null
    }
  };
}
