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
| P2 | 完成日常数据库工作闭环 | [ ] |
| P3 | 补齐数据库管理与数据工程能力 | [ ] |
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
- [ ] 支持按文本、连接、日期和状态搜索历史
- [ ] 支持收藏、命名和标签
- [ ] 支持保存和打开 `.sql` 文件
- [ ] 设置历史保留周期和容量上限
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


- [ ] 支持服务端排序和筛选
- [ ] 支持列显示/隐藏、调整宽度、冻结列和密度设置
- [ ] 支持复制单元格、行、列和选区
- [ ] 支持 NULL、空字符串和二进制内容的明确展示
- [ ] 支持刷新并保持当前筛选、排序和页面位置
- [ ] 无稳定唯一键的表显示只读原因

### 2.5 可靠的数据修改

- [ ] 从真实约束元数据获取完整主键或唯一键
- [ ] 支持复合主键
- [ ] 查询结果只有能证明映射到单表唯一记录时才允许编辑
- [x] BigInt、Decimal 保持精度，不转换为 JavaScript `Number`
- [x] 时间类型保留时区和数据库语义
- [ ] 为 JSON、二进制、布尔和日期提供专用编辑器
- [ ] 区分 NULL、空字符串、默认值、表达式和未填写
- [ ] 所有变更先进入 `ChangeSet`，不再编辑后立即提交
- [ ] 提供差异预览、逐项撤销、全部撤销和批量提交
- [ ] 使用原始值或版本字段检测并发修改冲突
- [ ] 提交失败时保留待提交变更和完整错误

### 2.6 基础导出

- [x] 导出当前结果为 CSV
- [x] 导出当前结果为 JSON
  - 均完成于 `3483676`。查询结果导出排序后的整份（用户看到的次序就是文件里的
    次序），表数据是服务端分页的、只有当前页，对话框直接写明范围。
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
- [ ] 大结果导出使用后台任务和流式写入
  - 当前不需要：结果集本来就被行数与字节上限钉死在内存里，表数据按页取。
    等 3.4「导出表、查询和选中行」要导出未分页的整表时才成为真问题。
- [ ] 支持取消、进度和失败重试
  - 同上，依赖后台任务化。当前一次写入是同步的一次 `fs::write`，
    失败会把后端原话显示在对话框底栏，重试就是再点一次。

**新增命令**：`write_text_file`。没有引入 `tauri-plugin-fs`——保存对话框返回
任意路径，用插件就得把写权限 scope 开到整个主目录，而这里需要的只有
「写一个文件」。

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
- [ ] 新建和修改表结构
- [ ] 所有 DDL 变更先生成预览 SQL
- [ ] 危险 DDL 明确显示影响对象并二次确认

### 3.2 事务控制

- [ ] 支持自动提交开关
- [ ] 支持开始、提交和回滚事务
- [ ] 事务固定绑定同一个实际 Session
- [ ] 状态栏持续显示事务状态和开始时间
- [ ] 关闭标签、切换连接或退出应用时处理未提交事务

### 3.3 执行计划与诊断

- [ ] 支持 PostgreSQL `EXPLAIN` / `EXPLAIN ANALYZE`
- [ ] 支持 MySQL `EXPLAIN`
- [ ] 支持 SQLite `EXPLAIN QUERY PLAN`
- [ ] 提供文本和树形执行计划
- [ ] 对 `ANALYZE` 的真实执行风险进行明确提示
- [ ] 保存慢查询诊断信息，但不默认保存敏感结果

### 3.4 导入与高级导出

- [ ] CSV 导入向导
- [ ] 字段映射和类型预览
- [ ] 批量大小、事务策略和错误行处理
- [ ] 导入前验证，导入后提供成功/失败统计
- [ ] 导出表、查询和选中行
- [ ] 后台任务支持暂停、取消、重试和日志

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
- [-] 支持自动布局、缩放、搜索和导出图片
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
- [ ] 支持按 Schema、表和关系过滤

**P3 退出标准**

- 核心关系型数据库具备常用对象浏览、事务、执行计划、导入导出和结构变更能力
- 高风险操作均可预览、取消或回滚，并有明确状态反馈

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
