/**
 * 中文是源语言：这个文件里的键就是全部合法的键。
 *
 * 其它语言文件声明成 `Translations`，少一个键或多一个键都是**编译错误**，
 * 不是运行期才发现的空白文案。加一条文案时先加在这里，`bun run typecheck`
 * 会立刻指出哪些语言还没跟上。
 *
 * `{name}` 形式的占位符由 `translate` 替换。占位符在各语言之间必须一致，
 * 由 `catalog.test.ts` 守住——漏掉一个 `{count}`，界面上那个数字就凭空消失了。
 */
export const zh = {
  // 应用外壳
  'app.appearance': '外观',
  'app.language': '语言',
  'app.theme.light': '浅色',
  'app.theme.dark': '深色',
  'app.theme.system': '跟随系统',
  'app.language.zh': '中文',
  'app.language.en': 'English',
  'app.language.system': '跟随系统',

  // 连接
  'connection.select': '选择数据库连接',
  'connection.none': '暂无连接',
  'connection.new': '新建连接',
  'connection.edit': '编辑连接',
  'connection.delete': '删除连接',
  'connection.connecting': '连接中…',
  'connection.connected': '● 已连接',
  'connection.notConnected': '尚未连接',
  'connection.deleteConfirm': '确定要删除连接 "{name}" 吗？',
  'connection.deleteConfirmTitle': '确认删除',
  'connection.loadListFailed': '加载连接列表失败',
  'connection.deleteFailed': '删除连接失败',
  'connection.dismissError': '关闭错误提示',

  // 环境标识
  'environment.production': '生产',
  'environment.staging': '预发',

  // 对象浏览器
  'explorer.title': '数据库浏览器',
  'explorer.connected': '已连接',
  'explorer.connecting': '连接中...',
  'explorer.cached': '已缓存',
  'explorer.refresh': '刷新',
  'explorer.loading': '加载中...',
  'explorer.loadFailed': '未能读取数据库对象。',
  'explorer.retry': '重试',
  'explorer.empty': '暂无数据库对象',
  'explorer.connectionMissing': '连接不存在',
  'explorer.noDatabaseName': '该连接没有指定数据库名，无法列出对象。请在连接配置中填写数据库。',

  // 对象类型
  'objectKind.table': '表',
  'objectKind.view': '视图',
  'objectKind.materialized-view': '物化视图',
  'objectKind.function': '函数',
  'objectKind.procedure': '存储过程',
  'objectKind.sequence': '序列',

  // 对象定义弹窗
  'objectDefinition.loading': '正在读取定义…',
  'objectDefinition.empty': '数据库没有返回定义。',
  'objectDefinition.readFailed': '读取对象定义失败',
  'objectDefinition.noSequences': '当前数据库类型没有序列对象',
  'objectDefinition.close': '关闭',

  // 通用
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.copyFailed': '复制到剪贴板失败',
  'common.cancel': '取消',
  'common.confirm': '确定',
  'common.done': '完成',

  // 欢迎页
  'welcome.title': '连接到数据库',
  'welcome.recent': '最近连接',
  'welcome.newConnection': '新建连接',
  'welcome.openSqlite': '打开 SQLite 文件',
  'welcome.noConnections': '还没有保存的连接',

  'tab.close': '关闭 {title}',
  'tab.connectionDeleted': '{title}（连接已删除，仅可查看草稿）',
  'tab.connectionInactive': '{title}（绑定的连接未激活）',
  'tab.newQuery': '新建查询',
  'tab.queryTitle': '查询 · {connection}',
  'tab.queryNumbered': '查询 {index} · {connection}',
  'tab.duplicate': '{title} 副本',
  'tab.resizeSidebar': '调整侧边栏宽度',
  'session.networkLost': '设备网络连接已断开',

  'palette.group.currentConnection': '当前连接',
  'palette.action.themeLight': '外观：浅色',
  'palette.action.themeDark': '外观：深色',
  'palette.action.themeSystem': '外观：跟随系统',
  'palette.action.languageZh': '语言：中文',
  'palette.action.languageEn': '语言：English',
  'palette.action.languageSystem': '语言：跟随系统',
  'palette.label': '命令面板',
  'palette.search': '搜索表、连接或命令',
  'palette.noResults': '没有匹配的结果',

  'welcome.hint': '选择一个连接，或新建一个。',
  'welcome.openSqliteEllipsis': '打开 SQLite 文件…',

  'environment.production.description': '生产环境连接，改动会影响线上数据',
  'environment.staging.description': '预发环境连接，改动可能影响发布验证',

  // 命令面板
  'palette.placeholder': '搜索连接、表或命令…',
  'palette.empty': '没有匹配项',
  'palette.group.connection': '连接',
  'palette.group.action': '操作',
  'palette.action.newSql': '新建查询标签',
  'palette.action.newConnection': '新建连接',
  'palette.action.openSqlite': '打开 SQLite 文件',
  'palette.action.reopenTab': '重新打开最近关闭的标签',
  'palette.action.toggleTheme': '切换外观',
  'palette.action.toggleLanguage': '切换语言'
} as const;

export type TranslationKey = keyof typeof zh;
export type Translations = Record<TranslationKey, string>;
