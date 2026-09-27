# DataOmni 开发路线与完成度追踪

> **2026-09-27 归档**：此前的完整记录（194 条已完成项的做法、取舍、判据与反向验证）原样移到
> [`docs/archive/TODOs-2026-09-27.md`](docs/archive/TODOs-2026-09-27.md)。本文件只留**还没做完的**和**接下来要做的**。
> 代码注释、README、手册与 rfcs 里写的「TODOs 4.2「ClickHouse」」这类章节号，指的是归档里的同名章节。
>
> 原则不变：做之前先评估，结论带「当前版本」的限定；「不做」要写可执行的重估条件；做完先提交再改这里的状态。

## 使用规则

- `[ ]` 未开始　`[-]` 进行中　`[x]` 已完成并通过验收　`[!]` 阻塞（条目下说明原因）
- 完成时在条目末尾补提交号与验证方式；做法、取舍与反向验证记录写在条目下面
- 新接一种库：补齐连接、元数据、执行、分页、导入导出和测试，达到核心验收标准后才标「已支持」（原 4.2 的两条长期规矩）
- 这份文件再次长到读一次就占掉大块上下文时（约 100 KB），照这次的办法再归档一次

## 总体进度

| 阶段 | 目标 | 状态 |
|---|---|---|
| P0 | 建立质量基线并修复高风险缺陷 | [x] |
| P1 | 建立可信的连接、会话与查询内核 | [x] |
| P2 | 完成日常数据库工作闭环 | [x] |
| P3 | 补齐数据库管理与数据工程能力 | [x] |
| P4 | 扩展数据库与外围能力 | [x] |
| P5 | 完成统一桌面 UI 与交互设计 | [ ] |
| P6 | AI 设计、导出与备份（下一步规划 A） | [ ] |
| P7 | 更多数据库：国产库与云库（下一步规划 B） | [ ] |

---

## 下一步规划（2026-09-27 定）

评估与理由见 `rfcs/ai-design-and-export.md`、`rfcs/editions-and-branching.md`。
**一条 `main`**，不开长期版本分支；AI 整块放在 Cargo feature `ai` 后面，只做 Anthropic 与 OpenAI 兼容两种接口。

### A. AI 设计、导出与备份（P6，按顺序）

- [x] A0 实验：AI 生成的库设计能不能一次通过校验（结果见 `rfcs/ai-design-and-export.md` §2.5）
  - `deepseek-chat`（OpenAI 兼容），Key 只从环境变量读、没落任何文件；标准答案是 PostgreSQL 16 真库建表（事务里回滚）。
  - 10 × 3：JSON 30/30，真库能建 23/30，校验通过 21/30；改提示后 10 × 1：全部 10/10。CASCADE 占外键 89% → 57%。
  - 实验顺带修了校验：补「默认值引用序列」（7 份建不出来全是它）；`serial` 家族与自增写法不再误报类型不一致。
    修完后校验与真库结论完全一致（7/7，无误报），反向用例在测试里。
  - 结论：一次通过率高，「回给 AI 修」只做成按钮；A4 的重心是让 CASCADE 显眼、能一格改掉；自增做成列属性按方言渲染。
- [x] A1 导出为 `INSERT` 语句（`9545fb9`）
  - 导出对话框的第三种格式，表数据（当前页 / 整表流式 / 选区）与查询结果都有；目标表只写表名不带 schema，
    查询结果默认空、不填不让导。每行一条（Oracle 不认多行 `VALUES`）；重名列照原样写，让数据库报错。
  - 值按方言：字符串转义沿用 `quoteSqlStringLiteral`，二进制沿用 `binaryLiteral`，SQL Server / Oracle 布尔写 `1`/`0`，
    Oracle 日期写 `DATE '…'` / `TIMESTAMP '…'`（字符串会按会话 NLS_DATE_FORMAT 解析）。
  - 门：语料新增 12 条（7 种方言各一条全值类型、4 条标识符转义、1 条空结果），下限改 28；
    `sql_export_replays_into_an_identical_table` 导出后灌回副本双向 `EXCEPT` 比对。反向验过：改 Oracle 日期写法语料红；
    SQLite 二进制写成字符串、SQLite 反斜杠写两遍，回灌测试都红。
  - 真库：MySQL 8.4、PostgreSQL 16、SQL Server 2022、Oracle 23 Free、ClickHouse 25.8、DuckDB、SQLite 执行生成的语句并读回，
    值一致（MySQL / ClickHouse 反斜杠按字符数核过）；Oracle 的 `''` 读回是 NULL，属 Oracle 自身规则，手册写明。
  - 打包版（`com.dataomni.uitest` 测试包）看过：格式切换、清空表名时禁用与提示、整表流式写文件后回灌一致、查询结果默认空表名。
  - 已知不做：SQL Server 老式 `datetime` 在 `DATEFORMAT dmy` 会话里日月颠倒（手册写明）；Oracle 超过 4000 字节的字符串字面量会被拒。
    重估条件：有人拿着这两种数据来。
- [x] A2 多表模型 `SchemaDraft` + 外键进 DDL + 按依赖排序 + 校验（`src/utils/schemaDraft.ts`）
  - 模型：表、列、主键（带次序）、唯一约束、索引、外键（`ON DELETE` 只给 CASCADE / SET NULL，五家都认的只有这两种）。
    `CreatableDialect` 在类型上排掉 ClickHouse（建表要引擎与排序键，本来就不做）。
  - 校验只做结构：重名（不分大小写）、撞已有表、引用的表与列、外键列数、被引用列组须是主键或唯一约束、
    SET NULL 落在 NOT NULL 上、名字字节上限（PostgreSQL 63 会**静默截断**，含生成的索引名）、两端类型不一致（警告）、
    没有主键（警告）、DuckDB 的环与 `ON DELETE`。**不校验类型属不属于方言**：手写清单必漏，误拒比放过更糟，错类型由数据库报。
  - 建表：被引用的先建、其余保持设计次序；环上前向的外键用 `ALTER TABLE … ADD FOREIGN KEY` 补；SQLite 不能 ALTER 但建表不查被引用表，
    照样内联；主键写成表级约束，列次序不动。`buildCreateTable` 只多了 `constraints` 一个缝。
  - 门：`schemaDraft.test.ts` 20 条；反向验过 SQLite 例外、按字节计长、自引用不算依赖、`ON DELETE` 规则，各自删掉都红。
  - 真库：同一份设计（倒序的博客三表、复合主键自引用、两表成环、索引）在 PostgreSQL 16、MySQL 8.4、SQL Server 2022、
    Oracle 23 Free、SQLite、DuckDB 上执行，外键与索引数目逐一核对。DuckDB 不收 `ON DELETE` 是这一步跑出来的。
  - 从目录读成 `SchemaDraft`（让 AI 避开已有表名）挪到 A4：现在的消费者只要表名，`validateSchemaDraft` 已收 `existingTables`。
- [ ] ~~A2b 整库结构导出（建表脚本）~~ **当前版本不做**（从 A2 拆出，2026-09-27）
  - 理由：ER 图的目录查询只有列、主键、外键，没有默认值、索引、唯一约束、外键动作、检查约束；拼出来的脚本和原库不等价。
    这正是 3.1「PostgreSQL 不给建表 DDL」的同一个理由——不等价的 DDL 比没有更糟。MySQL / SQLite 单表已有原生 DDL。
  - 重估条件：有人要「整库建表脚本」；届时先给 MySQL / SQLite 拼原生 `SHOW CREATE TABLE` / `sqlite_master.sql`（等价），
    PostgreSQL 等给 `pg_dump --schema-only`（与 A6 同一套找工具的做法）。
- [x] A3 `ai` feature：后端调用（Anthropic / OpenAI 兼容）、Key 存钥匙串、后端报告「有没有 AI」、设置默认关（`40f6254`）
  - Cargo `default = ["ai"]`；`services/ai.rs` 整块在 feature 后，命令照样注册、没编进时回答 `DATAOMNI_AI_NOT_IN_BUILD`。
    不发 `response_format`（OpenAI 兼容的各家不是都认）。Key 在钥匙串 `DataOmni / #ai`，只进不出，一次存一份。
  - 门：CI 多一步 `rust:clippy:no-ai`；`ai.rs` 四条单测用本地 HTTP 桩（`no_proxy`）核对两家的请求头、请求体与错误。
    反向验过：两种构建各打一次包，`strings` 找 `anthropic-version|/chat/completions`，带 AI 的 2 处、不带的 0 处；
    不带 AI 的包里设置没有 AI 一节（打包版看过）。
  - 注意：cargo 输出带颜色时 `grep ^warning` 会漏，这一轮就漏过一条；查警告前设 `CARGO_TERM_COLOR=never`。
- [x] A4 设计标签页：需求 → 设计 → 校验、ER 图、外键删除行为 → DDL 预览 → 执行（`40f6254`）
  - 按 A0 结论收窄：「回给 AI 修」就是「按要求修改」再按一次；**不做表格逐格编辑**，只做外键删除行为一格可改
    （CASCADE 标红）——实验里真正的风险在这里。重估条件：有人要改列而不想再问一次模型。
  - 提示词写死两条（`onDelete` 默认 null、不引用序列）和各方言的自增写法；只发需求、已有表名、当前设计，原文可展开。
  - 打包版上跑出来的两处已修：外键指向库里已有的表改为警告（模型真这么设计了，而且合理）；左栏 flex 把需求框挤成一条线。
  - 真库：六种方言各用真实提示走一遍 DeepSeek → 校验 → DDL → 执行，外键数目逐一核对；DuckDB 那份模型仍写了 CASCADE，
    被校验拦下（提示压不干净，校验兜底）。
  - 打包版（测试 identifier）走通：设置填 Key（`axt typeenv`，没有钥匙串弹窗）、生成、改删除行为、预览、建表、
    对象树刷新、引用已有表、离线提示；测完删了钥匙串条目与数据目录。
  - 已知不做：设计不进工作区快照，重启要重新生成；外键指向已有表时不核对那边的列。重估条件：有人因此丢过设计 / 建表失败。
- [ ] A5 数据字典 / Agent Skill 导出（`SKILL.md`：同一份 `SchemaDraft` 的 Markdown 输出）
- [ ] A6 备份：SQLite `VACUUM INTO`、DuckDB `EXPORT DATABASE` 先；`mysqldump` / `pg_dump` / `mongodump` 找得到才给
  - 不自己实现 dump；密码经环境变量传，不进命令行
- [ ] ~~A7 框架代码生成（Prisma / TypeORM / JPA）~~ **当前版本不做**
  - 确定性映射，不用 AI；重估条件：A2 落地后先只做 Prisma 一种
- [ ] ~~A8 DataOmni 作为 MCP 服务~~ **当前版本不做**
  - 重估条件：确认「让 Agent 直接查自己配好的库」是日常工作流；届时单独写设计说明，
    验收门里要有「写语句被拒」「生产连接不可见」两条该红的用例
- [ ] A9 Neo4j / MongoDB 的 AI 设计：A4 走通之后；MongoDB 先给建集合补 `$jsonSchema` 校验规则

### B. 更多数据库（P7）

- [ ] B1 第一个协议兼容的国产库：KingbaseES 或 OceanBase（MySQL 模式）
  - 走归档 4.2「协议兼容库」的流程：连真库跑现有用例、归因、修应用缺陷、写明缺口
  - 先确认 cu 的容量（2026-09-27 `/data` 剩约 8 GB；OceanBase 单机版吃内存与磁盘）
- [ ] B2 openGauss / GaussDB：先做 sha256 认证的实验（标准 PostgreSQL 驱动不认）
- [ ] B3 云库认证（AWS RDS IAM、Azure Entra、GCP Cloud SQL 代理）：按有人要的顺序
- [ ] B4 驱动按 Cargo feature 分
  - 重估条件：第一个客户端库不许随包分发或只在部分平台有的库（多半是达梦）、或包的大小成问题（现在 171 MB）
  - 做法：`DatabaseType` 不加 `cfg`；后端报告驱动清单；门按 feature 成立；CI 构建两套组合

---

## 还没做完的旧条目

以下按原章节号排列，完整记录在归档的同名章节。

## P2：基础功能与日常工作闭环

### 2.4 表数据浏览

- [-] 元数据与表数据查询改走自建 query_executor，不再用 tauri-plugin-sql 的解码器
  - 剩余：表结构查询仍走插件，因 `execute_query` 不收绑定参数；84495ab 的 CAST 让它能用，CAST 是否补齐由 `e61654c` 的门比对。
  - 暂不支持：PostgreSQL `BIT` 与 `INET` / `CIDR`（需开 sqlx `bit-vec` / `ipnetwork`，应用 schema 少见）。
  - 重估条件：真需要时给 `execute_query` 补绑定参数。

## P3：数据库管理与数据工程能力

### 3.1 结构与对象管理

- [-] 查看建表 DDL
  - MySQL / SQLite 已完成（`e7b6bc1`）；**PostgreSQL 当前版本不做**。
  - 理由：无 `SHOW CREATE TABLE`，从目录重建难以覆盖全部属性，不等价的 DDL 比没有更糟。
  - 重估条件（可执行）：`services::schema_metadata::tests::postgres_has_no_ddl_query` 变红。

## P4：外围功能与数据库扩展

### 4.3 非关系型数据库专属工作区

- [ ] MongoDB 使用文档浏览与查询模型，不复用 SQL 表格写入模型
  - 已完成的记录见归档（只读、增删改、结构页、导入导出、索引、批量改删、聚合、SRV、证书与 X.509、建删集合、执行计划、命令台）。
  - 明确不做：JS 写法的 mongosh / 一标签多条命令；LDAP、Kerberos、AWS IAM；删库、改集合名；导出聚合结果；JSON 数组 / CSV 导入导出；`hidden`、`collMod` 改索引；生产库批量写额外一道门；乐观锁以外的并发控制。
  - 重估条件：有人拿着 mongosh 脚本 / 这类账号 / `--jsonArray` 文件来，或有人要；建删集合对话框「打包版待屏幕解锁后再看」（待核）。
- [ ] Redis 使用键空间、类型和值浏览模型
  - 已完成的记录见归档（只读浏览、命令行、键级改动、改元素与新建键、stream 写入）。
  - 还没做：集群（按槽路由）、Sentinel、客户端证书（需先定读文件规矩）、RESP3 推送与发布订阅。
  - 重估条件：有人拿着这种部署来。
- [ ] 每种数据库拥有独立能力声明和交互设计
  - 能力清单仍不抽（2026-09-25 四种非关系库接入后重估：仍不抽），维度只有 `speaksSql`、`hasQueryEditor`。
  - 理由：前后端各一份的判断只是改时多动几处，从未出过不一致缺陷。
  - 重估条件：出现第一个前后端不一致缺陷，届时做共用语料（仿 `fixtures/export-conformance.json`）。

### 4.4 可选外围能力

- [ ] ~~连接和查询模板~~ **当前版本不做**
  - 查询模板的唯一增量是带参数模板，依赖 `execute_query` 绑定参数；连接模板无需求。
  - 重估条件：2.4 给 `execute_query` 补上绑定参数之后。
- [ ] ~~插件或扩展机制评估~~ **评估完成：不做**
  - 理由：没有扩展点答案，插件 API 是对外承诺、前端仍在快速改形状。
  - 重估条件：出现第一个「想改而改不动」的具体诉求先做配置点；第三个同类诉求再谈机制。
- [ ] ~~可选的团队配置同步~~ **当前版本不做**
  - 理由：需要服务端（账号、传输安全、冲突合并），项目是纯本地客户端。
  - 重估条件：有明确多人场景且能说清同步什么；在此之前先做连接配置文件导出 / 导入。
- 2026-09-27 的两条评估（AI 设计与导出、更多数据库与版本管理）已拆成上面「下一步规划」的 A、B 两组任务。

## P5：最终 UI、交互与桌面体验

### 5.1 工作区布局

- [-] 左侧对象树、编辑器和结果区支持拖动调整
  - 仍未做：多条结果之间单独拖动调整（侧栏 / 编辑器拖动与结果表自适应高度已完成）。
  - 理由：公式自带上限、各结果互不挤占，没有「把第二个调大」的需求。
  - 重估条件：有人说得出这个需求。
  - 2026-09-27 多条结果已经可以逐条或全部收起（`a26cf41`），「挤」的问题更小了。

### 5.2 设计系统

- [-] 建立颜色、间距、字号、圆角、阴影和层级变量
  - 颜色与圆角已完成（`1cdcd61`）；间距、字号、阴影、层级 token **当前版本不做**，理由是没有消费者。
  - 层级改为守隐式约定，门 `designTokens.test.ts`（档位不增、常驻层低于模态层）。
  - 重估条件：密度要铺到工具栏 / 对话框 / 侧边栏时，密度不变量的断言先红，届时做间距与字号 token。

### 5.3 桌面交互

- [-] 增加应用菜单和命令面板
  - 命令面板与 ⌘W 关标签已完成（`cd19ca8`、`093bb17`、`bd488b1`），macOS / Linux 均验过。
  - 仍不做：把应用自身动作搬进原生菜单——命令面板已覆盖可发现性，状态启停做不好会是「撒谎的菜单」。
  - 门：`shortcuts.test.ts`、`windowCapabilities.test.ts`。

### 5.4 性能与体验验收

- [-] Windows、macOS、Linux 完成安装、升级和卸载验证
  - 未做：Windows 三件事，必须真机 / 虚拟机（MSI/NSIS 注册表、开始菜单、SmartScreen）。
  - macOS 缺口：ad-hoc 签名被 Gatekeeper 拒（需 Developer ID + 公证）、只有 arm64、无 updater；Linux 缺口：`.rpm` 未装过、AppImage 只 extract-and-run 过、未在真实桌面会话跑。
  - 带 Oracle 的 AppImage 不发；重估条件：AppImage 打包可排除目录不改 ELF，且 `sha256sum` 比对 AppDir 与 `src-tauri/vendor/instantclient` 一致。

## 发布里程碑

### v0.3：可日常使用的关系型数据库 MVP

- [ ] 完成三平台基础安装与冒烟测试
  - macOS 与 Linux（容器）已验，Windows 没有，需真机或虚拟机。

### v1.0：稳定桌面客户端

- [ ] 完成 P5
  - 还开着：5.4 Windows 安装验证；5.1 结果区拖动、5.2 间距字号 token 属「当前版本不做」，不算欠账。
- [ ] P0-P3 无阻塞级缺陷
  - 已知都修了（2026-09-24 / 09-25 macOS 打包版回归），但须发版前完整回归才能勾。
  - 还不能勾：Windows——构建要改 `src-tauri/Cargo.toml` 且需 Windows 开发环境，这一轮不处理。

## 暂不优先

- [ ] 团队实时协作
- [ ] 云端数据同步
- [ ] AI 自动执行写操作
- [ ] 大型 BI 仪表盘
- [ ] 在适配器体系完成前继续增加数据库图标
