export type WorkspaceTabKind = 'sql' | 'table-data' | 'table-structure';

export interface WorkspaceTabBinding {
  readonly profileId: string;
  readonly sessionId: string | null;
}

interface WorkspaceTabBase {
  id: string;
  kind: WorkspaceTabKind;
  title: string;
  binding: WorkspaceTabBinding;
  dirty: boolean;
  createdAt: string;
  lastActivatedAt: string;
}

export interface SqlWorkspaceTab extends WorkspaceTabBase {
  kind: 'sql';
  draft: {
    sql: string;
  };
}

export interface TableWorkspaceTab extends WorkspaceTabBase {
  kind: 'table-data' | 'table-structure';
  object: {
    schema: string | null;
    table: string;
  };
}

export type WorkspaceTab = SqlWorkspaceTab | TableWorkspaceTab;

interface WorkspaceTabOptions {
  id?: string;
  sessionId?: string | null;
  now?: string;
}

interface CreateSqlWorkspaceTabOptions extends WorkspaceTabOptions {
  title?: string;
  sql?: string;
}

interface CreateTableWorkspaceTabOptions extends WorkspaceTabOptions {
  kind?: TableWorkspaceTab['kind'];
  schema?: string | null;
  title?: string;
}

function createTabBase(
  kind: WorkspaceTabKind,
  profileId: string,
  title: string,
  options: WorkspaceTabOptions
): WorkspaceTabBase {
  const now = options.now ?? new Date().toISOString();

  return {
    id: options.id ?? crypto.randomUUID(),
    kind,
    title,
    binding: {
      profileId,
      sessionId: options.sessionId ?? null
    },
    dirty: false,
    createdAt: now,
    lastActivatedAt: now
  };
}

export function createSqlWorkspaceTab(
  profileId: string,
  options: CreateSqlWorkspaceTabOptions = {}
): SqlWorkspaceTab {
  const sql = options.sql ?? '';

  return {
    ...createTabBase('sql', profileId, options.title ?? '新建查询', options),
    kind: 'sql',
    dirty: sql.length > 0,
    draft: { sql }
  };
}

export function createTableWorkspaceTab(
  profileId: string,
  table: string,
  options: CreateTableWorkspaceTabOptions = {}
): TableWorkspaceTab {
  const kind = options.kind ?? 'table-data';

  return {
    ...createTabBase(kind, profileId, options.title ?? table, options),
    kind,
    object: {
      schema: options.schema ?? null,
      table
    }
  };
}

export function updateSqlWorkspaceTabDraft(
  tab: SqlWorkspaceTab,
  sql: string
): SqlWorkspaceTab {
  return {
    ...tab,
    dirty: sql !== tab.draft.sql || tab.dirty,
    draft: { sql }
  };
}
