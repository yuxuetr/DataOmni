# DataOmni 开发路线与完成度追踪

> 目标：先把 MySQL、PostgreSQL、SQLite 做成可信、可控、可恢复的桌面数据库客户端，再扩展数据库管理、外围能力和最终 UI。
>
> 原则：按阶段顺序推进。除缺陷修复外，前一阶段未达到退出标准时，不启动后一阶段的大型功能。

## 使用规则

- `[ ]` 未开始
- `[-]` 进行中
- `[x]` 已完成并通过验收
- `[!]` 阻塞，需要在条目下说明原因
- 完成任务时，在条目末尾补充 PR、提交或验证命令，例如：`完成于 #123，验证：bun run build`
- 只有代码合入且满足条目中的验收标准后才能标记为 `[x]`
- 新需求先归入对应阶段，不直接插入当前阶段打乱主线

## 总体进度

| 阶段 | 目标 | 状态 |
|---|---|---|
| P0 | 建立质量基线并修复高风险缺陷 | [x] |
| P1 | 建立可信的连接、会话与查询内核 | [x] |
| P2 | 完成日常数据库工作闭环 | [x] |
| P3 | 补齐数据库管理与数据工程能力 | [x] |
| P4 | 扩展数据库与外围能力 | [ ] |
| P5 | 完成统一桌面 UI 与交互设计 | [ ] |

---

## P0：质量基线与高风险止损

### 0.1 建立可验证的工程基线

- [x] 为前端增加并固定 `lint`、`typecheck`、`test` 命令
- [x] 为 Rust 增加并固定 `fmt`、`clippy`、`test` 命令
- [x] 建立 CI，至少覆盖前端构建、类型检查和 Rust 检查
- [x] 为连接串生成、SQL 分句、查询分类和行变更增加单元测试
- [x] 建立 MySQL、PostgreSQL、SQLite 的最小集成测试数据库
- [x] 提供一套示例 schema，便于观察 ER 关系图
  - `examples/sample-schema.sql`（MySQL）与 `examples/sample-schema.postgres.sql`
    （PostgreSQL），建库 `dataomni_demo`，11 张表。刻意覆盖了在图上长得不一样的
    几种情况：一条链（customers → orders → order_items）、一个分叉、
    自引用（categories.parent_id）、复合外键（inventory），以及三张一条外键
    都没有的孤立表——正是用来确认「没有关联的表也画出来」。
- [x] 记录三平台构建状态，避免在未验证前宣称完整跨平台支持
  - README 新增「构建与验证状态」表：macOS aarch64 已验证（2026-09-20 `bun tauri build` 退出码 0，产出 .app 与 .dmg）；macOS x86_64 未验证；Linux 仅 CI 编译检查、从未执行 `tauri build`；Windows 完全未验证。
  - 同时对齐 README 能力声明：MongoDB / Redis / Neo4j / DuckDB / ClickHouse / Elasticsearch 只有连接表单、不能执行查询；导出、服务端排序筛选、变更集、危险语句确认、应用级主题均未实现；表名列名补全是硬编码示例值；无 Releases 可下载。
    （其中导出、应用级主题、补全接入真实元数据此后已完成，README 已同步。）

**退出标准**

- 每个 PR 都能自动验证前端与 Rust 基线
- 三种核心数据库至少有连接、查询、分页、增删改的自动化测试
- README 中的能力声明与当前实现一致

### 0.2 修复立即影响数据安全与用户信任的问题

- [x] 修复查询耗时统计，覆盖实际数据库等待时间
- [x] SQLite 测试连接不再校验无意义的端口
- [x] MySQL TLS 设置必须与最终连接参数一致，禁止勾选 TLS 后静默使用 `DISABLED`
- [x] 删除“后端失败后返回 mock 连接串”的成功形降级
- [x] 未连接时不把正常状态显示成错误或谎话
  - 两处（`4375548`）：`database!.select(...)` 在句柄为 null 时抛
    `Cannot read properties of null`，用户只看到「null 类型错误」；
    对象树在未连接时显示「暂无数据库对象」，那是在说**这个库是空的**，
    而真相是根本没连上——两件事的下一步完全不同。
  - 句柄为 null 是正常状态：ER 图这类标签会从工作区快照恢复，在任何连接
    建立之前就挂载。改用 `requireDatabase()` 给出可读文案，ER 图直接渲染
    「需要先连接数据库」。
- [x] 所有连接和执行错误必须进入可见 UI，不只写入控制台
  - 补一处长期失效（`a8462af`）：`error instanceof Error ? error.message : '兜底'`
    这个写法在 Tauri 下永远走 else —— Rust 返回 `Err(String)` 时 reject 的是
    普通字符串，不是 `Error` 实例。全部 17 处后端错误都被换成了占位文案，
    "进入可见 UI" 成立但内容是空的。统一收到 `describeError()`：
    字符串 / Error / 带 message 的对象 / 可序列化对象逐级取值。
  - 另有 9 处 `String(error)`，对字符串正确但对象会变成 `[object Object]`，
    一并并入同一个函数。
- [x] 未保存的连接草稿可以「测试连接」
  - `ConnectionProfile` 的 `id` / `created_at` / `updated_at` 缺 `#[serde(default)]`
    （`a8462af`）。这三个字段由后端在保存时生成，新建表单的草稿本来就没有，
    反序列化直接 `missing field \`id\``——表现为测试永远失败、保存后却能连上。
  - 反向验证：`models::tests::draft_connection_without_id_deserializes`
    去掉默认值就红，报的正是那句 `missing field \`id\``。
- [x] 连接选择、连接列表加载和删除失败时显示可关闭的错误提示
- [x] 更新、删除后检查影响行数；影响 0 行或多于预期时明确报错
- [x] 在可靠行定位完成前，复杂查询结果默认只读
- [x] 标识符统一由数据库方言安全引用，禁止直接拼接表名、Schema 和列名

**退出标准**

- 不会把连接失败、TLS 降级、更新失败或删除失败展示为成功
- 无法唯一定位记录时不能执行写操作
- 核心数据库的保留字、特殊字符表名和 Schema 名可安全使用

---

## P1：可信连接、会话与查询内核

### 1.1 定义核心领域模型

- [x] 定义 `ConnectionProfile`：保存配置、环境标签和凭据引用
- [x] 定义 `Session`：实际数据库连接、当前数据库、事务上下文和能力集合
- [x] 定义 `WorkspaceTab`：标签类型、连接绑定、草稿和未保存状态
- [x] 定义 `QueryExecution`：SQL 快照、状态、耗时、错误、取消和结果引用
- [x] 定义 `ResultSet`：列类型、数据批次、截断状态和可编辑性
- [x] 定义 `ChangeSet`：新增、修改、删除、原始行标识和提交状态
- [x] 将前后端共享字段集中为类型化契约，消除重复接口定义

### 1.2 统一连接身份和生命周期

- [x] 删除从连接串生成连接 ID 的逻辑，统一使用 `ConnectionProfile.id`
- [x] 移除 `SqlWorkbench`、`TableDataViewer` 中的自行重连逻辑
- [x] 建立唯一的 `SessionManager`，统一负责连接、复用、重连和关闭
- [x] 区分保存的连接配置 ID 与运行时 Session ID
- [x] 切换侧边栏连接不得改变已打开标签页的执行目标
- [x] 断开连接时显式调用驱动关闭并等待完成
- [x] 应用退出时关闭所有 Session 和未完成任务
- [x] 定义断线、认证过期、网络恢复和手动重连状态机
- [x] 连接握手加超时，不让 UI 无限停在「连接中」
  - `withTimeout` 给 `test_connection` 与 `switchConnection` 各加 15s 上界
    （`86dfe5b`）。端口通但握手不完成（TLS 不匹配、认证卡住）时原本会永远
    转圈，且没有任何提示。超时文案直接点出这几种可能。
  - 原始 rejection 优先于超时文案——先失败的是谁就报谁，不拿超时掩盖真错误。
- [x] 连接删除时处理关联标签页、草稿和元数据缓存

### 1.3 凭据和传输安全

- [x] 从 `connections.json` 移除明文密码
- [x] 使用 macOS Keychain、Windows Credential Manager、Linux Secret Service 保存凭据
- [x] 配置文件只保存凭据引用和非敏感字段
- [x] 定义明确的 TLS 模式：禁用、优先、要求、校验证书、校验主机名
- [x] 支持 CA、客户端证书和私钥配置
- [x] 日志统一脱敏，禁止打印密码、Token 和完整连接串
- [x] 支持“不保存密码”和每次连接时输入

### 1.4 重建查询执行模型

- [x] 使用可靠 SQL 解析器或方言感知分句器替代 `split(';')`
- [x] 正确处理字符串、注释、Dollar-quoted string 和过程体中的分号
- [x] 根据驱动返回结果判断结果集，而不是只识别 `SELECT`
- [x] 支持 `WITH`、`SHOW`、`DESCRIBE`、`EXPLAIN` 和 `RETURNING`
- [x] 编辑文档、执行请求和执行结果使用独立生命周期
- [x] 修改 SQL 时保留上一份结果，直到新执行成功或用户清除
- [x] 每次执行绑定 Session、标签页、SQL 快照、方言和执行 ID
- [x] 支持执行选中内容、光标所在语句和全部语句
- [x] 支持查询超时
- [x] 支持取消查询，并区分“取消请求中”和“已取消”
- [x] 明确串行和并行执行多语句的规则
- [x] 禁止通过多个池连接模拟同一个事务

### 1.5 结果集和大数据基础

- [x] 增加默认结果行数上限和用户可调整上限
- [x] 支持分批读取或流式传输结果
- [x] 定义前后端内存预算和超限行为
- [x] ResultSet 返回真实列类型、可空性和数据库类型信息
- [x] 明确显示结果是否被截断
- [x] 大结果集不再完整加载后仅靠前端 `slice()` 分页
  - 本条的目标由上面三条共同达成，未再替换 `slice()` 分页：结果在 Rust 侧即按 `row_limit` 截断（默认 1000，上限 100000，`query_executor.rs`），按 250 行批次流式回传，前端再加 16 MiB 预算，因此 `QueryResult.rows` 本身是有界窗口，`QueryResultScrollTable` 只是在这个有界数组上取当前页并只渲染当前页（`currentRows`，≤ pageSize 行）。
  - 改为按页重跑用户 SQL 会更差：任意语句没有稳定排序保证、会重复触发副作用、每翻一页重付查询代价。
  - 判据：`cargo test --manifest-path src-tauri/Cargo.toml --test database_smoke` 中的 `assert_truncated_result` 断言 `rows.len() == row_limit && truncated`；这条红了就说明上限失效，本条需重估。
  - 该判据已反向验证：把 `query_executor.rs` 的 `while row_count < row_limit` 改成 `row_limit + 10` 后测试确实变红（left: 3, right: 2），已还原。
  - **本地跑要指向专用库**：连接串里的库名必须是 `dataomni_test`（CI 用的就是
    这个），不能指向 MySQL 的 `mysql` 系统库——夹具表会被建进系统库，而且
    MySQL 拒绝在系统表上建触发器，症状是「单独跑某些测试好好的，加了触发器
    测试就报 1465」。
  - 覆盖范围：本地未设 `DATAOMNI_MYSQL_TEST_URL` / `DATAOMNI_POSTGRES_TEST_URL` 时，MySQL / PostgreSQL 冒烟测试会跳过，只有 SQLite 真正跑到这道门。CI 的 `database-smoke` job 起了 postgres:17 与 mysql:8.4 服务并注入两个连接串，同时设 `DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS=1`——缺连接串时 `network_database_url` 会 panic，不会静默跳过。
  - 重估条件：出现「单次执行返回行数可超过 `row_limit`」的路径，或前端需要展示超出内存预算的结果集。
- [x] 表数据分页增加稳定排序策略
- [x] 避免每次翻页都执行昂贵的完整 `COUNT(*)`
  - 行数按「连接 + schema + 表名」缓存；翻页与调整页大小复用缓存，切表、新增行、删除行、用户显式刷新才重新统计。完成于 1063589，验证：`bun run typecheck && bun run lint && bun run test`

**P1 退出标准**

- 不会因为组件挂载、视图切换或 ID 不一致而重复连接
- 查询可以正确计时、取消、超时，并保留独立执行结果
- 大结果不会无上限进入前端内存
- 凭据不以明文写入应用配置文件

---

## P2：基础功能与日常工作闭环

### 2.1 多标签工作区

- [x] 支持 SQL、表数据、表结构等标签类型
  - 标签栏落地于 5e7c65f，`WorkspaceTabBar` 按 `workspaceStore.tabs` 渲染；
    退休了 `appStore.viewMode` / `tableViewerState` 单视图模型。
  - 多个 SQL 标签完成于 0532e1e：`queryStore` 改为 `documents: Record<tabId, SqlDocument>`
    + `activeDocumentId`，异步操作在开始时捕获 documentId，保证执行期间切换标签时
    结果仍回到发起它的文档。`QueryExecution.tabId` 此前恒为 `workbench:${connectionId}`，
    现在填真正的文档 id。
  - 遗留：SQL 历史仍按 connectionId 存一份、只覆盖当前活动文档；一个连接下多个标签的
    草稿全量恢复归入下面的「恢复窗口、标签、布局、草稿和最后活动位置」。
- [x] 每个标签永久绑定 Session，不随侧边栏选择变化
  - 同时修掉一个已复现的缺陷：切换侧边栏连接后，已打开的表视图会拿旧表名查新库
    （`performConnectionSwitch` 不清 `tableViewerState`，`ensureDatabaseConnection`
    只检查 `database` 非空）。现在按 `queryStore.connectionId` 比对标签的
    `connection.id`，不匹配即停下并说明原因。
  - 限制：`SessionManager` 只维护一个活跃会话，所以绑定到其它连接的标签无法同时
    执行，界面明确标为「绑定的连接未激活」而不是静默改到当前连接上执行。
    并发多会话是独立的更大改动，出现「需要同时查询两个库」的真实需求时再重估。
- [x] 支持新建、关闭、固定、复制、重新打开标签
  - 新建 / 关闭完成于 0532e1e、5c88bd5；重新打开完成于 b363792（最近关闭列表上限 10，
    标签栏历史按钮 + ⌘⇧T）；固定 / 复制完成于 255f032（标签右键菜单）。
  - 复制只对 SQL 标签开放：表标签的 id 由 `workspaceTabId` 按对象确定性生成以实现去重，
    复制出来会被合并回原标签，没有意义。
- [x] 未保存标签关闭时提供保存、丢弃、取消
  - 丢弃 / 取消完成于 5c88bd5，保存补齐于 b363792。判据为
    `selectSqlDocumentHasUnsavedContent`（按 trim 后的草稿文本判空，刚新建的空标签不拦）。
    标签栏脏点由 `documents` 计算，`tab.dirty` 对 SQL 标签从未更新过。
  - 「保存」= 关闭标签但把草稿留进「最近关闭」，之后可重新打开。确认框是自建的
    `CloseTabPrompt`：`plugin-dialog` 的 `confirm` 只有两个按钮，装不下第三种结果。
  - 导出为 `.sql` 文件仍归 P2.3，与本条无关。
- [x] 恢复窗口、标签、布局、草稿和最后活动位置
  - 标签 / 草稿 / 最后活动标签完成于 fb498b9：新增 `workspacePersistence`，存一份带版本号的
    工作区快照（不含查询结果）。恢复在 `main.tsx` 首次渲染前执行，否则 App 的保存 effect
    会拿首帧的空 tabs 把快照覆盖成空。
  - 同时移除了原来的 `SqlHistory` 草稿缓存：它按 connectionId 只存一份、`getAllSqlHistories`
    与 `clearSqlHistory` 零调用方。执行历史是 P2.3 的独立模块，契约保留在 `contracts/query.ts`。
  - 窗口大小 / 位置：接入 `tauri-plugin-window-state`。**必须钉在 `=2.2.0`** —— 2.4.x 会把
    `tauri-runtime-wry` 顶到与当前 tauri 2.5.1 不兼容的版本，实测直接编译失败。
  - 「布局」当前无对应实现：侧边栏宽度是固定的 `w-80`，没有任何可调布局可存。出现可调整的
    分栏或面板后需回来补这一项。
- [x] 支持连接断开后的离线草稿查看
  - 完成于 4872fe9：`OfflineTabView` 只读展示草稿，区分「连接未激活」与「连接已删除」。
    未放「连接」按钮——连接需处理 `SESSION_PASSWORD_REQUIRED` 的密码提示，流程在 Sidebar，
    复刻不全更糟，且侧边栏常驻可见。
  - 同时修掉：删除连接会丢掉带草稿的 SQL 标签。`handleProfileDeleted` 只看 `tab.dirty`，
    而它仅在创建标签时设过一次。改为由 `stateSync` 传入 `tabIdsWithDrafts`。

### 2.2 SQL 编辑体验

- [x] 使用当前 Session 的真实元数据补全 Schema、表和列
  - 完成于 1e99f9b。此前补全给的是编造的清单（表名固定 users / orders / products /
    customers / categories，列名固定 id / name / email / created_at / updated_at /
    status），和当前连接的库毫无关系——选中一个就得到一个不存在的标识符。
  - 新增 `completion_catalog` 服务，一条查询取回整库的关系与列。与 `er_diagram`
    的列查询分开：ER 图只要表（视图没有外键），补全要表**和**视图（视图一样能 SELECT）。
  - 别名解析交给 `@codemirror/lang-sql` 自己的 schema 补全源——它按语法树判断位置，
    `FROM orders o` 之后 `o.` 能补出 orders 的列。我们负责的是把真的库结构喂给它。
  - 目录缓存在 appStore：一次只渲染活动标签，编辑器随切标签卸载，存在组件里
    等于每切一次标签就把整库的列重查一遍。失效条件是 `schemaVersion`，并与对象
    目录一起被 `clearDatabaseMetadata` 清掉。
  - 判据：`src/utils/sqlCompletionSchema.test.ts`（25 条，其中「弹出来的次序」一组
    起真的 EditorView 读 `currentCompletions`）与 `cargo test --test database_smoke`
    里的三条 `*_completion_catalog_lists_views_next_to_tables`。已反向验证：MySQL 加回
    `BASE TABLE` 过滤后精确红在视图断言，PostgreSQL 改按列名排序后红在列顺序断言。
- [x] 补全内容按数据库方言和对象类型过滤
  - 关键字改由 lang-sql 按方言给：`AUTO_INCREMENT` 只在 MySQL 出现，`RETURNING`
    只在 PostgreSQL 出现；原来那份硬编码清单三种库共用。层级也跟着方言走：
    PostgreSQL 保留 Schema 一层，MySQL 与 SQLite 不保留（连接时已经选定了库）。
  - 对象类型：表与视图都进补全并在说明里区分。函数与存储过程**没有**放进来——
    PostgreSQL 的函数可重载、目录里的名字带签名，要正确插入得先去掉参数表，
    而它们本就不在本条要求的「Schema、表和列」里。真需要时再补。
  - 两处是看了真实渲染才发现的：(1) CodeMirror 会按匹配得分重排，补出来的第一个
    是 customer_id 而不是 id，改为按表内位置递减加权（范围 ±99，而匹配质量档距
    至少 100，所以只在质量相同时起作用，两端都有测试钉住）；(2) 深色模式下补全
    弹窗的选中项看不见（oneDark 的 #2c313a 压在 #21252b 上），改用应用强调色，
    靠选择器特异性取胜——同优先级时 oneDark 的样式表在后面。
- [x] 增加格式化 SQL
  - 完成于 179484c。⌘⇧F 或头部图标按钮；有选区只排选区，没有就排整份。
  - 用 `sql-formatter` 不自己写：SQL 排版要为三种方言各做一遍词法分析
    （字符串、行/块注释、反引号、双引号、$$ 引用）再认子句结构、嵌套、CTE、
    CASE、窗口函数；做错的代价是改坏编辑器里的正文。代价是包大小
    858KB → 1155KB（gzip 267KB → 345KB），桌面应用从本地磁盘加载，
    主要成本是启动解析时间而不是下载。
  - 解析不了就什么都不做，只显示解析器给的行号列号；认不出的方言禁用按钮，
    不退回默认方言去撞解析器。
  - 改动走 `view.dispatch` 而不是 `setSqlInput`——受控地整份换文本会重置
    CodeMirror 的编辑历史，格式化就撤不回来了。
  - 排完光标回到原来那条语句的开头（CodeMirror 默认会把光标映射到改动末尾，
    等于每按一次视线就掉到文档最底下）。回不到语句内部原位置：排版重排了
    语句内的一切，那个位置在新文本里没有对应物。
  - 判据：`src/utils/formatSql.test.ts` 的「排版不改内容」一组——去掉所有空白、
    统一大小写后排版前后必须逐字相等。已反向验证：让排版顺手吃掉行注释后
    精确红在注释两例。
- [x] 增加查找、替换、跳转和注释快捷键
  - 查找 ⌘F、下一个 ⌘G、上一个 ⇧⌘G、跳转到行 ⌘⌥G、注释 ⌘/、块注释 ⌥A。
    这些绑定本来就在（basicSetup 的 `defaultKeymap` + `searchKeymap`，注释靠
    lang-sql 声明的 `commentTokens`），实测逐个确认过：⌘/ 会加 `-- ` 并能再按一次
    取消，⌘⌥G 会弹出跳转面板。
  - 真正缺的是那两个面板本身：文字是库里写死的英文，样式是浏览器默认的灰色
    立体按钮（深色下是 oneDark 的另一套）。整个界面都是双语的，唯独按下 ⌘F
    弹出来的那一条是英文，不像「还没翻」，像「这块不是我们的」。
  - 文案改走 `EditorState.phrases`，样式抽成 `utils/editorTheme.ts` 统一对齐到
    设计令牌（补全弹窗的选中项样式也一并挪了进去）。
  - 判据：`src/utils/editorPhrases.test.ts` 起一个真的编辑器打开面板，把渲染出来的
    **全部**文字读回来比对。对着键表自比是没用的——那只能证明「我写的键翻译了」，
    证明不了「面板上的字都来自我写的键」。已反向验证：删掉 `by word` 一条，
    断言里直接多出一个 `by word`。
- [x] 显示执行目标、数据库、Schema、只读和生产环境标记
  - 执行目标（host:port）与生产环境标记本来就有；这轮补的是数据库、Schema、只读。
  - 新增 `session_target` 服务：一条查询取回**服务端自己说的**库名、schema、只读标记。
    头部原本显示的是连接配置里的库名，它回答不了「不带前缀的 CREATE TABLE 会落到哪」——
    PostgreSQL 上这取决于 `search_path`，而它来自连接串 options 或角色默认值，配置里没有。
  - 只读是这次唯一的新信息，也最有用：挂在只读副本上时写入会失败，而失败信息往往
    只说「不能写」，不说「因为这是个副本」。不拦截写入——服务端自己会拒绝，
    按关键字拦截正是下一条 TODO 点名反对的做法。
  - **不做实时刷新**，查证后改掉的设计：(1) `tauri-plugin-sql` 用 sqlx 默认连接池
    （最多 10 条），`SET search_path` 只改其中一条，再查可能落在另一条上，指示器会闪；
    (2) MySQL 的 `USE` 走不了预处理协议（1295），而 `execute_query` 正是预处理的，
    在编辑器里根本切不了库；实测就算切了，`DATABASE()` 在预处理语句里是准备时求值的。
    所以那一栏说的是「新查询默认落在哪」，不是「会话现在在哪」——后者在连接池上
    不是一个有定义的概念。
  - 判据：`database_smoke.rs` 的 `postgres_session_target_reports_the_servers_own_answer`
    （同连接 SET 之后报新 schema，证明不是回显）、`sqlite_session_target_reports_query_only`
    （query_only 打开后报只读，证明这一列是活的）、
    `mysql_use_is_rejected_by_the_prepared_protocol`（执行器改回文本协议时会红）。
- [x] 查询错误显示数据库原始错误、位置和可复制详情
  - 后端完成于 d252240，界面完成于本轮。执行路径上原本是 `error.to_string()`，
    数据库给的 SQLSTATE、出错字符位置、DETAIL、HINT、约束名、表名全在那一步丢掉。
    症状：`syntax error at or near "form"` 不说三百个字符里是哪个 `form`；
    唯一约束冲突不说撞的是哪个值（DETAIL 里写着，但那一整句从没到过界面）。
  - 新增 `QueryError`（`From<sqlx::Error>` 取结构）与 `QueryErrorPanel`。
    可以跳到出错位置；**只有拿得到位置时才显示跳转**——MySQL 与 SQLite 不给
    字符位置，凭空算一个会精确地指错地方。一键复制完整详情供贴工单。
  - 位置换算按码位数不按 UTF-16 码元：数据库数的是字符，语句里每多一个 emoji
    就偏一格，而偏出来的位置看上去完全像个正常位置。
  - 超时与取消不带结构（不是数据库说的话），且判断改走 `code` 而不是消息前缀——
    消息要翻译，按前缀匹配等于把判断绑在某一种语言上。
  - `details` 装箱：clippy 的 `result_large_err` 指出解码**每个单元格**都要经过
    一个 `Result<_, QueryError>`，而 Result 的大小是成功路径也要付的（152 → 56 字节）。
    `#[serde(flatten)]` 保证 JSON 仍是平的，另有测试钉住 `size_of <= 128`。
  - 判据：`database_smoke.rs` 四条（PG 语法错误的 SQLSTATE 与位置——断言该位置切回
    原文正好是写错的那个词；PG 唯一约束冲突的约束名、表名与带冲突值的 DETAIL；
    MySQL 有错误码但**没有**位置；SQLite 有扩展结果码），
    加 `src/utils/queryError.test.ts` 13 条。已反向验证：把 `From<sqlx::Error>`
    退回只取消息，四条精确变红。
- [x] 为危险语句提供可配置确认，不用简单关键字拦截替代权限控制
  - 风险分级与确认框此前已有；这轮补的是「可配置」。规则原本写死在
    `requiresConfirmation` 里，不是任何人选的——天天跑批量清理的开发库上它每次都弹，
    而想在预发也拦住每条 UPDATE 的人没地方说。
  - 改成按环境设定门槛（另有「从不确认」一档），新增设置弹窗（侧边栏底部进入）。
    **默认值精确等于可配置之前的行为**：`statementRisk.test.ts` 原有 20 条一条没改
    就继续绿，这就是判据。
  - `read` 不在可选项里：给每条 SELECT 弹确认，弹到第三次就没人看了，
    真正危险的那次也会被顺手点掉——那正是这道闸要避免的事。
  - 「不用简单关键字拦截替代权限控制」：设置说明里写明确认只是给一次停下来的机会，
    不能代替数据库权限，真正该只读的账号要在数据库里配。这句话写在提交说明里没用，
    要写在会来调这个设置的人眼前。确认框底部说明在哪调整——找不到入口的人
    只会学会闭着眼点「仍然执行」，那比不拦还糟。
  - 判据：`src/utils/confirmationPolicy.test.ts` 12 条（默认行为、自定义门槛、
    策略一路传到「一批里最危险的那条」、持久化逐项回落、localStorage 不可用不抛）。

**2.2 退出标准**：补全、格式化、查找替换跳转注释、执行目标标记、错误详情、
可配置确认六项均已落地。未做：错误位置只有 PostgreSQL 给（MySQL 与 SQLite
不提供字符位置，界面据此不显示跳转，不凭空算）。

### 2.3 查询历史与脚本管理

- [x] 将草稿恢复与执行历史拆成两个模块
  - 完成于 72f44af。草稿随标签生灭、随编辑覆盖，归 `workspacePersistence`；历史只追加，
    一条执行完就定了，归 `contracts/queryHistory` + `utils/queryHistoryStorage` + `stores/historyStore`。
    同时删掉零调用方的 `SqlHistory`——两者挤在它里面时按连接只存得下一份。
- [x] 执行历史记录时间、连接、数据库、SQL、耗时、状态和影响行数
  - 完成于 72f44af。记录由 `QueryExecution` 造出，不从调用方现攒散字段。失败 / 取消 / 超时
    一样记。连接名存成快照：连接会被改名、被删除，回查的结果是一堆「未知连接」。
  - 判据：`src/contracts/queryHistory.test.ts` 8 条。
- [x] 支持按文本、连接、日期和状态搜索历史
  - 完成于 cc3feac。侧边栏底部与命令面板各一个入口，`QueryHistoryDialog` 列出记录并按
    四个条件筛（与的关系）。文本用子串而非子序列匹配：SQL 动辄几行，子序列几乎命中一切。
    命名和标签一起参与匹配。
  - 取回语句走「开新标签」，不写进当前标签——后者会覆盖用户正在写的草稿。没有活动连接时
    那一行不是按钮而是纯文本，复制仍可用。
  - 判据：`src/utils/historySearch.test.ts` 11 条。已反向验证：`to` 不含当天时精确红在
    区间那条；日期按 UTC 解释时精确红在时区那条。测试在 Asia/Shanghai 与
    America/New_York 下都跑过。
- [x] 支持收藏、命名和标签
  - 完成于 43f398a。三种标注共用一条 `annotate` 动作。标签忽略大小写去重，保留先出现那个的
    写法；不设条数上限（上限只会静默吃掉第 9 个输入，存储层已按字节兜底）。
  - 清空标注存成 `undefined` 而不是 `''` / `[]`：留下空值会让 `isAnnotated` 继续为真，
    记录永远不过期，而用户以为标注已取消。
  - 标注过的记录免于按时间过期（`pruneHistory`），所以「收藏」是一句有后果的话。
    `annotate` 本身不触发淘汰——取消收藏的那条立刻消失会被当成误删。
  - 判据：`src/contracts/queryHistory.test.ts` 新增 5 条（去重、清空、不改原对象等）。
- [x] 支持保存和打开 `.sql` 文件
  - 完成于 725292f。存：编辑器工具栏图标按钮 + ⌘S，写完显示**路径**。开：标签栏「新建」
    旁边一个按钮 + 命令面板，读进**新标签**而不是覆盖当前草稿，标签名取文件名。
  - 后端新增 `read_text_file`，同样不引入 `tauri-plugin-fs`。两处各有 Rust 测试：8MB 上限
    （几百 MB 的整库转储会让窗口卡死，用户只看到「点了没反应」）；非 UTF-8 时点名说是
    编码问题（`read_to_string` 的原话会让人以为文件坏了）。
  - 前端：读进来先去 UTF-8 BOM（那个字符不可见，却会换来一条指着第 1 行第 1 列的语法
    错误）；存出去先换掉标签名里的非法字符（`public/orders` 在某些平台上会被当成路径分隔符）。
  - 判据：`src/utils/sqlFile.test.ts` 9 条 + `file_commands.rs` 3 条。
  - 未做：不记住「这个标签来自哪个文件」，所以 ⌘S 每次都问路径，没有「就地保存」。
    需要它时要先给 SQL 标签加一个 `filePath` 字段并处理外部改动。
- [x] 设置历史保留周期和容量上限
  - 完成于 458cbbc。两项都可配，逐项持久化、逐项回落。档位是离散下拉而非数字输入框，
    条数最高 2000 且不提供「不限」——历史与工作区快照共用 5MB 配额，撑满的代价是标签全没。
  - 改小立刻淘汰一遍，不等下次执行查询：设完什么也没发生会让人以为没生效。不可撤销，
    说明里明写；收藏 / 命名 / 打过标签的记录不按时间过期是这里唯一的安全网。
  - 重估条件（写在 `queryHistoryStorage` 模块说明里）：出现「历史要跨机器同步」或
    「上限需要上万条」时换成后端 SQLite 文件。当前两者都没有。
  - 判据：`src/utils/queryHistoryStorage.test.ts` 新增 6 条。
- [x] 敏感参数和结果不得默认写入历史
  - 完成于 72f44af。结果一行不存，`queryHistory.test.ts` 钉死字段清单，以后往里塞
    rows / columns 会红。SQL 里的口令在**入库前**替换（`utils/historyRedaction`），不是
    显示时打码——存原文显示打码等于没做。
  - 自带字符串字面量扫描：注释里一个撇号就能把后面所有字面量的边界整体错位。
    INSERT 按列位置对应且要求那一项整个就是一个字面量，否则 `md5('x')` 会被误打。
  - 判据：`src/utils/historyRedaction.test.ts` 11 条。已反向验证：退回按个数对应时
    精确红在 `md5('x')` 那条；关掉注释跳过时精确红在撇号那条。
  - 未做：反斜杠转义按 MySQL 算，不按方言分——PostgreSQL 里以反斜杠结尾的字面量边界
    会偏（少见），反过来选错会让 MySQL 的 `'it\'s'` 把整条语句的字面量全部带偏。

**2.3 退出标准**：草稿与历史已拆成两个模块，执行历史记录完整元信息并可按文本 /
连接 / 日期 / 状态搜索，支持收藏、命名与标签，保留周期与容量上限可配，`.sql`
文件可存可开，结果一行不入历史、SQL 里的口令入库前替换。未做：历史存在
localStorage（重估条件写在 `queryHistoryStorage` 模块说明里）；`.sql` 标签不记
来源路径，因此没有「就地保存」；脱敏的反斜杠转义按 MySQL 算，不按方言分。

### 2.4 表数据浏览

- [-] 元数据与表数据查询改走自建 query_executor，不再用 tauri-plugin-sql 的解码器
  - 证据：用户实测 MySQL 8 报 `unsupported datatype: VARBINARY`（84495ab 已用 CAST 绕开元数据查询）。
    插件解码器类型表是硬编码的：MySQL 缺 `VARBINARY` / `BINARY` / `DECIMAL` / `BIT` / `SET` /
    `GEOMETRY`，PostgreSQL 缺 `NUMERIC` / `DECIMAL`
    （见 `tauri-plugin-sql-2.2.1/src/decode/{mysql,postgres}.rs` 的 `_ => UnsupportedDatatype`）。
  - 表数据查询是 `SELECT *`，列由用户的表决定，无法靠 CAST 绕开：含 DECIMAL 或二进制列的表
    在表视图里仍会失败。而 P1 的 `query_executor.rs` 早已实现完整解码并保持 BigInt / Decimal 精度，
    等于同一个问题解决了两次、只有一次是对的。
  - 阻碍：`execute_query` 命令目前不接受绑定参数，改走它需要先补参数支持，否则只能拼接字面量。
  - 表数据查询完成于 74ee3f9（新增 `runReadQuery`）。解码器缺口补齐并加了全类型覆盖测试于 29aafc2，
    同时把查询从非预处理文本模式改为预处理二进制协议——`INTERVAL` 与 MySQL `TIME` 在文本模式下
    sqlx 根本不做转换。
  - 剩余：表结构查询仍走插件，因为它带绑定参数而 `execute_query` 还没有参数支持；
    84495ab 的 CAST 已让它工作，等真需要时再给命令补参数。
  - 未支持且暂不打算支持：PostgreSQL 的 `BIT` 与 `INET` / `CIDR`，需分别开启 sqlx 的
    `bit-vec` 与 `ipnetwork` feature，在应用 schema 中少见。碰上时会报出点名类型的错误。
  - 判据：`cargo test --test database_smoke` 中的 `mysql_decodes_common_column_types` 与
    `postgres_decodes_common_column_types`，针对真实 MySQL 8.4 / PostgreSQL 16 断言每列可解码
    且 DECIMAL / BIGINT UNSIGNED 不丢精度。已反向验证：移除 BINARY 支持后精确红在 `col_binary`。


- [x] 支持服务端排序和筛选（排序早前已完成；筛选 606e0e9）
  - 排序拼进 `ORDER BY` 并追加主键作决胜条件（`createSortedOrderClause`）；筛选拼进 `WHERE`，
    `COUNT(*)` 走同一个子句——否则分页控件仍按全表行数算，末几页是空的。行数缓存的键
    补上筛选子句：筛选条件是「数据集身份」的一部分。
  - 值只能内联（`execute_query` 还不收绑定参数，见本节第一条）。字面量转义**按方言分支**：
    MySQL 默认开反斜杠转义，`C:\temp` 的 `\t` 会变成制表符；PostgreSQL / SQLite 反过来。
    这与历史脱敏「一律按 MySQL 算」相反，因为代价方向不同——那边错了只是多打或少打一个
    展示用的码，这边错了是把错误的值发给数据库，查出来的行是错的而语句不报错。
  - LIKE 转义符用 `!` 不用 `\`：MySQL 里 `\` 同时是字面量转义符，两层叠起来最容易错。
    数值列上的数字不加引号——MySQL 比较字符串与数字时两边都转 DOUBLE，>2^53 的 BIGINT
    会和邻近几个值比成相等。类型名只取第一个词，`interval` / `point` 不会被误判成数值列。
  - 草稿与已应用分开，不做逐键查询；值空着的条件被忽略而不是当成 `= ''`。
  - 只有 AND，没有 OR：OR 需要分组模型，目前没有用户场景要求它；真出现「同一列取并集」
    时再加，那时多半该顺带支持 IN。
  - 判据：`sqlLiterals.test.ts` 八条 + `tableFilters.test.ts` 十四条。已反向验证四处：
    LIKE 不转义通配符、数值类型按子串匹配、MySQL 不转义反斜杠、空值也算填完。
- [x] 支持列显示/隐藏、调整宽度、冻结列和密度设置（宽度早前已完成；其余 5b18cfc）
  - 工具栏「列」菜单：行高三档、冻结左侧 N 列、逐列勾选显示。宽度仍由 `useResizableColumns`
    按内容量出、可拖动、双击自适应。
  - 选区改成按**可见**列建立：否则用户框住看到的几格，复制出来却混进藏起来的列——
    屏幕上一切正常，是这类网格最难自查的错。导出同样跟着可见列走，范围说明里写明少了几列。
  - 冻结偏移按可见列宽累计：藏掉第一列后「冻结 1 列」冻的是当时看得见的第一列，
    按原列宽算会让冻住的列悬在一段空白之后。
  - 拒绝两种会把界面锁死的状态：藏掉最后一列（剩一张空表，而找回列的入口就在那张空表上）、
    冻结全部列（横向滚动彻底失效）。
  - 判据：`src/utils/gridColumns.test.ts` 十四条，含「三档内边距必须递增且互不相同」。
    已反向验证三处：允许全冻结、允许藏掉最后一列、紧凑档与默认档同高。
  - 渲染核对补了冻结区的分界线——没有它时滚过去的内容看上去是凭空消失的。
- [x] 支持复制单元格、行、列和选区（080064d）
  - 单元格与矩形选区早前已有（⌘C，单格原样、多格 TSV）。本次补整行、整列与「含列名」。
  - 整列默认带列名：只有一串值贴到别处已经认不出是哪一列。带表头后这一段就是一张表，
    单格「原样复制」的规矩不再适用，否则含制表符的值会把两行都串列。
  - `copyRow` / `copyColumn` 一步完成选中与复制：选区是 state，刚 set 的值在同一次事件里
    读不到，拆两步会复制上一次的选区。
  - 键盘：⇧Space 整行。整列**不用**惯例的 ⌃Space——macOS 上它默认是切换输入法，
    本项目用户基本都装着多种输入源，按下去到不了这里；改用 ⌥Space，并判 `event.code`
    而不是 `event.key`（⌥Space 在 macOS 上产生 U+00A0）。
  - 两张网格都加了右键菜单，因为快捷键没有任何地方写着。
  - 判据：`src/utils/cellSelection.test.ts` 新增七条。已反向验证三处：带表头时单格仍原样
    复制、表头不转义、整行不查越界。
- [x] 支持 NULL、空字符串和二进制内容的明确展示（fa6f76c）
  - NULL / 空字符串 / 纯空白在朴素网格里都是一块空白，而 `IS NULL`、`= ''`、`= '  '`
    是三个不同的条件。现在三者分别显示为弱化的 `NULL`、`''` 和带引号的原文 `'   '`；
    字符串 "NULL" 与真 NULL 文本相同、样式与 title 不同，不去改用户的值。
  - 二进制带 `0x` 前缀与字节数，十六进制超 64 字符截断——1MB 的 BLOB 展开是两百万个字符，
    整串塞进 title 后一页 100 行就是两亿字符。
  - 抽出 `GridCellValue` 供 SQL 结果表与表数据视图共用：分头写必然漂移成两套约定。
  - 判据：`src/utils/cellDisplay.test.ts` 七条。已反向验证三处：去掉纯空白分支、
    字节数按截断后算、用 falsy 判空（0 被显示成 NULL），各自精确变红。
- [x] 支持刷新并保持当前筛选、排序和页面位置（32d63f3）
  - 筛选、排序、页码本来就走 ref / state，刷新后已经保住。真正丢掉的是不在「状态」里的两样：
  - **滚动位置**：加载时整张表被换成居中转圈，滚动容器随之销毁，刷新回来横竖都在原点。
    改成盖一层半透明提示，表格不拆。
  - **选区**：此前 rows 换引用就清掉，而「换引用」同时对应刷新（该留）与翻页/改排序/
    改筛选/换表（必须清）两件事。区别只有调用方知道，故由调用方给 `datasetKey`，
    判断抽成纯函数 `retainSelection`；越界的选区即使在刷新时也丢掉。
  - 列宽无需处理：`useResizableColumns` 的手动宽度按列名记录，只在整组列名变化时清空。
  - 顺带修掉：去结构页看一眼再回数据页会跳回第一页。
  - 判据：`src/utils/cellSelection.test.ts` 新增五条。已反向验证两处：越界判断差一位
    （最后一行永远选不住）、换数据集也留着。
- [x] 无稳定唯一键的表显示只读原因（d621c2f）
  - 没有主键时收起「添加 / 编辑 / 删除」，并在网格上方说明原因与替代做法；此前按钮照常亮着，
    点下去才抛出「无法找到主键列」。
  - 复合主键一并归入只读：写入路径取 `columns.find(col => col.is_primary_key)` 只拿第一列拼
    `WHERE pk1 = ?`，在复合主键上会命中所有前缀相同的行，事后 `assertSingleRowAffected`
    抛出时数据已经改了。等 2.5 用全部键列拼条件后去掉这一支。
  - 合并了重复提示：`stableAcrossChanges === false` 与「没有主键」是同一个条件，
    原先两条警告各说一半后果，现在由只读横幅一并说明。
  - 判据：`src/utils/tableEditability.test.ts` 五条。已反向验证：去掉复合主键分支后
    精确红在「复合主键暂时不可改」。

**2.4 退出标准**：排序与筛选都在数据库里执行并作用于整张表，`COUNT(*)` 走同一个
`WHERE`；列可藏可冻可调宽、行高三档；单元格 / 选区 / 整行 / 整列都能复制，整列带列名；
NULL、空字符串、纯空白与二进制在网格里互相区分得开；刷新保住筛选、排序、页码、
滚动位置与选区；无稳定唯一键的表收起写入入口并说明原因。未做：复合主键的网格编辑
（写入路径只取第一列拼 WHERE，会命中多行，已归入只读，等 2.5 的 ChangeSet）；
筛选只有 AND 没有 OR / IN；筛选值内联而非绑定参数，受限于 `execute_query`
还不收参数（见本节第一条）；列偏好与筛选不跨会话保存。

### 2.5 可靠的数据修改

- [x] 从真实约束元数据获取完整主键或唯一键（b9d2cbf）
  - `describeRowIdentity` 把「靠哪几列能定位到唯一一行」集中到一处：先取主键（按键内次序，
    不按列在表里的次序），没有主键时退到唯一索引。索引元数据本来就在读——结构页的索引列表
    用的就是它。
  - 明确排掉四类**看起来是唯一键、实际定位不到一行**的候选：部分索引（谓词外仍可重复）、
    `indisvalid = false` 的索引（`CONCURRENTLY` 建失败的残骸，唯一性从没在存量数据上查过）、
    表达式索引（唯一的是 `lower(email)` 的值，不是 `email` 这一列的值）、可空的唯一列
    （唯一索引把 NULL 之间看作互不相等，一列上可以有任意多行是 NULL）。
  - 目录查询新增 `is_partial` / `is_valid` 三方言各一份；缺列时前端读到 `undefined` 并按
    false 处理——宁可让表变成只读，也不要拿一个不保证唯一的键去定位行。
  - 「还没读到索引」「读不到索引」「确实没有唯一键」现在是三个不同的回答。前两个此前都会
    说成「这张表没有主键」，那是一句关于用户的表的假话。
  - 判据：`src/utils/rowIdentity.test.ts` 十五条 + `schema_metadata.rs` 的
    `every_index_query_reports_whether_the_index_can_identify_a_row`。已反向验证七处：
    去掉部分索引 / 未验证 / 可空 / 表达式四道排除、pending 与「没有键」混为一谈、
    同长度候选不排序、MySQL 查询少一列。
- [x] 支持复合主键（81ad120）
  - `buildUpdateStatement` / `buildDeleteStatement` 用**全部**键列拼 WHERE。此前
    `columns.find(col => col.is_primary_key)` 只拿第一列，在复合主键上命中所有前缀
    相同的行——语法正确、执行成功，事后 `assertSingleRowAffected` 抛出时已经改完了。
  - 键列不限于主键：`describeRowIdentity` 选出的唯一索引同样能定位一行。键列在网格里
    不可改——改键等于换一行的身份，那是删一行加一行，不是更新。
  - 值默认绑定，只有**数值列上的比较**内联成不带引号的字面量（MySQL 比较字符串与数字时
    两边都转 DOUBLE）。赋值一律绑定：那是转换不是比较，字符串转整数是精确的。
  - 顺带去掉两处按列类型做的转换：`Number(value)` 让大整数丢精度，`Boolean('false')` 是
    true。原样交给数据库按目标列的类型解析。写入语句与参数值不再打进 console。
  - 键值为 NULL 时报错而不是拼 `IS NULL`——SQLite 的非 INTEGER 主键列允许存 NULL，
    那一行定位不到，拼一条匹配不中或匹配一批的条件比报错糟得多。
  - 判据：`src/utils/rowStatements.test.ts` 十二条。已反向验证五处：只拼第一个键列、
    WHERE 先于 SET 拼导致 PostgreSQL 的 `$n` 错位、数值键走绑定、数值列上任何值都内联、
    键值为 NULL 时拼成 `IS NULL`。
- [x] 查询结果只有能证明映射到单表唯一记录时才允许编辑（e5be70d）
  - 此前先**猜**主键：查有没有一列叫 `id` / `ID` / `<表名>_id`。在一张冗余存了别人 id
    的表上那一列指向完全错误的行，而 UPDATE 语法正确、执行成功、不报错。猜不中才退到
    目录查询，而那条查询没有 schema 条件（同名表任选其一）且 `LIMIT 1`（复合主键砍成一列）。
  - 形态由 `parseSingleTableSelect` 认：只承认「单表 + 投影全是裸列名」，且键列必须在
    投影里——否则拿不到键值。键由 `loadTableMetadata` 从目录读。
  - 顶层关键字扫描复用 `topLevelKeywords`（跳过字符串、注释与括号）：
    `WHERE note = 'group by'` 不算分组，而 `... WHERE a = 1 UNION SELECT * FROM u` 必须拒——
    它开头的形状完全合法，却有一半的行来自另一张表。仅靠尾子句检查会放过这一条。
  - 认不出就只读，并在结果工具栏上说清是四种原因里的哪一种。
  - 顺带修掉三处：键值是 tagged 对象时被原样绑进 WHERE（BigInt / Decimal / 时间列的条件
    永远匹配不上，报「没有影响任何行」）；新增行按**列名**猜类型（`timeout_ms` 被当成
    时间戳）并用 `Number()` 处理大整数；新增之后用 `SELECT * FROM 表`（无 WHERE 无 LIMIT）
    刷新结果，在大表上直接把界面拖死。
  - 表结构查询从 TableDataViewer 提到 `tableMetadata`，两处共用。目录查询只在认出单表
    形态后才发；不做缓存——缓存一个键意味着外部改结构后仍拿旧键定位行，而这是写入路径。
  - 判据：`src/utils/resultEditability.test.ts` 三十一条。已反向验证五处：不扫顶层关键字、
    不查尾子句、PostgreSQL 不折小写、不查键列在不在投影里、元数据读不到也当成「没有键」。
    第一处最初**没有**红——所有反例都在更早的一道检查上就被拒了，补了四条
    「关键字在 WHERE 之后」的用例才真正守住。
- [x] BigInt、Decimal 保持精度，不转换为 JavaScript `Number`
- [x] 时间类型保留时区和数据库语义
- [x] 为 JSON、二进制、布尔和日期提供专用编辑器（bcb3003）
  - 二进制：纯文本框绑定的是那串十六进制**文本**，存进 BLOB 得到的是这些字符的字节，
    长度正好翻倍而语句不报错。现在按方言生成字面量走表达式档（`X'...'` /
    `'\xdeadbeef'::bytea`），写之前就验位数——奇数位说不清最后半个字节补在高位还是低位。
  - JSON：当场标红并给格式化按钮，但仍允许提交（列里可能真存着一段不是 JSON 的文本）。
  - 布尔：两个按钮。文本框里打 `false` 曾被 `Boolean('false')` 变成 true。
  - 日期：文本框是权威的那一份，选择器只往它里面写；认不出的原值（`0000-00-00`、
    带时区、带小数秒）让选择器空着，不显示成某个看似合理的日期再在保存时改掉原值。
    「现在」写的是 `CURRENT_TIMESTAMP`，取值由执行语句的那一方做。
  - 类型分类只看类型名的第一个词：`interval` 与 `point` 都含有 "int"。
  - 判据：`src/utils/columnEditors.test.ts` 二十七条。已反向验证六处：按子串匹配类型名、
    奇数位十六进制放行、PostgreSQL 也用 `X'...'`、T 不换成空格、认不出的日期也塞给选择器、
    日期与时间不分形状。
  - 渲染核对（1280/660、明暗两色）抓到四处：奇数位时按钮写着「1.5 字节」；多行编辑器旁
    那根从头拉到尾的细长箭头；datetime 选择器给窄了把秒切掉；带时区的时间戳与选择器挤在
    一行被截断——文本框因此独占一行。
- [x] 区分 NULL、空字符串、默认值、表达式和未填写（193b797，先于「专用编辑器」做，
  后者建在这个值模型上）
  - 编辑框此前只给一个字符串、空串当 NULL，五件不同的事挤在同一个值里：空字符串写不出来；
    「用默认值」写成 NULL 得到的是 NULL（自增列会被 0 覆盖掉序列该给的数）；
    `CURRENT_TIMESTAMP` 当字面量绑定存下的是那串字符本身；「还没填」和「要写空字符串」
    在空文本框里长得一模一样，而前者在非空无默认值的列上会被拒。
  - `CellInput` 把五档写进类型，`value` 的载荷不允许是 null——否则
    `{kind:'value',value:null}` 与 `{kind:'null'}` 会同时表示同一件事，两条路径迟早分叉。
  - INSERT 把 `unset` 与 `default` 的列整列省掉，不写 `VALUES (DEFAULT, ...)`（SQLite 不认）；
    UPDATE 的 `SET 列 = DEFAULT` 在 SQLite 里不存在，点名报错且界面上那一档不给选。
  - 提交前用 `missingRequiredColumns` 点名非空、无默认值又没填的列，而不是让数据库去拒绝。
  - 顺带删掉旧的日期选择器：它给 `<input type="datetime-local">` 喂
    `2024-01-01 12:00:00`（合法值必须带 T），控件显示空白，保存就把那一列清掉了。
  - 判据：`src/utils/cellInput.test.ts` 十一条 + `rowStatements.test.ts` 新增十条。
    已反向验证八处：NULL 当空文本、空串与 NULL 混为一谈、表达式算没变、默认值不算没填、
    `default` 进 INSERT 列清单、表达式当字面量绑定、SQLite 也发 `SET = DEFAULT`、
    `unset` 不从 SET 里滤掉。
  - 渲染核对（1280/660、明暗两色）抓到两处单测抓不到的：`unset` 被画成 DEFAULT；
    明确的空字符串与没填过的格子长得完全一样。现在靠三种占位符分开。
- [x] 所有变更先进入 `ChangeSet`，不再编辑后立即提交（649eb67）
- [x] 提供差异预览、逐项撤销、全部撤销和批量提交（649eb67，与上一条同一个提交：
  能排队却不能提交是跑不起来的框架）
  - 此前一改一提交：改三行是三次独立提交，中途失败前面几条已经落库，用户看到一句错误
    而数据停在一个他没打算要的中间状态；按下去之前也没有任何地方说得出这批会改什么。
  - 同一行只保留一条待提交改动（重复编辑合并、改回原值自动退出、全改回原值整条消失）；
    删除盖过同一行上待提交的编辑。行的身份用**键值**不用页面下标——翻页 / 排序 / 筛选
    之后同一个下标是另一行。
  - 排了队的行在网格里看得见（待改蓝底、待删红底加删除线）。
  - 提交走新的 Tauri 命令 `execute_write_batch`，整批一个事务。不能复用 `execute_query`：
    那是流式读、按一条语句设计、且自动提交。
  - 判据：`src/utils/pendingChanges.test.ts` 十四条 + `write_batch.rs` 七条（含
    SQLite 内存库上真实的回滚）。已反向验证九处：同一行不合并、改回原值不退出、
    删除不盖过编辑、已删除的行仍可编辑、行身份按书写次序算、不要求恰好影响一行、
    不开事务直接打到池上、出错语句序号写死、非标量参数转成 JSON 文本。
- [x] 提交失败时保留待提交变更和完整错误（649eb67，同上：失败会丢掉排的队就等于没排）
  - 失败时数据库里什么都没变，变更原样留着，预览自动打开并标出出错的那一条，
    连同数据库给的 detail / hint / constraint / SQLSTATE。
  - 「必须影响几行」的核对放在**事务里**做：一条本该改一行的 UPDATE 改到零行或多行，
    提交之后才发现就只能报告。不对就整批回滚，并用单独的错误码与数据库自己的错分开。
    `assertSingleRowAffected` 因此整个删掉——它做的正是那个来不及的事后检查。
  - SQL 结果表走同一套：三个「改一行提交一次」的 store 动作合并成一个 `commitRowChanges`。
- [x] 使用原始值或版本字段检测并发修改冲突（ec013b5）
  - 只按键定位挡得住「那一行被删了」，挡不住丢失更新：两个人同时打开同一行，后保存的
    无声盖掉前一个，而两条语句都影响了一行、都不报错。
  - 原值拼进同一条 WHERE，配合后端在事务内的「必须恰好影响一行」核对，一次往返既定位了
    行又验证了前提。不做「先 SELECT 回来比一遍再 UPDATE」：中间仍有窗口，还多一次往返。
  - **不用版本字段**：自动认出哪一列是版本号只能靠猜列名，猜错就是拿一个普通业务列当
    乐观锁——要么永远冲突，要么永远不冲突。原值比较对任何表都成立，不要求先改表结构。
  - 更新与删除有意不对称：更新只比正在写的那几列（别人改了同一行的另一列不该让这次保存
    失败），删除比整行（它不可逆，承诺的是「要删的还是我看到的那一行」）。
  - 参与比较的类型走白名单。比不准的结果不是多报一次冲突，而是**每次都报**，那一条永远
    提交不了。已排除：二进制（`blob = 'deadbeef'` 比的是 BLOB 和文本）、近似浮点
    （PostgreSQL 的 `float4 = 1.1` 会把 float4 提升成 numeric）、JSON（等值语义三方言
    各异）、认不出的类型（`point = '(1,2)'` 要么报错要么恒假）。这些列只受键与行数核对保护。
  - 判据：`rowStatements.test.ts` 新增九条 + `pendingChanges.test.ts` 新增一条。
    已反向验证六处：不比原值、更新比整行、原值为 NULL 时用 `= NULL`、比不准的类型也拿去比、
    键列再比一遍、删除不比原值。

**2.5 退出标准**：行标识来自真实约束（主键或一个非空、完整、无谓词、已验证的唯一索引），
复合键的全部列都进 WHERE；查询结果只在能证明映射到单表唯一记录时才可编辑；每个单元格分得清
NULL / 空字符串 / 默认值 / 表达式 / 未填写，JSON、二进制、布尔与日期各有专用编辑器；所有改动
先排队，可预览差异、逐项撤销、全部撤销，整批在一个事务里提交；提交在事务内核对行数，失败时
数据库不变、变更留着、出错那一条连同数据库给的细节一起标出；并发修改靠原值比较检测。

未做与有意不做：

- **不用版本字段**做并发检测——自动认出哪一列是版本号只能靠猜列名，猜错就是拿一个普通业务列
  当乐观锁。原值比较对任何表都成立。
- 二进制、近似浮点、JSON 与认不出的类型**不参与**原值比较：比不准的结果不是多报一次冲突，
  而是每次都报，那一条永远提交不了。这些列只受键与行数核对保护。
- SQLite 的 UPDATE 不支持 `SET 列 = DEFAULT`（方言里就没有这种写法），界面上那一档在
  SQLite 下不给选。
- 待提交的变更**不跨会话保存**，也不跨换表保留（键指着另一张表的行）；关标签页前会问一次。
- 新增的行在提交之前不出现在网格里，只出现在待提交列表与差异预览里。
- 删掉了 `src/contracts/changeSet.ts`：它是设计阶段留下的、从未被接上的占位，形状也不适配
  （值按 `SerializedResultValue` 存、同一行的多次编辑不合并、没有撤销）。真正落地的是
  `src/utils/pendingChanges.ts`。同一轮里 `assertSingleRowAffected` 也删掉了——行数核对
  移进了事务，它做的是那个来不及的事后检查。

### 2.6 基础导出

- [x] 导出当前结果为 CSV
- [x] 导出当前结果为 JSON
  - 均完成于 `3483676`。查询结果导出排序后的整份（用户看到的次序就是文件里的
    次序），表数据是服务端分页的、只有当前页，对话框直接写明范围。
    （整表这一档见下方「大结果导出」，由流式写入完成。）
  - CSV 按 RFC 4180 转义，转义条件随分隔符变；行分隔用 LF 而非 CRLF——
    Excel / Numbers 都读得了 LF，CRLF 会给 Unix 文本工具留下行尾 `\r`。
  - bigint / decimal 在 CSV 按原串写、在 JSON 加引号：JSON 数字在实践中就是
    IEEE-754 双精度，消费方 parse 一个 20 位整数必然丢位。
  - 重名列去重。一条 SELECT 可以返回两列都叫 `id`，用列名作键会让后一列
    静默顶掉前一列——少一列而文件看上去完全正常。
- [x] 支持编码、分隔符、表头和 NULL 表示方式
  - 编码只提供「UTF-8」与「UTF-8 加 BOM」。BOM 那档是给 Excel 的——不加 BOM
    的 UTF-8 CSV 在 Excel 里中文是乱码。GBK 等需要额外编解码依赖，没做。
  - 对话框带真实输出预览：分隔符和 NULL 写法这两个选项，光看名字判断不了
    对不对，看一眼结果就知道。
- [x] 大结果导出使用后台任务和流式写入
  - 完成于 `c39dd45`、`776b94a`、`57004c5`。导出对话框多出一档「范围」：
    表数据视图给「当前页 / 整张表」，查询结果在**结果真被截断时**给
    「当前结果 / 完整结果」。整表与完整结果走 `export_query_to_file`，
    行从数据库流出来、逐行格式化、逐行落盘，一行不进内存也一行不过 IPC。
  - 此前的路子是「整份结果拼成一个 JS 字符串，再整个交给 `write_text_file`」。
    整表导出没有行数上限，这条路在三处都断：行攒不进数组、字符串过不了 IPC、
    写的过程无法中断。
  - **点「导出」不该执行一条 DELETE。** 是否返回结果集只有数据库自己知道——
    `WITH … SELECT` 返回、`WITH … DELETE` 不返回，而两者开头一样。`describe`
    报 0 列就是它的回答，`NonQueryHandling::Refuse` 在真正 `execute` 的那一行
    前面拦下。反向验证：改回 `Execute` 后 PostgreSQL 上那条 DELETE 真的跑了，
    导出「成功」返回 0 行。
  - **先写 `.part` 再改名**：一份写到一半的 CSV 和一份完整的 CSV 长得一模一样。
    清理挂在 `Drop` 上，因为取消会把整个 future 丢掉，之后没有代码会再碰它。
  - 导出另开一条连接，不占编辑器那条 Session：一次整表导出可能跑几分钟，
    占着 Session 会让编辑器在这期间完全按不动。代价是看不到 Session 里未提交
    的事务，而这对「导出这张表现在的样子」正是想要的语义。
  - 整表那条 SQL（`utils/tableExportQuery.ts`）与网格取数同源，只是去掉
    LIMIT / OFFSET：投影收到可见列（`SELECT *` 会把特地藏起来的列写进文件）、
    WHERE 照留（漏掉它文件会比用户预期大几个数量级）、ORDER BY 照留
    （不分页也要有确定次序，否则同一张表导两次可能不一样）。
  - 判据：`database_smoke` 的 `{postgres,mysql}_exports_every_row_and_refuses_a_non_query`
    各造 2500 行——刻意超过默认 1000 行的上限，走错成那条限死的路会在第 1000
    行戛然而止。已反向验证：把导出的 `row_limit` 改成 `DEFAULT_QUERY_ROW_LIMIT`
    后两条都精确红在 `1000 != 2500`。
- [x] 支持取消、进度和失败重试
  - **取消必须是协作式的。** 第一版用 `tokio::select!` racing 一个 5 毫秒计时器，
    结果 50 万行跑满 2.3 秒也没被取消：SQLite 的行立刻就绪，整趟导出在**一次
    poll 里跑完**，运行时根本没机会轮询计时器那一侧。现在每个批次问一次取消，
    ≤250 行内生效。取消与查询共用同一个登记表（`QueryCancellationState`）。
  - 进度按 120 毫秒节流上报已写行数与字节数——按批次报会在窄表上变成每秒
    上千条 IPC 消息。收尾那一次无条件报，否则界面停在最后一次节流之前的数字上。
  - 重试用**同一个路径和同一份选项**再跑一遍，不再弹保存对话框：用户已经选过
    了，让他重选一次只会让人怀疑是不是选错了。不做断点续传——续传要求一个
    稳定的 ORDER BY 加偏移量，重读一遍比把它做得微妙地不对要便宜。
  - 取消不是失败：灰字「已取消，没有留下文件」，不是红字报错。
  - 这一条当时留了个尾巴：导出期间对话框是模态的。**3.4 的后台任务把它收掉了**
    ——整个范围的导出交给任务中心跑，对话框按下就关，取消与重试都搬了过去。

**格式化有两份实现**（预览在前端 `utils/exportResult.ts`，文件由 Rust 的
`services/export_writer.rs` 写），分叉时预览会变成谎话，而这种分叉不会让任何
一侧自己的测试变红。`fixtures/export-conformance.json` 是同一组输入的唯一期望
输出，两边各自照它核对（16 条，双向反向验证过）。语料逼出两处真实差异：
Rust 的 `{}` 给整数值的 f64 补 `.0` 而 JS 不补；`serde_json` 的 `Map` 是
BTreeMap，会把列按字母重排。

**新增命令**：`write_text_file`、`export_query_to_file`、`cancel_export`。
没有引入 `tauri-plugin-fs`——保存对话框返回任意路径，用插件就得把写权限
scope 开到整个主目录，而这里需要的只有「写一个文件」。

**2.6 退出标准**

- 一张任意大小的表可以完整导出成 CSV / JSON，过程可见、可取消、失败可重试，
  中途失败不留下任何看上去完整的文件。
- 对话框里的预览与文件里的字节由同一份语料钉住，预览是证明而不是声明。
- 明确不做：GBK 等编码（需要额外编解码依赖）；断点续传；后台任务列表
  （3.4）；导出选中行（3.4）。

**P2 退出标准**

- 用户能完成“连接 → 编写 SQL → 执行 → 检查结果 → 修改数据 → 导出 → 恢复工作区”的完整流程
- 日常操作不需要因缺少标签、历史、筛选或导出频繁切换其他工具

---

## P3：数据库管理与数据工程能力

### 3.1 结构与对象管理

- [x] 浏览索引、主键、唯一约束、外键和检查约束
  - 完成于 `47c5381`。表结构页的列表格下面新增索引 / 外键 / 检查约束三块，
    一条一行：`uq_orders_code (tenant_id, code) 唯一`、
    `fk_orders_region (region_a, region_b) → public.regions (x, y) 删除时 SET NULL`。
  - 九段目录查询放在 `services/schema_metadata.rs` 而不是前端：唯一能证明它们
    对的是拿真库跑一遍，而那只有 SQL 住在 Rust 侧时才做得到。前端取回三段
    文本自己绑参数执行，不做字符串拼接。
  - 夹具里刻意设了陷阱：复合外键 (ref_a, ref_b) → (x, y)，而 ref_b 在表里
    声明在 ref_a 之前。按列序而不是键序配对会错位，且错位后页面上仍是一行
    整齐的 `(a, b) → (x, y)`。
  - PostgreSQL 列名用 `pg_get_indexdef(oid, colno, true)`（表达式索引的 indkey
    是 0，join pg_attribute 会让那一列消失）；MySQL 用
    `COALESCE(COLUMN_NAME, EXPRESSION)`（函数索引的 COLUMN_NAME 是 NULL）；
    检查约束走 `pg_constraint` 而非 information_schema（后者把每个 NOT NULL
    也列成一条，淹掉真正的 CHECK）。
  - SQLite 没有检查约束目录，用 `Option::None` 表达，不返回一段查不到东西的
    SQL 再显示「0 条」。SQLite 表达式索引既无列名也无表达式原文，显示为
    `<表达式>`。
  - 判据：`cargo test --test database_smoke` 中的
    `{postgres,mysql}_reports_indexes_foreign_keys_and_checks` 与
    `sqlite_reports_indexes_and_foreign_keys`，针对真实 MySQL 8.4 /
    PostgreSQL 16 断言复合键的列顺序与配对。已反向验证：外键改成分两次
    unnest、MySQL 去掉 EXPRESSION 回退、PG 列名改回 join pg_attribute，
    三次都精确变红。
- [x] 查看视图定义、函数、触发器和序列
  - 视图定义与触发器已完成（`b414e45`）。
  - **视图**：三方言都有权威原文。PostgreSQL 在这一点上和建表语句正好相反——
    没有 `SHOW CREATE TABLE`，但 `pg_get_viewdef` 是服务器自己反解的 SELECT。
    PG 的定义查询只匹配 `relkind IN ('v','m')`：查视图给定义，查表返回 0 行。
    MySQL / SQLite 不需要新查询，`SHOW CREATE TABLE` 对视图返回 `Create View`、
    `sqlite_master` 按 tbl_name 也能查到。
  - **触发器**：形态不统一就不强行统一。PG / SQLite 给完整 CREATE TRIGGER
    原文；MySQL 只给拆开的组件，界面把时机与事件标成 `BEFORE INSERT`、语句体
    单独显示。不把组件拼成 CREATE TRIGGER——拼出来的未必能执行，那是伪造原文。
    PG 必须排掉 `tgisinternal`，否则每张带外键的表都凭空多出几条触发器。
  - 函数、存储过程、序列已完成（`0895bf2`）：对象树按类型分组后列出，点击
    弹出定义。函数可以重载，标识用 PostgreSQL 的 oid 而不是名字，否则点开
    两个重载会看到同一份定义；显示名带参数签名，否则它们在树里长得一样。
    序列没有 `CREATE SEQUENCE` 的反解函数，改为如实列出 pg_sequences 给的
    全部属性，不拼一条可能不等价的语句。
  - 判据：`postgres_returns_the_view_definition_but_not_a_create_table`、
    `postgres_lists_user_triggers_without_the_foreign_key_internals`、
    `mysql_returns_trigger_components_and_the_create_view_statement`、
    `sqlite_returns_view_and_trigger_definitions`。已反向验证：去掉
    tgisinternal 过滤、去掉 relkind 限制，两次都精确变红。
- [-] 查看建表 DDL
  - MySQL 与 SQLite 已完成（`e7b6bc1`）：结构页新增「建表语句」一段，带复制
    按钮，给的是数据库自己吐出来的原文。SQLite 一并取出索引与触发器——
    只给 CREATE TABLE 的话，照着重建出来的表会少掉所有显式索引。
  - **PostgreSQL 当前版本不做**：它没有 `SHOW CREATE TABLE`，从目录重建要
    覆盖类型、默认值、identity、排序规则、存储参数、分区、继承、注释、触发器、
    RLS。少任何一项，产出的就是看起来权威、照着重建却不等价的 DDL——比没有
    更糟，因为没人会去核对它。页面直说这一点。
  - 重估条件（可执行）：`services::schema_metadata::tests::postgres_has_no_ddl_query`。
    哪天真的实现了 PostgreSQL DDL，这条断言会红，逼着回来改掉理由，而不是
    让一个过期的判断留在代码里。
  - 两种取法用枚举区分：`SHOW CREATE TABLE` 不接受占位符，表名必须作为引用过
    的**标识符**插进去；`sqlite_master.tbl_name` 是**字符串字面量**，走绑定
    参数。两种引用规则不同，混用会在含特殊字符的表名上出错。
  - 判据：`mysql_returns_the_authoritative_create_table_statement` 钉住列名
    字面就叫 `Create Table`（带空格）、类型是 VARCHAR；
    `sqlite_returns_create_table_together_with_its_indexes` 钉住建表语句排在
    索引之前、自动约束索引不重复出现。
- [x] 新建和修改表结构
  - **修改**（`2ba8ac6` / `4efbc3d` / `0d0a399`）：结构页的列表格可以直接编辑
    ——改列名、改类型、改可空、改默认值、加列、删列、改表名。
  - **新建**（`5c9fb17`）：对象树标题栏的加号，填表名、列、主键，预览之后执行。
    主键写成表级 `PRIMARY KEY (a, b)`（复合主键只有这一种写法），主键列一律
    NOT NULL——三家里只有 SQLite 允许主键存 NULL，照着建出来的表会有一行谁也
    定位不到。没有主键不拦着，但界面上说清那样的表在这里只能看。
    建表不碰已有数据，风险和一条 INSERT 同级，不走二次确认。
  - 前置：列目录此前会说假话。PostgreSQL 把 `text[]` 报成 `ARRAY`、
    `varchar(32)` 报成 `character varying`；更严重的是自增主键——
    `GENERATED ALWAYS AS IDENTITY`（已在 PG 16 上复现）与 `AUTO_INCREMENT` 的
    `COLUMN_DEFAULT` 都是 NULL 且非空，于是新增行时被当成必填项点名，
    **那两种表一行都插不进去**。加了 `is_generated`，三段 SQL 一并搬进
    `services/schema_metadata.rs`——只有住在 Rust 侧才测得到。
  - 三种方言不强求一致，差别全在**能不能只改被点名的那一项**：
    PostgreSQL 有窄子命令，照着发；MySQL 只有 `MODIFY COLUMN <整段定义>`，
    重述时把排序规则、注释、AUTO_INCREMENT、ON UPDATE 一起带上；
    SQLite 的 ALTER TABLE 只有四种形态。
  - **MySQL 一律合成一条 ALTER TABLE**：它的 DDL 会隐式提交，事务兜不住，
    多条就不再是原子的。另两家的 DDL 在事务里，多条由 `execute_write_batch`
    兜住。删列排在加列之前——删掉 `code` 再建一个同名的是合理编辑，
    反过来的次序在三家里都会撞上「列已存在」。
  - **当前版本明确不做**的两类，理由都写在界面上：
    - SQLite 改类型 / 可空 / 默认值：要按官方步骤重建整张表，而重建脚本必须
      连索引、触发器、视图和外键一起覆盖——与 PostgreSQL 建表 DDL 不做是同
      一个理由。重估条件：哪天真的实现了那十二步并有真库测试覆盖索引与触发
      器的保留。
    - MySQL 上带表达式默认值或计算列的列改类型：目录里的表达式是归一化后的
      形式（实测 `DEFAULT (UPPER('x'))` 存成 `upper(_utf8mb4\'x\')`），
      重述出来的未必等价。重估条件：能从 `SHOW CREATE TABLE` 拿到该列定义的
      权威原文并有真库测试证明重述前后等价。
    - 主键、索引、约束的增删改：不在这一版，界面上直说「请到 SQL 编辑器」。
  - 判据：`utils/tableDdl.test.ts` 按方言钉住语句原文与次序；
    `fixtures/ddl-conformance.json` 是两侧共用的语料，
    `{postgres,mysql,sqlite}_runs_the_generated_ddl_from_the_shared_corpus`
    拿真库建表、跑同样几条语句、再读一遍列目录核对结果，连语料里的 `origin`
    也是断言而不是假设。建表那三条用例每条多一步——**不写主键值插一行**：
    三家的自增写法各不相同，而写错的表现不是建表失败，是建出来了但插不进行。
  - 已反向验证六次：去掉重述里的 COLLATE 并**同步改掉语料里的语句**（模拟
    「忘了重述，顺手改了期望」），前端全绿而真库那一侧精确变红——排序规则
    掉回了表默认值；去掉「主键列一律 NOT NULL」，前端三条建表用例全红且
    SQLite 的主键变成可空；另有四次针对列目录的注入（format_type 去掉
    typmod、MySQL 换回 DATA_TYPE、去掉 attidentity / EXTRA、SQLite 换回
    table_info）。
- [x] 所有 DDL 变更先生成预览 SQL
  - 结构编辑器不给「保存」，只给「预览 SQL」：改数据错了还能再改回来，
    一条 DROP COLUMN 没有对应的撤销。
  - 预览框里三块内容各回答一个不同的问题，所以不合并：**会丢什么**（删掉的
    列）、**会跑什么**（语句原文）、**哪几项做不到**（方言限制，带理由）。
    只给一段 SQL 的话，第一件事要靠读语句自己看出来，第三件事根本看不出来
    ——用户会以为他勾掉的那个「可空」已经改了。
  - 手写的 DDL 不进这条路径，也不需要：编辑器里的语句原文本来就是预览。
- [x] 危险 DDL 明确显示影响对象并二次确认
  - 复用 `DestructiveStatementPrompt`，新增可选的 `impacts`：删列时逐条列出
    「删除列 X，这一列里的数据一并丢掉」。只给 SQL 原文不够——一条
    `ALTER TABLE t DROP COLUMN a, DROP COLUMN b` 要从语句里数出来，
    而这个框存在的理由正是让人**不必**现场读懂一条 SQL。
  - 风险等级由计划算，不从语句文本再猜一遍：有删列就是 `destructive`，
    否则 `scoped-write`，然后过已有的 `requiresConfirmation` 与环境阈值。
    按文本猜会把 `ALTER COLUMN x DROP NOT NULL` 里的 DROP 也算成破坏性，
    而多余的确认弹到第三次就没人看了。
  - 顺带修正 `risk.destructive` 的文案：原文只说「删除表或清空数据」，
    而 `ALTER … DROP` 一直也归在这一级。

### 3.2 事务控制

全部完成于 `74855a2`。`contracts/session.ts` 里的 `TransactionContext` 从 P1
起就声明着、从没被读过也没被写过，这一轮把它填上。

- [x] 支持自动提交开关
  - 关掉之后，不在事务里的语句前面补一条 `BEGIN`。**客户端做**，不用服务端
    开关：PostgreSQL 根本没有服务端的自动提交设置（psql 的
    `\set AUTOCOMMIT off` 与 JDBC 的 `setAutoCommit(false)` 都是客户端行为），
    SQLite 也没有。
  - 用户自己写的 BEGIN / COMMIT 前面不补——SQLite 会直接报嵌套事务，而在
    COMMIT 前面补一条 BEGIN 是开一个立刻提交的空事务。
  - 目录与表数据的读取一律自动提交：浏览一张表不该让状态栏凭空亮起
    「事务中」。事务已经开着时它们照样落在同一个事务里——同一条连接，
    避不开，也正确。
  - 判据：`turning_autocommit_off_puts_a_plain_statement_inside_a_transaction`
    断言回滚真的能把那一行撤掉。已反向验证：去掉隐式 BEGIN 精确变红。
    只把状态栏点亮而语句仍各自提交，是最糟的形态——界面说在事务里，
    按回滚却什么也没撤销。
- [x] 支持开始、提交和回滚事务
  - 就是三条普通语句，走同一条执行路径，不另开命令。
  - 但**不过风险确认**：按钮本身就是确认，再弹一次是「弹到第三次就没人看了」
    的另一种写法。
  - **废掉的事务不能提交**：PostgreSQL 对 aborted 事务的 COMMIT 照常返回
    成功，做的却是回滚。工具栏那个按钮禁用，离开对话框里直接不出现。
    留着它等于让人按下「提交」之后以为数据存进去了。
- [x] 事务固定绑定同一个实际 Session
  - 本来就是：`QuerySessionState` 按 session id 扣住一条 `SessionConnection`，
    `keeps_transaction_statements_on_the_same_sqlite_connection` 从 P1 起就
    钉着这件事。这一轮补的是**让它看得见**。
- [x] 状态栏持续显示事务状态和开始时间
  - 权威在 Rust：三种方言都没有可移植的「我在不在事务里」查询（PostgreSQL 的
    `txid_current_if_assigned()` 对只读事务返回 NULL，MySQL 没有对应的会话
    变量，SQLite 的 `sqlite3_get_autocommit()` 在 sqlx 里取不到），而 session
    连接看得见在它上面跑过的**每一条**语句，包括用户自己写的 `BEGIN`。
    前端每执行完一条语句（成功和失败都）问一次，查的是内存里的值。
  - 只有**执行成功**的语句才改状态：一条失败的 BEGIN 什么也没开。
  - 三处容易写错、都钉了测试：`ROLLBACK TO SAVEPOINT` 不结束事务；
    已经在事务里再 BEGIN 保持最初的开始时间（覆盖成现在会让计时凭空归零）；
    读不出开始时间时不显示计时，而不是显示 00:00——后者看起来像一个刚开始
    的事务。
  - 「事务已失败」**只有 PostgreSQL 有**，拿真库钉住了两边：
    `postgres_aborts_the_whole_transaction_after_one_failed_statement` 与
    `mysql_keeps_the_transaction_usable_after_a_failed_statement`。
    已反向验证：让 `aborts_transaction_on_error` 对所有方言返回 true，
    MySQL 那条精确变红。
- [x] 关闭标签、切换连接或退出应用时处理未提交事务
  - 挂在三条**用户自己发起**的路径上：切换连接、断开、退出应用。网络掉线那
    几条不问——连接已经没了，问「要不要提交」是在骗人，所以内部走不经过闸的
    `disconnectNow`。
  - 三选一（提交 / 回滚 / 留下）而不是「确定/取消」：断开会让数据库把整个
    事务回滚掉，而用户此刻最可能想做的恰恰是**提交**它。只给「确定要断开吗」
    等于逼他先取消、自己去按提交、再断开一次。
  - 状态在弹框前**当场重读**：拿一份旧状态弹框，是在为一件已经不存在的事拦人。
  - 关闭 SQL 标签不在这条路径上，因为它不释放 session——事务跟着连接，
    不跟着标签。

### 3.3 执行计划与诊断

解析放在 Rust（`services/explain.rs`），理由和目录查询一样：三种返回的形状
只有拿真库跑一遍才知道对不对。三份 JSON / 行集先抄下来再照着写——照文档猜
写出来的解析器能跑通、画出来的树是错的，而错的树和对的长得一样。

**只发一次 EXPLAIN**：不额外取一份 `FORMAT TEXT` / `FORMAT=TREE`，带 ANALYZE
时那等于把查询再跑一遍。「原文」那一页给数据库返回的原文。

- [x] 支持 PostgreSQL `EXPLAIN` / `EXPLAIN ANALYZE`（`66bb849` / `02d396b`）
  - `EXPLAIN (VERBOSE, FORMAT JSON)`，带 ANALYZE 时加 BUFFERS——知道读了多少
    块才看得出慢在 I/O 还是 CPU。
  - 估算行数与实际行数是**两个字段**：把 285 显示成实际行数，整张图的意义
    就反了。没 ANALYZE 时实际值是 `null` 而不是 0。
- [x] 支持 MySQL `EXPLAIN`
  - `EXPLAIN FORMAT=JSON`。它的形状是**用键名表示操作**的不规则嵌套对象，
    所以不枚举词汇表（ordering_operation / grouping_operation /
    duplicates_removal…）：那份清单每个大版本都在长，漏一个就整棵子树不见。
    通用规则是「嵌套的对象/数组一律是子节点，标量是细节」。
  - **MySQL 的 EXPLAIN ANALYZE 当前版本不做**：它只出 TREE 那种缩进文本，
    要再写一个按缩进认层级的解析器，而这一条要的是「支持 MySQL EXPLAIN」。
    不支持时请求 analyze **直接报错**，不悄悄降级——降级会让界面说
    「真的跑了一遍」而给的是估算值。重估条件（可执行）：
    `services::explain::tests::only_postgres_can_really_run_the_plan`。
- [x] 支持 SQLite `EXPLAIN QUERY PLAN`
  - 扁平行靠 `parent` 指针组成树。`id` 是 VDBE 地址不保证连续，认不到父亲的
    行当成根而不是丢掉——静默少一步，没有任何地方会说这是为什么。
  - SQLite 没有「真实执行的计划」：裸 `EXPLAIN` 给的是 VDBE 字节码，不是同
    一回事。界面把开关禁掉，而不是给一个按了会报错的按钮。
- [x] 提供文本和树形执行计划
  - 树形是解析出来的结构，可展开每个节点的全部字段；文本是数据库返回的原文。
  - 树上只指认**一个**节点：估算与实际差了一个数量级以上的那个。指出十个
    「可疑」节点等于没指出任何一个，所以同一档里只挑实际行数最多的——差
    100 倍的 10 行和差 100 倍的一百万行不是同一件事。没跑过的计划一个也不
    指认：没有实际值可比时标成「准确」，正好把这个提示最该说话的场合变成沉默。
- [x] 对 `ANALYZE` 的真实执行风险进行明确提示
  - 分两句说：自动提交开着时，它写进去的东西**当场就提交了**，没有回滚的
    机会；关掉之后可以跑完再回滚——正好接上 3.2 那个开关。
  - 普通 EXPLAIN 不走风险确认：它什么也不执行，为它弹一次确认，弹到第三次
    就没人看了。
- [x] 保存慢查询诊断信息，但不默认保存敏感结果（`a7757ab`）
  - 「不保存敏感结果」本来就成立：历史从不存结果行，只存 SQL（口令已脱敏）、
    耗时、行数、错误。这一轮把它写进设置页的说明——一件只存在于代码注释里的
    保证，用户无从知道。
  - 新增：慢查询阈值（默认 1 秒，可关）；到了阈值的记录**不参与按时间淘汰**，
    和收藏过的一样；历史对话框可以只看慢的。总条数上限仍然管着，不会把
    localStorage 配额吃光。
  - 不存「当时算不算慢」的布尔，筛的时候现算——存下来的话，阈值从 1 秒调到
    200 毫秒之后那些 400 毫秒的记录仍然不见。
  - 取消与超时不算慢查询：它们的耗时说的是「用户等了多久」或「闸门设了多长」。
  - **不在慢查询之后自动抓执行计划**：那是一次藏起来的往返，它自己也可能很慢，
    带 ANALYZE 更等于把刚跑完的语句再跑一遍。要看就从历史里打开那条语句。

判据：`services::explain` 13 条单测（两份 JSON 是从真库抄下来的）、
`utils/planInsights.test.ts` 11 条、
`{postgres,mysql,sqlite}_explain_*` 三条冒烟测试。
已反向验证：关掉 MySQL 单键包装的拆包，单测与冒烟测试都精确变红——冒烟测试
第一版只断言「两张表出现过」，注入时照样绿，改成钉住 `nested_loop` 的直接
子节点之后才红。

### 3.4 导入与高级导出

- [x] CSV 导入向导
  - 三步：选文件与读法 → 字段映射 → 策略与执行。预览只读开头几十行，
    导入时从头再流式读一遍——文件可能有几百 MB，全程内存里只有当前这一批。
  - **分隔符是嗅探出来的，判据是「哪个切出来的行列数整齐」**，不是「哪个
    出现得多」：一段中文里逗号可以比分号多，但用它切出来每行列数都不一样。
    采样按字节截断，不以换行结尾时最后一条记录是半行，不参与投票。
  - CSV 的读取端用了 `csv` crate。导出端的转义是十几行，读取端不是：带引号
    的字段里可以有分隔符、换行和成对的引号，还要能报出每条记录的行号。
    这部分是已经被解决的问题，真正要写的是映射、批次与错误行处理。
  - **嗅探那条门第一版是假绿**：回落值就是逗号，拿逗号做断言无论对错都绿。
    改用制表符之后注入才真的红。
- [x] 字段映射和类型预览
  - **按目标列组织，不按 CSV 列**：写进语句的是目标列的清单，而「这一列不
    导入」是个真实的选择。反过来按 CSV 列组织的话，两个 CSV 列指向同一个
    目标列是个能表达出来的状态，而它没有意义。
  - **配不上就留空，不按位置猜**。按位置对齐在列序恰好一致时很省事，在不
    一致时会把整张表的数据错位写进去——而错位的导入看起来是成功的。
  - 由数据库产生的列（自增、identity、计算列）默认不导入：往
    `GENERATED ALWAYS AS IDENTITY` 里写值，PostgreSQL 会拒绝整条语句。
  - 类型预览挑的是**不合类型的那个值**而不是第一个非空值。渲染时才发现：
    挑第一个非空值会让屏幕上出现一个看着没问题的样例，底下却挂着一条说
    这列有坏值的提醒。
- [x] 批量大小、事务策略和错误行处理
  - 策略两档：整份一个事务 / 每批一个事务。错误行两档：停下 / 跳过并继续。
    两个维度正交，靠**保存点**做到：每批一个保存点，出错就退回去逐行重放。
  - 这是整个模块的核心：多行 INSERT 出错时数据库只说「这条语句失败」，
    不说是哪一行。逐行重放让坏行自己暴露出来，而代价只在真的含坏行的批次
    上付。PostgreSQL 还额外需要它——一条语句报错之后整个事务就废了，不退回
    保存点，坏行后面的每一行都会跟着失败。
  - **中止策略下也要逐行找一遍**：「第 12000 行的日期格式不对」和「这一批
    失败了」是两种可用性。
  - 值一律当文本绑定，不拼进 SQL。类型转换交给数据库：MySQL 与 SQLite 自己
    会转，PostgreSQL 不会，那边的占位符写成 `$1::text::integer`——只写
    `$1::integer` 的话 PostgreSQL 会把参数本身推断成 integer。目标类型会被
    拼进 SQL，所以它有一道字符白名单。
  - 一条语句的行数受占位符上限（32766）约束，按列数换算；列多的表上这个值
    会小于用户选的批量大小，超了数据库直接拒绝整条语句。
  - **真库教的**：MySQL 的预处理协议不收 `BEGIN` 与 `SAVEPOINT`，报 1295
    「This command is not supported in the prepared statement protocol yet」，
    一句完全不指向真正原因的错。事务与保存点控制因此走 `execute_unprepared`。
- [x] 导入前验证，导入后提供成功/失败统计
  - 检查分两档，**这个区分才是它的意义**：`error` 是现在按下去一定失败的
    （必填列没映射、写进由数据库产生的列），它禁用「开始导入」；`warning`
    是「可能不是你想要的」。把后者也做成拦截，就会在 `2026/01/02` 这种
    MySQL 其实收得下的值上挡住一次正常的导入。
  - 「不给值就插不进去」的判断提到了 `cellInput.isRequiredColumn`：新增行
    与 CSV 导入问的是同一个问题，规则只该有一处。
  - 统计带**文件里的行号**与原始字段值——要改的是文件，不是数据库。
    错误行最多记 100 条：一个列错位的文件能让每一行都失败。
  - **字段少一格是这一行坏了，不是「缺的当 NULL」**：短一格通常意味着这一
    行的值全都往前挪了一位，补 NULL 会把错位的数据静静写进库里。
  - 解析错误（引号没闭合、不是 UTF-8）在两种策略下都中止：`on_error` 说的
    是「数据库拒收的行」怎么办，而这是文件读不下去，后面的行号全对不上。
- [x] 导出表、查询和选中行
  - 表与查询本来就能导，这次补上**选中行**。选区是个矩形，导出的是这个矩形
    而不是「这些行的全部列」——后者会把用户没框进去的列也写进文件，范围说明
    里因此直接写出 N 行 × M 列。
  - 渲染时抓到：预览上方写着「文件里是全部 4 行」，而选中的只有 2 行。
- [x] 后台任务支持暂停、取消、重试和日志
  - 任务活在 store 里，对话框只负责把请求交出去然后关掉。浮动面板在真有任务
    时才出现：任务是从各处发起的，不属于任何一个标签页。
  - **只有导入能暂停**。导出的行是在一个同步回调里写出去的，那里没法等；
    导入的批次循环是我们自己的 async 循环，停在两批之间是干净的。单事务
    策略下暂停意味着那个事务一直开着，面板上直接说出来。
  - **留下了东西就不能重试**。成功的导入重跑一遍是重复写入；分批提交下被
    取消的导入，前面的批次已经在表里。导入失败时这一位由策略决定：单事务下
    报错意味着那个事务从没提交过。按钮是禁用而不是隐藏，鼠标停上去说明为什么。
  - 日志有上限，满了丢最早的并留一句「丢过」——悄悄丢掉会让人以为前面什么
    都没发生过。
  - **不做**：任务不跨进程存活（关掉应用就没了）。要做就得把「导了一半」
    这个状态持久化，而恢复它需要知道文件读到第几行、哪些批次已提交——
    这份账目本身比重跑一遍更容易出错。重估条件：出现「导入跑了几十分钟被
    应用崩溃打断」的真实反馈。

### 3.5 ER 图

- [x] 从真实外键元数据生成关系图
  - 完成于 `9b63f19`。所有表都画出来（含没有外键的），每张列出全部字段与
    类型，有外键的表之间按**具体字段**连线。
  - **改成库级标签页**：原来的 ER 标签在 TableDataViewer 里，是个写死的
    「开发中」占位。挂在某张表下面等于说「这是这张表的关系图」，而它不是。
  - 查询在 `services/er_diagram.rs`，三方言各自的要点：MySQL 取
    `COLUMN_TYPE`（`DATA_TYPE` 丢掉长度）并排掉视图；PostgreSQL 用
    `format_type` 并排掉系统列与已删除列墓碑；SQLite 用 pragma 表值函数
    一次查完整库。三个冒烟测试都专门建了一张与谁都无关的表并断言它出现。
- [x] 没有外键时明确说明，不猜测关系
  - 顶栏写明「N 张表 · M 条关联」，并单独标出其中多少张没有外键关联。
    孤立的表照常画出来，不去猜它和谁有关系。
- [x] 支持自动布局、缩放、搜索和导出图片
  - 自动布局与缩放已完成：布局是纯函数（`utils/erLayout.ts`），按连通分量
    分组、按外键方向分层（被引用的在左），孤立的表排成网格而不是一长列。
    缩放有按钮与「适应窗口」，画布可拖动平移。
  - 判据：23 条单测，其中三条反向验证过——任意两节点不重叠、每张表都有
    节点、被引用的表在左边。布局先按 key 归一，与输入顺序无关：不稳定的
    布局每次刷新都换个样子，没法对照着看。
  - 踩过一次假绿：「悬空引用被忽略」最初只断言没有幽灵节点，而那是被下游
    一个 `if (!table)` 兜住的，删掉过滤照样绿。改成「有悬空边与没有这条边
    的布局必须完全一致」才真的红，同时删掉了那个不可达分支。
  - 搜索已完成（`245ced9`）：表名与列名都参与匹配——找一张表常常是从
    「哪张表有 customer_id 这一列」开始的。命中的列整行高亮；未命中的表
    **压暗而不是隐藏**，藏起来会让图的形状跟着变，反而认不出剩下的是哪几张。
  - 导出与拖动已完成（`034a472`）：
    - **导出为 SVG**。颜色来自 Tailwind 类，直接存 `outerHTML` 在应用外打开
      是一张黑白线框；导出时把每个元素**当前计算出来的**颜色写成行内属性，
      于是导出的是「此刻看到的样子」，深色模式也对。另外补背景矩形（SVG 默认
      透明）、丢掉屏幕平移（那是视图状态）、写上 xmlns。走已有的
      `write_text_file`——SVG 是文本，不需要为它加二进制写入命令。
    - **卡片可自由拖动**。存偏移量而不是绝对坐标：布局在结构变化后会重算，
      存绝对坐标的话挪过的框会留在原地和别人叠住。位移除以缩放比例，否则
      缩得越小越拖不动。画布尺寸把拖出去的框算进来。
    - **PNG 导出**已完成（`49a2c86`）：新增 `write_binary_file` 命令，内容按
      base64 传——用 JS 数字数组传 `Vec<u8>` 经 IPC 会把体积撑到四倍。
      光栅化走 `<img>` + canvas，喂的是已内联颜色的那份 SVG（正因为自包含，
      画出来才不是白纸）；data URL 用 `encodeURIComponent` 而非 `btoa`，
      后者只吃 Latin-1，一个中文表名就会抛 `InvalidCharacterError`。2 倍分辨率。
    - 验证不是只看魔数——一张白纸也是合法 PNG。把导出的 base64 塞回 `<img>`
      渲染出来核对，深浅两种主题各导一张。
    - **PDF 导出**已完成（`5b32125`）：内嵌位图而非矢量。矢量 PDF 的文字要靠
      PDF 字体，基础 14 号字体只有 Latin-1——一个中文表名就会乱码或消失；
      随包嵌 CJK 字体是几 MB 的代价，为一个导出功能不划算。需要矢量用 SVG。
    - 不引入 PDF 库（jsPDF + svg2pdf 约 350KB）：单图 PDF 结构固定且很小，
      手写约 120 行。前提是它可验证——验证分三层：11 条单测直接查字节偏移
      （四次反向注入都精确变红）、Chromium 的 PDFium 打开看、再用 poppler 的
      `pdfinfo` 复核。最后一层是必要的：PDFium 在 xref 坏掉时会悄悄重建，
      poppler 会直接抱怨；把偏移故意 +3 后它确实报了
      「xref num 1 not found but needed」。
    - 图像走 JPEG + `/DCTDecode`（字节可原样内嵌，不需要浏览器端 zlib；
      `/FlateDecode` 要依赖 `CompressionStream`，旧 WebKit 没有）。
      页面尺寸取 1 像素 = 1 点，不凑 A4——关系图的比例不是纸张比例。
- [x] 结构变化后自动刷新
  - 能做到什么要说清楚：数据库**不会推送**「结构变了」这件事——PostgreSQL 的
    LISTEN/NOTIFY 要自己装事件触发器，MySQL 干脆没有。所以做不到推送式实时。
  - 做到的是**我们自己执行的 DDL 立刻反映出来**（`245ced9`）：编辑器里
    CREATE TABLE，对象树与 ER 图同时更新。`changesSchema()` 复用
    `topLevelKeywords`，跳过字符串与注释、不看子查询，`SELECT 'CREATE TABLE'`
    不触发；只在语句**成功之后**加版本号，失败的 DDL 什么也没改。
  - 外部改动（别人在另一个客户端改了结构）靠 ER 图上的重新读取按钮。
  - **不做轮询**：每隔几秒对整库查一遍列和外键，代价随表数增长，而收益只是
    把「点一下刷新」省掉。要做也该是用户显式开启的选项，不是默认行为。
- [x] 支持按 Schema、表和关系过滤
  - **过滤与搜索是两件事**，这个区别是整条特性的前提：搜索压暗（保住图的形状，
    不然剩下的几张表认不出原来在哪），过滤删掉（它的整个用处就是让图变小——
    两百张表的库里，把不相干的压暗仍然什么都看不清）。所以过滤在**布局之前**
    生效，表少了布局跟着重算。
  - 三个维度落在一个纯函数 `filterErDiagram` 上：
    - **Schema**：先划范围，后两步都在这个范围内谈。只有一个 schema 时界面上
      不给这个选择；没有 schema 的方言归一成空串，不单开 null 分支。
    - **表**：以某张表为中心。
    - **关系**：从中心按连线走 N 跳（1/2/3）。**方向不算数**——「谁引用了我」
      和「我引用了谁」都是关系，只看一个方向会漏掉一半。另有「只看有关联的表」，
      判据是「在**这张图里**没有连线」而不是「在整个库里没有外键」。
  - 两处「宁可空也不要骗人」：连线最后统一收一遍（留着指向已被排掉的表的连线，
    顶栏那句「N 条关联」就成了假话）；焦点表自己被 schema 排掉时返回**空图**
    而不是忽略焦点，空图上给一句说明和「清除过滤」。
  - 焦点表自己没有连线时不会被「只看有关联的表」藏掉——把用户刚点中的那张表
    藏掉，剩下一张空图，没人能理解发生了什么。
  - 顶栏在过滤生效时写出分母：「3 张表（整库共 6 张）」。「图上只有三张表」
    和「这个库只有三张表」必须一眼分得开。
  - 渲染时补的一处：过滤之后图整个换了形状，而平移是「在旧的那张图上的位置」，
    往右拖过的人会看到一片空白。过滤一变就把平移归零；缩放不动，那是用户
    明确选的。
  - 判据：14 条单测，四次反向注入各自精确变红——单向邻接、不收断掉的连线、
    忽略被排掉的焦点、藏孤立表时不保焦点。

**P3 退出标准**

- [x] 核心关系型数据库具备常用对象浏览、事务、执行计划、导入导出和结构变更能力
- [x] 高风险操作均可预览、取消或回滚，并有明确状态反馈
  - DDL 先出预览 SQL，危险 DDL 列出受影响对象并二次确认；写入走一个事务，
    行数对不上就整批回滚；导入可选整份一个事务，失败一行都不留下；
    长任务在后台任务里有进度、取消与日志。

---

## P4：外围功能与数据库扩展

### 4.1 能力声明与适配器体系

- [ ] 定义数据库能力清单：Schema、事务、取消、分页、解释计划、行编辑等
- [ ] UI 根据能力声明展示功能，不使用散落的数据库类型分支
- [ ] 建立方言适配器：标识符引用、参数占位符、类型映射和元数据查询
- [ ] 数据库类型标记为“已支持 / 实验性 / 计划中”
- [ ] 未实现的数据库不能以可用连接类型展示

### 4.2 扩展关系型与分析数据库

- [ ] 评估并接入 DuckDB
- [ ] 评估并接入 ClickHouse
- [ ] 为每个新数据库补齐连接、元数据、执行、分页、导入导出和测试
- [ ] 新数据库达到核心验收标准后才能标记为“已支持”

### 4.3 非关系型数据库专属工作区

- [ ] MongoDB 使用文档浏览与查询模型，不复用 SQL 表格写入模型
- [ ] Redis 使用键空间、类型和值浏览模型
- [ ] Neo4j 使用 Cypher 和图结果模型
- [ ] Elasticsearch 使用索引、Mapping 和 Query DSL 模型
- [ ] 每种数据库拥有独立能力声明和交互设计

### 4.4 可选外围能力

- [ ] 数据结果快速图表
- [ ] 连接和查询模板
- [ ] SSH Tunnel
- [ ] 代理与网络诊断
- [ ] 插件或扩展机制评估
- [ ] 可选的团队配置同步，默认不上传凭据和数据

**P4 退出标准**

- 新数据源不再通过继续增加 `switch` 分支接入
- 每种数据库使用符合自身模型的工作区和操作语义

---

## P5：最终 UI、交互与桌面体验

> 本阶段不是最后才修所有 UI 缺陷。影响可用性和错误反馈的问题应在对应功能阶段完成；本阶段负责统一视觉语言和完整桌面体验。

### 5.1 工作区布局

- [-] 将欢迎页改为最近工作区、最近连接、新建连接和打开 SQLite 文件
  - 已完成（`8dba259`）：最近连接（按本机真实使用时间排序）、新建连接、
    打开 SQLite 文件。六张功能宣传卡与装饰性渐变已删除。
  - 「最近工作区」未做：工作区本身已由快照自动恢复，是否还需要在欢迎页
    再列一遍，等多工作区概念落地后再定。
- [x] 接通首页“连接到数据库”按钮
  - 连接流程抽到 `useProfileConnector`，与侧边栏共用同一份实现，包括未保存
    密码时转去输入本次会话密码。
- [-] 左侧对象树、编辑器和结果区支持拖动调整
  - 已完成（`c983497`）：侧边栏 200–560px、编辑器高度 96–640px，双击分隔条
    恢复默认。分隔线 1px、命中区 5px。
  - 结果区之间（多条语句的结果）暂未支持单独调整。
- [ ] 支持隐藏、折叠和恢复面板
- [-] 持久化窗口尺寸、分栏比例和标签布局
  - 分栏比例已持久化（`c983497`，localStorage，读出时按当前上下限再夹一次）。
  - 窗口尺寸由 tauri-plugin-window-state 负责；标签布局由工作区快照负责。
- [x] 减少重复标题和状态条，把空间优先留给编辑器与数据
  - 侧边栏（`388824f`）：未连接时的 48px 图标加三行欢迎文案收成一行，
    头部下拉从 75px 收到 32px。
  - SQL 编辑器（`fb75b57`）：头部 66px → 46px，去掉「SQL编辑器」大标题；
    语句卡片每条约 104px → 33px，删掉卡片体里与编辑器重复的 SQL 代码块。
  - 编辑器与结果区的比例现在由用户拖动决定（`c983497`）。

### 5.2 设计系统

- [-] 建立颜色、间距、字号、圆角、阴影和层级变量
  - 颜色与圆角已完成（`1cdcd61`）：`src/index.css` 以 `@theme inline` 暴露
    surface / fg / line / accent / success / warning / danger 一组语义 token，
    圆角收敛为 control 与 panel 两档。14 个组件一次性转换完毕，不再出现
    `gray-500` 这类调色板刻度。
  - 间距、字号、阴影、层级尚未 token 化。
- [x] 完成全局浅色、深色和跟随系统主题
  - 三档偏好存 localStorage，`initializeTheme()` 在首次渲染前落地避免闪白，
    `system` 档通过 `matchMedia` 订阅运行期跟随系统切换。
  - 深色模式靠同名变量换值实现，组件不挂 `dark:` 变体。
  - `designTokens.test.ts` 直接解析样式表守住「新增 token 忘了深色值」这个
    唯一会静默出错的方向。
- [-] 统一成功、警告、错误、运行中、只读和生产环境状态
  - 语义色已统一到 token；状态本身（运行中 / 只读 / 生产环境）的呈现规则未做。
- [ ] 支持紧凑、标准和舒适密度
- [x] 支持中文与英文，可扩展到更多语言
  - 完成于 `0ef84b5`、`b8ecab6`、`e7b9d9e` 三批，共 401 条文案键。
  - **不引入 i18n 库**：需要的只有「按键取文案 + 占位符替换 + 语言偏好」。
    自己写三十行换来的是类型上的完整性——中文是源语言，`en.ts` 声明成
    `Translations`，少一个键或多一个键都是**编译错误**。加第三种语言时
    `const ja: Translations = {...}` 同样受这层保护。
  - 三道门（都反向验证过会红）：键集合一致（编译期 + 一条测试兜住 any
    绕过）、占位符跨语言一致（漏掉 `{count}` 界面上数字凭空消失）、
    英文里不许残留中日韩字符（漏翻不触发任何报错）。白名单只有语言名本身。
  - **标签标题带文案键**：`WorkspaceTab.titleKey` / `titleParams` 存进快照，
    切换语言后已经打开的标签跟着变。表名不翻译，所以没有键。
  - 模块级常量（对象类型、环境标识、风险等级、数据库分类）一律存**键**，
    翻译由调用方给——它们用不了 hook，而纯函数不该依赖当前语言。
  - React 之外用 `translateNow()`，取调用那一刻的语言；挂载时注册、很久
    以后才触发的回调也用它。
  - **未做**：后端 Rust 的错误文案仍是中文。要正确翻译需要把 `Err(String)`
    改成错误码再在前端映射，那是独立的一块工作。英文界面下后端报错会是中文。
  - **不翻译**：`contracts/` 里的状态机不变量报错。那是开发者诊断，
    用户不该看到；翻译意味着每加一条不变量都要写两份文案，收益为零。
- [-] 统一按钮、输入框、表格、标签、弹窗、通知和空状态
  - 表格（`a2d3a93`、`3a907e0`）：两个网格统一为按内容估算列宽、可拖动调整、
    双击恢复自适应；行高 44px → 33px；数值列整列右对齐；NULL 统一呈现；
    点表头按「升序 → 降序 → 取消」三态排序；分页档位合并为一份。
    数据单元格改用 13px 等宽字体——列宽模型只有在等宽下才成立。
  - 连接表单（`01bcca1`）：头尾常驻、只有表单体滚动——此前整张卡一起滚，
    点底部的「测试连接」而结果画在顶部，等于看不见；反馈移到底栏紧贴按钮。
  - 未做：按钮与输入框尚未抽成基础组件，各处仍在重复同一串 class。
- [x] 移除仅用于宣传的装饰，保持低干扰、高信息密度
  - 欢迎页六张功能卡、渐变大标题、三团高斯模糊光斑已删除（`8dba259`）。
  - SQLite 路径框下 25 行的蓝底说明框已由文件选择按钮取代（`01bcca1`）。

### 5.3 桌面交互

> 说明：界面改动必须实际渲染出来看。`388824f` 那一轮的三个缺陷——表单以
> 编辑模式打开一个 MouseEvent、侧边栏与启动面板重复同一段文案、悬停在深色
> 下反而下沉——typecheck、lint、单测全绿，只有截图能发现。


- [ ] 完整支持 macOS `Cmd` 与 Windows/Linux `Ctrl` 快捷键
- [-] 增加应用菜单和命令面板
  - 命令面板已完成（`cd19ca8`）：⌘K / Ctrl+K 打开，模糊搜索连接、当前连接
    已加载出来的表，以及新建查询标签 / 新建连接 / 打开 SQLite 文件 /
    重新打开最近关闭的标签 / 切换外观。↑↓ 选择（两端回绕）、Enter 执行、
    Esc 关闭，命中字符高亮。
  - 原生应用菜单（macOS 菜单栏）未做。
- [ ] 增加对象树、标签和表格右键菜单
- [-] 完成焦点管理、键盘导航和可访问性标签
  - 表格（`08d7fc2`）：点选单元格，方向键移动，Shift 延伸矩形选区，
    ⌘/Ctrl + 方向键到整行整列尽头，Home / End、⌘A 全选、Esc 清除、⌘C 复制。
  - 未做：对象树与标签页的键盘导航、命令面板。
- [ ] 长任务统一显示运行中、取消请求中、已取消、成功和失败
- [x] 生产连接常驻文字标识，不能只依赖颜色
  - 已完成（`d350d00`）：生产标「生产」、预发标「预发」，文字加颜色；
    开发和测试不标，避免牌子挂满反而失效。
  - 五处都标：侧边栏当前连接与下拉、欢迎页列表、工作台头部、工作区标签页、
    命令面板（写成文字，切库前就能看见）。
  - 环境到标识的映射是完整的 `Record<ConnectionEnvironment, …>`，新增环境
    编译不过。
- [-] 破坏性操作支持明确确认和可恢复策略
  - 明确确认已完成（`d1fe7ae`）：按语句破坏性分级拦截。不带 WHERE 的
    UPDATE / DELETE 与 DROP / TRUNCATE / ALTER … DROP COLUMN 在任何环境都拦；
    带 WHERE 的写入只在生产拦；SELECT 与 INSERT 不拦——见谁都弹窗只会让人
    练出闭眼点确认的肌肉记忆。
  - 判定复用 `topLevelKeywords`，跳过字符串与注释，不把子查询里的 WHERE
    算进来。SQL 编辑器的五个执行入口全部过闸。
  - 可恢复策略（执行前快照 / 撤销）未做。

### 5.4 性能与体验验收

- [ ] 大对象树采用按需加载和虚拟化
  - 现状（`0895bf2`）：一次查完全部对象，按类型分组后渲染。类型分组本身就是
    一层折叠，默认只展开第一组，DOM 规模比此前平铺所有表时更小。
    等遇到「一个库几千个对象」再测数再定。
- [x] 大表格采用行列虚拟化，但不替代服务端数据限制
  - 结论：**当前版本不做**（`8364ffe`）。动手前先测了一个数：最坏情况
    100 行 × 20 列共 2000 个单元格，整次重渲染中位数 25ms，且这个数还包含
    两帧 requestAnimationFrame 的等待，真正的渲染工作远在一帧之内。
  - 原因是两个表格本来就分页（结果表默认 25、表数据默认 50，档位上限 200），
    DOM 规模已被分页钉死，虚拟化解决的是分页已经解决的问题。
  - 重估条件是可执行的：`gridPagination.test.ts` 断言所有档位不超过
    `MAX_UNVIRTUALIZED_ROWS`。加一个更大的档位、或改成无限滚动不再分页，
    那条门就会红，逼着重新测一遍再决定。
- [ ] 定义冷启动、切换标签、展开对象树和滚动性能指标
- [ ] Windows、macOS、Linux 完成安装、升级和卸载验证
- [ ] 完成崩溃恢复、异常退出恢复和无网络场景测试

**P5 退出标准**

- 核心流程可完全通过键盘和鼠标完成
- 状态、错误、连接目标和未提交修改始终清晰可见
- 三平台布局、主题、快捷键和恢复行为一致且通过验收

---

## 发布里程碑

### v0.2：可信查询原型

- [ ] 完成 P0
- [ ] 完成 P1 的连接、查询执行和结果上限
- [ ] README 只声明 MySQL、PostgreSQL、SQLite

### v0.3：可日常使用的关系型数据库 MVP

- [ ] 完成 P1
- [ ] 完成 P2
- [ ] 完成三平台基础安装与冒烟测试

### v0.4：数据库管理工具

- [ ] 完成 P3
- [ ] 建立稳定的数据修改、事务和结构变更流程

### v1.0：稳定桌面客户端

- [ ] 完成 P5
- [ ] P0-P3 无阻塞级缺陷
- [ ] 核心数据库兼容性矩阵和用户文档完整
- [ ] 根据成熟度选择性纳入已完成的 P4 数据源

## 暂不优先

- [ ] 团队实时协作
- [ ] 云端数据同步
- [ ] AI 自动执行写操作
- [ ] 大型 BI 仪表盘
- [ ] 在适配器体系完成前继续增加数据库图标
