export type WorkspaceTabKind = 'sql' | 'table-data' | 'table-structure';

export interface WorkspaceTabBinding {
  readonly profileId: string;
  readonly sessionId: string | null;
}

export type WorkspaceTabAvailability = 'available' | 'profile-deleted';

interface WorkspaceTabBase {
  id: string;
  kind: WorkspaceTabKind;
  title: string;
  /**
   * 标题的文案键。有它时按当前语言翻译，`title` 只作为回落。
   *
   * 表名、视图名这类标题是数据库里的真实标识符，不该翻译，所以是可选的——
   * 只有「新建查询」这种我们自己生成的标题才带键。切换语言时已经打开的
   * 标签必须跟着变，否则界面一半中文一半英文。
   */
  titleKey?: string;
  titleParams?: Record<string, string | number>;
  binding: WorkspaceTabBinding;
  availability: WorkspaceTabAvailability;
  /** 固定的标签排在标签栏前面，不随新开标签往右漂 */
  pinned: boolean;
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

/** 关闭时要求保留的标签，连同它当时的草稿一起留待重新打开 */
export interface ClosedWorkspaceTab {
  tab: WorkspaceTab;
  /** SQL 标签的草稿正文；其它类型为空串 */
  draft: string;
  closedAt: string;
}

/**
 * 标签的身份：同一个连接下的同一个对象只应存在一个标签。
 *
 * 把身份编码进 id，`registerTab` 既有的按 id 去重就同时成了「再次打开已存在的
 * 标签时激活它而不是新开一个」，不需要另一套去重逻辑。
 */
export function workspaceTabId(
  profileId: string,
  kind: WorkspaceTabKind,
  object?: { schema: string | null; table: string }
): string {
  if (!object) {
    return `${profileId}:${kind}`;
  }

  return `${profileId}:${kind}:${object.schema ?? ''}:${object.table}`;
}

interface WorkspaceTabOptions {
  id?: string;
  sessionId?: string | null;
  now?: string;
}

interface CreateSqlWorkspaceTabOptions extends WorkspaceTabOptions {
  title?: string;
  titleKey?: string;
  titleParams?: Record<string, string | number>;
  sql?: string;
}

interface CreateTableWorkspaceTabOptions extends WorkspaceTabOptions {
  kind?: TableWorkspaceTab['kind'];
  schema?: string | null;
  title?: string;
  titleKey?: string;
  titleParams?: Record<string, string | number>;
}

function createTabBase(
  kind: WorkspaceTabKind,
  profileId: string,
  title: string,
  options: WorkspaceTabOptions & { titleKey?: string; titleParams?: Record<string, string | number> }
): WorkspaceTabBase {
  const now = options.now ?? new Date().toISOString();

  return {
    id: options.id ?? crypto.randomUUID(),
    kind,
    title,
    titleKey: options.titleKey,
    titleParams: options.titleParams,
    binding: {
      profileId,
      sessionId: options.sessionId ?? null
    },
    availability: 'available',
    pinned: false,
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
    // 没给标题时带上文案键，让「新建查询」也跟着语言走
    ...createTabBase('sql', profileId, options.title ?? '新建查询', {
      ...options,
      titleKey: options.titleKey ?? (options.title ? undefined : 'tab.newQuery')
    }),
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

/**
 * 固定优先的展示顺序。
 *
 * 只影响呈现，不改变 `tabs` 本身的顺序：存储里保持插入顺序，固定与否是
 * 标签自己的属性，两者各管各的。
 */
export function orderWorkspaceTabs(tabs: WorkspaceTab[]): WorkspaceTab[] {
  return [
    ...tabs.filter((tab) => tab.pinned),
    ...tabs.filter((tab) => !tab.pinned)
  ];
}

export function markWorkspaceTabProfileDeleted(
  tab: WorkspaceTab
): WorkspaceTab {
  return {
    ...tab,
    availability: 'profile-deleted',
    binding: {
      profileId: tab.binding.profileId,
      sessionId: null
    }
  };
}
