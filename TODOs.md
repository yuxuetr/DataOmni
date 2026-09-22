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
| P4 | 扩展数据库与外围能力 | [x] |
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
- [x] 后端还有一批中文错误串会原样印到英文界面上
  - 已经改完的是「连接测试」这条路：驱动缺失、TLS 校验、字段校验、SSH 隧道
    的五种失败（`8102e08`）。约定是 `CODE: 数据`，前端在 `describeError` 里
    按码查文案，认不出就原样显示。
  - `c37aa96` 又改了 `database_commands` 里的「数据库会话未连接」（5 处）：
    它走的是 `execute_query` reject 的那个对象，**绕过 `describeError`**，
    所以翻译提到了 `backendError.translateBackendMessage`，两条路共用。
  - 还没改的：`connection_service` 的凭据库与配置文件错误（「无法从系统凭据库
    读取凭据: …」「保存连接配置失败: …」「连接不存在」等约 10 条）、
    `file_commands`、`database_commands` 剩下的。这些的共同点是带操作系统给的
    原因，按同一套 `CODE: 数据` 改即可，只是数量多。
  - 已补完（`a215f95` + `0478e82`）：剩下的 61 处全部改成码，新增 44 个码，
    覆盖凭据库与配置文件、文件读写、CSV 导入、执行计划、导出、会话、列与参数
    类型、五种「某某库还不支持某功能」。
  - 动手前先收了一处重复（`a215f95`）：`connection_commands.rs` 里五个命令把
    「加锁、没有就建、还是没有就报错」抄了五遍，同一句错误串在 172 行的文件里
    有十五处。`with_service` 收成一处，172 行 → 140 行，顺带用
    `slot.insert(...)` 消掉了「初始化刚成功却还是 None」那条不可能的分支。
  - 几处是判断不是机械替换：三种库的「不支持的数据类型」合成一条（对用户来说
    「这一列读不出来」是同一件事，类型名已说明是哪种库）；五种「尚未支持」
    **不**合成一条带功能名数据的（功能名本身是要翻译的句子，塞进数据里等于把
    中文搬回后端）；`SESSION_PASSWORD_REQUIRED` 后面那句中文直接删掉，不换成码
    ——`useProfileConnector` 靠 `includes` 认它走重新输密码的流程，它本来就不该
    被当成一句话显示。
  - **第一次标完成是错的**（`0478e82` 那轮）：新加的那道门按**行**匹配
    「这一行既有 `QueryError::message` 又有中文」，跨行的写法一条都看不见，
    生产代码里还剩 24 条没改。补完见 `fa80adf`。
  - 门写到第四版才对，前三版都栽在同一件事上——**门自己有 bug，而它是静默的**：
    1. 按行判 → 跨行漏（中文在续行上，那一行没有构造函数关键字）。
    2. 改判字符串字面量，但 `println!` 括号配平算错 → 一个文件里出现第一个
       println 之后，后面整段都被跳过。
    3. 按行剥注释 → `'"'` 这种字符字面量把扫描器带进「字符串里」再也出不来，
       从那行起整个文件失效。
    第四版按字符走：注释剥离放进遍历里，认字符字面量与生命周期标注，
    `println!` 按括号深度配平。**三个历史盲点各造一次变异，全部红，还原后归零。**
  - 另一道门（`pub const` 的码必须有文案）照旧，也反向验证过。
  - 顺带一处设计归位：`connection_probe` 的 `detail` 本来就写着「只放事实，
    结论由前端按 name + ok 组合」，实际却塞着七句中文。改成「要区分的情况多开
    一个 `name`」，并顺手把「解析超时」和「域名不存在」分开——前者是 DNS 不通，
    后者是名字写错，下一步动作不一样。
  - 实测：英文界面上把对象目录查询打回
    `DATAOMNI_OBJECT_BROWSE_UNSUPPORTED: MongoDB`，画出来的是
    "Browsing database objects is not supported for MongoDB yet."。
- [x] 端口上限不再是凭空来的 32767（`f6464ae`）
  - 四处代码把「端口 > 32767」判死，理由写着「Tauri SQL 插件用 16 位有符号
    整数」。这个理由是错的：`Database.load(path: string)` →
    `invoke('plugin:sql|load', { db: path })` → `DbPool::connect(&db)` →
    `Pool::connect(conn_url)`，整条路径上只有一个 URL 字符串；插件里唯一的
    `i16` 在 `decode/postgres.rs`，是 SMALLINT 的取值分支。
  - 实测：测试库挂在本机 43306，`database_smoke.rs` 的 MySQL 用例 17 条过了
    16 条，唯一失败的那条断言的是库名。
  - 它拦掉的正是 `docker run -p 43306:3306` 这种最常见的映射，而且给出的提示
    是「去架 SSH 转发或 socat」——为一个不存在的问题让人多搭一层，属于
    「说得很具体但是错的」那一类。
  - 规则收到 `utils/connectionPort.ts` 一处（原先四份，其中两份还要从连接串里
    正则抠端口）。`connectionPort.test.ts` 把 43306 钉成合法。
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

- [ ] CSV 列映射的提示在英文界面上用的是中文顿号
  - `utils/csvImport.ts:223` 与 `:235` 里 `missing.join('、')`、
    `generated.join('、')` 把分隔符写死了，所以英文界面上印的是
    `column_a、column_b`。同一个毛病在 SSH 隧道表单里已经修过
    （分隔符走文案目录，见 `2a43375`），但那边的修法在这里用不上：
    `csvImport.ts` 是纯函数，拿不到当前语言。
  - 要么把分隔符作为参数传进去（渲染关心的事，本来就该由调用方定），
    要么让它返回数组、由组件去拼。两种都要改这两个函数的签名，
    所以留给下次动 CSV 导入的人，不在 SSH 隧道那一轮里顺手改。
  - 判据：`i18n/catalog.test.ts` 现在只扫文案目录里的 CJK，扫不到组件与
    工具函数里写死的标点。补这一条时顺带把那道门的范围扩到 `join('、')`
    这类调用。

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

> 这一节先做了评估，结论是两条**不做**、三条已落地。评估的依据：仓库里
> 「散落的数据库类型分支」共 63 条九路 `switch`，**全部在没有调用方的代码里**；
> 活着的方言代码早已是数据形态的适配器。详见下面每条。

- [x] ~~定义数据库能力清单：Schema、事务、取消、分页、解释计划、行编辑等~~
      **当前版本不做**
  - 前端真正按数据库类型**开关功能**的只有两处维度：`supports_analyze`
    （`QueryPlanDialog.tsx`，与 Rust `explain::supports_analyze` 同一判断）和
    `allowDefault !== 'sqlite'`（`SET 列 = DEFAULT`，两个网格各一处）。
    六个字段的清单服务两个消费者，是抽象成本现在付、收益等第二个消费者。
  - 更要紧的是：其余「能力」**已经是从数据推出来的**——不支持就是
    `Option::None`（检查约束目录、`CREATE TABLE` 文本、执行计划、会话位置）。
    再声明一份独立清单等于造第二个真相源，两边能静默对不上。
  - **重估条件（可执行）**：`models::tests::driver_support_and_metadata_queries_cover_the_same_types`
    钉住「有驱动」与五张查询表的 `Option` 覆盖同一批类型。当出现一个
    「有驱动但某张表没有」的类型时它会红，那就是第一个真实的能力维度，
    届时再抽清单。执行计划是唯一的已知例外（MySQL/SQLite 能取计划不能
    ANALYZE），由 `every_supported_type_can_produce_a_plan_even_if_it_cannot_analyze`
    单独钉住，免得哪天被顺手统一掉。
- [x] UI 根据能力声明展示功能，不使用散落的数据库类型分支
  - 九路分支全部清掉（`fe486ea`）：`services/database_service.rs`（206 行，
    36 条分支）与 `database_commands.rs` 的八个命令（336 行，27 条分支）
    前端一处都不 invoke，分支体里还有 `"// Redis 查询: 需要特殊处理"`
    这类注释字符串被当 SQL 返回。净删 555 行。
  - 剩下的方言代码是另一种形状，且是想要的那种：后端五张查询表
    （`schema_metadata` / `object_catalog` / `completion_catalog` /
    `er_diagram` / `session_target`）各一个 `match`、返回数据、不支持给
    `None`，都有按三种方言循环的形状一致性测试；前端全在
    `src/utils/` 的纯函数里，旁边就是同名测试。
  - 顺带修一处真重复（`0f8a41f`）：`TableDataViewer` 把
    `tableColumnsParams` 的判断又内联了一遍，而同一个文件已经 import 了它。
- [x] ~~建立方言适配器：标识符引用、参数占位符、类型映射和元数据查询~~
      **已存在，不再包一层**
  - 四项逐条对照：标识符引用 `utils/sqlIdentifiers.ts`（P0 0.2 已完成）；
    参数占位符 `utils/rowStatements.ts:49`；类型映射 `utils/tableDdl.ts` 与
    `utils/tableMetadata.ts`；元数据查询即后端那五张表。
  - trait 化的收益是「接口统一」，而这件事已经由 `for db_type in [三种]`
    的形状测试拿到了，没花抽象的钱。三个实现塞进 trait 只会多一层分派。
  - **重估条件**：出现一个不能用「返回不同的数据」表达的方言差异——
    即某方言需要不同的**结果后处理**而非不同的 SQL 文本。4.2 评估 DuckDB
    时第一次真正检验这条。
- [-] 数据库类型标记为“已支持 / 实验性 / 计划中”
  - 已做成两档：已支持（三种）与计划中（其余六种，界面置灰并标「尚未支持」）。
  - **“实验性”这一档暂不加**：现在没有任何成员，空着的枚举分支正是
    「大而全的枚举只有两个分支被构造」。它的第一个真实成员应当来自 4.2
    ——某个数据库能连能查但还没达到核心验收标准时。
- [x] 未实现的数据库不能以可用连接类型展示
  - 界面这一半完成于 `01bcca1`：类型按钮按 `SUPPORTED_DATABASE_TYPES` 置灰，
    `databaseSupport.test.ts` 直接读 `Cargo.toml` 的 sqlx features 比对，
    防止两边各改各的。
  - 后端这一半完成于 `a21c506`：`test_connection` 此前对这六种类型逐个
    校验主机端口，然后打印「连接配置验证通过」并返回一个 `mongodb://` 串，
    由前端 `Database.load` 在驱动层报错收场——P0 0.2 清掉的「成功形降级」
    换了个位置活着。现在 `DatabaseType::has_driver()` 在方法开头即拒，
    早于读钥匙串和拼 URL；所有连接入口都走 `test_connection`，一道门覆盖。
  - 反向验证：把 DuckDB 加进 `has_driver` → 三条门红（查询表没有它）；
    把 `has_driver` 缩到只剩 PostgreSQL → 也红，报
    「SQLite 缺文件路径要报路径，不能报成「没有驱动」」。
  - 还留着的不可达代码：`to_connection_string` 里六种类型的 URL 拼法。
    它是每种类型 URL 形态的唯一记录，4.2 评估 DuckDB 要用；若 4.2 结论是
    不接，连同那六条分支一起删。
  - README 同步（本次）：原文写「仅有连接表单，尚不能执行查询」偏轻——
    它们是**连不上**，驱动就没编进去。

### 4.2 扩展关系型与分析数据库

> **评估结论：当前版本不接。** 不是「暂时没空」——现有数据路径里**不存在**
> 这两个驱动，而补上驱动之前要先做的那件事（把前端直连改成后端命令）才是
> 这一节真正的主体，且与接哪个库无关。

- [x] ~~评估并接入 DuckDB~~ **评估完成：不接**
  - 驱动证据（查本地 registry 的 Cargo.toml，不是印象）：
    `sqlx 0.8.6` 的 driver features 只有 `mysql` / `postgres` / `sqlite`（外加
    `any`）；`tauri-plugin-sql 2.2.1` 只导出这三个，每个都是 `sqlx/<driver>`
    的转发。DuckDB 不是 sqlx driver，`Database.load("duckdb:...")` 认不出这个
    scheme，将来也不会——它要走 `duckdb` crate（默认 bundled 整个 libduckdb，
    C++ 编译，安装包量级会变）。
  - **前置条件才是主体**：前端现在自己持有 `tauri-plugin-sql` 的连接句柄，
    28 处 `requireDatabase(...).select(...)` 分布在 9 个文件里（对象树、
    表结构、ER 图、补全目录、会话位置、对象定义）。只有 `execute_query` /
    `execute_write_batch` / 导出 / 导入 / 执行计划走 Rust。接任何非 sqlx 的库，
    第一步都是把这 28 处收进后端命令——那是一次跨模块重构，该单独立项评估，
    不该藏在「接入 DuckDB」这条底下。
  - 定位上也要先想清楚：DuckDB 的典型用法是对本地 parquet / csv 做分析，
    与「连远程关系库的客户端」这个当前定位只有部分重叠。
- [x] ~~评估并接入 ClickHouse~~ **评估完成：不接**
  - 同上的驱动问题（要 HTTP 客户端，不是 sqlx driver），另加一条更硬的：
    它会直接冲击 P2 2.5 已经立起来的写入不变量。ClickHouse 没有通用事务，
    `UPDATE` / `DELETE` 是异步的 `ALTER TABLE ... UPDATE`，不返回可信的
    影响行数——而「影响 0 行或多于预期就报错」是 2.5 的核心断言之一
    （`ROW_COUNT_MISMATCH_CODE`）。在这个模型下那条断言要么失效要么误报，
    等于把已经可信的路径重新变得不可信。
- [ ] 为每个新数据库补齐连接、元数据、执行、分页、导入导出和测试
- [ ] 新数据库达到核心验收标准后才能标记为“已支持”

**重估条件（可执行，已就位）**——真的有人来接第四种库时，这几道门会红并
指出还缺什么，不需要靠记性：

- `models::tests::driver_support_and_metadata_queries_cover_the_same_types`：
  加了驱动但没补五张元数据查询表 → 红，且点名是哪张表。
- `src/contracts/databaseSupport.test.ts`：界面可选的类型集合与 `Cargo.toml`
  里编进去的驱动不一致 → 红。
- 还缺一道、接的时候要补：`identifierDialectFor()` 对不认识的类型回落到
  `sqlite`（双引号）而不是报错。这在「只有三种」时是对的容错，多出第四种
  方言时会变成静默用错引用字符。

### 4.3 非关系型数据库专属工作区

> **评估结论：当前版本不做**，且它排在 4.2 之后——4.2 的前置条件（前端直连
> 收进后端）没做之前，这一节一行代码都落不下去。

- [ ] MongoDB 使用文档浏览与查询模型，不复用 SQL 表格写入模型
- [ ] Redis 使用键空间、类型和值浏览模型
- [ ] Neo4j 使用 Cypher 和图结果模型
- [ ] Elasticsearch 使用索引、Mapping 和 Query DSL 模型
- [ ] 每种数据库拥有独立能力声明和交互设计

这四种的共同点不只是「没驱动」，而是**结果模型和写入语义都不一样**：
文档、键空间、图、倒排索引，没有一种能复用现在这张「行 × 列 + 按主键定位
单行」的网格。4.1 判定「不做能力清单」的理由（只有两个消费者）在这一节会
真正失效——四种各自独立的工作区就是第三、第四个消费者。也就是说：
**能力清单该在 4.3 真的动工时抽，不是现在。**

### 4.4 可选外围能力

- [x] 数据结果快速图表
  - 完成于 `bc4ed41`。两张网格的工具栏各一个「图表」，把当前这份结果（排过
    序、按可见列）画成柱状图或折线图。不引入图表库：ER 图已经是手写 SVG +
    纯函数布局，同一套做法。
  - 判断全在 `utils/resultChart.ts`（27 条测试）：一列能不能当纵轴看**实际值**
    而非声明类型（结果列常常是 `count(*)` 这类表达式，驱动给的类型未必可靠）；
    空串不是 0；布尔不当数字；全正数时纵轴从 0 起；刻度取 1/2/5 × 10ⁿ；
    折线在缺失值处断开。超过 200 个点不画，也不悄悄采样。
  - 三条硬规矩：绝不开第二根纵轴（同一个高度表示两个量比看不见更糟），
    所以默认只画第一列数值、勾出量级差 50 倍以上时给一句提示；分类色八槽位
    按固定次序分配不循环；柱子只有数据那一端是圆角。
  - 色板 `--dm-series-1..8` 浅深两套各自取值，用脚本验过而非凭眼睛：相邻槽位
    色盲可分辨度 ΔE 最差 9.1 / 8.4，常视觉 19.6 / 19.3。
  - 反向验证：去掉空串特判 / 去掉 0 基线 / 换成任意等分刻度，三条断言分别
    精确变红。最后一条圆角是**渲染出来才发现**的——第一版 `rect rx` 四角全圆。
- [ ] ~~连接和查询模板~~ **当前版本不做**
  - 「查询模板」与 2.3 已完成的部分高度重叠：收藏、命名、标签、`.sql` 文件
    存取都在。真正的增量只有一个——**带参数**的模板，填一次值跑一遍。
  - 而参数这件事有前置依赖：`execute_query` 至今不接受绑定参数
    （见 2.4「阻碍」那条）。在它之前做模板，只能自己把值内联成字面量，
    等于把一个正确性敏感的决定（按类型决定引用还是绑定）从执行器里复制一份
    到模板功能里。两份实现里必然有一份先错。
  - 「连接模板」：`createDefaultConfig` 已经按类型给出默认端口与默认库名，
    再加一层用户自定义模板，没有观察到需求。
  - **重估条件**：2.4 给 `execute_query` 补上绑定参数之后重开这一条。
    那时模板就是「一段 SQL + 一组参数名」，不需要自己处理字面量。
- [x] SSH Tunnel —— **单独立项，第一个增量已完成**
  - 它不是一个 bullet 的量级，评估如下（三件事都绕不开）：
    1. **凭据**：SSH 口令或私钥口令是**第二份**密钥，而
       `connection_service` 的钥匙串键是 `system-keyring://connection/{id}`，
       一个 profile 一份。要先改键的命名方案。
    2. **生命周期**：`test_connection` 现在是「算出一个连接串」，没有副作用。
       有隧道之后连接串指向 `127.0.0.1:<本地端口>`，而那个端口的存在依赖一条
       活着的 SSH 连接——连接串从纯函数的产物变成了一个带资源的句柄，
       要有人负责建立、复用、在断开时拆掉、在 SSH 掉线时报出来。
    3. **主机密钥校验**：不校验 known_hosts 的 SSH 客户端是可被中间人劫持的。
       这一步不能省——省了之后功能「看起来是好的」，而这恰好是 P0 0.2
       清理的那一类问题。
  - 依赖：`russh 0.63.3`（`russh-keys` 已并入其中）。rustc 1.98.1 满足它的
    1.89 下限。验证按 `database_smoke.rs` 已有的模式，用环境变量开关连真实
    sshd 的用例。
  - 结论：值得做，但要有自己的设计说明与验收标准，不该塞在 4.4 里顺手完成。
  - **设计说明：`rfcs/ssh-tunnel.md`**。第一个增量落在 `3d760cf`（后端）
    与 `2a43375`（前端与接线）。
    立项时三条顾虑各有了着落：
    - 凭据：实测无口令私钥不需要第二份密钥，第一个增量不动钥匙串键的命名
      方案；口令保护的私钥与口令登录留到第二个增量，键定为 `{id}#ssh`，
      不动已有的 `{id}`，因此已保存的数据库密码不需要迁移。
    - 生命周期：`TunnelRegistry` 放在 Tauri state 里，明确不做自动重连——
      第一个增量只负责把掉线报出来。
    - 主机密钥：`russh::keys::known_hosts::check_known_hosts` 的三种返回
      （匹配 / `KeyChanged` / 无记录）正好对应要区分的三种处置，且不提供
      「跳过校验」开关。
    - 验收的地基是一条**该红**的门：目标库只监听 `127.0.0.1`，直连必须失败。
      否则隧道完全不起作用时该绿的那条门也会是绿的。
  - 实现时多修了一处：`check_known_hosts_path` 的 `KeyChanged` 里带的行号会
    算错——跳过 `#` 注释行时不给计数器加一。改成自己比对并报**记录着的指纹**，
    那正是用户要拿去核的东西，而且不依赖行的算法。
  - 反向验证记录（单测）：三态压成两态 → 「密钥变了」那条红；一律放行 →
    三条红；非默认端口不加方括号 → 端口那条红。
  - 反向验证记录（连真实 sshd）：空 known_hosts → HostKeyUnknown，指纹与
    `ssh -v` 打印的一致；记一把别的 ed25519 密钥 → HostKeyChanged；连接串
    不改指向本地端口 → 连库超时。
  - **真在界面上点了一遍之后修的三处**（单测与冒烟全绿时它们都还在）：
    - `01f37e9`：私钥路径不认 `~`，而表单自己的占位符写的就是 `~/.ssh/id_rsa`，
      报错还反过来告诉用户「不支持 `~`」。加 `expand_home`，连真实服务器验过。
    - `c37aa96`：**连接串有两份实现**。`test_connection` 那条做了隧道重定向，
      后端执行查询走的 `resolve_connection_string` 直接拿 profile 的 host/port
      拼。`DbInstances` 按连接串做键，两份差了 `127.0.0.1:49201` 和
      `localhost:3306` 就查不到池子——而界面上连接状态还是绿的，因为对象树走
      前端自己的 `Database` 句柄。收成一处 `connection_string_via(tunnel_port)`，
      两条路都走它。反向验证：把两份实现装回去，门精确报出那两个地址。
    - 同一提交里的草稿隔离：未保存的草稿 `id` 是空串，**所有草稿共用这一个键**，
      第二个草稿会连上第一个草稿的跳板机而界面显示的是它自己填的那台。空 id
      改成每次重建，用真 sshd 的
      `two_drafts_get_two_tunnels_but_a_saved_profile_reuses_one` 钉住。
  - **教训**：这三处的共同点是「后端测试与前端测试各自为政的缝」。冒烟测试直接
    调 `TunnelRegistry`，前端单测 mock 掉 `invoke`，于是「前端算的连接串」和
    「后端算的连接串」谁都没比过。现在那道门比的就是这两份。
  - **还没做的（下一个增量）**：口令保护的私钥与口令登录（要先把钥匙串键改成
    `{id}#ssh`）、ssh-agent、多级跳板、掉线自动重连。不解析 `~/.ssh/config`
    是明确的收窄，理由见设计说明 §3。
- [x] 代理与网络诊断 —— **诊断已做，代理部分明确不做**
  - 诊断完成于 `2e82715`：`services/connection_probe.rs` 按顺序查解析主机、
    试连端口（各 5 秒上限），SQLite 则查文件（区分路径读不到 / 是个目录 /
    空文件 / 开头不是 SQLite 文件头）。连接表单在测试失败之后出现「网络诊断」
    按钮，结论由 `utils/connectionDiagnosis.ts` 按最后一步算出来。
  - 证据不是假想的：`connectionStore` 里本来就有一处手写补救——把驱动的
    `invalid port number` 换成「端口超出范围」，因为原话没法据以行动。
  - 补于 `6ea1f3f`：`tcp` 那一步原先只看 `TcpStream::connect` 的返回，而这在
    开了 TUN 模式代理的机器上永远成功——实测本机到一台 VPS 的三个端口全部
    握手成功并收到 0 字节，其中只有一个上面真有服务。改成连上后再听 500ms，
    「接受了连接又立刻关掉」单独报成 `tcpDropped`。顺带把前端那份手写的步骤
    清单换成从 `connection_probe.rs` 正则取出来的，两半各反向验证过一次。
  - **代理诊断不做**：MySQL / PostgreSQL 走各自的 TCP 协议，sqlx 不读
    `HTTP_PROXY`，系统 HTTP 代理对它们没有任何影响。报一句「检测到系统代理」
    会把人引向一个与故障无关的方向。（`~/.claude/CLAUDE.md` 里那条代理教训
    是关于测试里的 `reqwest`，不是关于数据库连接——两件事别混。）
  - 重估条件：真的引入走 HTTP 的数据源（ClickHouse / Elasticsearch）时，
    代理就开始相关了；而那由 4.2 决定，当前结论是不接。
- [ ] ~~插件或扩展机制评估~~ **评估完成：不做**
  - 插件机制要先回答「扩展点在哪」，而这个问题现在没有答案：没有第二方
    想扩展它，也没有一处功能是「用户各有各的做法」。凭空定义扩展点等于
    先定一份契约，再等需求来匹配它——顺序反了。
  - 而代价是实打实的：一旦有了插件 API，它就是对外承诺，之后每次重构都要
    考虑兼容。现在整个前端还在快速改形状。
  - **重估条件**：出现第一个「用户想改而代码里改不动」的具体诉求
    （例如自定义导出格式、自定义单元格渲染），先按那一个具体诉求做一个
    配置点；出现第三个同类诉求时再谈机制。
- [ ] ~~可选的团队配置同步~~ **当前版本不做**
  - 它需要一个服务端，而这个项目现在是一个纯本地的桌面客户端，没有任何
    后端设施——引入同步就是引入账号体系、传输安全和冲突合并三件事。
  - 「默认不上传凭据和数据」这条约束本身是对的，但它约束的是一个还不存在
    的东西。
  - **重估条件**：先有一个明确的多人场景（比如「团队共用一套只读连接配置」），
    并且能说清凭据留在各人本机的前提下同步什么。在那之前，导出 / 导入一份
    连接配置文件就能覆盖绝大多数「换台机器」的需求——这一条比同步小得多，
    真有人要的时候先做它。

**P4 退出标准**

- 新数据源不再通过继续增加 `switch` 分支接入
  - 达成（4.1）。九路 `switch` 已全部删除；新增方言的入口是五张查询表各加
    一条数据，且有门在没补齐时报红。
- 每种数据库使用符合自身模型的工作区和操作语义
  - 在**已支持的三种**范围内达成。4.3 的四种非关系型数据库判定为当前版本
    不做（连驱动都不在数据路径里），因此这条标准的适用范围就是这三种；
    等 4.2 的前置重构立项后再随之扩大，而不是让标准悬在那里不可能满足。

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
- [x] 支持隐藏、折叠和恢复面板
  - 完成于 `99155d3`。侧边栏与 SQL 编辑器可折叠。此前两个面板只有下限
    （200px / 96px），没有办法把这块空间收回来。
  - 「恢复」这两个字决定了实现：折叠**不动尺寸**，`panelLayout` 里折叠状态
    单独一个键，展开拿回的是折叠前那个数。写成「尺寸 = 0」会把用户拖出来的
    宽度抹掉，那就只剩「隐藏」没有「恢复」。
  - 两处都用 `display:none` 而不是卸载：对象树的展开节点、已取回的元数据、
    编辑器的撤销历史和光标全是局部状态，卸载一次就白折腾。display 类写成
    三元而不是叠一个 `hidden`——两个都是单类选择器，谁赢取决于 Tailwind
    输出的先后，不该赌。
  - 入口有三个，因为只留快捷键的话按错一次就找不回来了：侧边栏头部按钮 +
    折叠后 40px 的窄轨 + `Cmd/Ctrl+B` + 命令面板；编辑器的在工具栏左侧，
    折叠后工具栏仍在，入口不会跟着消失。
  - **本来还写了一个展开时 `requestMeasure()` 的 effect，渲染验证后删掉了**：
    去掉它行为完全不变——CodeMirror 自己的 ResizeObserver 会在 0 高度变回来
    时重量。实测展开后在 565px 处点击，光标落在 565px。删掉之后不坏的代码
    本来就不该留。
  - 反向验证：折叠写进尺寸那个键 → 4 条红；任何非空串都当成折叠 → 3 条红，
    含「存着的值不认识时该按展开处理」那条（认错了会让面板凭空消失）。
  - 渲染验证（浅色 / 深色、中文 / 英文、1440 与 1024 两个宽度）：折叠、展开、
    重启后仍折叠、折叠时隐藏的按钮拿不到焦点、窄窗口无横向溢出。
  - 小遗留：连接未激活时的只读提示写着「在左侧选择那个连接」，而侧边栏可能
    正折叠着。展开入口就在同一侧的窄轨上，先不改文案。
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
- [x] 支持紧凑、标准和舒适密度
  - 完成于 `8b73d3e`。三档密度本来就实现了，但只做了一半：它是
    `TableDataViewer` 里的一个 `useState`，换张表、关掉标签再开就回到默认；
    查询结果那张网格根本不读它。**一个每次都要重挑的设置等于没有。**
  - 改成 `settingsStore` 里的一档，存 localStorage。查询结果网格的表头与
    单元格也按这档排版；它没有列菜单，入口补在「设置 → 外观」，和列菜单写
    的是同一份偏好（实测：在列菜单点「紧凑」，localStorage 里就是 `compact`）。
  - 实测行高：紧凑 20.5px、标准 28.5px、宽松 36.5px。800px 的结果区分别是
    39 / 28 / 21 行——这个差别才是这个设置的全部意义。
  - **明确只管两张数据网格，不做全局 token 化的密度。** 工具栏、对话框、
    侧边栏的间距共 1192 处硬编码的 Tailwind 间距类、460 处字号类；把它们
    token 化是 5.2 第一条（间距、字号、阴影、层级）的工作，不该借「密度」
    这条顺手做掉。真做全局密度时那一条是前置。
  - 两条新的不变量，各自反向验证过会红：
    - **哪一档都不许带字号**。列宽按 `columnWidths.ts` 的 `charWidth 7.9`
      估算，那个数是照 13px 等宽字体量的。密度改字号 = 每一列都算错，而
      表现只是「有些列被截断了」，没人会把它和行高联系起来。
      （把紧凑档加上 `text-[11px]` → 红）
    - **左右内边距不许超过模型里的 `padding`（26px）**。超了列宽就不够放
      内容，而估算按字符数算，看不出这段差额。现在 `px-2`→17、`px-3`→25，
      都在线下。（把宽松档改成 `px-4`→33 → 红）
    - 另加一条：存着的值不是已知档位时回落到默认。认了一个不存在的档，
      `DENSITY_CELL_CLASS[density]` 是 `undefined`，单元格连内边距都没有。
  - 渲染验证：查询结果网格三档都量过（此前它完全不响应密度）；「设置 →
    外观」那一节渲染正常、重启后保留。`TableDataViewer` 那张网格这一轮
    **没有渲染验证**——预览环境喂不出表结构元数据，它那条路会停在「分页
    查询不稳定」。改的是取值来源（`useState` → store），落点仍是同一个
    `DENSITY_CELL_CLASS`，由 typecheck 与上面那条列菜单实测兜住。
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
  - **部分完成**：后端 Rust 的错误文案原本全是中文。连接测试与查询会话那两条路
    已按 `CODE: 数据` 改成错误码（`8102e08`、`01f37e9`、`c37aa96`），前端在
    `utils/backendError.ts` 里查文案、认不出就原样显示。剩下的见 0.2 那一条。
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


- [x] 完整支持 macOS `Cmd` 与 Windows/Linux `Ctrl` 快捷键
  - 已完成（`5ad05dc`）。动手前先分清了两件事：**判定**本来就是对的
    （处处写 `metaKey || ctrlKey`，两个平台都按得出来），**提示**是错的——
    `⌘C` 直接写进了文案，于是 Windows 上界面写着 ⌘C、要按的是 Ctrl+C。
    能用但写着假的，不报错，只有在那台机器上才看得见。
  - `utils/shortcuts.ts`：一份 `SHORTCUTS` 清单加 `matchesShortcut` /
    `formatShortcut`。mac 画 `⇧⌘⏎`，其余平台画 `Ctrl+Shift+Enter`。
  - 判定改成按平台**独占**：macOS 上 ⌃K 是文本框「删到行尾」的系统绑定，
    Windows 上 Win+K 是投屏，`metaKey || ctrlKey` 把两边都抢了。修饰键也
    精确比对，⌘⇧K 不再顺带命中 ⌘K。
  - 两道门，都反向验证过：
    - **别处不许直接读 `metaKey` / `ctrlKey`**——「完整支持两个平台」这句话
      只有在快捷键数得清时才检查得了，散在组件里的 `metaKey ||` 是数不清的。
      往 `Sidebar.tsx` 塞一个 `e.metaKey` 确认门红并点名了它。
    - **文案里不许写死 macOS 符号**。这条的第一版只认字面量，而 `en.ts` 的
      `editor.formatTitle` 恰恰写成 `\u2318\u21e7F`，门开着却放它过去了——
      **一条只认一种写法的门，等于只挡得住写得明显的那些**。改成两种写法
      一起扫之后，字面量和转义各造一个都红。
  - 渲染核对过两个平台两种语言（`?platform=win` 在加载前改掉 `navigator`）：
    Windows 下右键菜单从 `min-w-48`(192px) 自然长到 260px，提示列不换行，
    六条文案没有 `{shortcut}` 漏出。
  - **没做**：命令面板没有给每一条加快捷键提示。清单已经在了，加起来很便宜，
    但那是「命令面板」那一条的工作，不该借这条顺手做掉。
- [-] 增加应用菜单和命令面板
  - 命令面板已完成（`cd19ca8`）：⌘K / Ctrl+K 打开，模糊搜索连接、当前连接
    已加载出来的表，以及新建查询标签 / 新建连接 / 打开 SQLite 文件 /
    重新打开最近关闭的标签 / 切换外观。↑↓ 选择（两端回绕）、Enter 执行、
    Esc 关闭，命中字符高亮。
  - 原生应用菜单（macOS 菜单栏）未做。
- [x] 增加对象树、标签和表格右键菜单
  - 评估先分了一下：**标签和表格本来就有**（`WorkspaceTabMenu` 固定 / 复制 /
    关闭，`GridContextMenu` 四条复制），缺的只有对象树。所以这条的增量是
    对象树那一个菜单，加上把三份重复的菜单骨架收成一份。
  - `refactor(menu)`（`407f6ab`）：网格和标签各抄了一份约 30 行的「量一下夹进
    视口 + 点外面 / Esc / 滚动关掉」，第三份正要写，抽成 `useContextMenu`。
    删掉它三个菜单都会跑到屏幕外并且关不掉，不是包装层。顺带修了标签菜单
    的定位——它的边界是 `innerWidth - 180` **猜**的。
    `clampMenuPosition` 落 utils 带测试：菜单比视口还大时以上边为准，
    溢出的一半留在下面至少第一项看得见。
  - `feat(explorer)`（`5ec4982`）：对象树右键菜单。真正新增的能力是两条——
    - **打开结构**。`table-structure` 这种标签早就实现完整了（工厂、渲染、
      快照恢复全在），只是**没有任何地方造得出来**。菜单把这条已经能跑的
      路接上。标签另带一个文案键，否则数据页和结构页都叫 `public.users`。
    - **复制限定名**。复制裸名字没有用：`order` 是关键字，`My Table` 带空格，
      PostgreSQL 上还少了 schema。
  - 哪种对象有哪几条写成 `Record`，新增一种对象类型编译不过。三条边界都是
    真的：函数和序列没有行；视图不给「打开结构」，因为结构页是个可编辑的
    编辑器，它不知道自己打开的是不是视图；表和视图不给「查看定义」，因为
    后端取定义走 `pg_get_functiondef`，喂视图的 oid 会直接报错。
    `objectMenu.test.ts` 拿 `isBrowsableKind` 对照着守前两条。
  - **渲染出来看抓到一处**：函数的显示名带着参数签名（`calc_total(integer)`），
    整串当标识符引起来是 `"public"."calc_total(integer)"`——一个名字里带
    括号的函数，粘进 SQL 必然报错。签名留在引号外才对。按 `kind` 拆而不是
    看有没有括号：表真的可以叫 `weird(name)`。实测复制出来的是
    `"public"."calc_total"(integer)` 和 `"public"."order_items"`。
  - 三个菜单、结构页、离线态都渲染确认过（浏览器里桩掉 Tauri 的 IPC）。
  - 顺手修了 `fedb94e`：离线面板对三种标签都印着「下面是这个标签的草稿，
    只读」，而表数据 / 表结构 / ER 图下面根本没有草稿。结构标签有了入口，
    这块屏幕才被看见。
  - **没做**：视图的 DDL（要后端加 `pg_get_viewdef`）、结构页认得视图从而
    对视图只读。两件都是独立的事，不该借这条顺手做掉。
- [-] 完成焦点管理、键盘导航和可访问性标签
  - 表格（`08d7fc2`）：点选单元格，方向键移动，Shift 延伸矩形选区，
    ⌘/Ctrl + 方向键到整行整列尽头，Home / End、⌘A 全选、Esc 清除、⌘C 复制。
  - 未做：对象树与标签页的键盘导航、命令面板。
- [x] 长任务统一显示运行中、取消请求中、已取消、成功和失败
  - 评估先找出不统一在哪：**查询执行那一套五档齐全**
    （`contracts/queryExecution.ts`），SQL 编辑器也画得对——请求取消后按钮
    禁用、写「取消中…」、`cursor-wait`。而导入导出的 `TaskStatus` 根本没有
    `cancel-requested`：`cancel()` 只往**折叠着的**日志里写一行，状态仍是
    「运行中」，转圈还在转，取消按钮还亮着。于是人只会再点一次，再点一次。
  - 已完成（`e215dfa`）。`TaskStatus` 补上这一档，名字和查询执行那边**同名**，
    类型从 `TASK_STATUSES` 数组推出来，好让门能在运行期遍历。
  - `cancel()` 先翻状态再等后端：取消要跨过当前这一批才生效，那几秒里界面
    必须已经改口。
  - tone 仍是 `running`，转圈继续转——它**还在跑**。转圈停下来会让人以为已经
    停了，而这时候去关窗口、去改表，撞上的是一个还在写的事务。
  - 取消按钮**留在原地变灰**，不是消失：那一下点击落在哪个控件上，反馈就该
    出现在哪个控件上。`TaskDisplay.cancel` 用三值（none / available / pending）
    而不是两个布尔——「能点」和「已请求」互斥，两个布尔会允许一个没有含义的组合。
  - 四道门，都反向验证过：五档在两套状态机里同名、请求取消后 tone 仍是
    running、取消按钮转 pending、每一档文案互不相同（共用一句就等于没有这一档）。
  - 渲染确认了整条生命周期：`Running · 5s · 8000 行` → `Cancelling · 11s ·
    15000 行`（转圈继续、X 变灰且 `disabled`、角标仍是「1 task running」）→
    `Cancelled · 42s · 60000 行`。
  - **没做**：查询执行没有并进任务中心。查询的归宿是它自己那块结果区，
    搬进右下角只会让同一件事出现在两个地方。这一条要的是「五档一致」，
    不是「一个面板装下所有东西」。
  - 顺手修了 `5494f25`（不属于这一条，是渲染时撞见的）：**恢复工作区之后
    重新连上，编辑器收不到输入**。字能打出来（CodeMirror 自己的状态），
    但一个字都进不了 store，工具栏一直是「未解析出语句」，执行按钮一直灰着。
    断开时一个 effect 把活动文档清成 null，重新连上时标签 id 没变，只看 id
    的那个 effect 不会再跑——活动文档就永远是 null。从欢迎页连接碰不到，
    因为那会新建标签。**没有自动门**：依赖数组里缺一个耦合，纯函数测不出来，
    `exhaustive-deps` 也看不见（改之前那个 effect 根本没用到它）。
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

- [x] 大对象树采用按需加载和虚拟化
  - 结论：**做筛选框加单组上限，不做虚拟化，也不做按需加载**（`bf61009`）。
  - 动手前先量了一组数（点分组标题，等节点全部落地，取 9 次中位数）：

    | 单组项数 | 展开中位数 | 页面节点数 |
    | --- | --- | --- |
    | 200 | 24.8ms | 1,699 |
    | 500 | 41.7ms | 3,799 |
    | 2000 | 183.5ms | 14,299 |
    | 5000 | 300.1ms | 35,299 |

    Chrome 开发构建，打包后的 WebView 只会更慢。`buildObjectTree` 与命令面板的
    `rankFuzzy` 都不是瓶颈：两万个对象也分别只要 3.6ms 和 2.3ms。
  - 但把 5000 张表真的渲染出来看了一眼，300ms 不是主要问题：侧边栏一屏 27 行，
    要滚 185 屏才到最后一张表，而「视图」「函数」两组的标题被压在 5000 行之下，
    **连它们存在都看不见**。虚拟化能把 300ms 变成 25ms，然后留下一棵同样没法
    用的树。按需加载同理——目录查询本来就是一次往返，拆成多次只会更慢。
  - 做的是：筛选框（按限定名筛，筛时各组一律展开）＋单组封顶 200，
    剩下的画一行「还有 N 个未显示」。少画几百行是性能取舍，悄悄少掉几百个对象
    则是一个会让人去改连接配置的错误结论。
  - 筛选用**子串**不用命令面板那套子序列匹配。先复用了 `matchFuzzy`，理由是
    「一棵树里两种搜索规则记不住」；写测试才发现输 `or` 会把 `customers` 也
    留下。面板容得下这种宽松，因为它按分数排、只露前 50 条；树里结果按字母序
    一条不漏地铺开，噪音就摊在每一屏里，而人第一个输入的恰恰是两三个字母。
    两个控件两件事：树是「把看得见的东西缩窄」，面板是「凭印象找一个东西」。
  - 重估判据可执行，写法学 `gridPagination.test.ts`：断言
    `MAX_RENDERED_TREE_ITEMS` 不超过**字面量 200**——跟常量自己比的话，把常量
    改成 5000 也照样绿，那种门等于没有门。另有一条扫源码的门禁止组件绕过上限
    直接铺 `node.objects`：上限只在纯函数里生效是不够的，绕过去的那一版看起来
    完全正常，只是每次展开卡 300ms。
  - 四条门都反向验证过：上限改 5000、组件绕过上限、上限不生效、筛不到退回全部，
    各自红在对应的门上。
  - 实测（5000 张表那一档）：展开中位数 300.1ms → 25.1ms，页面节点
    35,299 → 1,705；顺带「视图」「函数」两组重新回到了第一屏里。
  - 未做：真的虚拟化。什么条件下重估——上面那条字面量 200 的门红了，
    也就是有人要放开单组上限时。
- [x] 大表格采用行列虚拟化，但不替代服务端数据限制
  - 结论：**当前版本不做**（`8364ffe`）。动手前先测了一个数：最坏情况
    100 行 × 20 列共 2000 个单元格，整次重渲染中位数 25ms，且这个数还包含
    两帧 requestAnimationFrame 的等待，真正的渲染工作远在一帧之内。
  - 原因是两个表格本来就分页（结果表默认 25、表数据默认 50，档位上限 200），
    DOM 规模已被分页钉死，虚拟化解决的是分页已经解决的问题。
  - 重估条件是可执行的：`gridPagination.test.ts` 断言所有档位不超过
    `MAX_UNVIRTUALIZED_ROWS`。加一个更大的档位、或改成无限滚动不再分页，
    那条门就会红，逼着重新测一遍再决定。
- [x] 定义冷启动、切换标签、展开对象树和滚动性能指标
  - 结论：**指标定成「驱动量的上限」，不定成毫秒阈值**。毫秒数跟机器、构建和
    WebView 版本走——这台 Mac 上量的数字对 Windows 用户没有意义，照它设阈值
    要么处处红要么处处绿。驱动量（一次交互要画多少个节点、要打几次库）是确定的、
    与机器无关的，而且**已经能在 `bun run check` 里判**。
  - 四条的实测基线（Chrome 开发构建，120Hz；打包后的 WebView 只会更慢）：

    | 场景 | 实测 | 驱动量 | 门 |
    | --- | --- | --- | --- |
    | 冷启动（前端） | 52ms（1 个标签）／77ms（400 个） | 恢复的标签数 | **不需要**，见下 |
    | 切换到表标签 | 109.5ms 画出 200 行 × 8 列（6,593 节点） | 单页行数 | `gridPagination.test.ts` 的 200 |
    | 展开对象树 | 24.8ms 画出单组 200 项 | 单组项数 | `databaseObjects.test.ts` 的 200 |
    | 滚动 | 90 帧中位数 8.3ms，**0 帧超过 32ms** | DOM 节点数 | 由上面两条上限钉死 |

  - 冷启动这条**量完之后判定不需要上限**：恢复 400 个标签比恢复 1 个只多 25ms，
    因为只有活动标签会渲染内容，其余的各自只是标签栏上一个小片。原本准备给
    「恢复的标签数」加一条上限，实测把它否掉了——没有证据支持不等于有证据反对，
    反过来也一样。
  - 滚动不掉帧的原因恰恰是**没有做虚拟化**：不虚拟化时滚动期间一行代码都不跑，
    浏览器只是移动已经画好的层。虚拟化才会把渲染工作搬进滚动里。
  - 冷启动这个数字只覆盖**前端**（Tauri IPC 被打桩）。进程启动与 WebView 初始化
    要在真机打包后才量得到，归到下面「三平台安装验证」那条一起做。
  - 量法（四条都是同一套）：触发交互，用 `requestAnimationFrame` 轮询等到节点
    全部落地，再等两帧，取 9 次中位数；滚动那条改为逐帧推进 `scrollTop`，统计
    帧间隔分布。
- [x] 切换回表标签要重新打 7 次库，把它降下来
  - 顺着这条查下去先撞见一个**比它严重得多**的问题，单独修了（`97c3a34`）：
    表标签切走就卸载，`changes` 是组件状态，于是**切到别的标签再切回来，待提交
    的改动全没了**——没有提示，也没有撤销。实测切走前写着「1 项待提交」，
    切回来一项不剩。同一个根因还有第二条路：标签栏上那个叉。表视图自己的
    「关闭」会问一句，而标签栏上的叉走 App 的 closeWorkspaceTab，那里只给
    SQL 标签问。
  - 改动挪进 `tableEditStore`，**按表存不按标签存**：改动的身份是「这张表的
    这几行」，`PendingChange` 本来就按 RowKey 认人，设计上就跨得过翻页、排序、
    筛选，只是跨不过卸载。按表存之后「换表时键指着另一张表」这个状态在结构上
    不存在了，组件里那条防它的清空也删掉了——留着反而会删掉改动，因为那个
    effect 挂载时也跑一次，而挂载正是切回来的那一刻。
  - 只活在内存里，不进工作区快照：改动里存着加载时的原值，重启后库里的行可能
    已经变了，拿过期的原值比对会得出错误的「这一列没变」。
  - 标签栏的叉现在也问，且**只有这张表的最后一个标签关掉时才清**：数据页和
    结构页是两个标签、同一张表，共用同一份改动。
  - 往返本身（`c78540a`）：表结构缓存进 `appStore`，挨着 `databaseMetadata`。
    失效分两层——我们自己改的用 `schemaVersion` 盖章（DDL 一执行立刻作废，
    作废的那份也不拿来合并），别人改的靠 5 分钟过期兜底（和对象树同一个数，
    顺手把那边的字面量换成了共用常量）。结构页的刷新按钮绕过缓存。
  - 数据页的刷新**不**顺手刷结构：`loadTableData` 用的是这一轮 render 闭包里的
    `tableSchema`，await 之后它不会变成刚取回来的那份，那样写只会读到旧列，
    而且看起来是对的。
  - 实测：切回表标签发出的命令从 8 次（其中 6 次打库）降到只剩 `execute_query`
    一种；前端画那 200 行仍是 112.4ms（桩里查询不要钱，省下的是真实连接上的
    往返）。
  - 未做：行数统计（COUNT）仍随卸载丢掉，每次切回来重算一次。它是数据相关的，
    缓存它等于接受一个过期的总行数；而 COUNT 在大表上到底多贵这一轮没有实测，
    按「判据按收益定」的规矩不先动。
- [-] Windows、macOS、Linux 完成安装、升级和卸载验证
  - **macOS 已验证**（`e2f4bbc`，产物 `DataOmni_0.1.0_aarch64.dmg` 9.3 MB /
    `DataOmni.app` 25 MB）。这是这个项目第一次真的把打包后的应用跑起来看——
    此前所有界面验证都在浏览器里、用打桩的 Tauri IPC 做的。
  - 跑起来是对的：窗口起来了，欢迎页列出钥匙串里那 7 条连接，菜单栏叫
    DataOmni，`lsappinfo` 报 `type="Foreground"`、`Arch=ARM64`，
    launch-to-checkin 0.058s。
  - 顺带验到一条只有真机能验的：`connections.json` 里 **7 条连接一条明文密码
    都没有**，密码在钥匙串的 `DataOmni` 服务下。凭据不落盘这个承诺在打包后
    成立。
  - 撞见并修掉一个启动路径缺陷（`e2f4bbc`）：带任何文件参数启动会直接
    `exit(1)`，一个窗口都不开。详见提交说明。
  - **卡在签名上，普通用户装不了**：`codesign` 是 `adhoc, linker-signed`，
    `Info.plist=not bound`、`Sealed Resources=none`，`spctl -a` 直接拒绝
    （"code has no resources but signature indicates they must be present"）。
    换一台 Mac 双击就会被 Gatekeeper 挡住。要过这关需要 Apple Developer ID
    证书加公证，不是代码能解决的。
  - **只有 arm64**：`Mach-O thin (arm64)`，Intel Mac 跑不了；而
    `LSMinimumSystemVersion` 写着 10.13——那个版本从来没在 Apple Silicon 上
    跑过，这个声明自相矛盾。要覆盖 Intel 得出 universal 包。
  - **「升级」这一条没有机制可验**：没配 updater 插件，也没有签名，
    现在的升级路径就是「重新下载一个 dmg 覆盖」。
  - 卸载会留下的东西已经摸清：`~/Library/Application Support/com.dataomni.app`
    （connections.json + .window-state.json）、`~/Library/Caches/com.dataomni.app`、
    `~/Library/WebKit/com.dataomni.app`（localStorage，工作区快照与历史在这里）、
    以及钥匙串里 `DataOmni` 服务下的条目。注意还有一组
    `~/Library/{Caches,WebKit}/DataOmni`，是 `tauri dev` 留下的。
  - 打包本身踩到一次：`bun tauri build` 第一次失败在
    `failed to run bundle_dmg.sh`，而这句话不说原因。真实原因是上一次的
    `/Volumes/dmg.*` 还挂着；`hdiutil detach` 加删掉 `rw.*.dmg` 之后连跑两次
    都成功。
  - 验证过程里拿到一份崩溃报告，查清了**不是应用的问题**，但值得记下来：
    从终端直接跑 `DataOmni.app/Contents/MacOS/dataomni` 会在启动 1.24 秒后
    `EXC_BAD_ACCESS (SIGBUS)`，崩在 `ShareKit → IconServices → ImageIO →
    PNGReadPlugin`，PC 是 `0xbad4007` 这种垃圾值。进程里映射着
    `/opt/homebrew/*` 的 libpng16、libjpeg、libtiff、libgif、liblzma、libzstd。
  - 原因是 macOS 的 dyld 认 `LD_LIBRARY_PATH`，而这台机器的 shell 里设了
    `LD_LIBRARY_PATH=/opt/homebrew/lib:/usr/local/lib`。Homebrew 的 libpng 抢在
    Apple 内部那份前面被加载，ImageIO 的 PNG 解码器跳进一个 ABI 不兼容的实现。
    `otool -L` 确认二进制本身只链系统库，一个 Homebrew 库都没有。
  - A/B 验过，是确定性的：带着 `LD_LIBRARY_PATH` 跑 3 次崩 3 次；**只摘掉这一个
    环境变量**、其余不变，跑 3 次一次都不崩。用 `open -a` 启动也不崩——launchd
    起的进程不继承我的 shell 环境，而 Finder 双击走的正是这条路。
  - 和签名那条连着：现在的签名没有 Hardened Runtime（flags 只有
    `adhoc, linker-signed`，没有 `runtime`）。带库校验的签名会直接拒绝这些外来
    dylib，这一类崩溃在正式签名之后不可能发生。
  - **一个教训记在自己账上**：这次崩溃发生时我看到「进程没了」，顺手归因成
    `timeout` 杀的就过去了，没去翻崩溃报告。不查就下结论，和没验一样。
  - 未做：Windows 与 Linux 的三件事。**这两项必须在真机或虚拟机上做**，
    不是「本机出不了包」那么简单——安装/升级/卸载的验证本身就是操作系统级的：
    Windows 要看 MSI/NSIS 装卸时的注册表项与开始菜单，Linux 要看 .deb /
    AppImage 的桌面入口与运行时依赖，两边还各有自己的未签名应用拦截
    （SmartScreen / 各发行版的策略）。macOS 上没有等价物可以模拟。
    等有那两个环境时再做，先推进其余条目。
- [x] 完成崩溃恢复、异常退出恢复和无网络场景测试
  - **崩溃 / 强杀恢复：量了一个数，不需要改代码。** 工作区快照是每次变化就写
    （effect 依赖 tabs / activeTabId / documents / closedTabs），不是退出时写；
    而 WebKit 的 localStorage 是 WAL 模式的 SQLite，提交后崩溃安全。
  - 刷盘延迟实测 **~550ms**（三次 539 / 554 / 560ms，量法是比对 `savedAt`
    那个由 JS 写入的时间戳和它出现在磁盘上的时刻）。`kill -9` 对照：
    0.3s ✗（应用还没挂载完，本来就没写）、1s ✓、2s ✓、5s ✓。
    **结论：强杀最多丢掉最近半秒的输入。**
  - 回不来的东西已经清楚：窗口尺寸（window-state 插件在退出事件里保存，
    强杀那次 `.window-state.json` 的 mtime 没动）、待提交的表格改动
    （只活在内存里，见上面那条的理由）、查询结果（按设计不存）。
  - **连接时没网：已经有门**，`connection_probe` 三条 Rust 测试分别钉住域名
    解析失败、端口关闭、以及「接受连接又立刻断开」（TUN 模式代理）。
  - **中途断网：找到并补上了一个真实缺口**（`c62218b`）。
    `classifyConnectionFailure` 只在切换连接失败时被调用，查询失败不走它；
    `reportConnectionLost` 只挂在浏览器 `offline` 事件上，管的是整台机器断网。
    机器有网、到这个库的连接死了（服务端重启、VPN 掉线、防火墙 RST）两条都
    不触发——查询报一句驱动原话，下一条还是同样的错，没人告诉你该重连。
  - 分类按 **sqlx 的枚举**判不按英文措辞猜（依据是 sqlx 0.8.6 `error.rs` 里
    `Io` 与 `Database` 两支的 Display 格式）。`PoolTimedOut` 刻意不算：
    它也可能只是连接都在忙，算进来一次慢查询就会让人以为断线了。
  - 「永远挂起」那一侧不另写测试：`with_timeout` 对 `pending::<()>()` 的测试
    模型的就是「对面永远不说话」，再套一层真 socket 是重复验同一件事。
- [ ] 断线之后没有恢复路径，界面还写着「已连接」
  - 上一条查出来的：查询打回 `CONNECTION_LOST` 之后，错误说得清了，但工作台
    头部仍然显示「Connected」，侧边栏也还是「已连接」。
  - **没有顺手改，因为那样会更糟**：翻成 offline 要走 `reportConnectionLost`，
    而从 offline 回来只有 `handleNetworkRestored` 一条路，它靠浏览器的
    `online` 事件触发——机器根本没断网，那个事件永远不会来，用户会卡在
    「连接中…」里出不去。
  - 还查到一件相关的：`connectionLifecycle` 那套状态机**在 stateSync 之外没有
    任何消费者**，`getConnectionState()` 一处都没被读。它现在只服务于自动重连。
  - 真做的时候要一起想清楚：断线后的状态怎么显示、重连入口在哪、
    以及那套状态机到底该不该有界面。

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
