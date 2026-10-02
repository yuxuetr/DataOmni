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
    2026-10-02 测了（另建 `dataomni_test_a`）：36 条里 4 条红。**修了一处**（`f879e16`）：列目录的 `COALESCE(x, '') <> ''`
    在 A 模式恒为 NULL，普通列的 `is_generated` 读出 NULL（前端按 Boolean 归一，界面上没露出来），改成点名取值。
    其余三条是用例按 PG 写死了 `date`：A 模式的 DATE 是 `timestamp(0)`，应用照真实类型显示 `… 00:00:00`，按类型分开预期（`7a26bf0`）。
    同一轮：PG 模式库上分区表那条也钉住（openGauss 的分区要写全 `VALUES LESS THAN`，没有 `PARTITION OF`，`f793f20`），
    并查过它分区表的 `tableoid` 每个分区各不相同，按 `tableoid, ctid` 翻页能唯一定位。四处（PG 16、CockroachDB、openGauss 两种模式）各 36/36。
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
