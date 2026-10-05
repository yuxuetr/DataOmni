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
| P7 | 更多数据库：国产库与云库（下一步规划 B） | [-] B1（OceanBase）、B2 / B2b（openGauss）完成；KingbaseES 缺安装包；B3 不做；B4 按触发条件 |

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
  - MariaDB 客户端（2026-09-28 补验）：mariadb-dump 13.0.2（Homebrew bottle 只解压、改写 openssl 路径，不安装）放在 PATH 最前，
    真库用例经 `backup_with_tool` 对 MariaDB 11.4、MySQL 8.4 备份灌回都过，TiDB 上同样钉住 SAVEPOINT 失败。
    反向：把版本识别改成永远 Oracle，MariaDB 11.4 上红（`unknown variable 'set-gtid-purged=OFF'`）。
    要这么跑：MySQL 8 的 `caching_sha2_password` 插件在 bottle 的 `lib/plugin`，得设 `MARIADB_PLUGIN_DIR`（装好的 Homebrew 版不需要）。
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

- [x] B1 第一个协议兼容的国产库：OceanBase（MySQL 模式）（`83d0752`，2026-09-28）
  - 环境：本机 Docker Desktop（8 GB），`oceanbase/oceanbase-ce` 4.4.2.1 arm64，`MODE=mini`，占约 3.9 GB；
    只绑 127.0.0.1:2881，口令随机生成、只在容器环境里（`docker inspect`）。用户名 `root@test`（`用户@租户`）。
  - 首跑 16/23，归因后 23/23：
    - 修了应用（2 处）：执行计划 OceanBase 给自己的 JSON 形状（`OPERATOR` / `CHILD_n`），新增方言与解析，子节点按编号数值排；
      要重写表的改列与 `RENAME TO` 同句报 1235，改表名拆开（与 TiDB 同一条路，文案去掉厂商名）。
    - 拼写差异（用例换拼法）：整数显示宽度、`on update current_timestamp` 小写、`SHOW CREATE TABLE` 列类型是 TEXT
      （解码器白名单里有，解码那条用例本就过）；预处理协议收 `USE`（与 MariaDB / TiDB 同，由应用那道挡住）。
    - 已知缺口（钉住现状）：表达式默认值不带 `DEFAULT_GENERATED`，`DEFAULT (UUID())` 与字符串 `'UUID()'` 在
      INFORMATION_SCHEMA 里一模一样，只有 SHOW CREATE TABLE 与内部表 `oceanbase.__all_column.column_flags`（第 8 位）分得开。
      改结构时会被重述成字符串默认值（预览里看得见）。不做：列目录是一段按连接类型固定的 SQL，引用内部表在 MySQL 上解析不过，
      要按服务端换查询是另一层机制。重估条件：有人在 OceanBase 上改带表达式默认值的列，或它补上标记（那条断言会红）。
    - 环境问题，不在应用：mysql 命令行客户端 26.7 对它的每条非查询语句报 `ERROR 2027 Malformed packet`；
      备份（`mysqldump` 26.7 或 `mariadb-dump` 13.0）没问题，恢复要用 `mariadb` 客户端。手册写明。
  - 反向验证：去掉子节点排序，倒序写入的单测红（正序写入时不红——serde_json 在这个构建里保留插入顺序，已改成倒序）。
  - 回归：MySQL 8.4、MariaDB 11.4、TiDB 8.5 各 23/23；`bun run check` 通过。打包版（测试包）看过计划树与明细、
    改列加改表名的预览（两条 + 新文案）并执行成功。
- [!] B1b KingbaseES——**阻塞：没有安装包**（官方没有公开镜像，社区镜像来源与许可说不清）。解除条件：拿到试用安装包。
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
    2026-10-02 测了（另建 `dataomni_test_a`）：36 条里 4 条红。**修了一处**（`f879e16`）：列目录的 `COALESCE(x, '') <> ''`
    在 A 模式恒为 NULL，普通列的 `is_generated` 读出 NULL（前端按 Boolean 归一，界面上没露出来），改成点名取值。
    其余三条是用例按 PG 写死了 `date`：A 模式的 DATE 是 `timestamp(0)`，应用照真实类型显示 `… 00:00:00`，按类型分开预期（`7a26bf0`）。
    同一轮：PG 模式库上分区表那条也钉住（openGauss 的分区要写全 `VALUES LESS THAN`，没有 `PARTITION OF`，`f793f20`），
    并查过它分区表的 `tableoid` 每个分区各不相同，按 `tableoid, ctid` 翻页能唯一定位。四处（PG 16、CockroachDB、openGauss 两种模式）各 36/36。
- [ ] ~~B3 云库认证（AWS RDS IAM、Azure Entra、GCP Cloud SQL 代理）~~ **不做**（2026-10-05 定：云厂商各自有客户端与代理，先把已有功能做好）
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
    2026-09-30 起表数据页与整表导出不再因此整张打不开（`39bb53d`）：解码器白名单以外的列（这几种之外还有枚举、域、timetz、
    money、xml、几何、区间……）按 `::text` 取。
    2026-10-01 SQL 标签里的查询也不再报错叫人 CAST（`039ee4a`）：describe 出的列有一列解码器不认，整条改走简单查询协议，
    认不得的照服务端文本显示（inet、money、timetz、xml、oid、regclass、范围、numeric[] / bool[] 等 22 种逐个与 `::text` 比对）；
    同一行里认得的列在文本格式下与二进制时逐列相同。PG 16 与 CockroachDB 过。
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
    逐项清单在 `docs/windows-checklist.md`（2026-10-05），在 Windows 真机上照着核对。
  - macOS 缺口：ad-hoc 签名被 Gatekeeper 拒（需 Developer ID + 公证）、只有 arm64、无 updater。
  - Linux（2026-09-28，本机 Docker 以 amd64 模拟构建与运行，包与发版的同一份配置，带 Instant Client）：
    - rpm（Fedora 42）：`dnf` 自动装上 `libaio`、webkit2gtk4.1；0.4.0 装好能起窗口，升到 0.4.1（Instant Client 9 个文件都在）
      再起一次，卸载干净。**修了一处**：卸载后留下 `/usr/lib/DataOmni/instantclient` 两层空目录（tauri 的 rpm 不登记子目录），
      加 `postRemoveScript`（`d4a6fb5`）。包名是 `data-omni`（`dnf remove data-omni`）。deb（Ubuntu 24.04）装卸干净，`libaio1t64` 自动带进来。
    - 真实桌面会话（Ubuntu 24.04 + xfce4-session + 会话总线 + gnome-keyring，deb）：存密码进 login 密钥环、重启后免输入连上；
      密钥环锁着时连接弹出系统解锁框，取消后再连会重新弹出，解锁即连上。**修了一处**：锁着 / 没有默认密钥环的提示
      原先叫人「装好后重启」，实际不用重启，改成单独一条说明（`af9f7c4`）。
    - 已知缺口（不修）：Secret Service 守护进程在应用运行中退出重启后，keyring 缓存的会话失效（`NoSession`），
      读报的是按 macOS 写的「签名身份」那句，要重启应用。重估条件：有人报告。
    - 没验到：AppImage 直接（FUSE）运行——Rosetta 的 binfmt 认不出 type-2 AppImage（ELF 头第 8 字节的 `AI\x02`），
      shell 当脚本跑；这是本机模拟的限制。v0.4.0 本来就不发 AppImage（见下条），要验得在原生 x86 上跑。
    - GNOME Wayland 会话（2026-09-29，Fedora 42 + GNOME Shell 48 无头 Wayland，rpm 0.4.1 → 0.4.4 连升三次）：应用是原生 Wayland
      客户端（不走 XWayland），GTK 客户端侧标题栏的最大化 / 还原可用；GTK 文件对话框（无 portal）打开 SQLite 文件；Wayland 剪贴板
      粘贴中文 SQL 并执行；外观「跟随系统」随 GNOME 的深色设置实时切换。**修了两处**（都不是 Wayland 特有的）：
      「执行当前 / 选中」每执行一次多挂一条同样的语句（`28f6210`）；1200 宽窗口里结果头与表数据工具栏折字（`855fdc7`）。
    - 真实输入法（2026-09-29，ibus-libpinyin，Wayland 与 X11 两条路径各测一遍）：SQL 编辑器里拼音上屏、候选框跟随、选字中的回车只上屏字母
      不换行；行编辑与筛选框里选字中的回车不提交 / 不应用，平常的回车照常提交与应用；命令面板里选字中的 Esc 只取消选字。
      Linux 本来就不受影响（Wayland 下按键在合成器里就交给了输入法，X11 下 WebKitGTK 不把它报成 Enter）。**修了一处**（`e2216b7`）：
      全仓库没有一处问过输入法，而 macOS 的 WKWebView 会把确认候选那一下报成 `key: 'Enter'`、`isComposing: false`、`keyCode: 229`
      （WebKit bug 311717，新版已修）——选字时会提交单元格、执行命令、关掉对话框。加 `isImeKeyEvent`，36 个文件的 Enter / Esc 先问它，
      门在 `shortcuts.test.ts`（判断这两个键的文件必须调用它）。macOS 上没有用真输入法复现（要改本机输入源），靠 229 的单测钉住。
    - 同一轮顺带修的（`acc1a7e`）：表数据网格里排了队的改动原先仍画加载时的值（只有行底色变蓝），而那一行只给撤销、不能再编辑，
      按下回车后看不到自己改成了什么。现在画新值，悬停另起一行写原值；待删的行照旧是原值加删除线。
    - 仍未做：CJK 与彩色 emoji 字体靠发行版桌面自带。
  - 带 Oracle 的 AppImage 不发；重估条件：AppImage 打包可排除目录不改 ELF，且 `sha256sum` 比对 AppDir 与 `src-tauri/vendor/instantclient` 一致。

## 发布里程碑

### v0.3：可日常使用的关系型数据库 MVP

- [ ] 完成三平台基础安装与冒烟测试
  - macOS 与 Linux（容器）已验；Windows 能构建（2026-10-02），安装与冒烟没有，需真机或虚拟机。

### v1.0：稳定桌面客户端

- [ ] 完成 P5
  - 还开着：5.4 Windows 安装验证；5.1 结果区拖动、5.2 间距字号 token 属「当前版本不做」，不算欠账。
- [ ] P0-P3 无阻塞级缺陷
  - 已知都修了（2026-09-24 / 09-25 macOS 打包版回归），但须发版前完整回归才能勾。
  - 2026-09-29 Linux 打包版（rpm 0.4.9，GNOME Wayland，SQLite）回归事务、网格提交与 CSV 导入，**修了两处**：
    - SQL 标签事务开着时，网格提交 / 结构变更 / 导入走另一条连接、写在事务外面（`9250dc2`）：SQLite 等五秒报
      `database is locked`，PostgreSQL 撞上事务动过的行一直等，不撞时当场提交而状态栏仍说「事务中」、回滚撤不掉。
      现在直接拒绝并说明原因；打包版验过网格提交与导入都当场拒绝、回滚后提交成功。
      把写入并进用户事务（会话连接上加保存点）当前版本不做：七种方言各一份，MySQL 的 DDL 还会隐式提交用户事务。
      重估条件：有人要在事务里直接改表格。
    - 单事务整份退回的导入画成绿勾「已完成」（`e901ef2`）：现在是「失败」且可重试。
  - 2026-09-29 同一套环境连 cu 上的真 PostgreSQL 16（rpm 0.4.12）回归 PG 类型、网格编辑、执行计划、失败事务与断线重连，**修了三处**：
    - `NUMERIC(10,2)` 的零显示成 `0`、`0.00000001` 显示成 `1E-8`（`d9ac9e8`）：BigDecimal 的 Display 所致，MySQL DECIMAL 同病。
      改用 `to_plain_string`；`database_smoke` 两边各加用例，拿真库跑过、去掉修复精确变红。
    - PG 事务失败后刷新表格只见 sqlx 描述列时的一长串原话、0 行（`300f8d2`）：横幅先说原因与「到 SQL 标签回滚再刷新」。
    - 驱动报连接断开后「重新连接」按了没反应（`3a69957`）：`performConnectionSwitch` 只看 `connectionReady`，
      queryStore 那层修过、这层漏了；判断改用和界面同一个 `connectionHealth`。打包版验过：服务端杀掉会话 → 断线 → 重连 → 语句照常执行。
  - 2026-09-29 同一套环境连 cu 上的真 MySQL（rpm 0.4.15，TLS）回归 AI 设计（`deepseek-flash`，5 表 4 外键建成、与库里逐一对上）、
    DECIMAL 显示、外键拒删的整批回退，**修了三处**：
    - 待删除行的划线传到「撤销」按钮上，像是禁用了（`8ad9a71`）：两张网格都只划数据格。
    - 长 SQL 把语句结果头部的「执行」挤成两行（`e14a3d2`）。
    - 没填 AI Key 时报「没有这个连接的密码」、存不进钥匙串时建议「不保存密码、每次输入」（`3b88024`）：另立两条 AI 专用的码。
  - 2026-09-29 同一套环境连 cu 上的 Oracle Free 23ai（rpm 0.4.16 → 0.4.18，经 SSH 隧道）：rpm 自带的 Instant Client
    在 Fedora 42（`libaio` 由 dnf 装上）上**第一次真的连上库**（此前只核对过文件在）。类型显示（`NUMBER(10,2)` 的 `0.00`、
    20 位整数、`BINARY_DOUBLE`、带时区的 TIMESTAMP、CLOB、RAW）、PL/SQL 块按 `/` 切成一条、违反唯一约束的报错带约束名与列、
    执行计划树、事务回滚、结构页与包的源码都正常；升级后标签恢复、密码从密钥环读出重连。**修了三处**：
    - RAW 列落到文本框，照着网格显示的 `0xdeadbeef` 输入就报 ORA-01465（`723a0d4`）：改用和 BLOB 同一个十六进制编辑器，
      写成 `HEXTORAW(...)`。打包版上写入 `0xCAFE`，服务端 `RAWTOHEX` 读回 `CAFE`；同一行的 DATE（带时分秒）与 CLOB（中文加撇号）一并核对。
    - 十六进制输入不认 `0x` 前缀、却说「需要偶数个十六进制字符」（`87371b5`）：只认开头那一个。
    - 「真的执行一遍」的悬停提示印着 `**真的跑**`（`3bb5856`）：文案只进 `title`；`catalog.test.ts` 加门，文案里不许有 `**`（先红后绿）。
      打包版上连 PostgreSQL 悬停看过。
  - 2026-09-30 同一套环境连 cu 上的 SQL Server 2022（rpm 0.4.18 → 0.4.19，英文界面，经 SSH 隧道，TLS「优先」配自签证书）：
    DECIMAL(38,10) 与 bigint 上限一位不差、`GO` 分批加过程体、除零报错「跳到出错处」落在编辑器的行上（不是批内行号）、
    估算执行计划树、结构页（identity、计算列、rowversion、默认值）、升级后从密钥环读回密码重连都正常。**修了三处**：
    - 表里有一列 `sql_variant` / geography / geometry / hierarchyid，表数据页整张打不开，导出也一样（`d0abc30`）：
      报错让用户在查询里 CAST，而表数据页没有查询可改。现在按列点名、把这几列 `CAST(… AS nvarchar(max))`；
      打包版上四种都读出来了，改 `sql_variant` 一格提交后库里是 `edited-v`（nvarchar），rowversion 跟着变。
    - 无主键表按全部列分页排序，而 SQL Server 不许 ORDER BY xml、text、ntext、image、geography、geometry（`ef062b9`）：
      这种表同样整张打不开。这几列不进分页排序；打包版上九种类型各一列的无主键表能打开（按设计只读）。
    - `time(7)` / `datetime2(7)` 丢第七位小数（`80110fe`）：按微秒格式化所致，改成按纳秒。`sql_server_smoke` 补了用例，
      拿真库跑、去掉修复精确变红；MySQL / PostgreSQL 只到微秒，输出不变。
  - 2026-09-30 同一套环境连 cu 上的 MongoDB 8.0（rpm 0.4.19 → 0.4.20，英文界面，经 SSH 隧道）：网格与文档详情按 mongosh 写法
    显示 Long 上限、Decimal128、UUID、Binary、ISODate；整篇文档改写后 `2.0` / `-0.0` / `1e300` 仍是 double、`i` 仍是 int、
    2^53+1 的 Long 一位不差（服务端 `$type` 逐个核对）；Decimal128 比较筛选、按条件删除（先报 40 条再删）、聚合、`$out` 被拒、
    命令控制台的服务端报错、删集合后对象树跟着刷新都正常。**修了两处**：
    - MongoDB / Elasticsearch / Neo4j 的确认框说「现在是自动提交」（`53640f0`）：这几个工作区没有自动提交开关，也没有事务可开。
      另立 `no-transaction`：「这里没有事务：执行即生效，撤不回来」。组件测试先红后绿；打包版上 `{ drop: … }` 的确认框已是新文案。
    - 命令控制台执行后不滚动，上一条回复很长时新结果在视口外、像没反应（`8c2f949`）：照 Cypher 工作台滚到新一条。打包版上验过。
  - 2026-09-30 同一套环境连 cu 上的 Redis 7.4（rpm 0.4.20 → 0.4.21，英文界面，经 SSH 隧道，另建 ACL 只读用户的连接）：
    `SCAN` 模式筛选（`[^b]`）、二进制值与二进制键名转义只读显示且能按原字节删除、多行与中文值改写后服务端字节正确、
    改带 TTL 的值不丢 TTL、hash 加已有字段被拒、zset 分数 `1e+20` / `inf` 与非法分数、stream、250 项列表分三页读完、
    改名撞已有键被拒（RENAMENX）、过期设 0 被拒、新建撞已有键被拒、命令行按 redis-cli 的样子画回复、`FLUSHDB` 先确认、
    只读用户写入报 NOPERM 且草稿留着，都正常。别处改过之后的保存 / 按下标删除都被拒、服务端没被覆盖。**修了四处**，都是打包版上撞到的：
    - 字符串保存被拒后，提示说「取消后能看到现在的值」，取消却仍印打开时那份，再改一次拿去比对的也还是它——
      这个键从此存不进去，除非换个键再点回来（`be7109d`）：取消时重读。
    - 集合元素同样：改元素被拒后点 × / Esc 不重读；按下标删列表元素被拒时说「草稿还在，取消后看得到」，
      而删除既没草稿也没取消（`8d3475c`）：取消重读，删除被拒直接重读并说「什么也没删」。
    - 键过期或被删之后刷新列表，列表里已经没它，右边仍印着它和过期前的剩余时间（`b30c3f3`）：从头一次扫完都不见就清掉选中。
    - 切到命令行后直接敲字全落空（那一页一直挂着只是藏起来，没拿到焦点）（`857e731`）。
    四处各有组件测试先红后绿；打包版 0.4.21 上逐一复现原场景看过：取消后显示别处写入的值且再改能存上、
    删除被拒后表里是现在的 5 项、改元素被拒后 Esc 显示现在的 6 项、删掉选中的键后刷新回到「选一个键」、切到命令行直接敲能执行。
  - 2026-09-30 同一套环境连 cu 上的 Neo4j 2026.09 Community（rpm 0.4.21 → 0.4.22，英文界面，经 SSH 隧道）：
    点标签自动跑、按最少见的标签着色、路径与自环、只返回关系时端点画成虚线占位、属性按 Cypher 字面量显示
    （2^53+1 的整数、`date` / 带偏移的 `datetime` / 三维点、`toFloat('NaN')`、多行中文）、新建节点（中文键名加反引号）、
    改关系属性、非法值表达式报服务端语法错且草稿留着、多条语句第三条失败后停下并标出没跑的、写了标签后对象树刷新、
    `DETACH DELETE` 模式先确认、`PROFILE` 计划树带估计与实际行数、行数上限截断提示、5 秒超时由服务端终止事务，都正常。
    **修了三处**，都是打包版上撞到的：
    - 改节点、关系会悄悄覆盖别处的改动：打开 Alice 后别处把 age 改成 99，这边改成 31 一保存，99 没了（`8e23843`）。
      MongoDB、Redis、Elasticsearch 都拒绝，只有这里不。语句只 `SET` / `REMOVE` 改到的键，所以只比对这些键
      （打开时的字面量；原来没有的 `IS NULL`；NaN 用 `isNaN`）。18 种类型的字面量拿去 `=` 在服务端逐个验过全为真。
      没匹配上时再读一次，分清被改了还是被删了；被改了就把结果换成现在的样子，草稿留着，点「还原」换成现在的值。
    - 删节点时确认框说「一起删掉 3 条关系」，确认前别处又连上一条，`DETACH DELETE` 删掉的是 4 条，界面照样说删成了（`958df14`）：
      删除语句要求 `COUNT { (n)--() }` 仍是确认时的条数（与数的那句同一写法，自环算一条，服务端验过），
      对不上就什么也不删，并说「关系变了，再点一次看现在要一起删几条」。
    - 结果表不分页（`5664c24`）：行数上限选 10,000、5 列时，`invoke` 回来后还要约 3 秒才画出 5 万个单元格；
      结果留在屏幕上时每敲一个键都整表重画，一行 60 来个字符要 8 秒多才打完（amd64 模拟环境里量的）。
      按 `MAX_UNVIRTUALIZED_ROWS` 分页，文案沿用 SQL 结果表的。
    三处各有测试先红后绿（「还原显示现在的值」另做了一次去掉 `onRevert` 的反向验证）；打包版 0.4.22 上逐一复现原场景看过：
    保存被拒、服务端仍是 99、结果行换成现在的样子，「还原」后显示 99 与别处加的属性，再改（连同 NaN 那个属性）能存上；
    删除被拒、节点还在，再点删除确认框说 3 条、确认后删掉；10,000 行一页 200 行、翻到第 2 页是 201–400，结果在屏幕上时打字不再卡。
  - 2026-09-30 同一套环境连 cu 上的 Elasticsearch 9.5（rpm 0.4.22 → 0.4.23，英文界面，经 SSH 隧道，HTTPS「校验证书颁发机构」配自签 CA）：
    点索引自动搜、2^53+1 的 long 与 `unsigned_long` 最大值原样显示并原样写回、`date_nanos` / geo_point / nested / 多行中文、
    改文档撞上别处的改动回 409 不覆盖、带路由的文档读写都带 `routing`、桶聚合与指标聚合分表、多条请求 404 后停下并标出没发的、
    `_cat` 纯文本、`HEAD`、别名搜索、请求体写错不发并指出行号、结构页（多字段、nested、别名）、删索引先确认并带文档数、查询历史，都正常。
    **修了三处**：
    - 别处删掉的文档，这边保存或删除时提示「别处改过，关掉重新点开拿最新的」（`abd75f0`）：带 `if_seq_no` 写一份没了的文档，
      ES 回的是 409（"but no document was found"）而不是 404，`writeOutcome` 的「没了」分支从来走不到。409 时再读一次，404 就说它没了。
    - `_bulk` 里有条目失败时状态码照样是 200，徽标绿、历史记成功、后面的请求照发（`1fa0da0`）——而控制台说「一条失败就停」。
      现在 `errors: true` 的批算失败：停下、历史记失败、回答上方写「2 条里 1 条没写成」。
    - 英文界面「1 hits」「(1 documents right now)」（`cf83ccc`）：这两条的数用的是 `{total}`，单复数只认 `{count}`。改成 `{count}` 补 `.one`，
      单复数的门也认 hits、documents 了。
    三处各有测试先红后绿；打包版 0.4.23 上复现原场景看过：别处删掉 b4 后这边保存，提示「没找到，可能已被删」、服务端没有被重新建出来、
    结果重发后 0 hit；批里一条类型不对时写「1 of 2 items failed」，后面的 `_update_by_query` 没发（服务端 b4 的 score 仍是 1）；别名搜索写「1 hit」。
  - 2026-09-30 同一套环境连 cu 上的 ClickHouse 25.8（rpm 0.4.23 → 0.4.27，英文界面，经 SSH 隧道）：一张 22 列的类型表
    （UInt64 / UInt256 上限、Decimal(38,10)、nan / -inf、LowCardinality(Nullable)、非 UTF-8 的 FixedString、带引号的 Enum、Date32、
    带时区的 DateTime、DateTime64(9) 上限、UUID、IPv4/6、Array / Map / Tuple、多行中文）显示都对；多条语句里的 `SET` 与临时表跨语句有效、
    自带 `FORMAT` 的结果成一列文本、除零报错带码并停下、执行计划列出各索引筛掉的 granule、取消后服务端随即停下。
    **表格编辑与筛选修了六处**，都是打包版上撞到的，其中两处会悄悄改错数据或筛错行：
    - Int128 最小值显示成 0（`8099067`）：`abs()` 溢出回绕，被当成安全整数截断。Oracle 的 NUMBER 整数同一写法，i64 最小值成了近似值（`c29937e`），
      拿 Oracle Free 23ai 先红后绿。
    - Decimal 列的行改不了、删不了，Int128 上还会把相邻的值一起比中（`939e2d2`）：整行定位时数值内联成字面量（为 MySQL 做的），
      ClickHouse 把带小数点的字面量和超过 64 位的整数读成 Float64。ClickHouse 的参数带列类型，不再内联。
    - 筛选同一个原因：Int128 上筛 …727 把 …728 也筛出来，Decimal 上一行也筛不中（`936a7ff`）。ClickHouse 的数值列按字符串字面量比。
    - **字符串参数被服务端当成 TSV 转义读**（`d29a96c`）：表格里写 `C:\new\table` 存成换行与制表符，`a\b` 存成退格符；
      含换行的行整行定位读不进去（BAD_QUERY_PARAMETER）。字符串照 TSV 转义，Array / Map / Tuple 按字面量原样传。
      `clickhouse_smoke` 新增一条，两半各自反向验证变红。
    - 行里有非 UTF-8 的字节时改不了、删不了（`781106a`、`d6bd7f4`）：十六进制文本被当参数去比，报 TOO_LARGE_STRING_SIZE。
      整行定位时二进制值不进条件。第一次只改了纯函数，打包版上照样报错——编辑和删除在取键前已经拆了包；第二次改成从原行取键，
      TableDataViewer 补了第一条组件测试（改、删各一条，撤掉改动即红）。
    - 新增一行要求 16 列全填，提示说它们「没有默认值」（`fade551`）：ClickHouse 省略的列得到类型的零值。它没有必填列。
    打包版 0.4.27 上逐一复现原场景看过：Int128 最小值原样显示；Decimal 那行改成 `-9999999999999999999999999999.9999999999`、
    服务端一位不差；筛 …727 得 0 行、…728 得 1 行；多行文本加二进制 FixedString 的那行改 note 为 `C:\new\table \\N`，服务端字节一致、
    其余列未动，再把这行删掉；新增只填 id 与 Enum，其余为零值、note 取列默认值。
  - 2026-09-30 英文界面的单复数（rpm 0.4.28，SQLite）：单复数的门只认 `{count}`，而 14 条文案把数量放在别的占位符后面跟复数名词，
    数是 1 时印「1 rows」「1 links」——比上面记的 5 条多，门放宽之后才看全（`6ebee4e`）。门改成「任意占位符后跟复数名词」，先红 20 条；
    到不了 1 的 6 条（多于一页 / 超过上限才显示、常量、选项里没有 1）列明原因豁免。一句一个数的改用 `{count}` 补 `.one`，
    两个数的换成不跟名词的说法（`Rows: 1 · columns: 2`）。打包版上看过 ER 图「Tables: 2 · links: 1」、导出框表头 / 范围说明 /
    「first 1 row」预览、导出任务「1 row written」；ES 批量失败的 `.one` 只有组件测试，没连 ES 看。
  - 2026-09-30 同一套环境开本地 DuckDB 文件（rpm 0.4.28 → 0.4.29，英文界面）：一张 24 列的类型表（HUGEINT / UHUGEINT 上下限、
    DECIMAL(38,10)、NaN / inf、`infinity` 日期、TIMESTAMP_NS、TIMESTAMPTZ、INTERVAL、UUID、非 UTF-8 的 BLOB、BIT、带引号的 ENUM、
    LIST / STRUCT / MAP / UNION、2^53+1 的 JSON、多行中文）显示都对；改 UBIGINT / DECIMAL / STRUCT / MAP 后 CLI 逐个核对一位不差，
    HUGEINT 上限的筛选只中一行，新增只填主键、删除、无主键表只读、多条语句里的 `SET` 与临时表、报错带类别并停下且跳到编辑器第 4 行、
    执行计划、事务回滚、停止后 CPU 随即归零、CSV / JSON 导出（大数与嵌套值原样），都正常。**修了三处**，都是打包版上撞到的：
    - 多行文本改一个字就丢掉换行（`6fa5338`）：单行文本框按规范剥掉值里的换行，末尾补一个 `!`，语句里写的是没有换行的那份。
      与方言无关，两张网格都是。值里有换行就用 textarea（Enter 换行、Esc 取消），删掉最后一个换行也不换框；组件测试先红后绿。
    - UNION 的字符串成员显示成 `"hi"`，照着改就把引号存进去（`a119a14`）：DuckDB 把 `'"hey"'` 转成五个字的 VARCHAR 成员，
      CSV 导出也带着引号。按成员自己的样子解码；`duckdb_smoke` 的「显示的字能原样比中」补 UNION 列，先红后绿。
    - 同一条语句再跑一遍、中途停下，卡片照样打绿勾、摊着上一次的结果，SQL 没改所以也没有「结果来自上一次」（`aa912d0`）；
      执行中也同时画着转圈和绿勾。卡片状态收进 `statementOutcome`（先红后绿），停下的标「已停止」并写明结果是上一次的。
    打包版 0.4.29 上复现原场景看过：两行文本补 `!`、回车再加一行 `x`、UNION 改 `bye`，CLI 读回 23 个字两处换行、`bye` 三个字；
    靠 `SET VARIABLE` 让同一条 SQL 变慢再停下，卡片是「Stopped」加说明、没有绿勾。
  - 2026-09-30 同一套环境回归备份（rpm 0.4.29 → 0.4.34，英文界面）。PostgreSQL 16、MySQL 8.4（TLS 必需）、MongoDB 8.2 用本机
    Docker 起在同一网络里，客户端工具装的是 Fedora 自带的 pg_dump 16 / mysqldump 8.0 与 MongoDB 官方的 mongodump 100.13；
    备份路径带撇号、空格与中文。四家各备份一次再用各自的工具恢复进新库，与原库逐项比对一致（PG 的 numeric(38,10)、bytea、
    timestamptz、数组、jsonb 大整数、视图与函数；MySQL 的 bigint unsigned 上限、DECIMAL(38,10)、多行与反斜杠、varbinary、
    datetime(6)、过程与触发器，dump 里没有 GTID_PURGED；MongoDB 的 Long 上限、Decimal128、Binary、`-0.0`、索引）。
    SQLite 副本 `integrity_check` 为 ok、索引 / 视图 / 触发器都在；SQL 标签开着事务、有一行没提交时备份，副本里没有那一行。
    挪走 mongodump 后重试，任务里说没找到并给出安装办法。**修了七处**，都是打包版上撞到的：
    - 断开连接后在任务面板点「重试」备份，日志印的是驱动原话「attempted to acquire a connection on a closed pool」（`92d4fe9`）：
      会话连接取不到时把 sqlx 的错误压成一句话，丢了 CONNECTION_LOST；执行中断线后重新取连接失败的查询同样没被认成断线。
      改走 `QueryError::from`，单测先红后绿；重连后重试照常成功。
    - 扩展名是 `.db` 的 DuckDB 文件被当成 SQLite 打开（`3b47a17`）：工作台写着「已连接」，对象树报「file is not a database」，
      备份入口说的是 VACUUM INTO。打开文件时按文件头认（新增 `database_file_type`），空文件或读不到时才看扩展名；单测先红后绿。
    - 找不到备份工具时，Linux 那段只写了 Debian 的包名（`b4a64cf`）：rpm 装在 Fedora 上，照着 `dnf install postgresql-client`
      找不到包。分开写 Debian/Ubuntu 与 Fedora/RHEL。
    - **DuckDB 的备份显示成功、却恢复不回去**（`8b51a74`）：ENUM 取值里有撇号时，DuckDB 自己的 EXPORT DATABASE 在 `CREATE TYPE` 里
      不转义它（列类型里转义了；1.5.5 与 CLI 1.5.6 都如此），`IMPORT DATABASE` 报语法错误。视图、宏、序列、schema、索引、
      默认值与 CHECK 里的撇号逐个试过都没问题，只有这一处。导出后在空的内存库里重放 `schema.sql`（只有建表语句，开销与库大小无关），
      失败就删掉这份备份并说明原因；单测先红后绿。
    - 上一条修好之前存下的 SQLite 配置、或手动建的 SQLite 连接指着 DuckDB 的库，重新打开照样「已连接」加原始报错（`6959b13`）：
      插件打开时不读文件头。`test_connection` 对有内容、开头却不是 SQLite 文件头的文件直接拒绝，并说 DuckDB 的库怎么连；
      空文件（新库）与相对路径照旧。单测先红后绿。
    - 验上一条时撞到：侧边栏连接失败的报错排在可滚动菜单的最后，7 条连接时落在视野外，点了像没反应（`e673c4b`）；
      从命令面板连接失败则根本没人渲染它的错误（`7952d70`）。前者只让连接列表滚动、报错钉在底部，后者接到标签栏下已有的报错条。
      两处都是布局 / 接线，happy-dom 量不出，也没有 App 级的组件测试可放——靠打包版前后对照（修前截图里都看不到报错）。
    七处在打包版上复现原场景看过：断开后重试写「The connection to the database was lost … Reconnect and try again」，重连后重试成功；
    `.db` 的 DuckDB 文件按 DuckDB 打开、对象树与备份入口都对；缺 pg_dump 时提示分出 Debian/Ubuntu 与 Fedora/RHEL；
    带撇号 ENUM 的库备份被拒、说明原因且没留下目录，换成不带撇号的同一套结构备份后 `IMPORT DATABASE` 进新库，
    HUGEINT 上限、DECIMAL(38,10)、多行中文、BLOB、LIST / STRUCT / MAP / UNION、ENUM、TIMESTAMP_NS、视图、宏、序列、
    另一个 schema 逐项一致；旧的 SQLite 类型配置重新打开时报「不是 SQLite 数据库…用 DuckDB 类型连它」，
    从侧边栏连时报错就在菜单底部看得见，从命令面板连时报在标签栏下。
  - 2026-09-30 接着修上一轮看到的四处小问题（rpm 0.4.35 → 0.4.36，同一套环境）：
    - 断线提示原先说「这条查询没有执行」（`02c3495`）：socket 断在语句送达之后时，自动提交的写可能已经生效，
      这句话会让人放心重跑一条非幂等的写；备份任务断线也用它，「查询」也不对。改成「没拿到结果」，写操作先确认是否已生效。
    - MongoDB 备份任务的标题只写连接名（`8a1aec4`），同一连接备份两个库时是两条同名任务。改成「连接 / 库」；单测先红后绿。
    - 文件库的连接信息写着「保存密码：是」「TLS：已关闭」（`0ccdcbc`），是表单默认值。文件库不列用户、TLS、保存密码；
      组件测试在旧代码上先红。
    - 侧边栏连接菜单只写名字（`093096d`），两个目录里都叫 `app.db` 的文件打开后是两条分不出的 `app`。每行下加「类型 · 目标」；
      第一版在打包版上看，路径从尾部截断只剩 `/home/teste…`，正好截掉了区分的那段，改成文件库写上级目录加文件名
      （`…/a/app.db`），完整路径在悬停提示里；单测先红后绿。
    打包版上看过：两条 `app` 写成 `SQLite · …/a/app.db` 与 `…/b/app.db`，点 b 连上的是 b 的表；SQLite 的连接信息只剩名称、类型、
    路径、环境与两个 ID；MongoDB 在对象树上备份 shop，任务写「Back up mg / shop」；欢迎页照旧写完整路径。
  - 2026-09-30 再修两处：
    - MongoDB 连接在侧边栏菜单与欢迎页写成 `host:port/admin`（`3309d2c`）：那一格是认证库，树里照样列全部库，
      会被读成「连的是 admin 库」。MongoDB 不写库名；单测先红后绿。
    - Redis 键列表一页远超 200 行（原先记在「看到没修的」）：`SCAN` 固定 `COUNT 1000`，键密的库一轮就回来约 1000 个。
      没有照原来的重估条件先量重渲染——「一次交互画多少个节点」本来就该有上限（见 CLAUDE.md），固定收到页大小
      又会让稀疏模式多跑几倍往返；改成按已看到的匹配密度估下一轮的 `COUNT`（第一轮按页大小，一轮没中就给上限 1000），
      键密时一轮约一页，稀疏时第二轮起就回到 1000。冒烟测 3000 个键的库每页不超过 400，旧代码上一页 1002 个（先红）；
      估法单测钉住；`redis_smoke` 12 条在本机 Docker 的 Redis 7 上全过。
    打包版上看过（rpm 0.4.37，同一套 GNOME 容器）：欢迎页与侧边栏写 `bk-mg:27017`（Redis 仍写 `rd:6379/0`，那是库号）；
    3000 个键的库第一页「200 keys read, scan not finished」；稀疏模式 `*dense:12*`（111 个）一页读完、写 scan complete，
    服务端 `cmdstat_scan` 记 4 次（200 + 3×1000），与固定 1000 时的轮数相同。
  - 没设密码的库在表单里取消「保存密码」后连不上（`24941e7`）：每次连接都报 `SESSION_PASSWORD_REQUIRED` 打开表单，
    空着保存再连还是弹，绕不出去——空密码从不记成会话密码。新建与编辑时空着提交记作本次会话的空密码，
    已输过的会话密码不动；重启后照旧先问一次。单测先红后绿。
    打包版上看过（rpm 0.4.38，同一套 GNOME 容器，无口令的 Redis 7）：表单里取消保存、密码留空，保存后一次连上；
    重启应用再连，先弹一次编辑表单，空着保存后连上。
  - 连接列表读不出来时欢迎页是空的、一句话也没有（`1f2131a`）：`connections.json` 空文件、坏 JSON、或从更新的版本退回来
    遇到不认识的 `db_type`，看起来就像连接全丢了（后端其实没丢：服务起不来时所有命令都报错，不会拿空表覆盖文件）。
    错误原先写进表单共用的 `error`、没地方画；另立 `loadError` 由欢迎页常驻显示，后端报错带上文件路径。
    store 单测与 Rust 单测（报错里要有路径）都先红后绿；打包版（rpm 0.4.39）上空文件与未知类型两种都看过，写出路径与原因。
    顺带（`b4f1950`）：保存配置原先 `fs::write` 就地截断再写，写到一半崩溃或断电留下的正是空文件；改成和导出、备份同样的
    `.part` + 改名。崩溃中途无法廉价模拟，**没有先红的测试**。
  - 同一套环境回归 CockroachDB 25.2 与 PostgreSQL 16（rpm 0.4.40，本机 Docker）：表里一列 `inet` 或枚举，表数据页整张打不开
    （`39bb53d`），报错叫人在查询里 CAST，可表数据页没有查询可改——和 SQL Server 的 `sql_variant` 同一回事，PG 上更常见。
    同样的做法：解码器白名单以外的列 `::text AS 原名`，按 `format_type` 的整个类型名比（`timetz`、`float8[]` 的首词是
    `time`、`double`，按首词会误认）。单测先红后绿；打包版上 PG 16 一张 17 列的表（inet、cidr、macaddr、枚举、域、timetz、float8[]、
    money、bit、xml、point、tsvector、int4range……）整张打开，改 inet 与枚举发的是 `'10.0.0.11'::inet`、`'ok'::mood`，服务端读回一致；
    CockroachDB 的 `items`（带 INET）同样打开。代价：按这种列排序时排的是文本（别名与列名相同，`ORDER BY` 认别名）。
  - 同一轮看到：PG 的 interval `'1 day 02:03:04'` 显示成 `1 days 7384 secs`（`b83844a`）——注释说按 PostgreSQL 的文本形式拼，实际拼的是秒数，
    单复数也不对。照 `EncodeInterval` 的 postgres 风格重写；15 条期望值是 PG 16 对同一个值的输出，先红后绿。
    打包版（rpm 0.4.41）上与 psql 逐字一致（`-1 days +02:00:00.25`、`1 year 2 mons 3 days 04:05:06`），改成 `2 days 00:00:01` 写回，服务端读回一致。
  - 同一件事在 MySQL 一侧查过，没有问题（MariaDB 11.8，本机 Docker，应用的 `execute_query` 直读）：`INET6` / `UUID` / `INET4`
    在协议上报 `BINARY`，内容是可打印文本，按文本显示；`VECTOR` 报 `VARBINARY`，显示十六进制字节。字符串绑定写回前三种，服务端读回一致。
    timetz 的编辑框只选时刻、不带时区，是有意的：文本框才是权威值，带时区的原值选择器空着，与 timestamptz 用 `datetime-local` 同一做法。
  - SQL 标签一侧（rpm 0.4.42 → 0.4.43，本机 Docker 的 PG 16）：
    - `SELECT *` 一张带枚举列的表整条报错、叫人 CAST（`3587a7b`）；枚举数组同样（`8b08596`）。枚举的二进制与文本形式都是标签，
      按 `PgTypeKind::Enum` 认出直接取字节；数组逐个元素按 String 解（解码不查类型，只是 `try_decode` 的兼容检查不认，走 `unchecked`），
      输出和别的数组同为服务端的文本字面量。冒烟用例在 PG 16 与 CockroachDB 25.2 上先红后绿。
    - **SQL 结果只要没写 schema 就永远不能就地编辑**（`bb3ec1a`），提示说「读不到索引与约束」，连不带枚举的表也一样。
      目录查询的 null 照插件绑成 `None::<JsonValue>`，PG 当 jsonb，`COALESCE($2, current_schema())` 报类型不匹配，错误被
      `loadTableMetadata` 吞进 console。冒烟用例名叫「界面实际发的参数」，却自己绑 `Option<String>`、不经应用的 `select`，所以一直是绿的；
      改成走 `sqlx_pool::select` 发界面那组参数，先红后绿。这条路只传名字，改按文本绑；MySQL 8.4 上同一条仍过。
      打包版上 `select * from tickets` 可编辑，改枚举发 `'happy'::mood`，服务端读回一致。
    - 同一轮看到：SQL 结果网格里排了队的改动仍画加载时的值（`4b5c69e`）——`acc1a7e` 只改了表数据网格。两张网格改用同一个
      `StagedCellValue`（放在 GridCellValue 旁边，判断仍是 `pendingCellInput` 那条已有单测的纯函数）。组件没有先红的测试；
      打包版（rpm 0.4.44）上 SQL 结果改中文标题画新值、悬停「登录超时 / Was: 登录失败」，表数据页改枚举同样画新值、悬停「ok / Was: sad」。
  - 2026-10-01 SQL 标签的类型覆盖（本机 Docker 的 PG 16 与 CockroachDB 25.2，应用的 `execute_query` 直读逐个探）：
    - 解码器不认的 22 种类型改显示服务端文本（`039ee4a`，见 2.4）。连 `select oid, relname from pg_class` 原先都跑不了。
    - `'infinity'::date` 与 `'infinity'::timestamptz` 让 sqlx **panic**（`0fca595`），不带时区的 timestamp 读成 294277 年；
      表数据页读日期列走同一个解码器。二进制值自己换算，两端最值显示 `infinity` / `-infinity`，越界报错；冒烟用例先红后绿。
    - 浮点的 `Infinity` / `NaN` 显示成 NULL（`baae33a`）：JSON 里没有这几个数，serde_json 给 null。PG 写 `Infinity`，SQLite 的
      `1e999` 写 `Inf`。同时单精度（`0.1::float4`、MySQL 的 FLOAT）原先放宽成 f64 读成 0.10000000149011612，改按 f32 最短写法。
      PG / SQLite / MySQL 8.4 各一条用例先红后绿。
    - numeric 的 `NaN` / `Infinity` 整条报错（`6204723`）：BigDecimal 装不下，按头部符号值认出。先红后绿。
    打包版（rpm 0.4.45，同一套 GNOME 容器，PG 16）：一张带 inet、money、date、timestamptz、float4、float8、numeric、bool[] 的表，
    SQL 标签里 `select *` 整条读出、可编辑，`infinity` / `-infinity`、`0.1`、`NaN`、`Infinity`、`{t,f}` 都照 psql 显示；
    把 `infinity` 的日期改成 2030-01-01、inet 改掉，预览里乐观检查带 `"valid_to" = 'infinity'::date`，提交后服务端读回一致。
    `infinity` 的日期格编辑框里是文本 `infinity`、选择器空着（同 timetz 的做法）。表数据页同样显示。
  - 2026-10-01 接着探边界值：
    - MySQL 的零日期 `0000-00-00` 与部分为零的 `2020-00-15` 整条报错（`dacdb77`），这样的旧表整张打不开；全零的还被 sqlx 的
      `is_null` 当成 NULL（零 TIMESTAMP 显示 NULL，服务端存的不是）。三种日期类型照协议字段直接拼，先于 NULL 判断。
      MySQL 8.4 先红后绿，MariaDB 11.8 同样过。
    - PG 的 `'24:00:00'::time` 显示成 `00:00:00`（sqlx 从午夜加上去绕回来），公元前的日期写成 `-043-03-15`（`0742a60`）。
      自己从微秒换算、照 psql 写 `0044-03-15 BC`；与服务端 `::text` 逐个比，两种格式都比，先红后绿。
      没改：timestamptz 的公元前仍按 RFC 3339 写（`-0043-03-15T12:00:00+00:00`），界面的日期时间编辑按这个形状。
    打包版（rpm 0.4.46，同一套 GNOME 容器，MySQL 8.4 与 PG 16）：MySQL 一张带零日期与部分为零日期的旧表整张打开，真正的 NULL
    仍是 NULL；在零日期那一行改 note（服务端是默认的严格 sql_mode），只发 `note` 一列，提交后零日期原样。PG 表数据页
    `24:00:00` 与 `0044-03-15 BC` 照 psql 显示，改同一行的 note 提交后两列不变。
  - 2026-10-01 其余几家的同一类边界值（SQL Server 2022、Oracle 23ai 在 cu 上，DuckDB 进程内）：
    - 单精度放宽成 f64，`0.1` 显示成 0.10000000149011612：SQL Server 的 real（`1ac04d0`）、DuckDB 的 FLOAT（含列表与结构体里的，`127d9fe`）、
      Oracle 的 BINARY_FLOAT（`03e5aa7`，同时无穷与 NaN 原先是 Rust 的 `inf` / `NaN`，照 SQL*Plus 写 `Inf` / `-Inf` / `Nan`，
      显示的值绑回 BINARY_FLOAT / BINARY_DOUBLE 列读回不变）。三条用例各自先红后绿。ClickHouse 走文本格式，没有这回事。
    - **Oracle 存成地区名的 TIMESTAMP WITH TIME ZONE 让整条查询 ORA-01805**（`46258c8`）：客户端用自己的时区文件换算，
      客户端与服务器的时区文件版本不同就出错：macOS 的 Instant Client 23.26.2 带 45 版、23ai Free（23.26.3）是 43 版，报错；
      rpm 里的 Linux 23.26.3 恰好也是 43 版，不报错。把服务器的 43 版文件给 macOS 客户端（`ORA_TZFILE`）就好了，根因确认；
      老一些的服务器（19c 之类）的版本更低，哪个平台都会碰上。JDBC 按 JVM 时区写进来的就是地区名，这样的表整张打不开。表数据页让服务端写成文本（写法与驱动读偏移时相同，
      会话格式解析得回去，并发守卫按时刻比与地区名相等）；会话格式不改成 `TZR`：那样解析时 `-03:30` 读成 `+03:30`（试过）。
      SQL 标签的语句不能替用户改，ORA-01805 的提示说明原因并给 `TO_CHAR` / `SYS_EXTRACT_UTC` 的写法（`edfde58`）。单测先红后绿，冒烟用例在 23ai 上复现。
    - **Oracle 没有小数秒、偏移为负的带时区时间戳，写回去变成正偏移**（`26d1ba2`，原有的，不是这一轮引入的）：会话格式
      `SS.FF TZH:TZM` 把「空格加负号」当成了小数点，`00:00:00 -03:30` 存成 `+03:30`。美洲的偏移全是负的，改一格就悄悄差出几个小时；
      并发守卫拿原值比时对不上，报行数不符——打包版上改一格时就是这么发现的。改用 `SSXFF`（23ai 上把六种格式 × 五种值逐个试过）。
      冒烟用例先红后绿，Oracle 冒烟 18 条全过。
    打包版（rpm 0.4.47 → 0.4.48，同一套 GNOME 容器，经隧道连 cu 上的 Oracle 23ai）：SQL 标签里 BINARY_FLOAT / DOUBLE 显示 `0.1`、`-0.25`、
    `Inf`、`Nan`；表数据页发的是投影语句（服务端 `v$sql` 里看到），存成 `America/New_York` 的值显示 `2026-07-01 10:00:00.5 -04:00`，
    与 SQL 标签逐字相同；改同一行的 note 只发 note，提交后地区名原样。ORA-01805 用 PL/SQL 主动抛出，提示中英文都画出来了。
    0.4.47 上把 `-03:30` 那格改日期，守卫对不上、整批回滚（就是上面那个错误）；0.4.48 上同样的操作提交成功，服务端读回 `-03:30`。
    SQL Server 的 real 与 DuckDB 的 FLOAT 没在打包版上单独看：走的是与 PG float4 同一条显示路径（0.4.45 上看过）。
  - 2026-10-01 接着查 ClickHouse 与 SQL Server 的 money（ClickHouse 25.8、SQL Server 2022 在 cu 上）：
    - ClickHouse 没查出问题：Float32 / BFloat16、`-0`、`nan` / `-inf`、Int256 最小值、Decimal(76,40)、带时区的 DateTime64(9)、
      Date32 的 1900 年、带 `\0` 的 FixedString、枚举、IPv6、带制表符与引号的数组，都照服务端的写法显示；
      FixedString、DateTime64、Date32、枚举四种把显示的值当参数传回去，逐个比得上。结果头里的类型名也反转义过了。
    - **SQL Server 表数据页里大额 money 读不准，改这一格提交不了**（`ef6e46a`）：tiberius 把 money 拼成 f64 再除以 1e4，
      五千亿往上第四位小数就不对了。只改别的列不受影响（守卫只比改了的列）；改 money 这一格时守卫拿读歪的值去比，
      行数对不上整批回滚；最大值附近读出的数超出 money 的范围，报溢出（8115）。表数据页与整表导出改成转 `decimal(19,4)` 再取，
      与 `sql_variant` 同一条路，显示的写法不变（原本就按 4 位小数写，与 sqlcmd 相同）；smallmoney 只有 32 位，f64 装得下，不转。
      单测与冒烟用例都先红后绿（冒烟用例同时钉住「驱动读的值当守卫比不上」）。
    打包版（rpm 0.4.49，同一套 GNOME 容器，经隧道连 cu 上的 SQL Server）：表数据页 `123456789012345.6789`、`-922337203685477.5808`
    与 sqlcmd 逐字相同；把第一格改成 `…6790`，预览里守卫是 `[m] = 123456789012345.6789`，提交后服务端读回 `…6790`。
  - **MySQL 里 `CALL` 一个查询过程，结果整个丢掉、显示「影响 0 行」**（`ab54cb9`）：describe 对 CALL 说没有列，按非查询执行了。
    describe 不出列的语句改用 `fetch_many`：第一个结果集给用户看（列名取自第一行），一个结果集都没有就是各段影响行数之和，写语句照旧。
    冒烟用例在 MySQL 8.4 上先红后绿，`database_smoke` 72 条（MySQL 8.4 + PG 16）全过。
    打包版（rpm 0.4.50，同一套 GNOME 容器，连 cu 上的 MySQL 8.4）：`CALL om_report(7)` 显示 `7 / 订单 / 1`，与 mysql 客户端的第一个结果集相同。
    （核对时先看到 `订单` 成了乱码：建过程用的 mysql 客户端是 latin1，过程体里的字面量本身就是双重编码，mysql 客户端读出来也一样；
    改用 utf8mb4 重建后正常，不是应用的问题。）
    没做：过程的第一个结果集是空的时候拿不到列（sqlx 不给没有行的列定义），仍报影响行数；导出照旧在执行前拒绝 CALL。
    重估条件：有人报告「CALL 一个查不到行的过程显示影响 0 行」。
  - **SQLite 的 TEXT 里存了非 UTF-8 的字节，整条查询报解码失败**（`30c29a9`）：SQLite 不检查 TEXT 的编码，老程序按 latin1
    写进来的就原样存着，这样的表整张打不开。解不出时取原始字节、非法部分换成 U+FFFD。单测先红后绿。
    同一轮探过、没有问题的：i64 两端、超出 i64 落成 REAL、空 blob、内嵌 `\0`、声明类型与存储类不一致（INTEGER 列里的 `'abc'`、
    DATE 列里的整数）。`-0.0` 同 DuckDB 那条（见下）。
    打包版（rpm 0.4.51，同一套 GNOME 容器）：一行 `Caf` 加 latin1 的 é 的表照常打开，显示 `Caf�`；改同一行的 note 只发 note，
    提交后 `hex(name)` 仍是 `436166E9`；改 name 本身时守卫比不上、整批回滚，库里不变。
  - 2026-10-01 MySQL 其余类型与 JSON 里的数（MySQL 8.4、PG 16 在 cu 上）：
    - **`tinyint(1)` 被当成布尔**（`289ab82`）：sqlx 把显示宽度为 1 的 TINYINT 一律报成 BOOLEAN，存的 `2`、`-128` 都显示 `true`，
      SQL 标签、表数据页、导出都是。照存的数取，与 mysql 客户端相同；`BOOL` 列随之显示 `1` / `0`。UNSIGNED 取 u64。
    - **有一列 GEOMETRY，整条查询解码失败**（`623ec7c`）：原有的分支从来没跑通过（sqlx 的 `Vec<u8>` 不认这个类型名），
      这样的表整张打不开。跳过类型检查取字节，照 `mysql --binary-as-hex` 写十六进制（SRID + WKB）。
    - **JSON 里 2^53 以上的整数在网格上显示错，点「格式化」再保存就写坏了**（`17fdf4f`）：前端的显示与格式化都走
      `JSON.stringify(JSON.parse())`。改成只重排空白，字符串与数照原文抄（雪花 ID 这类后端本来就读得准）。
    - **PG 的 json / jsonb 超出 u64 的整数与长小数被读成双精度**（`1782028`）：取服务端的原文，与 psql 相同（jsonb 显示从
      `{"a":1}` 变成服务端的 `{"a": 1}`）。MySQL 不改：它自己就把 JSON 里的数存成双精度，服务端读出来也是那样。
    四条用例各自先红后绿；`database_smoke` 73 条全过（两条备份用例单独跑过）。
    同一轮探过、没有问题的：BIT(64) 全 1、YEAR、SET、ENUM、负 TIME 到 `-838:59:59`、BIGINT UNSIGNED 上限、`DATETIME(6)` 上限、latin1 的 CHAR。
    打包版（rpm 0.4.52，同一套 GNOME 容器，连 cu 上的 MySQL 8.4）：一张带 `tinyint(1)`、GEOMETRY、JSON 的表整张打开，status 显示
    `2` / `-1`，JSON 里的 `order_id` 显示 `1234567890123456789`，「格式化」后仍是原数；改 note 一并提交格式化过的 JSON，
    服务端读回 `order_id` 不变、GEOMETRY 的字节不变。PG 的 JSON 只在冒烟用例里核过（显示走同一条前端路径）。
  - 2026-10-01 MariaDB 11.4 特有的类型（cu 上）：没查出问题。UUID、INET4 / INET6、存成 LONGTEXT 的 JSON（大整数是原文）、POINT、
    零日期、DECIMAL(65,30)、带系统版本的表与 `FOR SYSTEM_TIME ALL` 都照常读出。VECTOR 要 11.7，没测。
  - **CSV 导入：GBK 文件第一行就报「invalid utf-8」**（`268cdb4`）：中文 Windows 上 Excel 另存的「CSV（逗号分隔）」是 GBK，
    分隔符嗅探也全部出局、回落到逗号。开头 64 KB 不是 UTF-8 就按 GB18030 边读边转，预览、嗅探与导入共用一个判断；
    导入前检查里提醒一句。BOM 与 CRLF 原本就没问题。单测先红后绿（把判断改回总是 UTF-8 精确红在两条 GBK 用例上；
    导入用例里一个字跨在读缓冲的边界上）。README 同步（`ebb7bf8`）。
    打包版（rpm 0.4.53，同一套 GNOME 容器，SQLite）：分号分隔的 GBK 文件经 GTK 文件框选中，预览认出 `;`、`张三` / `广州,天河`
    都对，映射页与执行页显示提醒，导入 3 行、0 失败，库里与原文一致。
    不做：编码下拉框（Latin-1、Big5 之类读成乱码时只能先另存为 UTF-8）。重估条件：有人拿着这类文件来。
  - 2026-10-01 导出再导回（每种方言一张各类型的表，CSV 导出后导回同结构的空表，逐列比对；MySQL 8.4、PG 16 在 cu 上，
    SQL Server 2022、Oracle 23ai 经隧道，DuckDB 进程内）。**修了五处**：
    - **二进制导回去存的是 `0x…` 这串字符**（`a8f1a7d`）：PG bytea、MySQL / SQLite / DuckDB 的 BLOB 长度翻倍、不报错；
      SQL Server 报 nvarchar 不能隐式转 varbinary；Oracle 报 ORA-01465。二进制列的值绑成十六进制，由语句在库里转回字节
      （decode / UNHEX / unhex / from_hex / CONVERT(…, 2)）；`0x` 加偶数位十六进制按字节存，别的文本存它自己的字节（与原来一样），
      Oracle 本来就把文本当十六进制读，只去掉 `0x`。六种方言各一条真库用例，旧代码上都先红。
    - **MySQL 的 BIT 导回去**（`f88096f`）：导出是十进制数，`bit(8)` 导 `0` 存成字符 `'0'` 的字节 48、不报错，`165` 报 Data too long。
      占位符改成 `CAST(? AS UNSIGNED)`。
    - **MySQL 的 GEOMETRY / POINT 导回去报 1416**（`8e05889`）：导出是 `0x` 加内部格式，与二进制列同样转回字节。只限 MySQL。
    - **SQL Server 1900 年以前的 datetime 读不出**（`a67b9ac`）：tiberius 把负的天数转成 u64，release 下报 overflow adding duration to date，
      整条查询（表数据页、导出）报驱动错误；`1753-01-01` 是常见的最小日期占位值。改为自己按天数与 1/300 秒换算，debug 与 release 都先红。
    - **Oracle 原生 JSON（21c 起）与 VECTOR（23ai）的表整张打不开**（`48e397a`、`e1d98ed`）：rust-oracle 0.6 读不了这两种类型，
      报的是 unsupported Oracle type JSON / unknown Oracle type number 2033。投影里写成 `JSON_SERIALIZE` / `VECTOR_SERIALIZE(… RETURNING CLOB)`，
      文本写得回去；SQL 标签的报错加提示给出同样的写法。单测先红后绿，冒烟用例在 23ai 上复现、读出、写回。
    修完以后：PG 24 列、MySQL 22 列、DuckDB 25 列（HUGEINT / UHUGEINT、列表、结构体、MAP、BIT）、SQL Server 24 列（geography 走 WKT、
    hierarchyid、datetimeoffset、xml）、Oracle 21 列逐列一致，剩下的都是预期内的：JSON 里的数被规整（`2.50` → `2.5`，数值相等），
    以及恰好等于 NULL 写法（`\N`）的文本。
    打包版（rpm 0.4.54，同一套 GNOME 容器，经隧道连 cu 上的 Oracle 23ai）：带 JSON 与 VECTOR 列的表整张打开，JSON 里的 20 位整数原样，
    VECTOR 是 Oracle 自己的写法（`1.0E+000`）；网格里给空着的一行填 JSON（JSON 编辑器）与 `[7, 8, 9]` 提交，语句里两列都不进守卫，
    服务端读回一致；SQL 标签 `SELECT *` 报错下面中英文提示都画出来了。CSV 导入、BIT、GEOMETRY、datetime 几处只改后端，没单独打包看。
  - **「执行全部」跑的是改之前的语句**（`6709c3f`，上一条打包验证时撞见）：自动解析有 500ms 防抖，改完立刻点「执行全部」
    （或 Ctrl+Shift+Enter），跑的是上一次解析出的那几条，结果卡片却已换成新文本，危险语句的确认框判断的也是旧的；
    关掉「自动解析」时则一直跑旧的。改了 WHERE 立刻执行的 DELETE，删的是另一批行。执行全部先按现在的文本解析一次，
    确认框与执行用同一份。单测先红（发出去的是旧的 `id = 2`）后绿。
    打包版：0.4.54 上改成 `SELECT 2 AS new_v` 立刻执行，结果列是 `OLD_V`；0.4.55 上关掉自动解析、把 v8 改成 v9 直接「执行全部」，结果是 `V9`。
    （虚拟输入在这台模拟环境里赶不上防抖的时间窗：点击会落在打字中途，所以防抖那条路靠单测钉。）
  - 2026-10-01 导出成 INSERT 再执行回去（各方言一张各类型的表，走应用的整表导出写成 INSERT，执行回同结构的空表逐行比对）。
    值本身没查出问题：PG 34 列（NaN / ±Infinity、公元前日期、`24:00:00`、timetz、数组里的 `NULL` 与 `"NULL"`、money、xml、tsvector、
    范围）、MySQL 24 列（BIT(64)、GEOMETRY / SRID、7 万字的 LONGTEXT、emoji）都一致。问题全在**列的定义**上，**修了三处**：
    - **计算列**（`57b4f41`）：INSERT 里写了计算列，PG 428C9、MySQL 3105、SQL Server 271 / 273（rowversion），每一行都进不去。
      列目录补 `identity_generation`，把 `is_generated` 里的自增与计算列分开；`sql` 格式略去计算列，CSV / JSON 照写。
    - **自增列**（`31ad7f9`）：SQL Server 带 identity 的表（几乎每张）每行报 544，PG 的 `GENERATED ALWAYS` 报 428C9。
      只有 `ALWAYS` 写覆盖：SQL Server 前后各一句 `SET IDENTITY_INSERT`（只在真写了 identity 列时加，表上没有 identity 时这句本身报 8106），
      PG 写 `OVERRIDING SYSTEM VALUE`。BY DEFAULT 不加：CockroachDB 不认 `OVERRIDING`（语法错，试过），它 BY DEFAULT 的表原本执行得回去。
      SQL Server 的 identity 算 ALWAYS，MySQL 的 AUTO_INCREMENT 算 BY DEFAULT。
    - **PG 的序列不跟着走**（`1fb3eb4`）：带着原 id 插回去以后，下一条不给 id 的插入从 1 取号，报 23505。照 pg_dump 在末尾补
      `SELECT setval(pg_get_serial_sequence(…), max(…)) FROM …`（identity 与默认值是 `nextval(…)` 的 serial；空表时什么也不做）。
      MySQL、SQL Server、SQLite 自己会推；CockroachDB 的 identity 同样认这句。
    共用语料八条用例前后端各自先红；真库上 PG 16、MySQL 8.4、SQL Server 2022 导出再执行回去逐行一致，各方言列目录的
    `identity_generation` 在 PG / MySQL / SQL Server / Oracle 23ai / DuckDB / ClickHouse 的冒烟用例里核过（openGauss 没有 identity，为 NULL）。
    打包版（rpm 0.4.57，同一套 GNOME 容器，SQL Server 经隧道、PG 连 cu）：两种库各一张「ALWAYS 自增 + 计算列」的表（PG 另有一列 serial，
    SQL Server 另有 rowversion），预览与整表导出写出的文件一致——计算列与 rowversion 不在、SQL Server 前后有 `SET IDENTITY_INSERT`、
    PG 有 `OVERRIDING` 与两句 `setval`；CSV 照旧带着计算列。在应用里打开这份文件「执行全部」，四条全过，两行原样进去（中间删掉的 id 2 仍空着），
    服务端再插一行：SQL Server 拿到 4，PG 拿到 4。
  - 看到没修的：
    - Oracle 的 `GENERATED ALWAYS`（`GENERATED AS IDENTITY` 的默认）自增列：导出的 INSERT 执行回去报 ORA-32795，Oracle 没有 INSERT 里的覆盖写法，
      只能先 `ALTER TABLE … MODIFY … GENERATED BY DEFAULT AS IDENTITY`；BY DEFAULT 的表执行得回去，但 identity 的序列不跟着推，下一条插入可能撞主键。
      重估条件：有人拿 Oracle 的自增表导出再导回并报告。
    - 导出对话框右上角的「列数」仍按结果的列数算，INSERT 格式略去计算列后写出去的列比它少。没人会因此做错事，不改。
    - `oracle_smoke` 并行跑时 4 条在建表一步失败（用例之间撞上），`--test-threads=1` 21 条全过。与本轮改动无关。
    - Oracle 公元前的 DATE（`-4712-01-01`）导出后导不回去（ORA-01841）：会话的日期格式不认负年份，网格改这种值同理。
      重估条件：有人存公元前的日期。
    - Oracle 的 BFILE 列整条查询报 ORA-00932；`SYS.ANYDATA` 只显示类型名。重估条件：有人拿着这种表来。
    - SQL Server 的冒烟用例并行跑时偶发失败：两条导入用例共用 `dbo.dataomni_import`。单线程 21 条全过。
    - 导出预览（`exportResult.ts`）的 JSON 仍经 `JSON.parse`，2^53 以上的整数在预览里丢位；写出的文件走 Rust，整数是准的，
      超出 u64 的数与长小数照样经 serde_json 成了双精度。重估条件：有人拿 PG 的高精度 JSON 导出并报告。
    - SQLite 非 UTF-8 的那一格在表格里改不了（守卫拿替换字符比不上），而提示说的是「被别人改过、刷新重试」，刷新了也一样。
      要改得在 SQL 标签里按 `rowid` 写。重估条件：有人报告这种表改不了。
    - 表数据页的 inet `::1` 显示成 `::1/128`（`39bb53d` 按 `::text` 取，`text(inet)` 总带掩码；SQL 标签按 `inet_out` 是 `::1`）。
      同一个值，写回不变。重估条件：有人嫌两处写法不一，届时改用走输出函数的转换。
    - DuckDB 的 `COMMENT ON` 注释不进 EXPORT DATABASE 的备份（上游行为），恢复后表与列的注释没了、不报错。
      重估条件：有人靠注释存文档并报告备份后丢失。
    - DuckDB 的 `-0.0` 在网格与导出里都成了 `0`（JSON 数解析后 `String(-0)` 是 `0`）。`-0.0 = 0` 为真，定位与筛选不受影响，
      只是显示与导出丢了符号。重估条件：有人要靠导出区分负零。
    - Redis 元素改动（hash / list / zset 的比对后写）走 Lua 脚本：ACL 给了写权限、但 `-@scripting` 的用户改不了，
      报错里提的是用户没跑过的 `evalsha`。重估条件：有人报告这种 ACL 配置下改不了值。
    - 一批返回多个结果集时（过程里两条 SELECT、`sp_help`、MySQL 的 `CALL`）只显示第一个，其余读掉丢弃，**界面上不提示**
      （`stream_first_result` 的注释说与另外几家一致）。最小的做法是在结果摘要里带「另有 N 个结果集没显示」；
      要动每个后端的 `QueryExecutionSummary`，这一轮不做。重估条件：有人要看过程的第二个结果集，或 `sp_help` 这类系统过程被报告「只出一半」。
    - SQL Server 的 `PRINT` / 低级别 `RAISERROR` 消息不显示：tiberius 的结果流不给 info 消息。重估条件：换驱动或 tiberius 开放这类消息。
    - 已连上的连接，每执行一条语句都要从钥匙串读一次密码（每个命令都重新 `resolve_connection_string`，会话池以完整连接串为键）。
      钥匙串中途上锁（KDE Wallet 闲置关闭、macOS 设了闲置锁定）时，每条查询都会弹解锁框，取消就报错；解锁一次即恢复。
      重估条件：有人报告查询时反复弹钥匙串，或 macOS 上每条语句的钥匙串读取在耗时里看得出来。
    - 连接在网络上被静默丢掉（没有 RST）后，事务里的下一条语句要等满语句超时才失败，报的是「超时，调大超时」，
      而真正该做的是重连。这次在 Docker Desktop → cu 的路径上闲置约一分钟就出现。sqlx 不给 TCP keepalive 选项；
      重估条件：有人在云负载均衡 / VPN 后面报告这件事。
    - SQL Server 的 money 在 SQL 标签里仍按驱动读（大额末几位不对）：语句不能替用户改。表数据页已修（`ef6e46a`，见上）。
      重估条件：tiberius 改成按定点数解 money（冒烟用例里那条 `assert_ne!` 会红），届时投影也可以去掉。
    - Oracle 表数据页上存成地区名的值显示为偏移（`-04:00`），改这一格写回去存的就是偏移，地区名没了（只改别的列时不受影响）。
      重估条件：有人要在表格里保留地区名。
    - `sql_server_smoke` 并行跑时有 5 条互相干扰失败，`--test-threads=1` 全过。与本轮改动无关。
    - `database_smoke` 的两条备份用例与其它用例并行跑时偶发失败（`pg_dump` / `mysqldump` 撞上别的用例正在建删的表），
      单独跑稳定通过。与本轮改动无关。
  - 2026-10-01 结构页改列会不会丢属性（MySQL 8.4、MariaDB 11.4、SQL Server 2022 在 cu 上）。MySQL 只有 `MODIFY COLUMN <整段定义>`、
    SQL Server 的 `ALTER COLUMN` 一次重述类型与可空性，没写进去的属性被静默删掉、语句照样成功。**修了四处**：
    - **MySQL 的 INVISIBLE 列**（`7ccf5cf`）：改完变回可见列。照 EXTRA 带上 `INVISIBLE`；`ON UPDATE` 的正则只取到函数名与精度为止
      （EXTRA 是 `on update CURRENT_TIMESTAMP(3) INVISIBLE`，MariaDB 是 `…(3), INVISIBLE`），否则 INVISIBLE 被吞进去写两遍。
    - **MySQL 的空间列**（同上）：SRID 被删掉（有空间索引时报 3644）。SRID 在 `COLUMNS.SRS_ID`，TiDB 与 MariaDB 没有这一列、
      TiDB 又不看版本注释的版本号，共用的列目录查询读不了它，所以改类型 / 可空性时拒绝并说明，只改名照常放行。
      重估条件：有人要在结构页改空间列，届时按方言分开列目录查询再读 SRID。
    - **SQL Server 的 SPARSE 与动态数据掩码**（`f3e3153`）：稀疏列改完就不稀疏了；带掩码的列不论改什么（只改可空性也一样）掩码都被摘掉，
      敏感列改个长度就成了明文。列目录的 `column_extra` 记 `SPARSE` 与服务端转义好的 `MASKED WITH (FUNCTION = N'…')`；
      SPARSE 写在 COLLATE 之后、NULL 之前（写在 NULL 后面是语法错误），掩码另起一句 `ADD MASKED` 加回去。改结构语料加一条，
      去掉 ADD MASKED 那句真库用例就红。
    - **SQL Server 系统版本表的时间段列**（`1b47a21`，顺带查出）：`GENERATED ALWAYS AS ROW START / END` 由服务端写（显式给值 13536），
      列目录不算它 `is_generated`，于是新增行时被当成必填项、导出的 INSERT 每一行都执行不回去。改为 `generated_always_type <> 0` 也算。
    - **网格里 INVISIBLE / HIDDEN 列整列是 NULL**（`b576691`，打包版上看到的）：`SELECT *` 不展开这两种列，网格的列却来自列目录。
      有这种列时取表数据逐列点名；SQL Server 的 `column_extra` 补记 `HIDDEN`。
    打包版（rpm 0.4.58 → 0.4.59，同一套 GNOME 容器，SQL Server 经隧道、MySQL 连 cu）：系统版本表新增一行，预览里时间段列是 DEFAULT、
    INSERT 只写 id 与 name，提交成功；INSERT 导出不带时间段列；HIDDEN 的 `vt` 显示 `9999-12-31 23:59:59.9999999`（0.4.58 上是 NULL）。
    带掩码与稀疏列的表改长度，预览三条（`ALTER COLUMN`、`ADD MASKED`、`… SPARSE NULL`），执行后服务端目录里掩码与稀疏都在。
    MySQL：INVISIBLE 列的值显示出来（0.4.58 上是 NULL），改长度预览带 INVISIBLE，空间列改可空性被拒、理由文案正常；执行后
    `secret` 仍 INVISIBLE、`g` 的 SRID 仍是 4326。
  - 看到没修的：
    - ~~Oracle 的 INVISIBLE 列没查~~ 查了，比另两家更糟，**已修**（`e0342ae`）：列目录按 `hidden_column = 'NO'` 取，而 INVISIBLE 列与
      函数索引背后的系统列同是 `HIDDEN_COLUMN = 'YES'`，于是这一列在结构页、网格与整表导出里都不存在（导出的文件静默少一列）。
      改为再收 `user_generated = 'YES'` 的，`column_extra` 标 INVISIBLE、取表数据时点名；`MODIFY` 改它的长度与可空性后仍是 INVISIBLE。
      真库用例在旧查询上红。打包版（rpm 0.4.60，Oracle 23ai 经隧道）：网格里有这一列与它的值，CSV 导出预览带着它，行编辑改它提交后服务端是新值。
    - SQL Server 列目录读 `sys.masked_columns` 与 `is_hidden`，这两样 2016 起才有，2014 及更早整段列查询会报错（结构页、表数据页都打不开）。
      2014 已出扩展支持期，README 写的验证版本是 2022。重估条件：有人连 2014。

  - 2026-10-01 顺着同一个问题查 PostgreSQL：`ALTER COLUMN ... TYPE` 是窄语法，原以为只改类型，实际**排序规则跟着类型走**——
    不写 `COLLATE` 就换成新类型的默认值，语句照样成功（PG 16 与 CockroachDB 都是）。`COLLATE "C"` 的列改个长度，排序与唯一性就变了。
    **已修**（`df629cd`）：列目录从 `information_schema.columns` 读显式的排序规则（服务端引好；`pg_catalog` 的不带模式名，
    因为 CockroachDB 不认带模式名的写法，它的 `pg_collation` 也对不上 `en_US` 这类名字），改成字符类型时拼回 `COLLATE`，
    改成数字等类型时不写（写了报「collations are not supported by type bigint」）。改结构语料加一条，真库红过再绿。
    打包版（rpm 0.4.61，连 cu 的 PG 16）：改 `varchar(20) COLLATE "C"` 为 `varchar(50)`，预览带 `COLLATE "C"`，执行后服务端仍是 C、排序仍按字节。

    DuckDB 同样会丢（`VARCHAR COLLATE nocase` 改类型后没了），**不修**：它的目录（`information_schema.collation_name`、`duckdb_columns()`）
    不给排序规则，只在建表原文里；而 DuckDB 的 VARCHAR 没有长度，「字符列改成字符列」几乎不会发生。重估条件：有人在 DuckDB 上改带排序规则的列。
  - 2026-10-01 编辑器切语句（各方言特有写法逐个试）。**修了四处**，都是切错之后整条报语法错：
    - 引号里的反斜杠一律当转义（`0c3241a`）：PostgreSQL、SQL Server、Oracle、SQLite、DuckDB 里 `'C:\'` 是完整的字面量，后面整段脚本
      被吞进字符串合成一条。现在只有 MySQL / ClickHouse 与 PostgreSQL 的 `E'…'` 认反斜杠。
    - Oracle 的 `q'[…]'`（`cf9993f`）：里面的撇号把字符串提前结束，分号把语句切开。
    - SQLite 的 `CREATE TRIGGER … BEGIN … END` 与 PostgreSQL 14 起的 `BEGIN ATOMIC` 函数体（`fadb40d`）：体里的分号把它切成几段，
      编辑器里建不了 SQLite 触发器（没有 DELIMITER 可用）。只在这两种语句里数 BEGIN / CASE 与 END；单独的 `BEGIN;` 照旧切。
    - SQL Server 没有 GO 时的 `CREATE PROCEDURE` / `FUNCTION` / `TRIGGER`（`610d6f2`）：过程体被按分号切开。T-SQL 的过程体到批的末尾，
      没有 GO 整段就是一批，所以从它开始到脚本末尾算一条，前面的语句照旧切。
    切出来的语句在 SQLite、PG 16、SQL Server 2022 上逐条执行过。打包版（rpm 0.4.62，连 cu 的 PG 16）：一段脚本里建 BEGIN ATOMIC 函数、
    查 `'C:\'`、删函数，解析成 3 条，全部执行成功，结果是 1 与 `C:\`。
    没修：MySQL 不写 DELIMITER 的触发器 / 过程体照旧被切（`END IF` / `END LOOP` 让数 BEGIN 与 END 不成立，DELIMITER 本来就是它的写法）；
    风险判定用的关键字扫描不分方言，遇到上面几种写法只会往「更危险」那边偏（藏住后面的 WHERE），不会漏报。

    同一轮查了格式化：sql-formatter 对上面几种写法（`'C:\'`、`q'[…]'`、`$tag$`、`#` 注释、方括号、GO、`/`、BEGIN ATOMIC、触发器体）
    都不改字面量与注释的内容，GO 与 `/` 仍单独成行，不用修。
  - 2026-10-01 一条语句返回几个结果集（`EXEC` 过程、`sp_help`、MySQL 的 `CALL`）：只显示第一个，后面的读掉就没了，界面上看不出少了东西。
    **已修**（`4acb3a3`）：结果里记下没显示的个数，结果头上写「还返回了 N 个结果集，这里只显示第一个」。SQL Server 按列定义数（空的也算），
    MySQL 按每个结果集收尾的 OK 数减去 CALL 自己的那一个。两条真库用例（SQL Server 2022、MySQL 8.4），去掉计数就红。
    打包版（rpm 0.4.63，SQL Server 经隧道）：`EXEC sp_spaceused` 显示第一个结果集，结果头上写还有 1 个。
    没做：把每个结果集都画出来（结果模型是一条语句一份结果，要改形状）。重估条件：有人要看过程的第二个结果集。
    MariaDB 的 CALL 2026-10-02 验过：同一条真库用例在 MariaDB 11.4 上过。
    ~~Oracle 的隐式结果集没查~~ 查了，比另两家更糟，**已修**（`6668c66`）：PL/SQL 块用 `DBMS_SQL.RETURN_RESULT` 交回的结果集整个丢掉，
    显示「影响 0 行」。执行完先取出全部隐式结果，第一个照查询显示，其余报个数（在列之前送，到了行数上限也不漏）。
    真库用例旧代码上红。打包版（rpm 0.4.64，Oracle 23ai 经隧道）：块交回两个结果集，显示 3 行与「还有 1 个」。
  - 2026-10-01 分区表（PG 16 在 cu 上）。**修了一处**（`167f718`）：引用分区表的外键，服务端在本表上给每个分区各记一条克隆
    （`conparentid` 指回本表那条），结构页上一条外键成了 1 + 分区数条（删克隆报 cannot drop inherited constraint），
    ER 图从本表向每个分区各连一条线；父表的每条外键又从每个分区各连一条。排掉克隆，分区从父表继承来的外键照常列出；
    ER 图只画分区表、不画分区。`conparentid` 与 `relispartition` 经 `row_to_json` 读（openGauss 没有这两列），
    两条查询在 openGauss 5.0.3 与 CockroachDB 25.2 上照常。真库用例旧查询上红（6 行对 2 行）。
    同一轮看过、没有问题的：对象树与补全都收 `relkind = 'p'`；没有按 `reltuples` 估行数的地方；备份是整库；
    MySQL 分区表的列、索引与 `SHOW CREATE TABLE` 照常。
    打包版（rpm 0.4.65，连 cu 的 PG 16）：引用两个分区的分区表的那张表，结构页外键 1 条、指向 `public.om_part (id, created)`；
    ER 图 4 张表 4 条线，没有分区的框。
  - 2026-10-01 SQL Server 的图表（`AS NODE` / `AS EDGE`，SQL Server 2022 在 cu 上）：节点表与边表的数据页整个打不开。**修了四处**：
    - **驱动读不了图表的伪列**（`996a090`）：`$node_id` 等伪列在列元数据里带着 TDS 没定义的标志位，tiberius 0.12 遇到不认识的位
      整个结果报「column metadata: invalid flags」，`SELECT *` 都不行。升到 0.13（忽略不认识的位）。同时得到的：`sql_variant` 与
      CLR 类型不再 `todo!()` panic、照底层类型解出来（CLR 类型给二进制，表数据页照旧转文本）；Cargo.lock 里重复的 rustls 0.21 一套没了。
      升级要处理的两件：0.13 默认每个往返最多等 30 秒，关掉（执行多久归界面的超时设置，32 秒的 `WAITFOR` 用例去掉这一句就红）；
      握手的 future 在 debug 构建里从 10 KB 涨到 36 KB，目录用例在握手里撑爆 2 MB 线程栈（lldb 看到栈顶在 `Connection::establish`），
      改为放在堆上，1.5 MB 栈也过。TLS 四档重新试过：关闭 / 要求连得上，校验证书对自签证书照旧拒绝且原因写得清楚。
    - **列目录把内部列记成 HIDDEN**（`c9b1d5f`）：`graph_id_…`、`from_id_…` 等 `is_hidden`，取表数据时按 HIDDEN 点名，报 13908
      「Cannot access internal graph column」。HIDDEN 只能写在 `GENERATED ALWAYS` 的列上，「隐藏却不是 generated always」的只会是
      这几列，结构页、ER 图与补全都排掉；`$node_id` / `$edge_id` 算服务端产生（`graph_type` 经 `FOR JSON` 读，2016 上不报列名无效）。
    - **NVARCHAR 里半个代理对让整条查询失败**（`c86808c`，顺带查出）：`LEFT` 截在 emoji 中间就存下半个，驱动严格解码报
      「invalid UTF-16 sequence」。打开 0.13 的宽松解码，换成 U+FFFD（与 SQLite 的非 UTF-8 文本同一个做法）。
      改这一格时：默认的 `SQL_Latin1_General_CP1_CI_AS` 把半个代理对与 U+FFFD 当成相等，照常改（行靠主键定位，改的就是这一行）；
      二进制与 `_SC` 排序规则下守卫比不上、整批回滚（`238091e` 把注释改成照实写）。
    - **新增行表单里很长的列名压到右边那一格**（`9e17f22`，打包版上看到）：`$node_id_<32 位十六进制>` 没有空格，标签折行。
    四条真库用例都先红后绿，`sql_server_smoke` 26 条单线程全过。
    打包版（rpm 0.4.66，SQL Server 经隧道）：节点表数据页显示 `$node_id`（JSON）、id、name，新增行时 `$node_id` 标「生成」、预览里
    INSERT 只写 id 与 name，提交后新行带着服务端给的 `$node_id`；`om_cut` 显示 `�!`，改 note 提交成功、改 txt 也提交成功
    （见上一条的排序规则）；编辑器里 `SELECT *` 边表、`sql_variant`（1.5）、hierarchyid（`0x58`）照常显示。
    rpm 0.4.67：新增行表单里 `$node_id_…` 的标签在自己那一格里折行，右边的 `id (PK) * int` 不再被盖住。
  - 2026-10-02 怪名字标识符（PG 16 在 cu 上：模式 `om.Odd "S"`、表 `My "T".x` / `Par.ent "P"`，列名带空格、双引号、`]`、反引号，
    外键与索引名同样带引号）。打包版（rpm 0.4.68）逐项走过：表数据页取数、行编辑（`q'"x`）、新增（默认值 `it's` 生效）、删除、
    结构页改长度与改列名、INSERT 导出预览、CSV 预览、ER 图，生成的语句引用都对、服务端结果都对。引用这一侧没有问题。
    顺着走出来的两处，都不是怪名字特有的。**修了两处**：
    - **PostgreSQL 改完表结构，表数据页在这条连接上再也刷不出来**（`6d3cd62`）：报「cached plan must not change result type」。
      sqlx 按 SQL 原文缓存预备语句，`describe` 命中缓存时不问服务端；结果形状变了的旧语句服务端一律拒绝，同一句 `SELECT *`
      每次都撞。不论哪条连接改的结构都会这样（psql 里改也一样），编辑器里同一句查询同样中招。describe 前先清掉这条连接的语句缓存
      （缓存非空时多一次 Close 往返）。事后重试不行：在事务里那一下已让整个事务作废；容量设 0 也不行：sqlx 仍开具名语句却不关。
      真库用例旧代码上红；MySQL 服务端自己重新准备，同一条用例本来就过、钉住它。
    - **取数失败时上一次的行画在新的列下面**（`c784e1a`）：上一条报错时列已按新结构重读，旧行里没有新列名，改了名的那一列整列 NULL，
      像是数据没了。失败就清掉旧行，有错误横幅时不再写「暂无数据」。
    打包版（rpm 0.4.69）：结构页改列名加改类型（int → bigint）后切到数据页，新列名、新类型、值都在；另一个会话 `LOCK TABLE … ACCESS EXCLUSIVE`
    让取数超时，页面只剩超时横幅，解锁后刷新恢复。`database_smoke` 82 条（两条备份用例与其它并行时照旧撞表，单独跑过）。
    取数失败后工具栏的「N 行」仍是上次缓存的行数——2026-10-02 已修（`c7cf471`，rpm 0.4.71：打开后另一边改表名再刷新，只剩错误横幅，改回再刷新恢复 37 行）。
    同一个问题逐个库查过（同一条连接上 `SELECT *`、改结构、再 `SELECT *`）：**SQLite 更糟，已修**（`7207ebc`）——SQLite 自己重新准备语句，
    sqlx 却按缓存里旧的列数取值，加一列之后 sqlx-sqlite 的工作线程下标越界 panic、这一句返回空结果；同样 describe 前清缓存（本机，没有往返）。
    MySQL（服务端重新准备并重发列定义）与 Oracle 23ai（OCI 自己重新描述，`07e7306`）本来就对，各有一条用例钉住；
    DuckDB 每次现准备、SQL Server 与 ClickHouse 不缓存语句，不涉及。
  - 2026-10-02 宽表（PG 16 上 300 列 × 500 行；5.4 的基线只量到 20 列，行数门 200 管不到列数）。打包版（rpm 0.4.70，amd64 在本机模拟，
    数字只能互相比、不代表真机）：翻页 8 列 50 行约 1.2 秒（大半是查询与模拟开销），300 列 50 行约 2.6 秒，300 列 200 行（6 万格）约 6.7 秒；
    点一格选中在 0.5 秒内出来，交互不随格数整页重画，慢的只是换页那一次。**当前版本不做**列虚拟化：没有真机数字也没人报过，
    而它是两张网格的结构性改动。重估条件：有人报宽表卡，或在真机（原生 WebView）上 300 列 × 200 行换页超过 1 秒。

  - 2026-10-02 视图的数据页（PG 16 在 cu 上，SQLite 本机文件）：**PostgreSQL、SQLite、DuckDB 的普通视图在数据页一律打不开**（`5f78d5f`）。
    没有主键时分页按 `ctid` / `rowid` 排序，视图没有这两个伪列（PG「column "ctid" does not exist」，SQLite、DuckDB 同样报列不存在，
    本机 sqlite3 3.54 与 duckdb CLI 各试过），而视图都没有主键；整表导出走同一个排序，同样失败。视图改为不排序、按数据库默认次序翻页；
    不退回按全部列排序（json、point 没有排序运算符，大视图每页一次全量排序）。种类取自对象树，物化视图有 `ctid`、仍按表处理。
    打包版（rpm 0.4.72）：PG 聚合视图出 2 行、点表头排序生效，物化视图照旧，SQLite 视图出 10 行，都是只读。DuckDB 没在打包版里开。
    视图的只读横幅原先写「这张表既没有主键……」，结构页照样给「编辑结构」与「新建索引」（会生成服务端拒绝的 `ALTER TABLE` / `CREATE INDEX`）——
    已修（`9e80478`，rpm 0.4.74）：视图换一句专用的横幅，视图与物化视图都不给编辑结构，物化视图保留新建索引，普通表不变。
    顺着查 Oracle（23ai 在 cu 上）：**没有主键、带 CLOB 的表或视图在数据页报 ORA-22848**（`592dc79`）。没有主键时按全部列排序，
    而 CLOB / NCLOB / BLOB / BFILE / VECTOR、XMLTYPE 与对象类型、LONG 都不能做比较键（逐个试过；JSON、RAW、BOOLEAN、时间与区间可以）。
    按白名单只排能排的类型，一列不剩时不写 ORDER BY。打包版 0.4.72 上复现、0.4.73 上 7 行照常出来。
    接着（`a431207`）：没有主键的**表**改按 `ROWID` 翻页——略去 CLOB 后只在它上面不同的两行是并列的，同 PG 分区表那一条会跨页重复、漏行。
    `ROWID` 在分区表、外部表上都取得到且唯一（23ai 上试过）；视图仍按白名单，聚合视图取不了 `ROWID`（ORA-01446）。生成的语句在库上直接跑过，没打包。
  - 2026-10-02 表数据页一页读不全（PG 16 在 cu 上）：**两种情况都悄悄少行、翻页跳过**（`eac034e`）。`runReadQuery` 不看后端的截断标志——
    一页超过 12 MiB 时后端停在那一行，网格照画、下一页从第 51 行起，中间的行再也看不到；它还借用编辑器的「行数上限」（最低 100），
    每页 200 行时只读到前 100 行。改成自己的行数上限、截断就报错（读到几行、调小每页行数）。打包版（rpm 0.4.75）：60 行 × 400 KB 的表
    每页 50 行报「只读到前 31 行」，改 25 行后 1–25 行、共 3 页；编辑器选 100 行、每页 200 行时一页 200 行读满。
    还没做：单行就超过 12 MiB 时调小每页也读不出来，只能去 SQL 编辑器选列；大列按前缀取（网格本来只显示前几十个字）没做，重估条件：有人报。
  - 2026-10-02 PG 没有主键时的 `ctid` 排序（PG 16 在 cu 上）：**分区表翻页重复、漏行**（`259b4c6`）。`ctid` 只在一张物理表里唯一，
    从分区表或继承的父表读时各个子表各自从 (0,1) 数起；8 个分区 2 万行、每页 50 行翻完只拿到 19777 个不同的行（2 个分区 1000 行时碰巧不出），
    改成 `ORDER BY tableoid, ctid` 后 20000 行一行不差。外部表（file_fdw）的 `ctid` 每行都是 `(4294967295,0)`，不报错、按它排等于不排，没动；
    CockroachDB 没有 `ctid`，但没有主键的表都有隐藏的 `rowid` 主键（`pg_index` 里看得到），走不到这条路。
  - 2026-10-02 ClickHouse 没法排序的类型（25.8 在 cu 上）：**AggregatingMergeTree 表在数据页打不开**（`199e8c9`）。分页按排序键加其余全部列排，
    而查询的 ORDER BY 不收 `AggregateFunction`、`Variant`、`Dynamic`，嵌在 Array / Map / Tuple 里也不收（Code 44，逐个试过；
    `SimpleAggregateFunction`、JSON、Map、Tuple、Point 可以）。这几种列不进分页排序。
    顺着发现（`cb1af89`，各方言都有）：**点不能排序的列的表头后，这张表只能关掉重开**——查询报错、行清空、表头跟着没了，排序只能在表头上取消，
    刷新又带着它。现在数据那条失败、且设了排序时，取消排序再读一次，横幅写「按 s 排序失败，已取消排序：原因」。
    打包版（rpm 0.4.76 / 0.4.77）：聚合表 3 行照常出来，删一行的定位条件只用排序键；点 `s` 表头出横幅、行与表头都在，再点 `total` 正常排序、横幅消失。
    没改：聚合状态是二进制，恰好是合法 UTF-8 的（`sumState`）按文本画出控制字符，不是的（`uniqState`）画成十六进制，两种都看不懂；
    重估条件：有人要在网格里看聚合状态（该用 `…Merge` 查）。
  - 2026-10-02 MySQL 的冒烟用例全部在 MariaDB 11.4 上跑了一遍（cu）：32 条里 2 条红，都是用例自己的问题——几何列建表写的
    `POINT SRID 4326` 是 MySQL 8 的语法，MariaDB 要写 `REF_SYSTEM_ID=4326`，于是 MariaDB 上的几何读写从没被验过。改了写法、
    断言改与服务端自己的 `HEX()` 比（MySQL 8 对 4326 按「纬度 经度」读 WKT 并换轴存，MariaDB 不换，同一句 WKT 两边字节不同），
    两边都过（`f56bf9e`）。顺着查 MariaDB 特有的对象：**系统版本表从 ER 图里消失**（`b37ce37`）——ER 的列查询只认
    `BASE TABLE`，这种表是 `SYSTEM VERSIONED`；改成白名单，序列（`SEQUENCE`）仍不画。真库用例旧代码红。查询改动，没打包。
    没改：序列在对象树里算表，结构页照样给「编辑结构」（服务端拒绝 `ALTER TABLE`）；重估条件：有人在 MariaDB 上用序列。
  - 2026-10-02 MySQL 与 PostgreSQL 的冒烟用例换着库各跑一遍（cu）。TiDB 8.5：32 条里 4 条红在用例（没有存储过程、没有空间类型、
    不许 ALTER 临时表），钉住或换真表后 32/32（`677e7d5`）。CockroachDB 25.2：36 条里两条红在用例（改临时表的列类型、PG 的
    `PARTITION OF`，`9a876b2`），第三条是应用的问题——**结构页在 CockroachDB 上改不了要重写数据的列类型**（`8565d04`）：
    int → text、带排序规则的字符列，在事务里与走预备语句时都报「not supported inside a transaction」，和别的子命令同句又报
    「cannot be combined」。整批都是改结构的语句时在同一条连接上逐条以简单协议执行、不包事务；生成器把改类型各拆一条；
    预览说明逐条生效。事务本来也保不住它：25.2 起默认开着 `autocommit_before_ddl`，第二条失败时第一条已生效（实测）。
    真库用例旧代码红，PG 16 与 CockroachDB 各 36/36。打包版（rpm 0.4.79）：bigint → text 加设非空，预览是两条加那句说明，
    执行后两行数据都在。
    没做：CockroachDB 上「改类型时带上原来的排序规则」只手工试过（`COLLATE "en_us"` 单独一条可以），共用语料用的 `"C"` 它不认，
    那条用例在它上面跳过；SQL 编辑器里手写 `BEGIN; INSERT …; ALTER …; ROLLBACK` 时 INSERT 已被它提交，界面不提示——
    这是服务端的设置，重估条件：有人报。
  - 2026-10-02 取消与超时（MySQL 8.4、PG 16 在 cu 上）：**在 MySQL / PostgreSQL 上点取消，服务端并没有停**（`6023749`）。
    取消与超时只是丢掉执行的 future：点了取消的 `UPDATE` 照样跑完、提交；会话连接上还留着它没读完的回包——PG 的下一条要等它跑完，
    MySQL 的下一条读到残包，先报 `COM_STMT_PREPARE_OK` 协议错、再给出「成功、0 行」，这个标签页直到关掉都是坏的（之前的冒烟只在池上测超时，
    没测会话；300ms 的超时经慢链路死在预处理那一步，语句根本没发出去，测不出来）。照 ClickHouse 的 `KillOnDrop`：执行期间拿一个守卫，
    被丢掉时另取池里一条连接发 `pg_terminate_backend` / `KILL`，下一条先等它结束再换新连接，事务状态归零。真库用例旧代码红；
    只换连接不发结束语句时红在「UPDATE 提交了」。MySQL 8.4、MariaDB 11.4、TiDB 8.5、PG 16、CockroachDB 25.2、openGauss 两种模式都过
    （CockroachDB 不发结束语句也会停：旧连接一关它就取消），MySQL + PG 整套 87/87。
    顺着补了界面（`fb92eac`）：事务里停下一条语句会回滚整个事务（SQL Server、Oracle 本来就是），原先只有状态栏变了；
    现在那一行写「查询已取消」再加一句事务也回滚了。打包版（rpm 0.4.80 / 0.4.81，PG 16）中英文都看过，服务端那行没被改、`pg_sleep` 已停。
    SQLite 接着查了，同样有（`2dfb5df`）：被放弃的语句在 sqlx 的工作线程上接着跑，一条 3 亿次的递归 CTE 让下一条 `SELECT` 等了 85 秒，
    事务里连 `ROLLBACK` 都排在后面、10 秒超时，写语句跑完照样提交。会话开连接时从 `lock_handle` 取一次 `sqlite3*`，放弃时当场
    `sqlite3_interrupt`（代码库第一处 `unsafe`，两处各写了安全前提）；连接不换（内存库换连接就是换库），之后按 `sqlite3_get_autocommit`
    同步事务状态——打断写语句时 SQLite 自己回滚了事务，打断读语句时事务还在。`libsqlite3-sys` 钉死在 sqlx 用的 0.30.1。
    用例旧代码红在 ROLLBACK 超时，不按 autocommit 同步时红在「事务回滚了」。提示改成不说「结束连接」（`ebb1562`），
    打包版（rpm 0.4.82，SQLite 文件）看过。
    顺着查了池里的连接（MySQL 8.4、PG 16，池只给一条连接）：导出取消到一半、读到行数上限中途不再读流、池上的查询超时被丢掉，
    之后同一个池上的 `SELECT 42` 三家各读回自己的一行——sqlx 的池连接被还回或丢掉时自己会读完或关掉。出问题的只有会话那种一直拿在手里、
    从不还回池的连接。没留用例：这道门造不出让它红的输入（除非改 sqlx）。重估条件：升级 sqlx 之后，或有人报表数据页读到别的查询的结果。
  - 2026-10-02 连接串里的主机与库名（本机 Docker 的 PG 16 / MySQL 8.4 监听 `::1`；cu 的 SQL Server 2022、Oracle 23ai 经绑在 `[::1]` 的隧道）：
    **主机填 IPv6 地址连不上**，**库名里的 `#` 吞掉 TLS 参数**（`09cddfa`）。MySQL / PG 的串原样拼主机：`::1` 报 sqlx 的 `EmptyHost`，
    加方括号才连得上；库名里 `#` 之后成了 URL 片段——连到的是另一个库，`sslmode` / `ssl-mode` 一起丢掉，设了必须 TLS 的连接悄悄降级。
    主机按 `http_endpoint` 的判断加方括号，库名百分号编码（sqlx 解码回原样）；单元测试旧代码红，本机经 `::1` 连名为 `a#b` 的库两家都读回 `a#b`。
    Oracle 同样（`bb223a4`）：Easy Connect 串 `//::1:1521/…` 报 ORA-12262，加方括号后 `oracle_smoke` 经 `::1` 24 条全过。
    SQL Server 本来就行（tokio 按最后一个冒号切主机与端口），ClickHouse / Elasticsearch 的 `http_endpoint` 早就加了方括号。
    没验：MongoDB、Redis、Neo4j 与 SSH 隧道的跳板机填 IPv6 地址（都按结构化的主机与端口交给驱动，没经过 URL）；重估条件：有人报。
  - 2026-10-02 会话时区（本机 Docker 的 MySQL 8.4 / PG 16，`TZ=Asia/Shanghai`）：**MySQL 会话被 sqlx 设成 UTC**（`70c9ca5`）。
    sqlx 默认连上就 `SET time_zone='+00:00'`，服务器在东八区时 `NOW()` / `CURDATE()` 差 8 小时，写进 DATETIME 的 `NOW()`、表格里
    「当前时间」按钮写的都是 UTC 的钟点，TIMESTAMP 列按 UTC 读写——与应用和其他客户端对不上。我们按字节照原样显示日期时间，用不着
    sqlx 那条假设，开池时 `timezone(None)`。用例（会话时区等于 `@@global.time_zone`）旧代码在 cu 与本机都红；`mysql_` 冒烟两边各 34 条全过。
    `plugin_decode` 的 TIMESTAMP 仍按 `+00:00` 标偏移，没改：它只解目录查询，而 information_schema 里的时间列都是 DATETIME。
    **PostgreSQL 不改**：sqlx 在启动包里写死 `TimeZone=UTC`，没有开关；它算客户端来源，`RESET` 回来还是 UTC，非超级用户读不到
    配置文件里的值（实测 `reset_val` = UTC、`source` = client）。能选的只有 UTC 或本机时区（JDBC 的做法），两种都会在一部分部署上
    与 psql 不一致，不是对错之分。timestamptz 按 UTC 带偏移显示，存取的时刻是对的；受影响的是 SQL 里不带偏移的字面量与 `current_date`。
    重估条件：有人报东八区的库里 `current_date` 或写入的时刻不对，届时按 JDBC 用本机时区（`after_connect` 里 `SET TimeZone`）。
  - 2026-10-02 顺着查 sqlx 对 MySQL 会话改的别的设置，又修两处（都在 `sqlx_pool::open` 的 `after_connect`）：
    - **`||` 成了拼接、函数名成了保留字**（`621528e`）：sqlx 往 sql_mode 加 `PIPES_AS_CONCAT`，`WHERE id = 2 || n = 5` 成了
      `id = (2 || n) = 5`，一行都不中（cu 上实测）；在这里建的存储过程、触发器、事件会把这个 sql_mode 记下来。握手时它还写死
      `CLIENT_IGNORE_SPACE`，服务器据此加 `IGNORE_SPACE`，`CREATE TABLE position (x INT)` 报语法错。关掉加的两项，连上后去掉
      `IGNORE_SPACE`（全局本来开着的不动——在 MariaDB 上临时开了全局验过，会话照样保留）。
    - **用户变量与 `CAST` 跟列比较报 1267**（`0b7894b`）：sqlx `SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci`，MySQL 8 的列默认
      `utf8mb4_0900_ai_ci`，`SET @v = 'a'; … WHERE name = @v` 报 Illegal mix of collations。服务器默认字符集是 utf8mb4 时
      连接用 `collation_server`，不是的话（latin1 之类）列是什么说不准，不动。
    用例比对会话与全局的 time_zone、sql_mode，并跑一条与 `CAST` 比较的查询，旧代码在 cu 的 MySQL 8.4 上各自红；
    MySQL 8.4、MariaDB 11.4、TiDB 8.5 的 `mysql_` 冒烟各 35 条全过。OceanBase 没跑（本机那台不动）。
  - 2026-10-02 经事务池连 PostgreSQL（本机 pgbouncer 1.26，`pool_mode = transaction`；Supabase、Neon、云厂商托管 PG 的连接池端口是这种）：
    - **每条查询都报 26000**（`1a63e54`）：取列信息用的 sqlx `describe` 为推断可空另发目录查询和 `EXPLAIN (VERBOSE) EXECUTE sqlx_s_1`，
      那句在 SQL 文本里点名预备语句，连接池只改得了协议里的名字（`max_prepared_statements = 0` 时报的是 42P05 already exists）。
      PG 冒烟 37 条红 16 条。改用 `prepare`，结果表头的可空写「未知」（与 DuckDB、SQL Server 相同）。顺带每条语句少两次往返：
      经 cu 20 次平均 describe 1.14 秒、prepare 0.36 秒。用例要设 `DATAOMNI_POSTGRES_POOLER_TEST_URL` 才跑，旧代码红。
    - **取消 / 超时停掉了别的客户端的连接**（`3eb2729`，`6023749` 引入的）：会话打开时记下的 pid 过后可能在服务别人，
      照它 `pg_terminate_backend`，另一个客户端的查询报 terminating connection due to administrator command（旧代码三次三红）。
      现在只停 `pg_stat_activity` 里那个 pid 正 active、语句文本含这条开头 48 个字符的后端；MySQL（ProxySQL 一类代理同理）
      先在 PROCESSLIST 里核对再 KILL，两句之间还有一个往返的窗口（MySQL 没有带条件的 KILL）。对不上就不停，被放弃的语句在服务端跑完。
      停失败原先被整个吞掉；改的过程中 PROCESSLIST 的 ID 按 u64 取，在 MariaDB（有符号）上解码失败、KILL 没发出去，是放弃语句的用例抓到的，
      改成按文本比，失败时 `eprintln`。放弃语句的用例在 MySQL 8.4、MariaDB、TiDB、PG 16、CockroachDB、openGauss 两种模式库都过。
    - 没修：经 pgbouncer 改了表结构之后，同一句查询报 `cached plan must not change result type`。pgbouncer 在服务端按原文缓存预备语句，
      我们发的 Close 只关掉它那边的名字映射（pgbouncer 文档里写着这条限制）。重估条件：有人经连接池用结构编辑后报这个错，
      届时考虑让 PG 的查询不走具名语句。Supabase 的 Supavisor 本身没验，只验了 pgbouncer。
  - 2026-10-02 事务开着时服务端断开连接（PG 的 `idle_in_transaction_session_timeout`，托管库常设；MySQL 的 `wait_timeout`；
    被结束、重启、掉线同理）：**标签页一直卡住**（`c95be77`）。状态停在「事务失败 / 事务中」，`ROLLBACK` 与之后每一条都报连接已断，
    只能关掉标签页。会话在事务里不换连接是对的，可「连接没了」也没记下来。现在会话连接报出连接已断时记下：事务报无事务，
    下一条之前换连接。服务端说完就断开的也算：MySQL 的 4031（SQLSTATE 只是 HY000）、PG 的 FATAL / PANIC（建连时的认证、库不存在、
    连接数满不算），原话留在消息里。CockroachDB 的闲置事务超时报 ERROR 级的 XXUUU 再断开，第二条才认出来。用例旧代码在 PG 16（Failed）
    与 MySQL 8.4（Active）上红，PG 16、MySQL 8.4、MariaDB、TiDB、CockroachDB 过（openGauss 没有这个参数，没跑）；cu 上冒烟 94 条全过。
    前端两处：出错那一行在事务没了时说清整个事务回滚了（`4648370`，原来只在取消 / 超时时问），执行成功就清掉「连接已断开」
    （`f78bed7`，原来只在重连时清，换了连接照常能跑却还摆着重连按钮）。打包版 rpm 0.4.84 / 0.4.85 在 PG 16 上看过。
    没改：断开的提示仍写「请重新连接后再试」——会话自己会换连接，但池整个断了（网络没了）时这句仍对。
  - 2026-10-02 同一件事在 SQL Server 2022、Oracle 23ai 上（cu）：会话本来就恢复——SQL Server 被 `KILL`、Oracle 被
    `ALTER SYSTEM KILL SESSION`（带不带 `IMMEDIATE` 都报 `DPI-1080 … ORA-00028`）之后状态回到无事务、下一条换连接、服务端回滚，
    补了两条用例钉住（`9e14358`；Oracle 那条要测试用户有 `ALTER SYSTEM`，没有就跳过）。顺着查到不走会话的那条路，**修了两处**：
    - **池里的连接被服务端断掉之后，对象树、表数据页连着报几次「连接已断开」**（Oracle `d77aad3`、SQL Server `91ab637`）：
      服务端重启、DBA 清会话、故障转移之后，目录查询每次拿出一条旧连接、报一次，池里有几条就错几次（实测 4 次，第 5 次才好）。
      sqlx 那几家取连接前先 ping，一次都不错。现在拿出来的旧连接报断开就把池里同一批一起丢掉，读换一条新连接再读一次；
      写批量不重试（不知道写进去没有），只清池。两条用例旧代码红（SQL Server 那条起初是假绿：用池里的连接去列会话，它自己不在
      `KILL` 名单里、又最先被拿出来；改成另开一条会话连接去列），只去掉写批量的清池时写那一半单独红。SQL Server 29 条、Oracle 26 条冒烟全过。
      打包版（rpm 0.4.86，同一套 GNOME 容器，连 cu 上的 SQL Server 2022）：把应用的连接全部 `KILL` 之后，对象树刷新一次就出来。
      表数据页第一次刷新仍报一次断开——它走 SQL 标签的会话连接，空闲不到 60 秒不先 ping（`REVALIDATE_AFTER`），编辑器里的语句
      不知道是不是只读，不重试；第二次刷新照常。ClickHouse 走 HTTP（hyper 的池自己重发）、DuckDB 在进程内，没有这个问题。
  - 2026-10-02 危险语句确认的分级（`statementRisk.ts`，36 种各方言写法逐个过一遍）：**两类改数据的语句被当成只读，生产上也不弹确认**
    （`31af2a8`）。PostgreSQL 的数据修改 CTE（`WITH gone AS (DELETE FROM t RETURNING *) SELECT …`，归档常用）顶层只看得到 SELECT；
    `EXPLAIN ANALYZE DELETE / UPDATE`（PG 与 MySQL 8）真的执行，却按 EXPLAIN 算。词法扫描改成带上每个词所在的括号
    （`sqlWords`；`topLevelKeywords` 取顶层，行为不变），WITH 再看括号里的写语句、只认它自己括号里的 WHERE；`FOR UPDATE`、
    `ON CONFLICT DO UPDATE`、`ON DUPLICATE KEY UPDATE` 不算。EXPLAIN 带 ANALYZE（含 `EXPLAIN (ANALYZE, BUFFERS)`）按被解释的那条定级。
    三条用例先红后绿，前端 1752 条全过。打包版（rpm 0.4.87，GNOME 容器，「生产」环境的 PG 16 连接）：两种写法都弹出「没有 WHERE 条件，
    将影响整张表」，取消之后服务端的行与值都没变。
    没改：动态 SQL（PG 的 `DO $$ … $$`、T-SQL 的 `EXEC('…')` / `sp_executesql`）看不到字符串里的语句，按有界写入算（生产上照样拦）；
    `SELECT pg_terminate_backend(…)` 这类有副作用的函数调用按只读算——从语句文本分不出来。重估条件：有人在非生产环境被这类语句伤到。
  - 2026-10-02 打开 Windows 上存的 `.sql`（CRLF 换行）：**「执行选中」「执行当前」截错文本**（`650422f`）。CodeMirror 把 CRLF 读成一个换行，
    选区与光标是这种文本里的位置，`sqlInput` 却还是带 `\r` 的原文；按位置截出来的那段每多一行往前偏一个字符，开头带上一行的尾巴、
    结尾少几个字符（`WHERE` 可能就被截掉）。打包版 rpm 0.4.87 复现：第 4 行选中 `SELECT 4444 AS fourth;`，执行的是 `… AS four;`。
    `setSqlInput` 与恢复草稿时换行统一成 `\n`；来源文件记下原来是 CRLF，写回同一个文件照原样写 CRLF（另存为新文件用 `\n`），
    比对磁盘内容前也先统一换行。四条用例先红后绿，前端 1756 条全过。rpm 0.4.88 同一步执行的是 `fourth`，打开后不显示未保存，
    加一行按 Ctrl+S 直接写回、`od -c` 看每行仍是 `\r\n`。
    同一轮看过、没问题的：UTF-8 BOM 原本就去掉；GBK / UTF-16 的 `.sql` 明确报「不是 UTF-8」，不会乱码打开。
    没改：GBK / UTF-16 脚本打不开（SSMS「生成脚本」默认存 UTF-16）。重估条件：有人拿着这种脚本来，
    届时照 CSV 导入（`268cdb4`）的做法认编码。
  - 2026-10-03 SQL 编辑器的补全：**选中后插的是裸名字**（`650f1b5`）。候选是带类型说明的对象，而 lang-sql 只给字符串候选自动加引号，
    所以 PostgreSQL 的 `Orders`、叫 `order` / `unit price` 的列、Oracle 小写建的表补进去就报不存在或语法错。现在按方言判断能不能裸写
    （PostgreSQL 小写、Oracle 大写、其余字母数字下划线，保留字一律引），不能就用各自的引号；筛选仍按原名，已敲左引号时不引两层。
    在真的 EditorView 里接受补全看插入的文本，四条先红后绿（只撤源码改动精确变红）。rpm 0.4.89 连 cu 的 PG 逐段回车接受补全，
    得到 `FROM "om_Orders" o WHERE o."OrderId" = 7 AND o."order" = 'x' AND o."unit price" > 1`，执行出那一行。
    同一轮看过、没问题的：结果网格复制（选区行号对当前页、多格按 TSV 转义、NULL 与空串分开）；对象树「复制限定名」本来就加引号。
    没改：SQL Server 在 `.` 后面也给关键字候选，输入正好是关键字（`u.use`）时回车选中的是关键字，是 lang-sql 的行为。
  - 2026-10-03 格式化会不会改名字的大小写（各方言拿 60 个常见词当表名、列名逐个排）：**ClickHouse 上改坏了**（`4004561`）。
    关键字统一大写，而 sql-formatter 的 ClickHouse 方言把 `type`、`name`、`key`、`events`、`settings` 等当关键字，名字跟着成了大写；
    ClickHouse 区分大小写，cu 上的 25.8 报 Unknown expression identifier `TYPE`、UNKNOWN_TABLE 'EVENTS'。ClickHouse 改成保留原样。
    其余方言不用改：PostgreSQL 折小写，Oracle、SQLite、SQL Server、DuckDB 不分大小写，MySQL 被大写的都是它的保留字（本来就不能裸写）。
    原有的「排版不改内容」比对前转了小写，抓不到这个；新用例按原大小写比，先红后绿。rpm 0.4.90 连 ClickHouse 输入小写语句、点格式化、执行，查出那一行。
    没改：同一方言把 `type` 当子句关键字排，`type` 单独起一行、逗号落在下一行，难看但能跑，是 sql-formatter 的方言表所致。
  - 2026-10-03 跑大脚本（本机 SQLite 文件，6 条各 1MB 的 INSERT，照 mysqldump 扩展 INSERT 的长度）：rpm 0.4.90 上点「执行全部」**界面卡死**，
    一条都没发出去；跑完小一点的也会**挤掉之前的历史**。修了三处：
    - 记历史时的口令脱敏是平方级（`39bfe53`）：连接串那条正则在一长串字母的每个位置都重新起头，1MB 一条实测 628 秒。加后顾，几毫秒。
    - 真正卡住界面的是执行前一句调试用的 `console.log` 打印整条 SQL（`9e61f50`）：WebKitGTK 打印长字符串是平方级的。
      在副本里给前后端打时间点量出来的：200KB 一条光这一句 38.5 秒，IPC 往返 62ms、后端 11ms。删掉之后 200KB 每条 27–349ms，1MB 每条约 1.5 秒。
      先猜过两处都不是：工作区快照每次 documents 变都重写、结果卡片头放整条 SQL——分别改了打包验过，耗时不变，已撤回。
    - 历史写不下时从旧的砍起，6 条 1MB 记完只剩 4 条、之前的全没了（`50c6ea6`）。现在单条只记开头 2 万字符并标出来，
      截断的记录不给「在新标签里打开」（半截的 DELETE 可能截在 WHERE 前）。rpm 0.4.96 上 9 条都在，截断的点了不打开。
    没改：几 MB 的草稿超过 localStorage 配额，工作区快照写不进去，重启后这个标签回到打开它之前的样子（文件本身在磁盘上）。
    重估条件：有人报重启丢了大脚本的标签，届时让关联了文件的标签只存路径。
  - 2026-10-03 退出时的未完成工作：**后台任务跑着时关窗口不问**（`96b472f`）。关窗口只问事务；rpm 0.4.99 上 40 万行 CSV 按每批一个事务
    导入 SQLite，跑几秒关窗口，窗口当场关掉、进程退出，表里剩 82500 行，下次打开任务中心是空的。现在有进行中（含暂停、正在取消）
    的任务时先列出来问，有导入时说明已写进去的批次会留下。用例先红后绿；rpm 0.4.100 上关窗口弹出「1 个后台任务还没做完：导入 om_imp…」，
    取消后导入照常跑完 400000 行，跑完再关不问，选「中断并关闭」则退出。
    同一轮看过、没问题的：事务只有当前连接一份会话，切换连接与关窗口都经同一道询问；导出与备份先写 `.part` 再改名，中断不会留下假文件
    （`.part` 本身会留着）。数据字典的 Markdown 转义了 `|` 与换行。
  - 2026-10-05 DuckDB 上大小写不同的唯一索引（`schema_metadata.rs` 的 `DUCKDB_INDEXES`；rpm 0.4.164 / 0.4.165，容器里的 DuckDB 文件，本机 DuckDB 1.5.6 CLI）：
    **修了一处**（`36aceeb`）。`duckdb_indexes()` 的 `expressions` 照建索引时的写法给：`CREATE UNIQUE INDEX u ON t (EMAIL)` 得到 `[EMAIL]`，
    而列叫 `email`。前端按列名对索引，对不上就当表达式索引排除，唯一键只有这个索引的表在网格里成了「没有主键也没有可用的唯一索引」、只读。
    现在按 `duckdb_columns()` 不分大小写换回表里的写法（DuckDB 的名字不分大小写，也不许两列只差大小写），表达式索引对不上照旧原样。
    夹具里普通索引改写成 `(NOTE, "Pa")`，断言不变，先红（交回 `NOTE`、`Pa`）后绿，DuckDB 用例 18 条全过。打包版：0.4.164 上这张表标只读；
    0.4.165 上可编辑，把 `b@x` 的 `n` 改成 20 提交，「已提交 1 项」，用 CLI 看文件里只有那一行变了。
    同一轮看过、没问题的：SQLite 的 `pragma_index_info` 交回表里的写法；MySQL、PostgreSQL、SQL Server、Oracle 的索引列取自列目录本身（按查询推断，没上真库验）。
    sqlx 连 MySQL 默认开 `FOUND_ROWS`，「改成同样的值」按匹配行数计，不会被当成并发冲突。
  - 2026-10-05 格式化改坏带前缀的字面量（`formatSql.ts`；rpm 0.4.163 / 0.4.164，本机 Docker 的 PG 16、ClickHouse 26.9，本机 DuckDB 1.5 CLI）：
    **修了两处**。拿各家特有的写法（PostgreSQL 37 条、ClickHouse 26 条）各执行一遍原文、一遍格式化后的，比较结果：
    - PostgreSQL 与 DuckDB 的 `N'…'` / `n'…'`（`b6ee667`）：sql-formatter 不认这个前缀，排成 `N 'a'`，两家都读成「类型 N 的字面量」，
      报类型不存在。从 SQL Server 搬过来的脚本满是这种写法。
    - ClickHouse 的 `x'4142'`、`b'01000001'`（`8a81d70`）：拆开后是语法错误。
    改法是用 `formatDialect` 给这三种方言的单引号字符串补上前缀，不另写词法。两条单测先红后绿，各撤一处补丁都在对应断言上变红，
    前端 1866 条全过。打包版：PG 上 `select N'national' as a, n'lower' as b` 点格式化后照样执行、返回 1 行；ClickHouse 上
    `x'4142'`、`b'01000001'` 排完执行得 `AB`、`A`。
    同一轮看过、没问题的：PG 的 `E'…'`、`U&'…'`、`$$…$$`、`#` 异或、`::` 与数组切片，ClickHouse 的 `tuple .1`、`m ['k']`
    （空格不影响，26.9 上试过）、lambda、`{p:UInt8}`、`FORMAT`；MySQL、SQL Server、Oracle、SQLite 各自认的前缀都没被拆。
  - 2026-10-05 查询历史的口令打码，各家建用户、改口令、连外部库的写法（`historyRedaction.ts`；rpm 0.4.162，本机 Docker 的 ClickHouse 26.9）：
    **修了四处**。拿 32 种写法逐个方言过一遍，按各家真实语法筛出四类漏打：
    - 带前缀的字面量（`871799b`）：SQL Server 的 `ALTER LOGIN … WITH PASSWORD = N'新' OLD_PASSWORD = N'旧'`（SSMS 生成的脚本都写 `N'`）、
      PostgreSQL 的 `PASSWORD E'…'`、MySQL 的 `_utf8mb4'…'`。前缀让字面量前面那段以 `N` 结尾，锚在 `$` 的关键字正则对不上。
    - MySQL 的 `SET PASSWORD FOR 'u'@'%' = '…'` 与 `SET PASSWORD = '新' REPLACE '旧'`（`cb07cd1`）。
    - 字面量里键值对写法的连接串（`26318b6`）：DuckDB 的 `ATTACH 'host=… password=…' (TYPE postgres)`、PostgreSQL 的 dblink、
      SQL Server 的 `OPENROWSET('…;Pwd=…;')`。原先只认 `postgres://u:pw@h` 这种 URL。只在字面量里面认，外面的 `pwd = col` 不动。
    - ClickHouse 按位置给的口令（`47a9bf7`）：`mysql()` / `postgresql()` / `mongodb()` 表函数与同名表引擎第五个参数、
      `CREATE DATABASE … ENGINE = MySQL(…)` 第四个。四种在本机 ClickHouse 上执行后看 `system.query_log`，它自己打成 `[HIDDEN]` 的位置与我们一致。
    每处单测先红后绿，前端 1864 条全过、1MB 一条的线性时间用例照过。打包版：ClickHouse 上执行 `SELECT 'Server=s;Pwd=hunter2;'` 与
    `mysql(…, 'u', 'hunter3')`（连不上、失败），历史里两条都是 `***` 并标「口令已被替换」；localStorage 里历史那份是打过码的，
    明文只在编辑器草稿里（草稿就是编辑器的原文，要原样恢复）。
    没改：ClickHouse 的 `s3(url, key, secret)` 三个参数时与 `s3(url, format, structure)` 分不开；`remote()` 的库表可以合写成一项，位置不定；
    SQL Server 的 `sp_addlinkedsrvlogin` 位置参数；PostgreSQL 的 `PASSWORD $$…$$`。这几种少见，有人报再加。
  - 2026-10-05 风险判定里的 `#` 与反斜杠（`sqlStatements.ts` 的 `sqlWords`；rpm 0.4.160 / 0.4.161，本机 Docker 的 PG 16）：**修了一处**（`a7fbf86`）。
    切分早已按方言读，定级用的词级扫描却不分方言：`#` 一律当行注释、反斜杠一律当转义。SQL Server 的 `DELETE FROM #tmp WHERE id = 1`、
    PostgreSQL 的 `UPDATE t SET flags = flags # 4 WHERE id = 1`、`'C:\' WHERE …` 里 WHERE 被吞掉，判成「没有 WHERE、影响整张表」——
    这一档默认在任何环境都弹确认，用临时表的 T-SQL 脚本几乎每条写入都被拦。现在给了方言就按切分时的同一套规则，不给方言时照旧往危险那边读。
    单测先红后绿，`#` 与反斜杠两处各撤一处都在对应断言上变红，前端 1860 条全过。打包版：0.4.160 上那句 PG 异或弹「没有 WHERE」，
    0.4.161 直接执行、影响 1 行（`1 # 4` 得 5），不带 WHERE 的 `UPDATE om_t SET flags = flags # 4` 照样弹确认。SQL Server 那句只有单测，没上真库。
  - 2026-10-05 块注释嵌不嵌套（`sqlStatements.ts`；rpm 0.4.160，SQLite 文件；本机 Docker 的 MySQL 8.4、ClickHouse 26.9，本机 sqlite3 与 DuckDB CLI）：
    **修了一处**（`4ca2c55`）。切分与风险判定的词法器一律把 `/*` 当成可嵌套，而 MySQL、SQLite、Oracle 到第一个 `*/` 就结束：
    `/* old /* note */ DELETE FROM t` 原先整段读成注释，切出 0 条，按「执行全部」什么也不发、也没有提示；风险判定定级为只读，生产库上不弹确认。
    实测：MySQL（`--comments` 原样发给服务端）与 SQLite 执行了注释后的语句；PostgreSQL、SQL Server（文档）、DuckDB、ClickHouse 嵌套
    （DuckDB 报 `unterminated /* comment`，ClickHouse 整句当注释）；Oracle 按文档不嵌套，没上真库。改成按方言定，风险判定把方言传下去。
    两条单测先红后绿，切分与词级扫描各撤一处判断都精确变红，前端 1629 条全过。打包版：SQLite 上这句加一条 `SELECT count(*)` 显示「2 条语句」、
    弹整表删除的确认，执行后影响 3 行、计数 0。
    没改：编辑器与结果卡片的上色仍按嵌套画（lang-sql 的词法器），注释后面的 DELETE 显示成斜体注释色，只是颜色。
  - 2026-10-05 上一轮记下没修的三处（`redisCommandLine.ts`、`historyRedaction.ts`、`esAggregations.ts`；rpm 0.4.159，本机 Docker 的 Redis 7 与 Elasticsearch 8.19.4）：**修了三处**。
    - Redis `SAVE`、`CLIENT PAUSE`、`DEBUG` 执行前先问（`4b7fc98`）：另起「停下来不理别人」一档，提示指向 `BGSAVE`；`DEBUG` 原先套用
      `KEYS` 的「从头扫一遍」。`CLIENT KILL` 归入「改服务端」，`CLIENT UNPAUSE`、`BGSAVE` 不问。打包版发 `CLIENT PAUSE 600000` 弹出新文案，取消。
    - 历史脱敏的 Redis 切词与 redis-cli 一致（`97132b2`）：`ACL SETUSER u >"my pass"` 原先只打掉 `>"my`，`pass"` 留在历史里。
      打包版执行后历史里是 `ACL SETUSER probe >*** on`；服务端 `ACL LIST` 里 probe 只有一个口令哈希，证实那是一个参数。
    - ES 桶里面的单桶聚合摊成带前缀的列（`88d6920`）：`terms` → `filter` → `avg` 现在是 `recent.doc_count`、`recent.avg_price`、
      `recent.inner.doc_count` 几列；单桶下面再有桶的那一格仍是 JSON。打包版「聚合」页与单测（真服务端原话）一致。
    - 三条单测都先红。
  - 2026-10-05 备份在 Windows 上找工具（`backup.rs`；本机单测，Windows 分支用 `rustc --target x86_64-pc-windows-msvc` 做类型检查）：**修了一处**（`eccf578`）。
    找 `pg_dump` / `mysqldump` / `mongodump` 时拼的是不带 `.exe` 的文件名，Windows 上 `is_file` 永远为假，装了也报「没找到」；
    PostgreSQL、MySQL 官方安装包与 MongoDB Database Tools 又都不改 PATH。现在补 `EXE_SUFFIX`，再按 `%ProgramFiles%` 下带版本号的
    目录找（新版本在前，版本号按数比，`9.6` 排在 `17` 后面）；拉起工具时设 `CREATE_NO_WINDOW`，否则 GUI 子系统的应用每次备份闪一个黑窗口。
    单测先红（版本排序与没有 `bin` 的目录）；类型检查反向验过（常量改成 `u64` 时 Windows 目标报错）。**没在 Windows 上跑过**，列进
    `docs/windows-checklist.md` 第 6 节。
  - 2026-10-05 数据字典的「可空」一列（`dataDictionary.ts`、`schemaDraft.ts`；rpm 0.4.158，容器里的 SQLite 文件；sqlite3 本机）：**修了一处**（`c77a7d6`）。
    字典把主键列一律写「不可空」，本意是盖住 SQLite 对 `INTEGER PRIMARY KEY` 报的 `notnull = 0`；但 SQLite 里非 INTEGER 的主键
    （`TEXT`、连 `INT` 也算）和复合主键真存得进 NULL（本机 sqlite3 逐个插过），字典照样写「不可空」，读的人和 Agent 会当真。
    `WITHOUT ROWID` 与 `STRICT` 表的目录本来就报 `notnull = 1`，DuckDB 等其余各家的目录也把主键报成不可空，所以只剩 rowid 别名
    （唯一的主键列、类型恰好是 `INTEGER`）不照目录。设计页的草稿原先靠这条一律改写，现在在 `draftToEr` 里就把主键列标不可空，
    与建表语句（`columnDraft`）一致。两条单测先红；打包版导出的字典里 `codes.code`（TEXT 主键，库里真有一行 NULL）与
    `pairs.x` / `pairs.y` 是 yes，`items.id` 是 no。
    - 同一轮看过、没问题的：多格复制的 TSV 对含制表符、换行、引号的格子加引号，单格原样；结果画图对数字字符串、空串、
      布尔的取舍与刻度取整都对。
  - 2026-10-05 Elasticsearch 聚合表里的单桶聚合（`esAggregations.ts`；rpm 0.4.157，本机 Docker 的 Elasticsearch 8.19）：**修了一处**（`632bee1`）。
    `nested`、`filter`（以及 `global`、`missing`、`sampler` 这类）只有 `doc_count` 与子聚合，原先被当成多值指标：
    下面 `terms` 的桶整个写成指标表里的一格 JSON。查 nested 字段几乎必经 `nested` 再套 `terms`，这张表就等于没有。
    现在照顶层摊开，表名带上外层（`c.by_author`），外层的 `doc_count` 与它下面的指标进指标表（`cheap.avg_price`）。
    单测用真服务端的原话先红；打包版发同一条请求，「Aggregations」里是 `c.by_author`、`cheap.by_city` 两张表与一张指标表。
    - 没改的：桶里面再套单桶聚合（`terms` → `filter` → `avg`）仍写成一格 JSON。已在后一轮修掉（`88d6920`）。
    - 同一轮看过、没问题的：SVG 导出对 `fill="none"` 的线条保留原属性，不会被填黑；控制台日志的脱敏只到开发者工具，
      不落盘，`ssh_password` 这类键名漏打不算外泄面。
  - 2026-10-05 Redis 命令行的回答与 Elasticsearch 控制台的风险判定（`redis.rs`、`esConsole.ts`；rpm 0.4.155 / 0.4.156，
    本机 Docker 的 Redis 7.4 与 Elasticsearch 8.19，cu 上的 Redis 7.4 与 OpenSearch 3.8）：**修了两处**：
    - Redis 的整数回答按 JSON 的数传到前端（`f8efef4`），到了 JS 是双精度：`INCR` 到 2^53 以上差一（`9007199254740993` 显示成 `…992`），
      雪花 ID 这类计数器正是这个量级。现在后端传十进制文字。单测先红；Redis 冒烟 12 条全过（新加一条 `INCR` 越过 2^53）；
      打包版命令行里 `INCR big` 显示 `(integer) 9007199254740993`，与 `redis-cli GET` 一致。旧版的界面没有另装一遍看。
    - `DELETE _all` 判成有界的写（`0612f62`）：`_all` 被当成了端点，而它在索引的位置上就是「所有索引」（cu 的 OpenSearch 上
      `_all/_count` 与 `*/_count` 同为 179）。开发环境默认只拦批量写以上，这条不弹框；OpenSearch 3.8 的 `destructive_requires_name`
      默认是 `false`，会照删（Elasticsearch 8 起默认拒）。现在按删数据判。单测先红；打包版发 `DELETE _all` 弹出「丢弃数据」确认，
      取消后 `om_keep` 还在。真删没有在 OpenSearch 上跑——那台上还有别的索引。
    - 同一轮看过、没改的：Redis 的 `SAVE`、`CLIENT PAUSE` 不问；历史脱敏里 `ACL SETUSER u >"my pass"` 只打掉前半截。
      两处都已在 2026-10-05 后一轮修掉（`4b7fc98`、`97132b2`）。
  - 2026-10-05 DuckDB 宏的「查看定义」（`object_catalog.rs`；rpm 0.4.154，容器里的 DuckDB 文件；DuckDB 1.5.6 CLI）：**修了一处**（`1d8072d`）。
    宏没有存原文，定义是拿参数名与宏体拼回来的：参数类型丢了（`typed(a DOUBLE)` 拼成 `typed(a)`，照它重建后实参不再先转类型，
    `typed(7, 'x')` 从 `7.0x` 变成 `7x`），名字也不加引号（`sales."My Macro"` 拼成 `sales.My Macro`，语法错误）。
    现在类型取自 `parameter_types`，名字不是普通标识符或是保留字时加引号。单测在内存库里照拼出的定义删掉重建、调用结果不变，
    换回旧语句三条都红。打包版里建 `"My Macro"("the x")`，查看定义是 `CREATE MACRO main."My Macro"("the x") AS ("the x" * 2)`。
    - 没修的：参数默认值（`b := 5`）目录里没有，只有 `EXPORT DATABASE` 写得出来，拼回来的定义里没有默认值。
      重估条件：`duckdb_functions()` 多出带原文或默认值的列（`SELECT * FROM duckdb_functions()` 看列名）。
      带类型的宏只有 v1.4.0 起的存储格式收，应用按默认格式开的文件里建不出来，打包版上只看了引号那一半。
    - 同一轮看过、没问题的：会话目标的「只读」在各方言都解码成布尔或数（Oracle 的 `NUMBER(1)` 是数）；
      SQLite 的对象 schema 恒为空，建索引不会把 schema 写到 `ON` 后面；MongoDB 文档网格里缺 `constructor` 这类字段时
      取到原型上的函数，只是少了「缺字段」的提示，不改。
  - 2026-10-05 Neo4j 语句的风险判定与 IPv6 主机的写法（`cypherRisk.ts`、`mongoConnection.ts`；rpm 0.4.153，cu 上的 Neo4j 2026.09，
    容器里只在 `[::1]` 上听的转发）：**修了两处**：
    - GQL 的 `INSERT` 不算写（`bf7ffa9`）：Neo4j 5.18 起与 `CREATE` 同义，2026.09 上不加 `CYPHER 25` 也建节点，`EXPLAIN` 报 `WRITE_ONLY`。
      写入词表里没有它，整条按读放行、连服务端都不问，「危险语句确认」设到「包括 INSERT 在内的所有写入」也不弹。
      默认门槛（生产只拦到「有界写入」）下看不出差别。拿服务端语法报错里列出的全部子句词逐个对过，漏的只有这一个。
      打包版里门槛设到 INSERT 档后执行 `INSERT (n:OmProbe {k: 7})` 弹「插入数据」确认，取消后库里没有这个节点。
    - IPv6 主机与端口拼成 `::1:7687`（`342f007`）：主机存的是去掉方括号的写法（`f2401ce`），工作区顶栏、命令面板与连接信息
      照拼，分不出哪段是端口；ES 控制台印出 `https://::1:9200`，不是合法 URL。四处手拼的改用 `serverAddress` 并让它加方括号，
      命令面板上 MongoDB SRV 连接也不再印出用不到的端口。打包版里欢迎页、Neo4j 顶栏、命令面板都是 `[::1]:7687`；
      SQL 与 ES 两处顶栏走同一个函数，没在界面上单独看。
    - 同一轮看过、没问题的：Cypher 拆语句与服务端一致（字符串不认 `''`、没有 `--` 注释、字符串里的 `;` 不拆）；
      写了东西之后刷新对象树看的是服务端的计数，不靠词表。命令面板的模糊匹配与字节数的写法只有小毛病
      （超过 1024 MB 仍写 MB、查询里的四字节字符匹配不上），不改。
  - 2026-10-05 接着查 ClickHouse 复合类型与 PostgreSQL 时间戳上的「包含」（`tableFilters.ts`；rpm 0.4.150 / 0.4.151，cu 上的
    ClickHouse 25.8、PG 16 与 CockroachDB 25.2）：**修了两处**：
    - ClickHouse 的 FixedString（`a615872`）：FixedString(4) 存 `ab` 是 `ab\0\0`，网格里看着是 `ab`，原列「结尾是 ab」0 行。
      不再当字符串原样比，交给 `toString`（它去掉末尾的 `\0`）。打包版：「结尾是 ab」出那一行。
    - PostgreSQL 的 timestamptz（`792a394`）：`::text` 是 `2024-01-01 19:04:05.5+00`，网格是 `to_rfc3339` 的
      `2024-01-01T19:04:05.500+00:00`，照网格搜 `T19:04`、`+00:00`、`.500` 一行也中不了。改用 `to_char` 拼成同一种写法，小数秒
      照 chrono 取 0 / 3 / 6 位；会话被 sqlx 定成 UTC，所以不写 `AT TIME ZONE`——CockroachDB 的上限时刻经它越界；判 infinity
      用 `IN ('infinity', '-infinity')`，CockroachDB 没有 `isfinite`。PG 16 与 CockroachDB 25.2 上逐行与网格一致。
      打包版：「包含 `T19:04:05+00:00`」「包含 `05.500+`」各出对的那一行。
    两条单测都先红后绿，前端 1850 条全过。
    同一轮看过、没问题：ClickHouse 的 Array / Map / Tuple 网格显示的就是 `toString` 的写法（带 `\'`、`\\`、`\t` 的也一样），
    界面上「包含 `it\'s`」出对的那行；PG 的 money、timetz 数据页本来就按 `::text` 投影，两边一致。
    没改：PG float8 的指数写法（`::text` 是 `1e+20`，网格是 `100000000000000000000`），在浮点列上搜子串少见；
    timestamptz 的公元前日期（网格 `-0043-…`，`to_char` 写 `0044-…`）；CockroachDB 存成 infinity 的行连原样 `SELECT` 都报 22009，与筛选无关。
  - 2026-10-05 Oracle 上筛选「包含」与网格的写法（`tableFilters.ts`；rpm 0.4.149，cu 上的 Oracle 23 Free）：**修了一处**（`856795c`）。
    和上一条 ClickHouse 同一类，Oracle 更多：LIKE 左边隐式 `TO_CHAR`，NUMBER(10,2) 的 12.50 写成 `12.5`、0.5 写成 `.5`，
    TIMESTAMP 带六位 0 的小数秒（`03:04:05.000000`），而网格是 `12.50`、`0.5`、`03:04:05`——照网格搜 12.50、0.5、以 `05` 结尾一行也中不了。
    NUMBER(p,s) 改用 `TO_CHAR(列, 'FM9…0.00')` 补齐标度，不带精度的 NUMBER 与 FLOAT 补上小数点前的 0，时间戳与数据页投影共用
    同一段写法（带时区的再接 ` TZH:TZM`）。DATE 靠会话的 `NLS_DATE_FORMAT` 本来就对，整数照旧。
    单测先红后绿，前端 1848 条全过；生成的语句在 23 Free 上逐条跑过，十一种搜法与网格一致。打包版：D「包含 .50」出 12.50、0.50，
    TZ「包含 `05 +08:00`」只出那一行，N「包含 `0.`」出 0.5、-0.75。
    没改：BINARY_DOUBLE / BINARY_FLOAT 服务端最少给 17 位（0.1 是 `.10000000000000001`），网格是 JS 的最短写法 `0.1`，SQL 里拼不出来；
    在这两种列上搜小数位要靠「等于」「大于」。
    同一轮看过、没问题：建索引在 SQLite 上写成 `ON "main"."t"` 会是语法错，但树上 SQLite 对象的 schema 是 null，走不到。
  - 2026-10-05 ClickHouse 上的筛选与建表、改结构（`tableFilters.ts`；rpm 0.4.148，cu 上的 ClickHouse 25.8）：**修了一处**（`1eeb2e4`）。
    Decimal 列上「包含」：toString 去掉末尾的 0，网格里的 12.50、3.00 转成文本是 12.5、3，搜 12.50 或 .00 一行也中不了；
    有小数位时改用 `toDecimalString(列, S)`，S 取类型里最后一个数（目录一律记成 `Decimal(P, S)`），与后端补零同一条规则。
    单测先红后绿，前端 1847 条全过；生成的语句在 25.8 上「包含」「开头是」「结尾是」都与网格一致。打包版：dec 列「包含 .00」只出 3.00、「包含 12.50」只出 12.50。
    同一轮看过、没问题：19 种类型上的「等于」「大于」（Float32、DateTime 带时区、DateTime64、Bool、Enum、Array、Map、Tuple、IPv4、
    UUID、FixedString、超过 2^53 的 Nullable(Int64)、Date32 的 1900 年）照字符串字面量交给 ClickHouse 按列类型转，全对。
    **撤回了两处**（`c22a5a3`、`c3bcb3b`，由 `ac3b12d` 撤回）：先查出建表与改结构生成的语句在 ClickHouse 上不对——「可空」勾着却建出
    不可空的列、NULL 悄悄存成空串；改可空、改默认值、改类型、改表名四种全是语法错——修完上打包版才看到这两个入口在 ClickHouse 上
    本来就不开（`PENDING_FEATURES` 有意不做 `structureEditing`），用户走不到。核过的写法留在这里，等要开放时照着做：可空是类型
    （`Nullable(T)`；`Array`、`LowCardinality` 不能包，要写 `LowCardinality(Nullable(String))`），`Nullable(…)` 再带 `NULL` / `NOT NULL`
    报 377；改类型、默认值用 `MODIFY COLUMN 列 类型 DEFAULT 表达式`（只写类型时原默认值保留），去掉默认值是另一个
    `MODIFY COLUMN 列 REMOVE DEFAULT`，同一条里不能和改名并用（48）；改表名是 `RENAME TABLE`；不写 `ORDER BY` / 主键建不了 MergeTree 表。
    教训：动手前先确认入口能不能走到。
  - 2026-10-04 数值列上的筛选（`tableFilters.ts`；rpm 0.4.146，本机 Docker 的 PG 16、cu 上的 MySQL 8.4，DuckDB 1.5 CLI）：**修了两处**。
    ① `f21a0f4`：MySQL 的 BIT 网格里显示成十进制数，「包含」却拿 LIKE 比那几位的字节，bit(8) 里的 54 搜 5 一行也中不了；
    转成 UNSIGNED 再 LIKE。比较不受影响（MySQL 拿字符串比 BIT 时按数比，`= '6'` 筛得中）。
    ② `374b9d6`：单精度浮点与 money 上的比较。PostgreSQL 的 `real = 1.1` 把列提升成 double，一行也中不了；`money = 12.5`
    报 `operator does not exist: money = numeric`——两者改成字符串字面量由它按列类型转。MySQL 的 FLOAT 不论 `1.1` 还是 `'1.1'`
    都按 double 比：「等于」中不了，「大于 1.1」反而把存的 1.1 筛进来；写成 `CAST(1.1 AS FLOAT)`，等于、大于、小于都对。
    DuckDB 的 REAL 本来就对，SQL Server、Oracle 按类型优先级把字面量转成列的类型，没动。
    单测都是先红后绿，前端 1846 条全过。打包版：PG money「等于 12.5」、real「等于 1.1」各中 1 行；MySQL BIT「包含 5」中 54，
    FLOAT「大于 1.1」只出 2.5、「等于 1.1」中 1.1。
    同一轮看过、没改：MySQL 其余类型（DOUBLE、JSON、DATETIME(3)、YEAR）上「包含」与网格显示一致；二进制列（varbinary、bytea、BLOB）
    上「包含」比的是原始字节而网格显示 `0x…`，各家显示规则不同，要单独评估。上一轮记的 `"this connection"` 横幅查清了：应用里删连接
    走的是「已删除」那句；只在连接配置文件被整份换掉、恢复出来的标签找不到连接时出现，是测试脚本造成的；应用里的操作不会走到这条，不改。
  - 2026-10-04 大对象列上的筛选（`tableFilters.ts`、`columnEditors.ts`；rpm 0.4.144，cu 上的 SQL Server 2022 与 Oracle 23 Free）：**修了两处**。
    筛选对所有列都给出全部算子，而有几类列原样比较必报错：SQL Server 的 text / ntext / image 报 402
    （`incompatible in the equal to operator`），Oracle 的 CLOB / NCLOB / BLOB 报 ORA-22848。
    ① `4b5c713`：SQL Server 的 text / ntext 转成 `nvarchar(max)` 再比；Oracle 写成 `DBMS_LOB.COMPARE(列, 值) 算子 0`
    （23 Free 上试过相等得 0、小于得 -1、大于得 1，NCLOB 配普通字面量也成，NULL 行照旧不中）。
    ② `3b3e4f5`：image 不在二进制编辑器的类型表里——改单元格时按文本绑定，报 206 `nvarchar is incompatible with image`
    （sqlcmd 上用同样的参数化语句核过），筛选里的 `0x…` 也被拼成字符串。归入二进制，比较时先转 `varbinary(max)`。
    单测都是先红后绿，前端 1843 条全过。打包版：text 列筛「等于 abc」得 1 行，image 列筛「等于 0xbeef」得 1 行，
    image 单元格出现十六进制编辑器，改成 cafe 提交后库里是 `0xCAFE`。Oracle 那条只在 sqlplus 上跑过生成的写法，没进界面。
    没做：大对象列上的「大于 / 小于」本身没多大意义，算子列表仍不按列类型收窄。
  - 2026-10-04 执行之后对象树刷不刷新（`schemaChanges.ts`；rpm 0.4.143，本机 Docker 的 PG 16）：**修了一处**（`13335d4`）。
    只认 CREATE / ALTER / DROP / RENAME / TRUNCATE / COMMENT 开头的语句，几种常见的改结构写法执行成功后对象树与关系图停在旧样子：
    PostgreSQL 与 SQL Server 的 `SELECT … INTO 新表`、SQL Server 改名的 `EXEC sp_rename`、ClickHouse 的 EXCHANGE / UNDROP /
    ATTACH / DETACH、Oracle 的 `FLASHBACK TABLE … TO BEFORE DROP` 与 PURGE。顶层有 INTO 的 SELECT 一律算（MySQL 的
    `INTO @变量` / `OUTFILE` 也会算进来，多刷新一次而已）。单测先红后绿，前端 1841 条全过。打包版：`SELECT * INTO om_bak FROM om_t`
    执行后 om_bak 立刻出现在树里（Tables 1 → 2）。没改：调存储过程间接建表（`CALL` / `EXEC 过程`）看不出来，仍要手动刷新。
    顺带看到：连接被删掉后，留下的查询标签横幅写 `The connection "this connection" is not active`——取不到名字时的兜底词也加了引号，只是措辞，没改。
  - 2026-10-04 结构页改列类型（rpm 0.4.142，本机 Docker 的 PG 16；CockroachDB 25.2 在 cu 上，DuckDB 1.5.5 CLI）：**修了一处**（`3f63650`）。
    PostgreSQL 的 `ALTER COLUMN … TYPE` 不写 USING 时只走赋值转换，text → integer / date / jsonb / 枚举、int → boolean 都报
    `cannot be cast automatically`——导入后全是 text 的表在结构页里改不成数值列。改成非字符类型时带 `USING "列"::新类型`；
    改成字符类型与 bit 不带：varchar(10) → varchar(3) 赋值转换报 value too long，显式转换却悄悄截断（PG 16 上核对过仍报错）。
    CockroachDB 同样要 USING、也收（int → bool、string → date 都成）。单测先红后绿（两条旧用例的预期跟着带上 USING），前端 1840 条全过。
    打包版：text 列 `s`（值 `12`）改成 integer，预览 `… TYPE integer USING "s"::integer`，执行后服务端是 integer、值 12。
    同一轮看过、没问题的：DuckDB 自己做转换（VARCHAR → INTEGER、INTEGER → BOOLEAN 不用 USING），一次改名、删列、改类型、
    加 NOT NULL 列、改表名的整批语句在 1.5.5 的事务里照样跑通。没改：带默认值的列换类型时默认值转不过去（int 默认 0 → boolean
    报 default … cannot be cast），USING 管不到默认值，服务端原话照给。
  - 2026-10-04 表格筛选里「包含」在日期与特殊类型列上（rpm 0.4.141，cu 的 SQL Server 2022）：**修了一处**（`908bb27`）。
    SQL Server 自己把 datetime、smalldatetime 隐式转成 `Jan  2 2024  3:04AM` 再 LIKE，照网格里的 `2024-01-02 03:04` 搜一行也中不了，
    语句不报错；xml 列直接报 8116。前两种按样式 121 转（就是网格的写法），xml 转成 `nvarchar(max)`；datetime2、date、time、
    datetimeoffset 隐式转换本来就是 ISO 写法，不动。单测先红后绿，前端 1839 条全过。打包版：datetime 列「包含 2024-01-02 03:04」
    筛出 1 行、「2025-01」0 行，xml 列「包含 `<a`」筛出 1 行。
    同一轮看过、没问题的：Oracle 会话设了 ISO 的 `NLS_DATE_FORMAT`，DATE 隐式转文本与网格一致；MySQL、SQLite 本来就是 ISO 文本。
    没改的：float 隐式转成 `1.23457e+006`，「包含 1234567」中不了，但在浮点列上搜子串本身少见；登录默认语言非英语
    （`DATEFORMAT dmy`）时 datetime 的「等于 '2024-01-02'」会按年日月读，没试。
  - 2026-10-04 确认框的「执行完还能不能反悔」（`statementReversibility.ts`，各方言 19 种写法逐个过；rpm 0.4.140，本机 Docker 的 PG 16，
    连接设为生产）：**修了一处**（`b241f35`）。PostgreSQL 的 `CREATE UNIQUE INDEX CONCURRENTLY` 与 `REINDEX (CONCURRENTLY) TABLE`（14 起
    选项写在括号里）按前缀认不出，被当成「改成在事务里跑就能回滚」并给出「在事务里执行」——PG 16 上两条都报
    `cannot run inside a transaction block`，会话还留在废止的事务里。补了 UNIQUE 那条前缀，REINDEX 的选项括号里出现
    CONCURRENTLY 也认。单测先红后绿，前端 1838 条全过。打包版：两条各弹确认，都写「事务包不住」、没有事务按钮，「仍然执行」后索引建成。
    同一轮看过、没问题的：DuckDB 的 `ATTACH` 在回滚后确实撤掉（1.5.5 上试过），不用进清单；`REINDEX (CONCURRENTLY false)`
    会被误判成包不住，往保守方向错，不改。没上真库、没改的：SQL Server 的全文索引增删据文档也不许进用户事务，没在真库上试，清单没加。
  - 2026-10-04 表格里日期、时间格的「现在」按钮（rpm 0.4.139，SQLite 文件；各家写法在 DuckDB 1.5.5、SQLite、本机 Docker 的
    PG 16 / MySQL 8.4 上逐条试过）：**修了一处**（`3f3fc93`）。三种列一律写 `CURRENT_TIMESTAMP`：DuckDB 写进 TIME 列报
    `Unimplemented type for cast (TIMESTAMP WITH TIME ZONE -> TIME)`，SQLite 把 `2026-10-04 11:41:55` 整段存进 date / time 列
    （之后选择器认不出）。PG、MySQL 两种写法都收（MySQL 给 1292 的 Note）。日期列写 `CURRENT_DATE`、时间列写 `CURRENT_TIME`；
    SQL Server 没有这两个，写 `CAST(CURRENT_TIMESTAMP AS date|time)`（没上真库）；ClickHouse 照旧（没核对它认哪些写法）。
    悬停提示改为写出实际表达式。单测先红后绿，前端 1837 条全过。打包版：SQLite 表 `om_now(id, d date, tm time)` 新增一行，
    两格各点「现在」，预览 `VALUES (NULL, CURRENT_DATE, CURRENT_TIME)`，提交后文件里是 `2026-10-04 | 11:56:45`。
    同一轮看过、没问题的：上一轮的带引号类型名在别处只有表格写回一处用到（`$1::"Role"`，不过校验）；DuckDB 表上有索引时
    改列、删列被它自己拒绝（Dependency Error，原话照给）；设置项都有消费者。
  - 2026-10-04 CSV 导入到带自定义类型的 PostgreSQL 表（rpm 0.4.137 / 0.4.138，本机 Docker 的 PG 16）：**修了一处**（`76dba6f`）。
    大小写混写或不在 search_path 上的类型（Prisma 建的枚举就是 `"Role"`），`format_type` 带双引号给出：`"Role"`、`"Billing".tier`、
    `"Role"[]`。导入把类型拼进 `$n::text::<类型>` 之前要过一道防注入的字符校验，它不认双引号，整次导入报「目标列类型不是合法的类型名」，
    一行也进不去。改为认成对的引号标识符：引号里任意字符（`""` 是转义），引号外照旧只认原来那几个字符，引号不成对拒绝。
    单测先红后绿（含引号后接 `; DROP` 与不成对两条该拒的）；`cargo test csv_import` 29 条过，fmt / clippy 干净。
    打包版 A/B：同一份 2 行 CSV 导进 `om_user(id, name, role "Role", tier "Billing".tier, roles "Role"[])`，0.4.137 任务失败、日志是
    `role · "Role"`；0.4.138 读 2 写 2 失败 0，库里 `ADMIN | a | {USER,ADMIN}` 原样。
    同一轮看过、没问题的：表格写回给 PG 占位符加的是同一个 `data_type`（`$1::"Role"`），不过这道校验；快速图表的取值与刻度；
    建索引的语句（各方言已有一致性语料钉着）；数据页隐藏列与选区、导出的配合；快捷键按平台独占判定。
    没改：MySQL 在 TEXT / BLOB 列上建索引要前缀长度，对话框不给填，服务端报 1170 原话照给。
  - 2026-10-04 新增行时每列都取默认值（rpm 0.4.137，本机 Docker 的 MySQL 8.4）：**修了一处**（`655a3d5`）。只有自增主键和
    `created_at` 这类每列都有默认值的表，新增行表单打开时全是 DEFAULT，INSERT 省掉全部列后报「没有有效的列可以插入」，界面上
    一行也加不进去。按方言写：PG / SQLite / DuckDB / SQL Server 用 `DEFAULT VALUES`，MySQL 用 `() VALUES ()`（它不认前者），
    Oracle 两种都不认，点名一列写 `VALUES (DEFAULT)`，绕开虚拟列；ClickHouse 没有对应写法，照旧报错。PG 16、MySQL 8.4、SQLite、
    DuckDB 上逐条执行过；SQL Server、Oracle 的写法没上真库。单测先红后绿，绕开虚拟列那条反向验过；前端 1834 条全过。
    打包版：`om_d(id auto_increment, created_at default current_timestamp)` 点「新增」直接保存，预览是
    ``INSERT INTO `dataomni_test`.`om_d` () VALUES ()``，提交后表里多一行 `2 | 2026-10-04 11:07:29`。
    同一轮看过、没问题的：网格复制选区（多格按 TSV 转义、NULL 写成 `NULL`、单格原样）；网格没有粘贴入口。
  - 2026-10-04 改表结构时 MySQL 的时间默认值（rpm 0.4.136，本机 Docker 的 MySQL 8.4 与 MariaDB 11.8）：**修了一处**（`f196418`）。
    `DEFAULT CURRENT_TIMESTAMP` 在 `EXTRA` 里也带 `DEFAULT_GENERATED`，改类型、改可空时被当成表达式默认值拒绝——最常见的
    `created_at` 列 `timestamp` 改不成 `datetime`、改不了 NOT NULL。它不是表达式：两家的目录里逐类看过，`NOW(3)`、`LOCALTIMESTAMP`
    归一成 `CURRENT_TIMESTAMP[(n)]`，真正的表达式 `(CURRENT_TIMESTAMP)` 存成 `now()`、`(NOW() + INTERVAL 1 DAY)` 带括号；
    MariaDB 存 `current_timestamp()`，分不出两者但写回都是同一个默认值。`MODIFY` 原样重述之后 `SHOW CREATE TABLE` 一致。
    只放行 `current_timestamp` 加可选精度这一种写法，`now()` 等照旧拒绝。两条单测，放行那条先红后绿；前端 1833 条全过。
    打包版：`created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP` 在结构页改成 `datetime`，预览是
    ``MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP``，执行后 `SHOW CREATE TABLE` 一致。
    同一轮看过、没问题的：SQL Server `datetime2` 按纳秒写出（`format_time`），7 位小数不截，当键定位不受影响；MariaDB 的 `COLUMN_DEFAULT` 形状
    在目录查询里已经换成 MySQL 的（带引号的字符串、字符串 `NULL`），不会被再引一层。
  - 2026-10-04 SQL 标签里就地改查询结果（rpm 0.4.134 / 0.4.135，本机 Docker 的 MySQL 8.4）：**修了一处**（`864356f`）。
    上一条的二进制主键修正只在表视图：结果表自己拼键、先拆了包装，`SELECT * FROM` 一张 `BINARY(16)` 主键的表，删一行发的是
    `WHERE id = 'ff01…'`，报 ROW_COUNT_MISMATCH（0.4.134 上复现）。取键那段从 `rowKeyOf` 拆成 `rowKeyFromColumns`，两处共用。
    结果表没有组件测试，红是在打包版上看的；单测补在 `rowKeyFromColumns` 上，前端 1831 条全过。打包版（0.4.135）：同一条 `SELECT *` 删同一行，提交成功，库里只剩另一行。
    同一轮看过：没有「按外键跳到被引用行」「按单元格值筛选」这类拿结果值拼条件的入口，别处不受影响。
  - 2026-10-04 二进制当主键、按二进制筛选（rpm 0.4.133 / 0.4.134，本机 Docker 的 MySQL 8.4，`BINARY(16)` 主键）：**修了两处**。
    - **二进制主键的行改不了、删不了**（`dc4c2b2`）：键值读回来是十六进制文本，绑成参数去比的是那串字符的字节，永远不等，
      提交时报「没有恰好影响一行」。`BINARY(16)` 存 UUID、bytea、BLOB 当键的表都是这样（SQLite 当场验过：`id = '0aff'` 0 行，`X'0aff'` 1 行）。
      `rowKeyOf` 记下值带 `binary` 包装的键列，定位条件按方言写成二进制字面量（与单元格编辑共用 `binaryLiteral`）。
      按值认、不按列类型认：MySQL 的二进制列内容可打印时按原文送来，绑原文正好比得上——按类型认的话，`VARBINARY` 里存十六进制原文的
      表会被当成字节读。单测先红后绿；打包版上一次提交改两行（一行带包装、一行可打印原文）、删一行，预览里分别是 `X'0011…'` 与
      `'cafecafecafecafe'`，库里三项都对。
    - **筛选里照抄网格的 `0x…` 一行也筛不中**（`486a330`）：拼成字符串比较；Oracle 的 RAW 还会报 ORA-01465。二进制列上 `0x` 加偶数位
      十六进制写成二进制字面量，别的文本照旧（与导入的约定相同）。单测先红后绿，前端 1830 条全过。打包版：修之前（0.4.133）筛 0 行，
      修之后（0.4.134）照抄 `0x0011…eeff` 筛出那一行，筛可打印的原文 `cafecafecafecafe` 同样筛出一行。
    同一轮看过、没问题的：稳定分页按主键排序用的是 `OFFSET`，不拿键值去比，二进制主键翻页不受影响。
  - 2026-10-04 MySQL 的 BIT 在表格里改（rpm 0.4.132，本机 Docker 的 MySQL 8.4；SQL 层的行为在 cu 的 MySQL 8.4 上逐条试过）：**修了一处**（`0a87319`）。
    10-01 修过导入（`f88096f`，`CAST(? AS UNSIGNED)`），表格写回走的是另一条路（`rowStatements.ts`），只有 PostgreSQL 给占位符加转换。
    网格里 BIT 显示成十进制数，改值按字符串绑定：`bit(8)` 上 5 改成 6 存进去的是 `'6'` 的字节 54、不报错；`bit(1)` 写 1 报 Data too long。
    赋值、插入与定位条件的占位符改成 `CAST(? AS UNSIGNED)`（`parameterCast` 只能加后缀，改成包住占位符的 `typedParameter`）；
    非数字报 1292、超出位宽与负数报 1406，`1.5` 四舍五入成 2（与导入一样，没另做）。两条单测先红后绿，前端 1823 条全过。
    打包版上 5 / 0 改成 6 / 1，预览是 `CAST('6' AS UNSIGNED)`，提交后库里 `mask+0 = 6`、`hex(mask) = 6`、`flag+0 = 1`。
    同一轮看过、没问题的：筛选里 BIT 与字符串字面量比按数比（`= '5'` 比得中）；MongoDB 建索引的键走自己的解析器直出 BSON，复合键次序不丢；
    设置里的历史保留与慢查询阈值都是下拉框。没改：BIT 列上「包含」筛不出东西（位串没有文字可包含）。
  - 2026-10-04 AI 设计生成的索引名（`schemaDraft.ts`）：**修了一处**（`c5ace9d`）。索引名是 `ix_表名_列名` 拼的，校验不查它撞不撞：
    同一个索引写两遍、`(a_b)` 与 `(a, b)`、表 `a_b` 的 `(c)` 与表 `a` 的 `(b_c)` 拼出同一个名字，第二条 `CREATE INDEX` 失败时
    前面的表已经建好了。现在报错「生成的索引名与另一个索引重复」；范围按方言：PostgreSQL、Oracle、SQLite、DuckDB 在 schema 内唯一
    （DuckDB、SQLite 本机当场验过两张表各建同名索引被拒），MySQL、SQL Server 只在表内唯一、跨表同名不报。两条单测先红后绿，前端 1821 条全过。
    打包版没验，理由同上一条（要模型恰好给出撞名的设计）。
  - 2026-10-04 顺着上一轮查外键名字的其他用处：**AI 设计新表修了一处**（`92396f2`）。校验按 `fold` 不分大小写认表名列名，
    而建表语句给名字加引号；设计里主键、唯一键、索引、外键的引用与声明只差大小写（`users` 表、外键写 `Users` / `ID`）时校验照过，
    PostgreSQL 16（cu）上旧语句报 `column "ID" named in key does not exist`、`relation "Om_Users" does not exist`，新语句建得成（事务里回滚）；
    关系图同样连不上这条外键。生成建表语句与关系图时把引用处换成声明处的写法，设计本身不改（人看的、校验的仍是模型给的那一份），
    指向库里已有表的引用照原样。三条单测先红后绿，前端 1819 条全过。
    **打包版没验**：要模型恰好给出大小写不一致的设计，复现不可控；改的是两个纯函数，界面照旧调用。重估条件：有人报 AI 设计校验过了却建表失败。
  - 2026-10-04 SQLite 外键在关系图与结构页上的写法（rpm 0.4.131，SQLite 文件）：**修了两处**：
    - 省略被引用列的外键（`8044ed1`）：`REFERENCES users` 不写列名就是引用父表主键，`pragma_foreign_key_list` 的 `to` 为 NULL，
      关系图连不到列、把这条边整个丢掉，结构页只写「父表主键」。两条查询按 `seq` 去父表的 `pragma_table_info` 取主键里同一位置的列
      （按主键次序，不是建表的列序）；父表没有主键时仍是 NULL，那条外键本来不成立。
    - 外键子句里名字大小写和建表时不同（`733d1bb`）：`REFERENCES FK_OWNER (K2, K1)` 指向 `fk_owner`，pragma 原样给大写，
      关系图按名字找表、当成悬空引用丢掉。关系图的查询按 `NOCASE`（只折 ASCII，和 SQLite 认名字一样）换成库里的写法。
    两处各在冒烟用例里先红后绿（父表 `PRIMARY KEY (k2, k1)` 故意与列序相反）；DuckDB 自己就把省略的列补成主键，不用改。
    打包版上关系图画出 4 条交叉的边（`o1→k2`、`o2→k1`、`v1→k2`、`v2→k1`），结构页是 `fk_0 (o1, o2) → fk_owner (k2, k1)`。
    同一轮看过、没问题的：PostgreSQL 函数的「复制限定名」把参数签名留在引号外；结构与关系图的复合外键都按同一下标配对；
    跨库外键按库名加表名比对；SQLite 主键里存了 NULL 时改那一行直接拒绝、不拼 `= NULL`；只取第一行的几处都是查版本号。
  - 2026-10-04 查看对象定义（`ObjectDefinitionDialog`，MySQL 8.4 在 cu 与本机 Docker 上，MariaDB 11.4 在 cu 上）：**修了一处**（`7bf59bf`）。
    MySQL 的函数与存储过程各有名字空间，同一个库里可以同名；对象列表的 `object_id` 只是名字，取定义按名字查出两行，
    对话框取第一行——点过程看到的可能是函数的 `return 42`，界面上看不出取错了。`object_id` 改成带类型（`FUNCTION f` / `PROCEDURE f`），
    取定义按它整体匹配。冒烟用例改成和界面一样从列表取 `object_id`，再建一个与函数同名的过程，两边各断言只取到自己的那一行
    （旧代码红：取到两行）；MySQL 的 40 条冒烟在 8.4 上全过，例程与插件解码两条在 MariaDB 11.4 上过。
    打包版（rpm 0.4.130，本机 Docker 的 MySQL 8.4）上同名的过程与函数各点一次，分别是 `select 'i am the procedure'` 与 `return 42`。
  - 2026-10-04 在打包版上点没点过的界面（rpm 0.4.128 → 0.4.129，SQLite 文件）：**修了一处**（`d4fe0b4`）。
    数据页「新增一行」，可空且没有默认值的列起手是 NULL，那一格是个按钮（点开「值 / NULL / 默认 / 表达式」菜单）。点它接着敲 `3`，
    字落在按钮上什么也不发生——两列都这么填完点保存，预览是 `INSERT INTO "gen_note" ("a", "b") VALUES (NULL, NULL)`，
    `a INT PRIMARY KEY` 在 SQLite 上照收 NULL 主键。组件注释写着「用户的第一反应是点它然后开始打字」，只接了点、没接打字。
    现在可打字的键把这一格切成「值」并以这个字开头、光标留在框里；命令键组合（复制、全选）、方向键、Tab、输入法组字与布尔列不动。
    两条组件用例：敲字成值（旧代码红）、命令键与非字符键不改档（拿掉命令键判断就红）。打包版上点 NULL 格敲 `3`、另一格敲 `30`，
    框里是 `3` 与 `30`（WebKitGTK 里第二个字跟在后面），提交后表里是 3 / 30 / 33 / 6，生成列由库算出。
    同一轮看过、没问题的：MySQL 8.4 与 9.4 的 mysqldump 备份 MariaDB 11.8 服务器正常（没撞上 `COLUMN_STATISTICS`）；
    Cypher 切语句（引号、反引号、两种注释里的分号，只剩注释的段）；SQL Server 筛选的 LIKE 转义了 `[`；DuckDB 结构查询按小写比表名；
    结果网格只认裸列名的单表查询，别名、JOIN 一律只读；SSH 隧道死掉后下次取连接会重建。
  - 2026-10-04 各处读列的来源是否一致（rpm 0.4.128，SQLite 文件）：**修了一处**（`ef731e8`）。SQLite 的补全与关系图用
    `pragma_table_info` 读列，它看不见 GENERATED 列（VIRTUAL 与 STORED 都看不见）——结构页（早已改用 `table_xinfo`）和 `SELECT *`
    有的列，关系图上没画、`表名.` 后面不补。两处改成 `table_xinfo` 并排掉虚表的隐藏列（`hidden = 1`）。两条 SQLite 冒烟用例各加一张
    带生成列的表，先红后绿；打包版上 `gen_note` 的 `total`（STORED）、`twice`（VIRTUAL）在 `gen_note.` 的补全与关系图里都出现。
    同一轮看过、没问题的：DuckDB 的 `duckdb_columns()` 列出生成列；Oracle 的补全与关系图用 `all_tab_columns`，不列 INVISIBLE 列，
    与 `SELECT *` 一致（结构页列出并标注，是有意的）；CSV 导入与导出 INSERT 都排掉了生成列；Oracle 筛选只写日期（`'2024-01-01'`）
    按会话设的 `NLS_DATE_FORMAT` 转得过去；各组件里按回车提交的地方都判了输入法组字；`EXPLAIN ANALYZE` 会真跑，界面上已经提示。
  - 2026-10-04 格式化之后名字的大小写，接 10-03 那轮（那轮只拿 60 个常见词试，结论「MySQL 被大写的都是保留字」不全）：**修了一处**（`748f65c`）。
    拿 sql-formatter 15.8 在表名位置会改的全部词（MySQL 207 个、T-SQL 216 个）逐个不加引号建表：MySQL 8.4 上 22 个、MariaDB 11.8 上 38 个
    （`commit`、`handler`、`offset`、`end`，MariaDB 另有 `function`、`row`、`system`、`window`、`option`）、SQL Server 2022 的
    `Latin1_General_CS_AS` 库里 56 个（`type`、`role`、`language`、`login`、`service`、`sequence`、`signature`）都建得成，格式化却改成大写——
    Linux 上 MySQL 表名区分大小写，`FROM COMMIT` 报 1146；区分大小写的 SQL Server 库（SAP 一类用 `_BIN2`）表名列名都区分，`FROM TYPE` 报 208。
    现在这些词保留原写法，其余关键字照旧大写（同一段排两遍——大写与保留原样——逐字对齐取回）。用例先红后绿；格式化后的语句在三台库上
    逐表执行：新代码全过，旧代码第一条就报对象不存在。rpm 0.4.127 连 MySQL 8.4，`select … from commit` 点格式化再执行，查出 2 行。
    没改：这些词被当成子句关键字排，不缩进，难看但能跑。升级 sql-formatter 后名单要按同样办法重算（`formatSql.ts` 注释里写了做法）。
    同一轮看过、没问题的：MySQL 9.4 的 mysqldump 仍认备份用的 `MYSQL_PWD`；各方言 30 种刁钻写法（`5--1`、`$$…$$`、`q'[…]'`、`E'\''`、
    `->>`、`<=>`、ClickHouse 的 `{p:UInt32}`）格式化前后语义不变。
  - 2026-10-04 SSH 隧道的 known_hosts、`.sql` 文件的编码、批量关标签与切语句（rpm 0.4.125 / 0.4.126，SQLite 文件；Oracle 23ai 在 cu 上）：**修了四处**：
    - 只有注释的一段切成一条语句（`bd59bae`）：脚本末尾的注释（mysqldump 的 `-- Dump completed on …`）单独成一条，编辑器补上分号发出去；
      Oracle 23ai 上 `-- x;` 与 `/* c */;` 都是 ORA-00900，「执行全部」最后一条报错（SQLite、MySQL 8.4 不报）。现在只有注释的一段不算语句，
      MySQL 的 `/*! … */` 由服务端执行，照旧算。打包版上 `SELECT 3; -- again` 不再多出第 4 条。
    - SSMS 存的脚本打不开（`b463e19`）：「生成脚本」默认存成「Unicode 文本」（带 BOM 的 UTF-16LE），PowerShell `Out-File` 也是，原先一律报「不是 UTF-8」。
      现在按 BOM 认出 UTF-16，标签记下编码，存回原文件照样写 UTF-16（和 CRLF、BOM 一样不悄悄改格式）。打包版上打开、改一行、存两次，
      文件头还是 `FF FE`、换行还是 CRLF，第二次存没有误报「文件被改过」。
    - 「关闭其他标签」草稿超过 10 份时丢草稿（`1be6622`）：「最近关闭」只留 10 条，后关的把先关的挤出去。超出的草稿标签现在留着不关；
      打包版上 13 个草稿标签关其他，10 个进「最近关闭」，3 个留着。
    - 跳板机主机名带大写就永远「known_hosts 里没有」（`4f57b23`）：OpenSSH 记录与比对都用小写（`ssh-keyscan GitHub.COM` 写出 `github.com`），
      russh 照原样比，按提示补记录补进去的还是小写，走不出去。比对前转小写；用例拿 russh 真的解析器先红后绿，没连真跳板机。
    - 没改：known_hosts 里的通配（`*.corp.example.com`）、`@cert-authority`、`@revoked` 行 russh 不认——前两种在我们这里落到「没见过这台主机」，
      按提示补一行即可；`@revoked` 只在同一把钥匙另有普通记录时才放行。重估条件：有人用 SSH CA 管跳板机，或报告通配记录连不上。
      GBK 等不带 BOM 的单字节编码的 `.sql` 仍报「不是 UTF-8」：猜编码会猜错，猜错的代价是存回去把文件写坏。重估条件：有人报中文 Windows 上存的脚本打不开。
      连接配置写盘失败时新建 / 编辑不回滚内存里的那份（删除会），界面在重启前显示的是没存下的值；写盘失败本身罕见，没改。
  - 2026-10-04 执行历史的存取与筛选（rpm 0.4.122 → 0.4.123，SQLite 文件；往 WebKitGTK 的 localStorage 库里直接灌 240 条各 2 万字符的历史）：**修了四处**：
    - 历史撑到配额边上，挤掉的是工作区快照（`d75febf`）：历史只在自己写不下时才缩，于是总能长到配额边上，随后写不进去的是
      标签与草稿——0.4.122 上 486 万字符的历史加一份 49 万字符的草稿，快照停在空标签，重启后草稿没了。实测 WebKitGTK 的配额
      在 486 万与 971 万字符之间（后者整个源一个键都写不进）。现在历史序列化后超过 150 万字符就往下缩；0.4.123 上跑一条查询后
      历史缩到 117 万字符（60 条），同一份草稿写进快照，重启后还在。
    - 写不下时按位置砍掉尾部一半，最旧的收藏跟着没了（`68cfa9f`）：改成按淘汰同一套优先级缩；上一条实测里最旧的那条收藏留下了。
    - 打开「执行历史」要四秒以上（`2ffc862`）：每行是单行截断，却把整条（最多 2 万字符）拿去上色，240 条约一百万个片段。
      改成只给开头 400 字符上色，0.4.123 上一秒内打开，样子不变。
    - 按日期筛时结束日是「零点加 24 小时」（`9ca0375`）：夏令时回拨那天有 25 小时，最后一小时的记录筛不出来。改成本地次日零点；
      用例在 `America/New_York` 下先红后绿，打包版没验（中国没有夏令时）。
    - 看过、没问题的：复制选区的 TSV 转义（单格原样、多格守引号规则）；单元格输入把 NULL、空串、DEFAULT、表达式分开；
      工作区快照逐个校验标签、坏一个只丢一个。
  - 2026-10-04 按方言切语句的边角写法（rpm 0.4.122，SQLite 文件与本机 Docker 的 MySQL 8.4）：拿 22 种写法喂给切分器，**修了两处**：
    - SQLite 的方括号标识符（`7cb1ffd`）：SQLite 也认 `[名字]`，切分器只对 SQL Server 开了这一条。`SELECT [it's] FROM t; SELECT 2`
      里的撇号被当成字符串开头，后面整段脚本吞成一条发出去；`[a;b]` 从中间切开。打包版上两条各自跑出 7 与 2。
    - MySQL 的 `--`（`0b9fdcc`）：MySQL 只把后面跟空白或控制字符的 `--` 当注释（8.4 上 `SELECT 1--1` 得 2）。原来一律当注释，
      `SELECT 5--x FROM d; SELECT 2` 拼成一条报语法错。打包版上切成两条，跑出 7 与 2。
    - 看过、没问题的：PG 的 `$tag$`、`E'…'`、`U&'…'`、嵌套块注释；反斜杠只在 MySQL / ClickHouse 里转义（`'C:\temp\'` 在别家是完整字面量）；
      Oracle 的 `q'[…]'` 与 `/` 行；SQL Server 的 `GO`、`N'…'`；DuckDB 的 `$$`。
    - 没改（只是颜色）：编辑器与结果标题的上色。CodeMirror 的 SQL 词法器在任何方言下都不认方括号标识符，SQL Server 也一样；
      结果标题的只读上色一律按标准 SQL，MySQL 的 `5--x` 后半截画成注释。语句怎么切、怎么跑都不受影响。
      重估条件：CodeMirror lang-sql 支持方括号标识符，或有人报告颜色误导。
  - 2026-10-04 CSV 导出再导入，空字符串变成 NULL（**当前版本不改**）：默认设置下导出把 NULL 与空字符串都写成空格子，导入把空格子当 NULL。
    要分开就得照 PostgreSQL `COPY … CSV` 的约定（不带引号的空格子是 NULL，`""` 是空字符串）。但 `csv` crate 读出来的记录不带「有没有引号」，
    要在 `csv_core` 上重写导入的读取（表头、行号、错位行都要重做），代价与风险都不小。
    已有的办法：导出与导入的「NULL 写成」都设成 `\N`，往返不丢。DBeaver 等工具的默认值也一样有损。
    重估条件：有人报告往返后空字符串变成 NULL，或 NOT NULL 列导入时因此失败。
  - 2026-10-04 CI 从 9 月 22 日起一直是红的，修好后打了 `v0.5.0`（`e7290db`）：
    - quality：本机的 2 格缩进来自作者 home 下的 `~/.rustfmt.toml`，仓库里没有，CI 按默认 4 格报 1531 处差异，
      后面的 clippy 与 Rust 测试在 CI 上一直没跑到。把配置放进 `src-tauri/rustfmt.toml`（`b90616a`）；之后两种 clippy、全部 Rust 测试在 CI 上首次跑通。
    - database-smoke 五条失败，都是环境问题（`2803f96`、`f0f74b5`）：MySQL 开着 binlog，普通用户建函数要 SUPER、恢复要建库，改用 root；
      runner 自带 pg_dump 16，服务端改用 PG 16（runner 没配 PG 的 apt 源，装不上 17 的客户端）；
      mysqldump 用例原来整库导出共享的测试库，撞上并行用例删表，改为只导出它自己建的库。
    - 重估条件：CI 再红就当天看。门是 CI 本身。
  - 2026-10-04 主机一格的写法（rpm 0.4.120，本机 Docker 的 Redis 7，另发布在 `[::1]` 上）：**修了两处**：
    - 主机两头的空白与 IPv6 的方括号（`f2401ce`）：粘贴带出的空格原样存下，Redis 报
      `nodename nor servname provided`，看起来像网络不通。写成 `[::1]` 时只有拼 URL 的几家认，Redis、MongoDB、
      Neo4j 与备份工具都当主机名去解析，同样失败。现在读连接配置时就去掉，已存的连接也一并生效。
      `127.0.0.1 `、` localhost`、`localhost\t`、`[::1]`、`::1` 在真 Redis 上逐个连通；打包版里一条存成 `" redis7 "` 的旧连接连上，键也列得出来。
    - MongoDB 备份的 IPv6 地址（`79d6a3d`）：拼出 `mongodb://::1:27017/`，mongodump 报 `too many colons in address`
      （cu 上的 mongo:8.0 验过，加方括号后能过解析）。照其余几处用 `url_host` 加上方括号。
    - 看过、没问题的：ES 与 ClickHouse 的 HTTP 地址本来就加方括号；SQL Server 拼成 `::1:1433` 也连得上，
      因为标准库会按最后一个冒号拆；Neo4j 驱动按（主机，端口）解析。
    - 没改：SSH 跳板机写成 `[::1]` 的情况。前端只去两头空格，跳板机填 IPv6 的少见；有人报再一并收拾。
  - 2026-10-04 Neo4j 时间、空间与浮点值的写法抄回去还是不是同一个值（rpm 0.4.119，本机 Docker 的 `neo4j:5-community`）：
    后端把这几种值写成 Cypher 构造式，格子里看的、属性编辑框里放的、保存时「打开以来没被改过」的条件用的都是它。
    逐个写出来再抄回 Neo4j 比相等，**修了两处**（`2717e8d`），另改一处显示（`39e0df2`）：
    - 负的小数秒时长差一秒：Bolt 的纳秒总是非负，-0.5 秒到后端是「秒 -1、纳秒 5 亿」，照拆写成 `PT-1.5S`。
      编辑这样的属性时条件永远不成立，存不进去。现在换成同号再拆。
    - 1900 年前后的地方平时（上海 +08:05:43）：chrono 写成 `+08:06`，抄回去 Neo4j 报 `Timezone and offset do not match`。
      Neo4j 自己也不认带秒的偏移，这时只写时区名；夏令时回拨那一小时照旧带偏移分清是哪一次。
    - `1e-300` 原来是一格三百多位的小数，现在小于 1e-6 的照 JavaScript 的界线写指数。
    - 连真库的用例 `written_temporals_points_and_floats_read_back_as_the_same_value` 把 16 种写法逐个抄回去比相等。
      打包版上一个节点同时带这三种属性，显示对，改其中两个后保存成功，库里读到的是新值。
    - 看过、没问题的：带符号与五位数的年份、纳秒、`time` 的偏移、三维点、`-0.0`、极值浮点。
  - 2026-10-04 MongoDB 筛选与命令里的日期写法（rpm 0.4.118，cu 上临时起的无认证 `mongo:8.0`，应用跑在 `TZ=Asia/Shanghai`）：**修了一处**（`8ef2092`）：
    `ISODate` 与 `new Date` 共用一个解析、一律按 UTC。mongosh 里 `new Date('2024-01-01T08:00:00')` 是 JavaScript 的规矩——带时间不带时区按
    **本机时间**，在北京是 `00:00Z`，我们给的是 `08:00Z`，筛选悄悄对不上八小时。另外 mongosh 认的 `T08:00`（不带秒）、`20240101`、`+0800`
    这里都报参数不对。两个各按 mongosh 的写法读：`ISODate` 横线可省、分秒可省、不带时区是 UTC；`new Date` 只有日期（`2024`、`2024-01`、
    `2024-01-01`）按 UTC、带时间按本机时间；`+08` 这种两边都不认的照旧报错。15 个串的预期逐条从 mongosh 2.x 抄来，先红后绿；
    打包版上 `new Date('…T08:00:00')` 的区间筛出 `00:00Z` 那篇，`ISODate('2024-01-01 08:00')` 筛出 `08:00Z` 那篇。
    同一轮看过、没问题的：网格显示的 mongosh 写法再读回来，60 种值（Long / Int32 上下限、NaN / ±Inf / -0.0、Decimal128 的 NaN 与极值、
    1970 年前与 9999 年后的日期、二进制各子类型、带 `/` 与换行的正则、Timestamp 上限、Code、怪键名）逐字节一样；`1_000`、`.5`、尾逗号、
    `/* */` 注释都认。没做：`0x1F`、`0b101`、`1n`、模板字符串、`'a' + 'b'`——写了明确报语法错。
    本机 Docker 起不了 MongoDB 8.0：内核 6.19 以上它拒绝启动（SERVER-121912），所以借 cu。
  - 2026-10-04 Elasticsearch 控制台照抄官方文档的请求（rpm 0.4.117，本机 Docker 的 Elasticsearch 8.19.4）：**补了一处**（`4d71300`）：
    Kibana Dev Tools 的三引号字符串（`"""…"""`）不认。ES|QL、SQL 与 painless 脚本的官方示例都这么写，照抄过来报 JSON 语法错；
    更糟的是脚本里 `//` 开头的那行先被当成控制台注释删掉。照 Kibana 的 `collapseLiteralStrings`（同一个正则：只去掉开头紧跟与收尾前的
    那个换行，下一行的缩进留在字符串里）先收成 JSON 字符串、再按行去注释；吞掉的换行补在字符串后面，报错行号仍对得上编辑器。
    用例先红后绿；打包版上 `_update` 带 `// …` 行的 painless 脚本把 `n` 从 1 加到 3，`POST /_query` 的 ES|QL 回 `dune | 3`。
    没做：请求体行内的 `//`、`/* */` 注释（Kibana 认）。写了会明确报 JSON 语法错、指到那一行，不会悄悄发错。
  - 2026-10-03 Redis 命令行拆参数（`redisCommandLine.ts`，rpm 0.4.116，本机 Docker 的 `redis:7` 当场比 redis-cli）：**修了一处**（`09f5f81`）：
    拆参数用的是 JS 的 `\s`，它还认全角空格（U+3000）与不换行空格。中文输入法下打出的全角空格把一个值拆成两个参数，
    `RPUSH l 你好　世界` 悄悄推进两个元素，`SET k 你好　世界` 报语法错。照 `sdssplitargs`：参数之间与引号收尾后按 `isspace`，
    没加引号的参数只在空格、`\t`、`\n`、`\r` 处断开（`\v` 留在值里），引号收尾即结束这个参数；另外拆原样的一行，
    `trim()` 会把行尾的全角空格一起去掉。每一条都先在 redis-cli 上跑出来再写进用例，先红后绿；打包版上
    `RPUSH l 你好　世界 a b 尾　` 回 4，库里第 1、4 个元素带着 `\xe3\x80\x80`。
    同一轮看过、没问题的：`a"b c"d`、`"x"y` 报引号不配对；`"\x4"` 是 `x4`；单引号里只认 `\'`。MongoDB 命令解析把全角空格当空白，
    与 JavaScript 一致（Zs 类都是空白），不改。
  - 2026-10-03 存回 `.sql` 与 MongoDB 导出导入的往返（rpm 0.4.115，容器里的 DuckDB 文件）：**修了一处**（`260c131`）：
    打开带 UTF-8 BOM 的脚本（SSMS、Windows 记事本存的）时去掉 BOM 是对的，存回同一个文件却不补回来，保存一次第一行就变了。
    上一轮 CRLF 那次把它记成「没改」但没写理由，与换行是同一个道理：来源文件记下 `bom`，写回原文件补上，另存为新文件不带。
    用例先红后绿；打包版打开 BOM + CRLF 的文件、加一行 Ctrl+S、再加一行再存，`od -c` 看开头仍是 `357 273 277`、每行仍是 `\r\n`，
    「执行全部」三条照常跑（BOM 没跟着发出去），第二次保存也没误报「文件被别处改过」。
    同一轮看过、没问题的：MongoDB 导出（canonical / relaxed）再按导入的读法读回，本机拿 bson 2.15 逐个类型比 BSON 字节——二进制各子类型
    （UUID 新旧、MD5、用户自定义、vector）、带选项的正则、Timestamp 上限、MinKey / MaxKey、Code / CodeWithScope、Symbol、Undefined、
    NaN / ±Inf / -0.0 / 5e-324、Decimal128 的 `-0.000` 与 NaN、1970 年前、9999 年后与 `i64::MIN` 的日期、空键与带点的键都一模一样；
    键的顺序也保住（`serde_json` 开着 `preserve_order`）。relaxed 下 Long 读回成 Int32 是格式本身的事，对话框里已经写明。
    没改：字段名本身就是扩展 JSON 的类型标记（`{"$date": "x", "a": 1}`、`{"$numberLong": "12"}`）时前者导不回、后者读成 Long——
    这是扩展 JSON 的歧义，mongoexport 同病。重估条件：有人的数据里真有这种字段名。
  - 2026-10-03 导出成 INSERT 的脚本能不能原样跑回去（七种方言各拿真库导出再执行、逐行比对；rpm 0.4.114 上看过 DuckDB 与 PostgreSQL）：**修了三处**：
    - Oracle 超过 4000 字节的文本导出来跑不回去（`8433411`）：单个字面量最长 4000 字节（ORA-01704，按字节算，1400 个汉字就超），
      `'…' || '…'` 拼起来也一样超（ORA-01489）。超长的按字符边界切成 `TO_CLOB('…') || TO_CLOB('…')`；正好 4000 字节的照旧一个字面量。
      预览与写文件两侧同改，语料加一例。`oracle_smoke` 拿 23ai 导出再执行、`DBMS_LOB.COMPARE` 逐行相同，去掉修复报 ORA-01704。
      BLOB 同样有 2000 字节的上限，没修：23ai 上 `TO_BLOB(…) || TO_BLOB(…)` 不报错、写进去的是 NULL，纯 SQL 里没有可靠的拼法。
      重估条件：有人要把带大 BLOB 的表导成 INSERT。
    - PostgreSQL numeric 的 `NaN`、`±Infinity` 原样写进 INSERT，不加引号就成了列名（`1173322`）：`column "nan" does not exist`。
      不是数字写法的照字符串字面量写，两侧同改，语料加一例。打包版上导出预览与文件都是 `'NaN'`、`'Infinity'`，在 SQL 标签里跑回去逐行 `=` 为真。
    - DuckDB 的 MAP 键或值里有 `=`、`,`、引号、是空串、`NULL`、首尾带空白时不加引号（`e9a1229`）：`{k'1=1, =NULL}` 转不回 MAP，
      表格里改这一格提交不了，导出的 INSERT 也跑不回去。照 DuckDB 1.5 的 `::VARCHAR` 加引号、反斜杠转义（命令行逐字对过）。
      打包版上显示成 `{'k\'1'=1, ''=NULL, 'a=b'=2}`，网格里把 2 改成 5 提交，按键取回 1 / NULL / 5、仍是 3 项。
    往返用例（`*_exported_inserts_carry_*_back`）七家各一条：MySQL 16 种、PostgreSQL 27 种、SQLite 8 列（连 `typeof` 一起比）、
    SQL Server 21 种、Oracle 长 CLOB、DuckDB 22 种（含嵌套）、ClickHouse 复合类型。各自做过反向验证（去掉反斜杠转义、`N` 前缀、
    `X'…'`、MAP 引号或 NaN 引号即红）。前端 1800 条、Rust 318 条全过，clippy（带与不带 `ai`）干净。
    同一轮看过、没问题的：Oracle 的 `Inf` / `Nan`、INTERVAL、23ai 的 BOOLEAN 与 JSON、带时区的 TIMESTAMP 文本都隐式转得回去；
    SQL Server 的 rowversion 按计算列略去；ClickHouse 的数组、Map、Tuple 带着内层转义原样回去；SQL Server 的 hierarchyid、geography 按二进制回去。
    没改：浮点的 `-0` 写成 `0`（照 JS 的 `String(-0)`，与预览一致，SQL 里两者相等）。SQLite REAL 的 ±Inf 读出来是字符串 `Inf`，
    和文本分不开，导回去存成 TEXT——要改得给值加一种标签，网格显示、排序、编辑都要跟着动；重估条件：有人在 SQLite 里存无穷并要导出。
    SQL Server 大额 money 在 SQL 标签里仍按驱动读（见上面 `ef6e46a` 那条）。
    观察到、没复现：PG 的 SQL 标签里换一份同样条数的语句再「执行全部」后，前四张卡片的标题是新的语句与时间，正文却是上一轮的
    「影响行数 / 耗时」（单行 INSERT 印成 0、0、0、4），第五张是新的；查询历史记的是这一次的 1 行与新耗时。照原顺序
    （带确认框的一轮 → 导出 → 清空结果 → 粘贴 → 执行全部）重做三次都正常。代码里结果与时间戳是同一次写入，没找到能只更新一半的路径。
    重估条件：再撞上时先复制卡片里的文字，分清是 DOM 里的旧数据还是 WebKitGTK 没重画。
  - 2026-10-03 DuckDB 五位数的年份与 UTF-16 的 CSV（rpm 0.4.112 / 0.4.113，容器里的 DuckDB 文件与 cu 的 MySQL 8.4）：**修了三处**：
    - DuckDB 五位数的年份显示成 `+10000-01-01`（`3a686fe`）：chrono 的 `%Y` 加的 `+`，DuckDB 自己不这么写，也不认，
      网格改值与 CSV 导回报 `invalid date field format`。日期与时间戳都去掉；上一轮记下的公元前 `-0043-03-15` 用 duckdb 命令行试过，
      DuckDB 认，读回来是公元前 44 年，不用改。用例在内存库里把显示的文本交回 DuckDB 比对，先红后绿。
      打包版上 `10000-01-01 01:02:03` 在网格里改成 `…:04` 提交，重查得 `10000-01-01 01:02:04`。
    - 带 BOM 的 UTF-16 文件（Excel 另存的「Unicode 文本」、Windows PowerShell 的 `Out-File`）导入时整份乱码（`d252ec3`）：
      不是 UTF-8 就落到 GB18030。认编码时先看 BOM。原想同时让解码器去掉 BOM，反向验证时拿掉那一句用例照样绿——
      转出来的就是 UTF-8 的 BOM，csv 自己去掉，所以没加。拿掉 BOM 检测时预览与导入两条用例都红。
      打包版上 UTF-16LE、制表符分隔的文件预览出 `张三`、认出 `\t`，导入 MySQL 后服务端的 HEX 是 `E5BCA0E4B889`。
    - 上一步时发现的：导入向导对一切不是 UTF-8 的文件都说「按 GB18030（GBK）读取」（`1d9c155`）。只在后端猜成 GB18030 时提；
      打包版上 UTF-16 的文件不再提，GBK 的照旧提。
    前端 1798 条、Rust 318 条全过，clippy（带与不带 `ai`）干净。
    同一轮看过、没问题的：MySQL / PostgreSQL 连接串里的用户名、口令、库名都经过编码；导出 CSV 可选 UTF-8 BOM；多格复制按 TSV 转义；
    PostgreSQL numeric 的 NaN / Infinity 早有用例。
    没改：MySQL 里 `--` 后面不跟空白不是注释（`SELECT 5--1` 是 6），切语句时仍当注释，`SELECT 5--1; SELECT 2` 会并成一条。
    重估条件：有人报这种写法切错。导出 CSV 不转义 `=`、`+`、`-`、`@` 开头的值（公式注入）：转义要改数据（`-5` 会变成 `'-5`），
    导回来就不是原值；DBeaver、DataGrip 默认也不转义。重估条件：导出的文件要直接交给不信任数据来源的人用 Excel 打开。
  - 2026-10-03 MySQL 的 SET autocommit、TIME 的取值与日期排序（rpm 0.4.111，连 cu 的 MySQL 8.4 与容器里的 DuckDB 文件）：**修了四处**：
    - 编辑器里执行 `SET autocommit = 0` 之后状态栏仍说「无事务」（`ebb7ce1`）：服务端此后每条语句都在事务里，要等 COMMIT 才落库，
      回滚按钮却不亮，断开连接时这些写入悄悄没了。8.4 命令行上试过：从 0 设回 1 提交开着的事务；`START TRANSACTION` 里设成 1、
      或在事务里设成 0 都不提交。会话记下用户设的值，关着时成功的语句把状态带进事务、设回 1 按隐式提交处理；`GLOBAL` / `PERSIST`、
      用户变量与看不出值的表达式不算。也查过会话连接会不会带着 `autocommit = 0` 回到池里：只在断开 / 切换连接时释放，紧接着整个池关掉，不会。
      打包版上 `SET autocommit = 0; REPLACE … (7)` 之后显示「事务中」，点回滚；`REPLACE … (8); SET autocommit = 1` 之后回到「无事务」，
      另一条连接只看得见 8。
    - MySQL 的 TIME 丢了小数秒、负号也不可靠（`5f007b2`）：`TIME(6)` 的 `12:00:00.5` 显示成 `12:00:00`。补上之后又露出 sqlx 0.8.6
      的三处：转 `time::Duration` 时符号只给了整秒（`-00:00:01.25` 成了 `-00:00:00.75`）、`MySqlTime::is_negative()` 返回的是
      `is_positive()`、文本协议（HANDLER READ 等）把 `-00` 读成 0。现在二进制只借 `MySqlTime` 拆字段、问 `sign()`，文本直接用服务端的写法。
      用例在预处理与文本两条路上各读一遍，先红后绿，三处每一处都单独红过。
    - 结果排序时 TIME 按文本比（`80965e9`）：`-01:00:00` 在 `-05:00:00` 前面、`100:00:00` 在 `99:00:00` 前面。`[-]H:MM:SS[.f]`
      的换成秒数比；PostgreSQL 的 interval 不是这个写法，照旧按文本。打包版上升序排成 `-05, -01, -00:00:01.25, 12:00:00.5, 99, 100`。
    - 结果排序时日期按文本比（`e2ddd8a`、`fca3f15`）：PostgreSQL 的 `0044-03-15 BC` 排在公元 10 年后面、五位数的年份排在 2026 前面；
      DuckDB 经 chrono 写成带符号的天文纪年（`-0043-03-15`、`+10000-01-01`），同样排错。两种写法都按年份的数值比，`±infinity` 在两端。
      打包版上 DuckDB 的六个日期升序排成 `-0099-06-01, -0043-03-15, 0010-01-01, 2026-10-03, +10000-01-01, infinity`。
    每处的用例先红后绿；前端 1798 条、Rust 315 条全过，clippy（带与不带 `ai`）干净；连 cu 的 MySQL 用例 38 条单线程跑过，
    其中 `mysql_abandoned_statement_stops_on_the_server` 那一轮热身的 `SELECT 1` 撞上 20 秒超时（整轮跑了 484 秒，链路慢），单跑通过。
    没改：DuckDB 的公元前日期写成 `-0043-03-15`，DuckDB 自己显示 `0044-03-15 (BC)`；网格把它写回去 DuckDB 认不认没有试。
    重估条件：有人在 DuckDB 里存公元前的日期并在网格里改。
  - 2026-10-03 结果排序、事务状态与 MySQL 的预处理协议（rpm 0.4.107 / 0.4.108，连 cu 的 MySQL 8.4 与容器里的 DuckDB 文件）：**修了四处**：
    - 结果表点表头排序时，浮点列里的无穷与 NaN 按显示文本比（`6e487b2`）：JSON 没有这几个数，它们是字符串，负无穷排在 -2 与 3.5 之间。
      现在负无穷最小、正无穷最大、NaN 在最后（同 PostgreSQL），各家拼法（`Infinity`、`Inf`、`inf`、`NaN`、`Nan`、`nan`）都认。
      打包版上 DuckDB 的 `3.5, -inf, -2, inf, nan, -100` 升序排成 `-inf, -100, -2, 3.5, inf, NaN`。
    - MySQL 隐式提交清单上不是 DDL 的那几条认不出（`a4c2e63`）：`SET PASSWORD`、`CHECK TABLE`、`CACHE INDEX`、`LOAD INDEX`、`RESET`、
      `INSTALL` / `UNINSTALL`、`CHANGE REPLICATION SOURCE`、`START` / `STOP REPLICA`。8.4 上用命令行试过 `CHECK TABLE` 与 `CACHE INDEX`：
      之后的 ROLLBACK 撤不掉前面的 INSERT。原先后端仍记着「事务中」，下一条写入不再补 BEGIN、当场提交，回滚撤不掉；
      确认框也说「改成在事务里跑就能回滚」。前后端两份清单一起补，PostgreSQL 另补不许进事务的 `REINDEX DATABASE / SYSTEM` 与
      `REINDEX … CONCURRENTLY`。打包版上关掉自动提交：INSERT 1 → `CHECK TABLE` 之后状态栏回到「无事务」→ INSERT 2 → 回滚，
      表里只剩 1。
    - 上一步时发现的：MySQL 预处理协议不收的语句在编辑器里直接报错（`6b3c39d`、`c04b006`）。8.4 上逐条 `PREPARE` 过，
      `CHECK TABLE`、`SHOW WARNINGS`、`LOCK` / `UNLOCK TABLES`、`HELP`、`HANDLER`、`XA` 报 1295「not supported in the prepared statement
      protocol yet」。这几种直接走文本协议，其余 prepare 报 1295 的同样退回；`USE` 照旧在前面拒绝。
      第一版是「先 prepare、失败再退回」，新用例当场红了：`SHOW WARNINGS` 说的是上一条语句，那次失败的 prepare 本身成了上一条，
      `SELECT 1 / 0` 之后看到的是 1295 而不是 Division by 0。改成按语句开头先分流；从表里拿掉 HANDLER 时用例照样绿，
      退回那条路是通的。HANDLER READ 读出的 DECIMAL(30,10)、DATETIME(3) 与预处理时取值相同。
      打包版上 `SELECT 1 / 0; SHOW WARNINGS;` 第二条显示 `Warning 1365 Division by 0`，`CHECK TABLE om_tx` 显示 `check status OK`。
    每处的用例先红后绿；前端 1796 条、Rust 311 条全过，clippy（带与不带 `ai`）干净；连 cu 的 `database_smoke` 95 条单线程全过。
    同一轮看过、没问题的：行定位（`rowIdentity.ts`）不用可空唯一列、部分索引与表达式索引；`sqlLiterals.ts` 按方言转义反斜杠。
    没改（下一轮已修，见上一条）：MySQL 的负 TIME（`-10:00:00` 排在 `-01:00:00` 后面）与 PostgreSQL 公元前日期在客户端排序里按文本比；
    `SET autocommit = 1` 也会隐式提交，没认。
  - 2026-10-03 格式化、历史脱敏与风险判定的边角写法（rpm 0.4.106，连 cu 的 MySQL 与容器里的 DuckDB 文件）：**修了四处**：
    - 含 `DELIMITER` 的脚本点格式化被排坏（`b5cedc7`）：sql-formatter 不认这条客户端指令，`//` 被拆成 `/ /`、`DELIMITER ;` 被并进
      上一行，存储过程脚本排完再跑就报错。选区里有这条指令、或处在换了分隔符的那一段里时不排，横幅说明原因；换回分号之后的部分照常排。
      打包版上整份点格式化弹出说明、编辑器一字未动；只选 `call om_p();` 那一行排成 `CALL om_p ();`。
    - 历史里漏打的口令（`253d24c`）：Oracle 的口令是标识符，`IDENTIFIED BY tiger`、`"N3w#pw"`、建库链接的 `CONNECT TO … IDENTIFIED BY`
      原样进了历史；另有改口令时 `REPLACE` 后的旧口令（MySQL、Oracle）、SQL Server 的 `OLD_PASSWORD`、MySQL 复制源的
      `SOURCE_PASSWORD` / `MASTER_PASSWORD`、`user_password` 这类带前缀的列名。
    - 同上（`a705d7e`）：DuckDB `CREATE SECRET` 的 `SECRET '…'`、`BEARER_TOKEN '…'`、`CONNECTION_STRING '…'`（名字与值只隔空白），
      ClickHouse 命名集合的 `secret_access_key = '…'`。`KEY_ID` 照旧保留。打包版上 MySQL 的 `ALTER USER … IDENTIFIED BY … REPLACE …`
      （用户不存在，执行失败）与 DuckDB 的 `CREATE SECRET`（执行成功）在历史里分别是 `'***' REPLACE '***'` 与 `SECRET '***'`。
      Oracle 那几条只有单测（cu 上的 Oracle 停着）。
    - `ALTER TABLE … TRUNCATE PARTITION` 按普通有界写入算（`f92965b`），生产连接上不弹确认；`DROP PARTITION` 早就算破坏性。只有单测，确认框本身没改。
    每处的用例先红后绿，前端 1793 条全过。
    没改：`IDENTIFIED BY VALUES '…'`（Oracle 的口令散列）不打；`CALL`、`DO $$…$$`、`EXEC` 里包着的写入看不进去，按有界写入算。
    重估条件：有人报这几种进了历史或在生产库上没被拦。
  - 2026-10-03 结果里的同名列：**MySQL、PostgreSQL、SQLite 上后一列顶掉前一列**（`c427193`）。行按列名做键，
    `SELECT 1 AS id, 'a' AS name, 2 AS id` 在 rpm 0.4.103 连 PG 16 显示 `2 · a · 2`，表头两个 `id`，看不出少了什么；
    连接查询里的 `a.id, b.id` 一样。SQL Server、Oracle、ClickHouse 早就给重名的列编号，这三家走 sqlx 的路径漏了。
    照它们编号（`id`、`id 2`），行与列元数据用同一份名字。改的时候撞了一次回归：MySQL 的 `EXPLAIN FORMAT=JSON` 描述出 0 列
    却有一行，按空名字表取键那一行整个是空的，`mysql_explain_nests_the_join_and_names_both_tables` 当场红了；名字表里没有的
    退回驱动给的原名，另补一条不连网的单测。用例先红后绿；连 cu 的 `database_smoke` 94 条单线程全过（并行跑时备份那两条
    会撞上别的用例正在建删的表，和这次无关）。rpm 0.4.104 上同一句显示 `1 · a · 2`，表头 `id`、`name`、`id 2`。
    同一轮看过、没问题的：口令不落盘——rpm 0.4.103 上存连接时点测试、连上、跑一条成功一条失败、断开、关窗口，
    在 `~` 与 `/tmp` 的全部文件里按原文与 URL 编码、UTF-8 与 UTF-16 各搜一遍，一处没有；同一批文件里查询文本能在
    localStorage（UTF-16）里搜到，扫描本身有效。上一轮改的「刷新顺带重读结构」不清列宽（按列名内容做键）、不动待提交变更。
    没改：历史按日期筛的「到」那一天按 24 小时算，夏令时切换那天差一小时；重估条件：有人在夏令时地区报筛漏或筛多。
  - 2026-10-03 执行计划里「估算差了一个数量级」的点名（`planInsights.ts`、`explain.rs`，PG 16 在 cu 上，20 万行表）：
    **三种情况点错了**，横幅都说「通常是统计信息过期」，照着去跑 ANALYZE 是白跑：
    - **Limit 下面提前停下的扫描**（`2389272`）：`SELECT * FROM big LIMIT 10` 的 Seq Scan 估 200000、实际 10。估算是整张表的，
      实际只跑了 Limit 要的那一截。现在 Limit 下面实际少于估算不算估错，多于估算照样算（提前停只会让实际变少）。
    - **根本没执行的节点**（`ae0a8d3`）：空表做哈希连接，大表那侧没扫（`Actual Loops: 0`），`Actual Rows: 0` 被当成实际 0 行。
      loops 为 0 时不给实际行数，树上那一格不写「实际」。
    - **点的是跟着错的上层**（`71539ba`）：两个完全相关的条件估 9、实际 2000，Seq Scan 与上面的 Limit 数一样，横幅点 Limit。
      同一档、行数一样时取更靠下的那层。
    三条用例与一条 Rust 用例都先红后绿；前端 1785 条全过，clippy、fmt 干净。打包版两头验：rpm 0.4.101 上前两种都弹横幅、
    实际标红；0.4.102 上都不弹；0.4.103 上相关条件那条（反向验证：真估错仍要点名）横幅点 `Seq Scan (om_big)`、估 9 实际 2.0k。
    没改：Merge Join 一侧先耗尽、EXISTS 拿到一行就停，也是提前停，同样会把另一侧的高估点名。重估条件：有人报这种误报。
  - 2026-10-03 表格里改数据拼出的定位条件（`rowStatements.ts`，PG 16 在 cu 上，rpm 0.4.100 / 0.4.101）：**修了三处**：
    - **PostgreSQL 上 char(n) 列的行改不了、删不掉**（`3fae0f5`）：char(n) 读回来补满空格（`'ab   '`），参数按 text 绑，
      而 `bpchar = text` 先把列去掉尾随空格再按 text 比，永远对不上——char 主键的行改不了，有 char 列的行删不掉
      （删除比整行），报的却是「那一行可能被别人改过或删掉」。0.4.100 上删一行 `char(5)` 主键、`char(4)` 普通列的行复现。
      比较与赋值的参数转成不带长度的 `::bpchar`：比较按补空格的语义，赋值超长照样报 `value too long`（带长度的显式转换会悄悄截断）。
      CockroachDB 25.2 读回来不补空格，`::bpchar` 也认，带空格的参数照样删中。
    - **变更预览把引号里的 `?` 当占位符**（`6acd881`）：列名 `ok?`、表达式里的 `'?'` 被填进值，后面的参数全部错位，
      预览里给的不是真正会发的那条（执行走绑定参数，不受影响）。填参数时跳过字符串与引号标识符。
    - **外面改了列名后点「刷新」，那一列整列画成 NULL**（`1e9c479`）：数据页的刷新只重读数据，PG 上 `SELECT *` 读回新列名，
      网格按旧列名取值，看上去像数据被清了，删那一行还会拿 NULL 去比。0.4.100 上 `RENAME COLUMN tag TO tag2` 后刷新复现。
      刷新时先绕过缓存重读结构，再按刚取回的结构取数（闭包里的旧结构不再用）。
    前两条用例先红后绿；第三条是组件里的调用次序，没有单测，靠打包版两头验。前端 1783 条全过。rpm 0.4.101 上：改 `char(5)`
    主键的行、删带 `char(4)` 列的行都提交成功；预览是 `"ok?" = 'q' WHERE "code" = 'cd   '::bpchar`；改名后刷新新列名和值都在。
  - 2026-10-03 表数据页的筛选（`tableFilters.ts`，各方言拿 LIKE 的边角值在真库上跑）：**修了两处**：
    - **SQL Server 上「包含 `[draft]`」筛出所有含 d / r / a / f / t 的行**（`de93deb`）：它的 LIKE 把 `[…]` 当字符类，
      2022 上实测 `'raw'` 也中，只是结果比预期多、不报错。只在 SQL Server 上把 `[` 跟 `!` 一起转义；别家的 `[` 不是通配符。
    - **PostgreSQL、DuckDB、ClickHouse 对数字、uuid、日期列选「包含」直接报错**（`45ecae9`）：这三家的 LIKE 只收字符串
      （PG 16 `operator does not exist: integer ~~ text`，DuckDB `No function matches like_escape(UUID, …)`，
      ClickHouse 25.8 `Illegal type Date of argument of function like`）。非字符串列先转成文本；字符串列（含 citext）不转——
      转了 citext 就区分大小写、前缀匹配也用不上索引。MySQL、SQLite、SQL Server、Oracle 自己会转，不动。
    两条用例先红后绿，生成的语句在 SQL Server 2022、PG 16、ClickHouse 25.8、DuckDB 上原样跑过；前端 1772 条全过。
    rpm 0.4.97 连 cu 的 PG 16：整数列「包含 5」筛出 15 与 205，行数也写 2。
  - 2026-10-03 快速图表（`resultChart.ts`）：**`SELECT year, sum(amount) … GROUP BY year` 画出来的是年份**（`a3cbd89`）。
    每列都是数字时横轴退回行号、默认画第一列：rpm 0.4.97 上是三根约 2000 高的柱子、横轴 1 2 3；勾上 total 横轴也还是行号，
    对话框里没有选横轴的地方，按年、按月份号、按部门 id 分组的结果都画不成。现在没有非数值列且数值列不止一列时第一列当横轴
    （分组键在最前面），只有一列时照旧按行号。用例先红后绿；rpm 0.4.98 同一句画出 17 / 30 / 25、横轴 2021–2023。
    没改：两列都是度量（`SELECT orders, revenue`）时第一列也会被当横轴，对话框仍不能改横轴。重估条件：有人报这种结果画错。
  - 2026-10-03 关系图导出 PNG / PDF（PG 16 上 300 与 620 张各 8 列的表，rpm 0.4.98）：**大的图导出 PDF 是一张空图**（`a901bdc`）。
    PDF 内嵌 JPEG，libjpeg 边长上限 65500；622 张表的图照两倍画是 2624×68072，`toDataURL` 给 `data:,`（日志 Maximum supported
    image dimension is 65500 pixels），写出 689 字节、图像流长度 0 的 PDF，界面照样说已导出。JPEG 的倍率按上限收（这张收到 1.92 倍），
    编不出来时报错并说「先筛选或导出 SVG」。用例先红后绿；rpm 0.4.99 导出 11MB，内嵌 2525×65500，图底的最后一行都在。
    同一轮看过、没问题的：先猜的 Cairo 32767 边长上限在这里不存在——PNG 33192 高、68072 高都完整画出来。
    没核实：PDF 页面 1312×34036 点超过 Acrobat 的 14400 点（200 英寸）页面上限，Acrobat 里可能打不开或被裁；没有 Acrobat 可试。
    重估条件：有人报 Acrobat 打不开导出的关系图，届时写 `/UserUnit`。
  - 2026-10-02 同一轮看过、没修的：
    - PostgreSQL 库编码是 `SQL_ASCII`、里面存着 GBK 字节：服务端在转成 UTF8 时就报 22021（psql 设成 UTF8 客户端编码报同一句），
      sqlx 写死 `client_encoding=UTF8`，没有开关。重估条件：有人拿着这样的老库来。
    - MySQL 开着 `NO_BACKSLASH_ESCAPES` 时，前端拼的字符串字面量（表数据筛选、导出的 INSERT）把 `\` 写两遍，筛选落空、导回多一个 `\`。
      前端不知道会话的 sql_mode；重估条件：有人报，届时后端随会话报出这个模式。
    - SQL Server：tiberius 登录时带 ODBC 驱动标志，服务端随之开 `ANSI_DEFAULTS`（QUOTED_IDENTIFIER、ANSI_NULLS 都开），与 SSMS 一致。
    - MySQL 8.4 的 `caching_sha2_password` 用户在缓存清掉后走完整认证，TLS 关 / 优先 / 必须三种都连得上（本机 Docker）。
  - 2026-10-02 Windows：在 Windows 上 `bun tauri build` 能构建（原先差的只是换行符，`643fcf0` 加 `.gitattributes` 统一 LF，并写了
    `docs/windows-build.md`）。顺着查带 Oracle 的打包：`fetch-oracle-client.sh` 的 windows-x64 文件集照 19c 的名字写，23ai 的 zip 里
    一个都没有，脚本在第一个 `cp` 就退出（本机拷到假仓库根下复现）。**修了一处**（`3e791b3`）：按 DLL 导入表重挑 5 个文件、补上校验和；
    文档补了点名平台的打包步骤（`e7a3d74`，`bash` 若是 WSL 的会被认成 linux-x64）。还没在 Windows 上真连过 Oracle。
  - 还不能勾：Windows 的安装、升级、卸载（MSI / NSIS）与带 Instant Client 的 Oracle 连接，需要 Windows 真机或虚拟机。

## 暂不优先

- [ ] 团队实时协作
- [ ] 云端数据同步
- [ ] AI 自动执行写操作
- [ ] 大型 BI 仪表盘
- [ ] 在适配器体系完成前继续增加数据库图标
