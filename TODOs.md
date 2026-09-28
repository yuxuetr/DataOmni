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
| P6 | AI 设计、导出与备份（下一步规划 A） | [x] A0–A6c、A9 完成（A2b / A7 / A8 当前版本不做） |
| P7 | 更多数据库：国产库与云库（下一步规划 B） | [-] B2 / B2b（openGauss）完成；B1 阻塞（测试环境）；B3 / B4 按触发条件 |

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
- [x] A5 数据字典 / Agent Skill 导出
  - ER 图导出菜单的两项，来源是图上的 `ErTable` / `ErLink`（不是 `SchemaDraft`：从目录读成设计要的字段 ER 查询里没有，
    而字典只需要列、类型、键）；AI 设计页的图同样能导，开头注明是未建的设计。`utils/dataDictionary.ts`，5 条单测。
  - 打包版上导出过两份并读回核对（YAML frontmatter 用 `yaml.safe_load` 解析过）；跑出来两处已修：UTC 日期（图片导出的文件名同病）、
    SQLite 主键列被目录报成可空。
  - 当前版本不做：列与表的注释（ER 的七套目录查询都没取注释）、AI 按名字猜的说明（RFC 里要求标「推测」）。
    重估条件：有人拿字典去给人看、嫌只有名字不够——先补注释查询，AI 说明排在它后面。
- [x] A6a 备份：SQLite `VACUUM INTO`、DuckDB `EXPORT DATABASE (FORMAT PARQUET)`（`services/backup.rs`）
  - 先写 `.part` 再改名；DuckDB 目标已存在则拒绝。入口在连接信息对话框底部与命令面板，走后台任务（不给取消：一条语句打不断）。
  - 门：两条 Rust 用例恢复后核对内容（路径带撇号），去掉路径转义变红；`describeTask` 断言备份不给取消。
  - 打包版上两家各备份一次并恢复核对（SQLite 副本直接打开；DuckDB 目录 `IMPORT DATABASE` 进新库，`decimal(10,2)` 原样）。
- [x] A6b（PostgreSQL）用本机 `pg_dump` 备份（custom 格式）
  - 密码只经 `PGPASSWORD`；TLS 走 `PGSSLMODE` 等；隧道用 `PGHOSTADDR` + 原主机名（verify-full 照样成立）；
    工具在 PATH 与 Homebrew / Postgres.app 位置里找；CockroachDB 预设直接拒绝并说用 `BACKUP`。
  - 门：三条单测（密码不进参数、隧道与 TLS 的环境变量、CockroachDB 拒绝）；真库用例备份后 `pg_restore` 还原成 SQL 核对值，
    去掉 `PGPASSWORD` 变红。打包版上从 `open` 启动（PATH 无 Homebrew）备份成功。
  - 已知：工具版本比服务端旧时 `pg_dump` 自己拒绝，原话显示在任务里；没有取消（与另两种备份一样）。
- [x] A6c MySQL（`mysqldump`）与 MongoDB（`mongodump`）备份
  - MySQL / MariaDB 完成（`a6eab1f`，本机 `brew install mysql-client` 后做）：`--single-transaction` 一致性快照、
    `--no-defaults`、`--protocol=TCP`、密码只经 `MYSQL_PWD`；按 `--version` 分 Oracle / MariaDB 两家客户端拼 TLS 参数
    （MariaDB 的 `--ssl` 连不上 TLS 会退回明文，所以「要求 TLS」落到验证证书——在 cu 的 mariadb-dump 11.4 上对三家服务端实测过）。
    TiDB 拒绝并指向 Dumpling（`--single-transaction` 的 SAVEPOINT 报 1305），连接没填库名不给入口。
  - 门：四条单测（密码不进参数、`--no-defaults` 在第一位、两家 TLS 参数、TiDB / 无库名先拒绝）；真库用例在 MySQL 8.4、MariaDB 11.4
    备份后用 `mysql` 灌进新库核对值，TiDB 上钉住失败原因（它好了会红）；去掉 `MYSQL_PWD` 变红（1045）。
    打包版从 `open` 启动（PATH 无 Homebrew）备份成功，恢复说明显示正确，备份灌回新库三张表与值都在。
  - MongoDB 完成（官方 Database Tools 100.19 解压到临时目录验，没装进系统）：按库 `mongodump --db --archive --gzip`，
    密码从标准输入喂、连接串不带凭据，SRV / TLS / X.509 / 隧道照 `MongoTarget`。**按库不按整个部署**：
    整个部署要读 `admin.system.users`，X.509 用户（只有 `dataomni_test` 权限）实测一开始就被拒。入口在对象树的库上右键。
  - 门：三条单测（密码不在参数与环境里、X.509 的 URI、SRV 不写 authSource）与无库名拒绝；真库用例备份后 `mongorestore`
    换库名灌回、文档相同，口令错被服务端拒，X.509 备份得出；不喂密码变红。打包版（`open --env PATH=…` 启动）
    右键备份 `dataomni_test`，恢复到新库 30 个集合文档数逐一相同。
  - 未验：MariaDB 客户端的 mysqldump 只在容器里手跑过参数，没经过应用本身（本机装的是 Oracle 版）。
- [ ] ~~A7 框架代码生成（Prisma / TypeORM / JPA）~~ **当前版本不做**
  - 确定性映射，不用 AI；重估条件：A2 落地后先只做 Prisma 一种
- [ ] ~~A8 DataOmni 作为 MCP 服务~~ **当前版本不做**
  - 重估条件：确认「让 Agent 直接查自己配好的库」是日常工作流；届时单独写设计说明，
    验收门里要有「写语句被拒」「生产连接不可见」两条该红的用例
- [x] A9a MongoDB 的 AI 设计（集合、`$jsonSchema`、索引）
  - 「建集合补 `$jsonSchema`」原本就有：建集合对话框的选项格收任意 `createCollection` 选项，含 `validator`。
  - 实验（10 条需求，MongoDB 8.0 真建）：7 份建得出来，3 份把 `$jsonSchema` 又包了一层。提示写死；校验用官方关键字白名单
    （8.0 上试过单子是封闭的），对 10 份的判断与真库一致。
  - 设计页：字段摘要 + 完整规则、索引、mongosh 命令预览，逐条执行并说停在哪。打包版上建出 3 个集合，服务端核对 validator、
    索引都在、违规插入被拒。7 条单测。
  - 不做：从已有集合反推 schema（要抽样文档）、改已有集合的 validator（`collMod`，已在 4.3 的「不做」里）。
- [x] A9b Neo4j 的 AI 设计（`1373db3`）
  - 图模型画成图，唯一约束与索引预览后逐条执行。7 条单测。
  - 实验：10 份设计的 83 条约束 / 索引在 Neo4j 2026.09 上没有一条报错；9 条「没建出来」是实验把 10 份建在同一个库、
    `IF NOT EXISTS` 遇到等价对象跳过（界面上写明）。一开始把它误判成「索引和唯一键重复」，按名字逐条对账后更正。
  - 打包版（英文界面）核对过（屏幕解锁后补做）：生成电影推荐的图模型，图画得出、键属性高亮，19 条语句执行后服务端
    `SHOW CONSTRAINTS` 有 7 条唯一约束（加 12 条索引）；看完删掉了这些约束与索引（冒烟用例共用这个库）和钥匙串条目。
  - 已知：同一对标签之间的几条关系（ACTED_IN / DIRECTED）在两个节点靠得近时文字挤在一起；图比面板大时靠滚动。
    重估条件：有人嫌看不清——再换力导向布局或加缩放。

### B. 更多数据库（P7）

- [!] B1 第一个协议兼容的国产库：KingbaseES 或 OceanBase（MySQL 模式）——**阻塞：测试环境**（2026-09-28 核对）
  - OceanBase CE 单机要 6–8 GB 内存，cu 只剩约 3 GB；KingbaseES 没有官方公开的镜像（社区镜像来源与许可说不清）。
  - 解除条件：有一台能跑 OceanBase 的机器，或拿到 KingbaseES 的试用安装包。在那之前先做 B2b（openGauss，PG 协议同一类问题）。
  - 走归档 4.2「协议兼容库」的流程：连真库跑现有用例、归因、修应用缺陷、写明缺口
  - 先确认 cu 的容量（2026-09-27 `/data` 剩约 8 GB；OceanBase 单机版吃内存与磁盘）
- [x] B2 openGauss / GaussDB：sha256 认证的实验（2026-09-28，openGauss-lite 5.0.3，cu 上 `dataomni-opengauss`）
  - 只存 sha256 口令的用户：sqlx 报 `unsupported SASL authentication mechanisms:`（机制列表是空的），libpq 17 同样不认。
    `password_encryption_type = 1`（同时存 md5）的用户连得上，`pg_hba` 写 `sha256` 也连得上。
  - 做了：这句原话换成说明（服务端怎么改），原话留在后面；连接测试里只印一遍（打包版上核对过）。
  - 不做：在驱动里实现 openGauss 的 sha256 认证（要 fork sqlx 的认证流程）。重估条件：有人的服务端不许改口令存储方式
    （比如托管的 GaussDB 强制 sha256）。
  - 官方镜像 `opengauss/opengauss:latest`（7.0.0-RC3）起不来（缺 `libopenblas.so.0`），用的是 `enmotech/opengauss-lite:5.0.3`。
- [x] B2b openGauss 兼容（PG 模式库）：PostgreSQL 冒烟用例 23 条全过（此前 12 条）
  - 修了应用：列、索引、外键（结构页与 ER 图）四条目录查询改成三家都认的写法（不用 `LATERAL` / `WITH ORDINALITY`，
    identity / 计算列经 `row_to_json` 读，openGauss 计算列走 `adgencol`）；`EXPLAIN` 认旧名 `Total Runtime`。
    PostgreSQL 16 与 CockroachDB 同样 23/23；反向验过（`attidentity` 键名改错，PG16 计算列那条红）。
  - 已知缺口（测试里钉住现状）：序列属性页（没有 `pg_sequences`；`pg_sequence_parameters` 三家列不同、CockroachDB 上崩）；
    约束违反不带约束名与表名（服务端不填字段，原话可能是中文，不去抠）；DDL 语料不在 openGauss 上跑（夹具用 IDENTITY）。
    重估条件：有人在 openGauss 上用序列属性页 / 要约束名。
  - 以下是归因时的原始记录：
  - 用例夹具用了新版语法（4 条）：触发器 `EXECUTE FUNCTION`（PG 11+，要 `EXECUTE PROCEDURE`）、`IDENTITY` 列（PG 10+）。
  - 应用的目录查询在 openGauss 上报错（4 条）：列参数查询、ER 外键与索引查询（语法错，疑为 `WITH ORDINALITY` 一类）、
    `pg_sequences` 不存在。
  - 错误与计划的细节不同（3 条）：约束违反不带约束名、语法错的 SQLSTATE 是 `0A000`、`EXPLAIN ANALYZE` 没有总耗时。
  - openGauss 建库默认 `DBCOMPATIBILITY 'A'`（Oracle 语义，`''` 即 NULL）；测试库是 `PG` 模式建的，A 模式另测。
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
  - 重估条件：有人拿着 mongosh 脚本 / 这类账号 / `--jsonArray` 文件来，或有人要。建删集合对话框已在打包版核对（2026-09-28：建带 `$jsonSchema` 校验规则的集合到新库、右键删除走「会丢掉数据」确认，树随之刷新）。
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
