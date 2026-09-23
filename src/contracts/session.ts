import { DatabaseType, type ConnectionProfile } from './connection';
import { supportsFeature } from './databaseSupport';

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
    DatabaseType.SQLite,
    DatabaseType.SqlServer
  ].includes(profile.db_type);
  const has = (feature: Parameters<typeof supportsFeature>[1]) =>
    isSupportedRelationalDatabase && supportsFeature(profile.db_type, feature);

  return {
    id,
    profileId: profile.id,
    database: profile.database ?? null,
    connectedAt: new Date().toISOString(),
    capabilities: {
      schemas: profile.db_type === DatabaseType.MySQL
        || profile.db_type === DatabaseType.PostgreSQL
        || profile.db_type === DatabaseType.SqlServer,
      transactions: has('transactions'),
      cancellation: false,
      explain: has('explain'),
      dataEditing: has('dataEditing')
    },
    transaction: {
      status: 'idle',
      startedAt: null
    }
  };
}
