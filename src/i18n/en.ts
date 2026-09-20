import type { Translations } from './zh';

/**
 * 声明成 `Translations`：漏掉一个键或多写一个键都过不了 typecheck。
 * 这是「加了中文文案忘了补英文」这个唯一会静默出错的方向上的门。
 */
export const en: Translations = {
  'app.appearance': 'Appearance',
  'app.language': 'Language',
  'app.theme.light': 'Light',
  'app.theme.dark': 'Dark',
  'app.theme.system': 'System',
  'app.language.zh': '中文',
  'app.language.en': 'English',
  'app.language.system': 'System',

  'connection.select': 'Select a connection',
  'connection.none': 'No connections yet',
  'connection.new': 'New connection',
  'connection.edit': 'Edit connection',
  'connection.delete': 'Delete connection',
  'connection.connecting': 'Connecting…',
  'connection.connected': '● Connected',
  'connection.notConnected': 'Not connected',
  'connection.deleteConfirm': 'Delete the connection "{name}"?',
  'connection.deleteConfirmTitle': 'Confirm deletion',
  'connection.loadListFailed': 'Failed to load the connection list',
  'connection.deleteFailed': 'Failed to delete the connection',
  'connection.dismissError': 'Dismiss',

  'environment.production': 'PROD',
  'environment.staging': 'STAGING',

  'explorer.title': 'Database',
  'explorer.connected': 'Connected',
  'explorer.connecting': 'Connecting…',
  'explorer.cached': 'Cached',
  'explorer.refresh': 'Refresh',
  'explorer.loading': 'Loading…',
  'explorer.loadFailed': 'Could not read database objects.',
  'explorer.retry': 'Retry',
  'explorer.empty': 'No database objects',
  'explorer.connectionMissing': 'Connection not found',
  'explorer.noDatabaseName': 'This connection has no database name, so objects cannot be listed. Set one in the connection settings.',

  'objectKind.table': 'Tables',
  'objectKind.view': 'Views',
  'objectKind.materialized-view': 'Materialized Views',
  'objectKind.function': 'Functions',
  'objectKind.procedure': 'Procedures',
  'objectKind.sequence': 'Sequences',

  'objectDefinition.loading': 'Reading definition…',
  'objectDefinition.empty': 'The database returned no definition.',
  'objectDefinition.readFailed': 'Failed to read the object definition',
  'objectDefinition.noSequences': 'This database type has no sequence objects',
  'objectDefinition.close': 'Close',

  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.copyFailed': 'Failed to copy to the clipboard',
  'common.cancel': 'Cancel',
  'common.confirm': 'OK',
  'common.done': 'Done',

  'welcome.title': 'Connect to a database',
  'welcome.recent': 'Recent connections',
  'welcome.newConnection': 'New connection',
  'welcome.openSqlite': 'Open a SQLite file',
  'welcome.noConnections': 'No saved connections yet',

  'tab.close': 'Close {title}',
  'tab.connectionDeleted': '{title} (connection deleted, draft only)',
  'tab.connectionInactive': '{title} (bound connection is not active)',
  'tab.newQuery': 'New query',
  'tab.queryTitle': 'Query · {connection}',
  'tab.queryNumbered': 'Query {index} · {connection}',
  'tab.duplicate': '{title} copy',
  'tab.resizeSidebar': 'Resize the sidebar',
  'session.networkLost': 'The device lost its network connection',

  'palette.group.currentConnection': 'Current connection',
  'palette.action.themeLight': 'Appearance: Light',
  'palette.action.themeDark': 'Appearance: Dark',
  'palette.action.themeSystem': 'Appearance: System',
  'palette.action.languageZh': 'Language: 中文',
  'palette.action.languageEn': 'Language: English',
  'palette.action.languageSystem': 'Language: System',
  'palette.label': 'Command palette',
  'palette.search': 'Search tables, connections or commands',
  'palette.noResults': 'No matches',

  'welcome.hint': 'Pick a connection, or create one.',
  'welcome.openSqliteEllipsis': 'Open a SQLite file…',

  'environment.production.description': 'Production connection — changes affect live data',
  'environment.staging.description': 'Staging connection — changes may affect release validation',

  'palette.placeholder': 'Search connections, tables or commands…',
  'palette.empty': 'No matches',
  'palette.group.connection': 'Connections',
  'palette.group.action': 'Actions',
  'palette.action.newSql': 'New query tab',
  'palette.action.newConnection': 'New connection',
  'palette.action.openSqlite': 'Open a SQLite file',
  'palette.action.reopenTab': 'Reopen the last closed tab',
  'palette.action.toggleTheme': 'Toggle appearance',
  'palette.action.toggleLanguage': 'Toggle language'
};
