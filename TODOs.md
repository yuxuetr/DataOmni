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
| P7 | 更多数据库：国产库与云库（下一步规划 B） | [-] B1（OceanBase）、B2 / B2b（openGauss）完成；KingbaseES 缺安装包；B3 / B4 按触发条件 |

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
  - macOS 与 Linux（容器）已验，Windows 没有，需真机或虚拟机。

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
  - 看到没修的：
    - Redis 键列表一页可能远超 200 行：后端 `SCAN` 带 `COUNT 1000`，键密的库里一轮就回来约 1000 个（本轮 3000 个键的库一页 1000），
      「再读一页」再追加约 1000。改成按剩余量给 `COUNT` 会让匹配稀疏的模式多出几倍往返，得先量。
      重估条件：量一次 5000 个键全读出来之后点选一个键的重渲染耗时，明显可感（比如过 100ms）就把 `COUNT` 收到页大小。
    - Redis 元素改动（hash / list / zset 的比对后写）走 Lua 脚本：ACL 给了写权限、但 `-@scripting` 的用户改不了，
      报错里提的是用户没跑过的 `evalsha`。重估条件：有人报告这种 ACL 配置下改不了值。
    - 一批返回多个结果集时（过程里两条 SELECT、`sp_help`）只显示第一个，其余读掉丢弃，**界面上不提示**
      （`stream_first_result` 的注释说与另外几家一致）。最小的做法是在结果摘要里带「另有 N 个结果集没显示」；
      要动每个后端的 `QueryExecutionSummary`，这一轮不做。重估条件：有人要看过程的第二个结果集，或 `sp_help` 这类系统过程被报告「只出一半」。
    - SQL Server 的 `PRINT` / 低级别 `RAISERROR` 消息不显示：tiberius 的结果流不给 info 消息。重估条件：换驱动或 tiberius 开放这类消息。
    - 已连上的连接，每执行一条语句都要从钥匙串读一次密码（每个命令都重新 `resolve_connection_string`，会话池以完整连接串为键）。
      钥匙串中途上锁（KDE Wallet 闲置关闭、macOS 设了闲置锁定）时，每条查询都会弹解锁框，取消就报错；解锁一次即恢复。
      重估条件：有人报告查询时反复弹钥匙串，或 macOS 上每条语句的钥匙串读取在耗时里看得出来。
    - 连接在网络上被静默丢掉（没有 RST）后，事务里的下一条语句要等满语句超时才失败，报的是「超时，调大超时」，
      而真正该做的是重连。这次在 Docker Desktop → cu 的路径上闲置约一分钟就出现。sqlx 不给 TCP keepalive 选项；
      重估条件：有人在云负载均衡 / VPN 后面报告这件事。
    - `database_smoke` 的两条备份用例与其它用例并行跑时偶发失败（`pg_dump` / `mysqldump` 撞上别的用例正在建删的表），
      单独跑稳定通过。与本轮改动无关。
  - 还不能勾：Windows——构建要改 `src-tauri/Cargo.toml` 且需 Windows 开发环境，这一轮不处理。

## 暂不优先

- [ ] 团队实时协作
- [ ] 云端数据同步
- [ ] AI 自动执行写操作
- [ ] 大型 BI 仪表盘
- [ ] 在适配器体系完成前继续增加数据库图标
