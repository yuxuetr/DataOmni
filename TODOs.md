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
  - 看到没修的：
    - 表数据页的 inet `::1` 显示成 `::1/128`（`39bb53d` 按 `::text` 取，`text(inet)` 总带掩码；SQL 标签按 `inet_out` 是 `::1`）。
      同一个值，写回不变。重估条件：有人嫌两处写法不一，届时改用走输出函数的转换。
    - DuckDB 的 `COMMENT ON` 注释不进 EXPORT DATABASE 的备份（上游行为），恢复后表与列的注释没了、不报错。
      重估条件：有人靠注释存文档并报告备份后丢失。
    - DuckDB 的 `-0.0` 在网格与导出里都成了 `0`（JSON 数解析后 `String(-0)` 是 `0`）。`-0.0 = 0` 为真，定位与筛选不受影响，
      只是显示与导出丢了符号。重估条件：有人要靠导出区分负零。
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
