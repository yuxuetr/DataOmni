# DataOmni - 现代化的数据库管理工具

<div align="center">

![DataOmni Logo](https://img.shields.io/badge/DataOmni-数据库管理工具-blue?style=for-the-badge&logo=database)
![Platform](https://img.shields.io/badge/已验证平台-macOS-green?style=for-the-badge)
![License](https://img.shields.io/badge/许可证-MIT-yellow?style=for-the-badge)

**让数据操作变得简单高效**

[![Tauri](https://img.shields.io/badge/基于-Tauri-FFC131?style=flat-square&logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/前端-React-61DAFB?style=flat-square&logo=react)](https://reactjs.org/)
[![TypeScript](https://img.shields.io/badge/语言-TypeScript-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/后端-Rust-DE4D37?style=flat-square&logo=rust)](https://www.rust-lang.org/)

</div>

## 📱 界面预览

<div align="center">

![DataOmni Interface](images/dataomni.png)

*DataOmni 启动后的主界面展示*

</div>

## 🌟 特性

### 🔗 数据库支持

- **可连接并执行查询**: MySQL, PostgreSQL, SQLite, SQL Server, Oracle, DuckDB（见兼容性矩阵）
- **可连接并执行查询，表格一次改一行**: ClickHouse（HTTP 接口；没有通用事务，改之前与之后各核对一次）
- **可连接、浏览与改文档**: MongoDB（库、集合、文档；条件、排序与编辑都用 mongosh 写法；`db.runCommand` 命令台）
- **可连接、浏览键值与跑命令**: Redis（逻辑库、按模式翻键、六种类型的值、redis-cli 写法的命令行）
- **可连接并执行 Cypher**: Neo4j（库、标签与关系类型；结果里的节点、关系、路径按 Cypher 字面量显示）
- **可连接并发请求**: Elasticsearch（索引、别名、数据流；Kibana Dev Tools 写法的控制台）

连接表单里列出的每一种类型现在都能连。后端 `test_connection` 仍然留着「没有驱动就拒绝」
那道门，给以后新增、还没接上的类型用。

#### 兼容性矩阵

下表每一格都来自真库上跑完的冒烟用例（`src-tauri/tests/database_smoke.rs`，
MySQL 一组 23 条、PostgreSQL 一组 23 条），不是按协议兼容推断的。
连接表单里 MariaDB、TiDB、CockroachDB 各有一个入口，填好各自的默认端口；存下来
的就是 MySQL / PostgreSQL 连接。

| 服务端 | 版本 | 连接类型 | 结论 | 用例 |
| --- | --- | --- | --- | --- |
| MySQL | 8.4 | MySQL | ✅ 支持 | 23 / 23 |
| PostgreSQL | 16 | PostgreSQL | ✅ 支持 | 23 / 23 |
| SQLite | 随应用内置 | SQLite | ✅ 支持 | 全部 |
| MariaDB | 11.4 | MySQL | ✅ 支持 | 23 / 23 |
| TiDB | 8.5 | MySQL | ✅ 支持 | 23 / 23 |
| OceanBase | 4.4.2（CE，MySQL 模式） | MySQL | ⚠️ 可用，有缺口 | 23 / 23（缺口由用例钉住） |
| CockroachDB | 25.2 | PostgreSQL | ⚠️ 可用，有缺口 | 23 / 23（缺口由用例钉住） |
| openGauss | 5.0.3（lite，PG 兼容库） | PostgreSQL | ⚠️ 可用，有缺口 | 23 / 23（缺口由用例钉住） |
| SQL Server | 2022 | SQL Server | ✅ 支持 | 17 / 17（独立用例，`sql_server_smoke.rs`，含改结构语料） |
| Oracle | 23ai Free（23.26） | Oracle（ODPI-C + 随包的 Instant Client） | ✅ 支持 | 14 / 14（独立用例，`oracle_smoke.rs`，含改结构语料） |
| DuckDB | 1.5.5（编进应用） | DuckDB（libduckdb） | ✅ 支持 | 16 / 16（独立用例，`duckdb_smoke.rs`，每次都跑，含改结构语料） |
| ClickHouse | 25.8 | ClickHouse（HTTP 接口，reqwest） | ⚠️ 表格一次改一行，没有事务 | 14 / 14（独立用例，`clickhouse_smoke.rs` 与最重的一条 `clickhouse_mutation_smoke.rs`；经 SSH 隧道那一条另要隧道的环境变量） |
| MongoDB | 8.0 | MongoDB（官方 Rust 驱动） | ⚠️ 文档级，有缺口 | 32 / 32（独立用例，`mongodb_smoke.rs`） |
| Redis | 7.4 | Redis（redis-rs） | ⚠️ 单机，不含集群 | 11 / 11（独立用例，`redis_smoke.rs`） |
| Neo4j | 5.26 LTS、2026.09 | Neo4j（`neo4j` crate，Bolt 5） | ⚠️ 单实例，不含集群路由 | 8 / 8（独立用例，`neo4j_smoke.rs`，两个版本各跑一遍） |
| Elasticsearch | 8.19、9.5 | HTTP（reqwest） | ⚠️ 单节点直连，不含 API Key 认证 | 6 / 6（独立用例，`elasticsearch_smoke.rs`，两个版本各跑一遍） |
| OpenSearch | 3.8 | Elasticsearch（同一个连接类型） | ⚠️ 同上；只读账号列不出对象树 | 6 / 6（同一份用例，按服务端分支） |

- **MariaDB**：JSON 列是 LONGTEXT 的别名，按文本显示与编辑，没有 JSON 专用
  编辑器；没有函数索引。
- **TiDB**：执行计划发的是它自己的 `EXPLAIN FORMAT='tidb_json'`（不认
  `FORMAT=JSON`），没有「真的执行一遍」；改结构时同时改列和改表名会拆成两条
  语句（它不收一条 ALTER 里两件事都做，8200），不再是一个整体，预览里写明。
  服务端本身没有的：结构页不显示检查约束（默认不启用，启用后目录里也接不上）、
  没有触发器与存储过程。按连上之后 `VERSION()` 分辨，从 MySQL 入口连的也一样。
- **OceanBase**（MySQL 模式）：从 MySQL 入口连，端口 2881，用户名写 `用户@租户`（如 `root@test`）。
  执行计划解析的是它自己的 `FORMAT=JSON`（算子挂在 `CHILD_n` 下），没有「真的执行一遍」；改结构时
  同时改列和改表名同样拆成两条（要重写表的改列与改表名同句它报 1235）。缺口：表达式默认值
  （`DEFAULT (UUID())`）在目录里与同样文字的字符串默认值分不开，改结构时这一列会被重述成字符串默认值，
  预览里看得见，动这种列前先核对。备份用 `mysqldump` 或 `mariadb-dump` 都行；恢复要用 MariaDB 的
  `mariadb` 客户端——mysql 命令行客户端（Homebrew 的 26.7）对它的每一条非查询语句都报 `Malformed packet`。
- **openGauss**（GaussDB 同源）：建库时要 `DBCOMPATIBILITY 'PG'`（默认的 `'A'` 是 Oracle 语义，没测过）。
  只存 sha256 口令的用户连不上——标准 PostgreSQL 驱动不认它的 sha256 认证，连接时会说明服务端怎么改
  （`password_encryption_type = 1` 后重设口令）。缺口：序列的属性页读不出（没有 `pg_sequences`）；
  违反约束时不给约束名与表名（服务端不填那两个字段）。
- **CockroachDB 的缺口**：结构页的触发器一段读不到（它没有
  `pg_get_triggerdef()`，目录表里也查不到触发器，只有 `SHOW CREATE TRIGGER`
  看得见），那一段单独显示原因，其余照常；错误里没有出错位置和表名。执行计划
  解析的是它的 `EXPLAIN (VERBOSE)` 文本树，「真的执行一遍」走 `EXPLAIN ANALYZE`。
  改结构的几条语句逐条执行、各自提交，不是一个事务（它在事务里改不了要重写数据的列类型），
  预览里会说明；改类型各自单独一条。
- **SQL Server**：四个阶段都已接上（连接、执行、对象与结构浏览、表格编辑、事务、
  执行计划、改结构与建表、CSV 导入、整表导出）。与另外几家不同、值得知道的几处：
  - 脚本里单独一行的 `GO` 按 SSMS 的约定分批；有 `GO` 时只按它切，一批原样发出去
    （过程体里的分号不切）。`GO 5` 这种带次数的不认，留给服务端报错。
  - 执行计划只有估算（`SHOWPLAN_XML`），没有「真的执行一遍」。
  - SQL Server 的读是加锁读：编辑器里开着一个改过某些行的事务时，表格里提交对这些
    行的改动、结构页读未提交的改表，会在等锁 5 秒后报 1222，提交或回滚那个事务即可。
  - 编辑器里查 CLR 类型（geography、hierarchyid）的列，显示的是它的二进制形态（与 SSMS 相同），
    要看文本就 `CAST(… AS nvarchar(max))`；表数据页自己转成文本。`money` 经驱动解成浮点，
    超过约 9×10¹¹ 的值末位可能不准（表数据页与整表导出不受影响）。
  - CSV 导入时，转不成目标类型的值在插入之前就查出来记成坏行：SQL Server 的类型
    转换错误会把整个事务回滚，不能像别家那样退回保存点。
- **Oracle**：三个阶段都已接上（连接、执行、对象与结构浏览、表格编辑、事务、执行计划、
  改结构与建表、CSV 导入、整表导出）。Instant Client（Basic Light，许可允许随应用分发，
  许可原文随包附上）装在应用里，用户不用自己装；Linux 上要系统的 `libaio`，deb 包声明了
  依赖。与另外几家不同、值得知道的几处：
  - 按服务名连接（Easy Connect）；按 SID 连接与 TLS（要钱包）还不支持，需要加密就走
    SSH 隧道。
  - 超时与取消会让服务端那条语句真的停下；错误带 ORA 码与出错位置。
  - 没有 BEGIN：「开始事务」发的是 `SET TRANSACTION`；DDL 会隐式提交，状态栏跟着
    服务端走。
  - 执行计划是 `EXPLAIN PLAN` 的估算（「文本」页是 `DBMS_XPLAN` 的原文），没有「真的
    执行一遍」。
  - **改结构不是一个事务**：Oracle 的每条 DDL 自己提交。能合进一条的合进一条，
    其余（改列名、删列、改表名）各自一条，预览里会说明；中途有一条失败时前面的已经
    生效。
  - Oracle 把空字符串存成 NULL，在表格里填一个空值得到的是 NULL。
  - 原生 JSON（21c 起）与 VECTOR（23ai）驱动读不了：表数据页让服务端写成文本，SQL 标签里
    要自己写 `JSON_SERIALIZE(列)` / `VECTOR_SERIALIZE(列)`（报错里会提示）。
- **DuckDB**：三个阶段都已接上（打开文件或 `:memory:`、执行、对象与结构浏览、补全、ER 图、
  表格编辑、事务、执行计划、改结构与建表、CSV 导入、整表导出）。与另外几家不同、值得知道的
  几处：
  - 库就是一个文件，连着的时候应用占着它：DuckDB 同一时间只让一个进程打开一个文件
    （只读也不行），在命令行或 Python 里用同一个文件之前先断开这条连接。
  - 结果边读边取，到了行数上限就停，`SELECT * FROM 'big.parquet'` 不会把整个文件读进内存；
    parquet 与 json 扩展编在应用里，其余扩展（httpfs、excel、spatial……）照 DuckDB 自己的
    规矩在第一次用到时从 extensions.duckdb.org 下载。
  - 没编时区扩展（ICU）：`TIMESTAMPTZ` 按 UTC 显示（带 `+00`），`AT TIME ZONE` 不可用。
  - 超时与取消会让那条语句真的停下，会话还是那条连接（事务、`SET` 都还在）；错误带类别
    （Catalog Error、Binder Error……）与出错位置。
  - 约束名是 DuckDB 自己起的，建表时写的 `CONSTRAINT x` 不保留；外键不能跨 schema。
  - 名字带不带引号都不分大小写：编辑器里写 `FROM Orders` 查的就是 `orders`，结果照样能改。
  - MAP 列按 DuckDB 自己的写法显示（`{k=1}`），列表与结构体显示成 JSON；两种都能原样改回去。
  - 事务和 PostgreSQL 一样：一条出错，整个事务只能回滚。
  - 执行计划是 `EXPLAIN (FORMAT JSON)` 的估算，没有「真的执行一遍」。
  - 改结构每个动作一条语句（DuckDB 一条 ALTER 只做一件事），整批在一个事务里。表上有
    `CREATE INDEX` 建的索引、或被别的表的外键引用时，DuckDB 拒绝改列、改名与删列（加列与
    改默认值可以），要先删索引或外键。没有自增列：要自增
    先建序列，主键的默认值写 `nextval('序列名')`。
  - 没有保存点：CSV 导入时「跳过坏行」只能每批一个事务（坏的那一批整批撤掉、逐行重写）。
- **ClickHouse**：走 HTTP 接口（8123，加密 8443；不用 9000 的原生协议）。连接（用户名口令，
  空着是 `default` 用户；库空着是这个用户的默认库；TLS 与 CA；SSH 隧道）、编辑器（结果上限、超时、
  取消、错误码与出错位置；`SET` 与临时表留在这个标签的会话里）、对象树按库列出表、视图、物化视图
  与字典、结构页（列、主键与跳数索引、建表原文）、表数据（分页、排序、筛选）、补全、ER 图、
  执行计划、导出。与别家不同的几点：
  - **表格一次改一行，没有事务**：ClickHouse 没有通用事务，`UPDATE` / `DELETE` 是 mutation、
    报不出影响行数，主键也不唯一。所以表数据页一次只提交一项：按整行（比得准的列）先数一遍，
    恰好一行才执行；改和删等服务端做完（`mutations_sync = 2`）再核对一次；对不上时分清
    「没有执行」和「已经执行、撤不回来」。改和删会重写这一行所在的整块数据（2000 万行的表上
    实测改一行 4 秒多）。主键列不能改；查询结果里不能直接改，到表数据页改；没有事务与 CSV 导入。
    数完到执行之间别处写进一行一模一样的，会被一起改——没有事务就消除不了，界面上写明。
  - 取消、超时、到了行数上限，都会在服务端停下那条查询（`KILL QUERY`），不只是这边不读了。
  - 不改任何服务端设置，`readonly = 1` 的只读账号照样能用。
  - 值按 ClickHouse 自己的写法显示：数组 `[1,2]`、Map `{'k':1}`、元组 `(1,'a')`，粘回 SQL 就能用；
    `UInt64` / `Int128` 与 `Decimal` 精确到每一位，`Decimal(10, 2)` 的 10.5 显示成 `10.50`；
    `nan`、`inf` 原样；不是 UTF-8 的字符串按二进制显示。
  - 主键不唯一（它是稀疏索引的排序键），所以表数据按主键列加其余列翻页；MATERIALIZED 与
    ALIAS 列照样显示（`SELECT *` 不带它们，这里把列名写出来）。
  - 执行计划是 `EXPLAIN indexes = 1`：读表那一步写出主键、分区、跳数索引各把 granule 筛到了多少；
    没有「真的执行一遍」。ER 图只有表和列：ClickHouse 没有外键。
  - 筛选里的「包含」这类走 `LIKE`，ClickHouse 没有 `ESCAPE`，这里用反斜杠转义 `%` 与 `_`。
- **MongoDB**：连接（认证库、TLS 与 CA、SSH 隧道、`mongodb+srv://` 即 Atlas、客户端证书与 X.509 登录）、对象树按库列出集合与视图（可新建集合、删除集合与视图）、集合页
  （条件、排序、分页、总数、执行计划）、按 `_id` 改、增、删单个文档、按条件批量改与删、只读的
  聚合管道、结构页（索引、校验规则、视图定义；可建与删索引）、按条件导出与导入
  （mongoexport 格式，可选保留全部类型；导入可按 `_id` 覆盖）。值的写法用 mongosh 的，
  显示出来的原样粘回条件框就能用，改一个字段不会换掉别的字段的类型；改文档时别处
  改过它就不覆盖。命令台标签跑一条 `db.runCommand({...})`（`distinct`、`serverStatus`、用户管理……），
  写法同筛选框；删除类与无条件的批量写按「危险语句确认」先问，认不出的命令按写算，改连接登录
  状态的（`logout` 等）拒跑，`find` 只回第一批。还没有的：`db.coll.find()` 这种 JS 写法（要 JS 引擎）。
  详见 [用户手册](docs/user-manual.md#mongodb)。
- **Redis**：连接（口令与 ACL 用户、库号、TLS 与 CA、SSH 隧道）、对象树列出有键的逻辑库、
  键浏览页（按模式与类型用 `SCAN` 逐页翻，每个键带类型与剩余时间；string、hash、list、set、
  zset、stream 各一种表，大的值分页读，字符串只带前 512 KiB；不是 UTF-8 的键和值按 redis-cli
  的写法转义并标出）、命令行（写法与回答都同 redis-cli；会阻塞或改连接状态的命令拒跑，
  清库、`KEYS`、改服务端的先确认）；界面上删键、改名（不覆盖已有的）、设或去过期、改字符串
  （别处改过就不覆盖，剩余时间不变）、改 hash / list / set / zset 的元素（同样先比对再写）、
  新建键、stream 加条目与按 ID 删条目。还没有的：集群与 Sentinel。
  详见 [用户手册](docs/user-manual.md#redis)。
- **Neo4j**：连接（用户名口令或不认证；库空着就是用户的主库；TLS 与 CA；SSH 隧道）、对象树按库
  列出标签与关系类型（点开是一条 `MATCH` 查询，开出来就跑）、Cypher 查询标签（多条按分号依次
  跑，一条失败就停；结果上限与超时，超时由服务端按事务超时停下；写入计数与服务端的提示；
  会写的先问服务端是读是写，按「危险语句确认」的门槛决定要不要先确认）。值按 Cypher 字面量
  显示（`(:Person {name: 'a'})`、`date('2024-01-02')`），点一格看全文与 `elementId`。
  结果里有节点、关系或路径时默认画成图（与表格一键切换）：按标签着色、拖动平移与挪节点、
  点中看属性，最多画 300 个节点。点中的节点或关系可以在界面上改：属性（值按 Cypher 写，
  输入框里放的就是当前值的字面量）、加摘标签、删（节点还连着关系时说清连着几条、一起删），
  工具栏上「新建节点」。按 `elementId` 定位，一次只动一个，要跑的语句一直摆在下面。
  以 `EXPLAIN` / `PROFILE` 开头的，结果里多一个「计划」：与 SQL 同一棵树，每一步带估算行数，
  `PROFILE` 还带实际行数与 DbHits，估错最多的那一步会被指出来；「计划原文」是服务端自己的那张表。
- **Elasticsearch**：连接（用户名口令或不认证；TLS 与 CA；SSH 隧道，经隧道仍按原主机名校验证书）、
  对象树列出索引、别名、数据流（点开是一条 `GET 名字/_search`，开出来就发）、控制台标签（写法同
  Kibana Dev Tools：一行方法与路径，下面跟 JSON 请求体；`_bulk` 这类多份 JSON 按 NDJSON 发；依次发，
  出错或 4xx / 5xx 就停）。回答是状态码加排好版的 JSON，搜索命中、ES|QL / SQL 的列与值、
  `_cat?format=json` 另有表格；超过 2^53 的整数原样显示。会写的按方法与路径分级，过「危险语句确认」。
  索引有结构页：Mapping 按路径摊平（对象、nested、多字段、运行时字段），参数原样列出，外加分片、副本与别名。
  搜索结果里点 `_id` 改或删这一份文档，带着读到的版本（`if_seq_no`），别处改过就不覆盖。
  对象树上右键删索引、删数据流（确认框写明现在有几份文档）。建索引、改别名在控制台里写。
  聚合（`terms`、`date_histogram`……）另有表格：嵌套的桶展开成行，指标并成一张。OpenSearch 用同一个连接类型。
  详见 [用户手册](docs/user-manual.md#elasticsearch)。
  `EXPLAIN` 什么也不执行，不走确认。
  还没有的：在界面上建关系、集群路由（`neo4j://`）。
  详见 [用户手册](docs/user-manual.md#neo4j)。
- 在编辑器里用 `USE` 切库在 MySQL 类服务端上一律拒绝：它会让侧边栏的对象树
  悄悄换成另一个库。MySQL 本来就拒，MariaDB 与 TiDB 不拒，所以由应用来挡。

### ⚡ 查询执行

- SQL 编辑器，支持语法高亮
- 方言感知的语句拆分，正确处理字符串、注释、Dollar-quoted 字符串中的分号
- 查询超时与取消，区分「取消请求中」和「已取消」
- 结果按行数上限截断并流式分批回传，超出内存预算时明确报错
- 补全按当前连接的真实结构给：表、视图与它们的列（列带完整类型），
  `FROM orders o` 之后 `o.` 补出 orders 的列；关键字按方言过滤
  （`AUTO_INCREMENT` 只在 MySQL 出现，`RETURNING` 只在 PostgreSQL 出现）
- 格式化 SQL（⌘⇧F）：有选区只排选区；解析不了时只报错、正文不动
- 编辑器快捷键：查找 ⌘F、下一个 ⌘G、上一个 ⇧⌘G、跳转到行 ⌘⌥G、
  注释 ⌘/、块注释 ⇧⌥A；查找与跳转面板跟随界面语言
- 查询失败时显示数据库原话：SQLSTATE、出错行列（PostgreSQL 可一键跳过去）、
  DETAIL、HINT、约束与表名，可一键复制完整详情
- 危险语句执行前确认，门槛按环境可配（设置 → 危险语句确认）；确认不代替数据库权限
- 把当前标签存成 `.sql` 文件（⌘S），或打开一个 `.sql` 到新标签（标签栏 📂）；从文件打开或存过的
  标签 ⌘S 写回原文件（文件在别处被改过或删了先问），⇧⌘S 另存为
- SQL 草稿随工作区恢复；执行历史是独立的一份，记录时间、连接、数据库、语句、
  耗时、状态与影响行数（失败 / 取消 / 超时一样记），可按文本、连接、日期与状态
  搜索，可收藏、命名和打标签，保留周期与条数上限可配（设置 → 查询历史保留）
- 历史里**不存任何结果行**；语句里的口令在写入前就被替换成 `'***'`，
  `IDENTIFIED BY`、`PASSWORD =`、敏感列名赋值与 `INSERT` 的对应列都覆盖到
- Cypher、Elasticsearch 的请求、Redis 与 MongoDB 的命令同样进历史（带语言标记、按各自的写法脱敏），
  从历史里打开只给同一种语言的连接
- 多条语句的结果可以逐条或全部收起，收起后标题上留一句摘要（行数、影响行数或错误原文）

### 📊 数据浏览与编辑

- 表格视图浏览表数据，服务端 LIMIT / OFFSET 分页并采用稳定排序
- 排序与筛选都在数据库里执行，作用于整张表而不只是当前页；行数统计走同一个条件
- 列可隐藏、拖宽（双击边界自适应）、冻结左侧若干列，行高三档
- 复制单元格、矩形选区、整行、整列（⌘C / ⇧⌘C 含列名 / ⇧Space 整行 /
  ⌥Space 整列，或右键菜单）
- NULL、空字符串、纯空白和二进制在网格里互相区分得开——这四种在朴素表格里
  都是一块空白，而它们在 WHERE 条件里行为完全不同
- BigInt、Decimal 保持精度，时间类型保留时区语义
- 刷新保住筛选、排序、页码、滚动位置与选区
- 行标识来自真实约束元数据：主键，或一个非空、完整、无谓词且已验证的唯一索引；
  复合键的全部列都进 WHERE。无法唯一定位记录时只读，并说明是哪一种原因
- 查询结果只在能**证明**它映射到单表唯一记录时才可改（单表 SELECT、投影全是
  裸列名、键列在投影里），否则只读并说明原因
- 编辑、新增、删除都先进入待提交队列：可以逐条预览「哪一行、哪一列、
  从什么改成什么」和真正会发出去的语句，逐项撤销或全部撤销，最后一次提交
- 整批在一个事务里执行，并在事务内核对每条语句影响的行数。失败时数据库里
  什么都不会变，待提交的变更原样留着，出错的那一条连同数据库给的
  detail / hint / constraint / SQLSTATE 一起标出来
- 原值一并进 WHERE 以检测并发修改：别人在你之后改了同一个值，这次保存会失败
  而不是无声地盖掉
- 每个单元格分得清 NULL、空字符串、默认值、表达式和未填写；JSON、二进制、
  布尔和日期各有专用编辑器
- 结果导出为 CSV / JSON / `INSERT` 语句，可选分隔符、表头、NULL 写法与 UTF-8 BOM，
  对话框带真实输出预览；`INSERT` 的字面量与标识符按当前连接的数据库写，七种关系库都实际灌回去验过。
  表数据导出的 `INSERT` 不写计算列；自增列照原值写，SQL Server 前后加 `SET IDENTITY_INSERT`，
  PostgreSQL 的 `GENERATED ALWAYS` 写 `OVERRIDING SYSTEM VALUE`，末尾照 pg_dump 用 `setval` 把序列推过插入的最大值
  （Oracle 的 `ALWAYS` 自增列没有覆盖写法，执行时报 ORA-32795）
- 备份：SQLite 用 `VACUUM INTO` 写一份一致的库文件，DuckDB 用 `EXPORT DATABASE` 导成 Parquet 目录，
  PostgreSQL 用本机的 `pg_dump`（custom 格式），MySQL / MariaDB 用本机的 `mysqldump`（一致性快照的 SQL 文本）；
  MongoDB 按库用本机的 `mongodump`（gzip 归档，对象树上右键）；密码不进命令行，经 SSH 隧道也行；走后台任务
- 整表流式导出：行从数据库直接落盘，不受行数上限截断，带进度、可取消、失败可
  重试；中途停下不会留下一份看上去完整的文件

- ER 关系图：整库的表都画出来（含没有外键的），每张列出全部字段与类型，
  有外键的表之间按具体字段连线；可搜索表名与列名、缩放平移、自由拖动卡片、
  导出为 SVG / PNG / PDF，或导出成数据字典（Markdown）与 Agent Skill（`SKILL.md`）；执行 DDL 后自动刷新

- AI 设计新表（可选，默认关）：一句话需求 → 模型给出多表设计 → 校验结果、ER 图、
  每条外键「删除被引用的行时」怎么办（级联删除标红，一格可改）→ 预览建表语句 → 执行。
  接口只有两种：Anthropic 与 OpenAI 兼容（DeepSeek、通义千问、智谱、Kimi、本地 Ollama 都走后者）；
  只发需求、已有表名与当前设计，不发数据；发了什么可以展开看；Key 存系统钥匙串。
  不要 AI 的构建用 `--no-default-features`，那样二进制里没有发往模型服务的代码

- 表结构编辑：结构页上直接改列名、类型、可空、默认值，加列删列改表名；
  对象树里新建表（填列与主键）。**一律先出预览 SQL 再执行**——预览里分开列出
  会丢什么、会跑什么、哪几项这个方言做不到（带理由）。删列走二次确认，
  并逐条点名受影响的列
- 对象管理：右键删除表 / 视图 / 物化视图、清空表（总会先确认，写明语句与会丢什么）；
  PostgreSQL / CockroachDB / SQL Server 上新建 schema；结构页上新建（按次序选列、
  可选唯一）与删除索引。每条语句都由一份共用语料钉住，在八种服务端
  （含 MariaDB / TiDB / CockroachDB）的真库上跑过
- 主键与约束的增删改还要去 SQL 编辑器；SQLite 改列类型、MySQL 改带
  表达式默认值的列与空间列（读不到 SRID，重述会把它删掉）的类型都明确不做，界面上写明原因。
  MySQL 重述列定义时带上 INVISIBLE；SQL Server 改类型时保留 SPARSE，动态数据掩码另起一句加回去；
  PostgreSQL / CockroachDB 改字符列的类型时带上原来显式写的排序规则

- 事务控制：自动提交开关、开始 / 提交 / 回滚，工作台头部常驻事务状态与计时。
  状态由执行语句的那条连接给出，所以你自己在编辑器里写的 `BEGIN` 一样算数。
  切换连接、断开或退出前若事务还开着，先问一句提交还是回滚，而不是让数据库
  默默回滚掉

- 执行计划：PostgreSQL / MySQL / SQLite 各自的 EXPLAIN，解析成同一棵可展开的树，
  也能看数据库返回的原文。PostgreSQL 还能「真的执行一遍」拿到每一步的实际行数
  与耗时——树上会直接点名估算差了一个数量级以上的那个节点，那通常就是慢的原因
- 慢查询不被时间淘汰，可在历史里单独筛出来；历史从不保存查询结果行

- CSV 导入：三步向导（选文件与读法 → 字段映射 → 策略与执行）。分隔符自动嗅探；
  文件不是 UTF-8 时按 GB18030 读（中文 Windows 上 Excel 另存的 CSV 是 GBK）。
  二进制列里的 `0x…`（导出就是这么写的）按它拼出的字节存，所以导出的文件能原样导回去。
  字段按列名配对、配不上就留空而不按位置猜。导入前分两档提示——会失败的拦住，
  可能不对的只提醒。批量大小、事务策略（整份一个事务 / 每批一个事务）与错误行
  处理（停下 / 跳过）可选；失败的行按**文件里的行号**列出来，连同原始字段值
- 导出：整表、查询结果、或者网格里选中的那一块矩形
- 后台任务：导入与导出都在后台跑，右下角的面板里看进度、暂停（导入）、取消、
  重试与日志。已经写进数据的任务不给「重试」——那只会重复写入

- ER 关系图可按 Schema、以某张表为中心（走 N 跳关系）、只看有关联的表来过滤。
  过滤与搜索是两件事：搜索压暗保住图的形状，过滤直接把表拿掉并重排——
  两百张表的库里，把不相干的压暗仍然什么都看不清

- 快速图表：把当前这份结果（排过序、按可见列）画成柱状图或折线图，看一眼形状。
  默认只画第一列数值——把量级差很远的两列放到同一根纵轴上，小的那条等于不存在；
  勾成那样时会明确提示，但绝不开第二根纵轴。超过 200 个点不画，也不悄悄采样

> 尚未实现：筛选的 OR / IN。

### 🛡️ 凭据与传输安全

- 密码存入系统钥匙串（macOS Keychain / Windows Credential Manager / Linux Secret Service），
  配置文件只保存凭据引用，不落明文
- 支持「不保存密码」，每次连接时输入
- 连接可以导出成一个 JSON 文件、在另一台机器上导入（首页的「导出连接… / 导入连接…」）。
  文件里**没有口令和 SSH 密钥**：存过口令的连接导入后第一次连接时会问，SSH 的口令要在编辑连接里重新填。
  导入时本机已有的同一个连接（名字、类型、地址、库、用户都一样）跳过，同一个文件导两次不会多出一份
- 明确的 TLS 模式（禁用 / 优先 / 要求 / 校验证书 / 校验主机名），支持 CA 与客户端证书
- SSH 隧道：数据库只在内网监听时，填跳板机的地址与用户名，应用自己开一个
  只绑 `127.0.0.1` 的本地端口转发过去。登录用私钥或口令，**带口令的私钥也支持**——
  私钥口令与登录口令都进系统钥匙串（键 `{连接 id}#ssh`），不落盘。跳板机的主机
  密钥按 `~/.ssh/known_hosts` 校验——和命令行 `ssh` 读的是同一份，没有记录或记录
  对不上都拒绝连接，没有「跳过校验」的开关。不读 `~/.ssh/config`，不走
  ssh-agent，不做多级跳板
- 连接失败后可以查断在哪一段：主机名解析不出地址、端口没人接受连接、端口接受了
  连接又立刻断开（本机开着 TUN 模式代理时最常见）、还是端口真的通了（那就只剩
  账号、TLS 或库名）。SQLite 查的是文件——路径读不到、是个目录、空文件（那是
  新库）、还是开头不是 SQLite 文件头（多半选错了文件）
- 日志统一脱敏，不打印密码、Token 和完整连接串
- 标识符由数据库方言安全引用，保留字与特殊字符表名可安全使用

- 破坏性语句执行前二次确认：默认不带 WHERE 的 UPDATE / DELETE 与
  DROP / TRUNCATE / ALTER … DROP COLUMN 在任何环境都拦；带 WHERE 的写入只在
  生产环境拦；SELECT 与 INSERT 不拦。阈值按环境可在设置里调
- 生产 / 预发连接常驻文字标识，不只靠颜色区分

> 尚未实现：权限层面的写保护。

### 🎨 界面

- 基于 Tauri 构建，原生性能
- 应用级浅色 / 深色 / 跟随系统主题，首次渲染前落地，不闪白
- ⌘K / Ctrl+K 命令面板：模糊搜索连接与表，新建查询、打开数据库文件（SQLite / DuckDB）、切换外观
- 数据网格按内容估算列宽、可拖动调整、双击恢复；点表头三态排序；
  键盘选区与 ⌘C 复制为 TSV
- 侧边栏与编辑器高度可拖动并持久化

## 🚀 快速开始

### 构建与验证状态

Tauri 本身跨平台，但**本项目只在下表记录的环境上实际验证过**。未列为「已验证」的
平台不代表不能用，而是**我们没有验证过，不作任何保证**。

| 平台 | 产出安装包 | 状态 | 依据 |
|---|---|---|---|
| macOS (Apple Silicon / aarch64) | `DataOmni.app`、`DataOmni_0.4.0_aarch64.dmg` | ✅ 已验证 | 2026-09-25 于 macOS 27.0 / arm64 执行 `bun run package`（带 Oracle Instant Client），退出码 0；装上后逐库回归，见 TODOs「发布里程碑」 |
| macOS (Intel / x86_64) | — | ⚠️ 未验证 | 无 x86_64 机器，也未做交叉编译 |
| Linux (Ubuntu 22.04 / x86_64) | `DataOmni_0.4.0_amd64.deb`、`DataOmni-0.4.0-1.x86_64.rpm` | ✅ 已验证（容器内） | 2026-09-25 执行 `bun tauri build --bundles deb,rpm --config src-tauri/tauri.oracle.conf.json`，退出码 0，包里的 Instant Client 与原件逐字节相同。**不发 AppImage**：打包工具会改 Instant Client 的 .so，而它的许可只许原样分发（TODOs 5.4）。以下为 2026-09-23 的验证记录：`.deb` 在干净的 Ubuntu 22.04 容器里装、升级、卸载都验过，在 Xvfb + openbox 里跑通界面、Ctrl+W 与 gnome-keyring 存取密码；AppImage 只以 `--appimage-extract-and-run` 跑过（容器里没有 FUSE）；`.rpm` 没装过。**没有在真实桌面会话（GNOME / Wayland）里验过** |
| Windows (x86_64) | `DataOmni_<版本>_x64_en-US.msi`、`DataOmni_<版本>_x64-setup.exe` | ⚠️ 能构建，未安装验证 | 2026-10-06 起由 GitHub Actions（`release.yml`，windows-latest）打包，带 Oracle Instant Client；还没在 Windows 上装过，清单见 `docs/windows-checklist.md` |

安装包由 GitHub Actions 打（`.github/workflows/release.yml`）：推 `v*` tag 时 macOS（Apple Silicon）、Linux、Windows
各打一份，放进一个草稿 Release。都**没有签名**——没有 Apple Developer ID，也没有 Windows 代码签名证书。
Linux 包要求 glibc 2.34 以上（Ubuntu 22.04、Debian 12、Fedora 35、RHEL 9 及以后）。

### 系统要求

- **操作系统**: 见上表
- **Linux 保存密码**需要一个已解锁的 Secret Service（GNOME 桌面自带 gnome-keyring）。
  没有时连接照样能建，只是勾「在系统中保存密码」会报错，改成每次连接时输入即可。
  钥匙串是应用运行中才装上的，要重启 DataOmni 才用得上
- **内存**: 最低 4GB RAM，推荐 8GB+
- **存储**: 至少 500MB 可用空间

### 安装方式

安装包在 [Releases](https://github.com/yuxuetr/DataOmni/releases)（发布之前没有可下载的，只能从源码构建）。
都没有签名，第一次打开要放行一次：

- **macOS**：双击会被拦下。到「系统设置 → 隐私与安全性」底部点「仍要打开」；或者装好后在终端执行
  `xattr -dr com.apple.quarantine /Applications/DataOmni.app`。macOS 15 起「右键 → 打开」不再能绕过
- **Windows**：SmartScreen 提示「Windows 已保护你的电脑」时点「更多信息 → 仍要运行」
- **Linux**：`sudo apt install ./DataOmni_*.deb` 或 `sudo dnf install ./DataOmni-*.rpm`，依赖（含 Oracle 要的 libaio）自动带上

#### 从源码构建

Linux 上先装系统依赖（Ubuntu 22.04 上实际出过包的就是这一组；`xdg-utils` 只有
打 AppImage 才要，缺了会在最后一步报 `xdg-open binary not found`）：

```bash
sudo apt-get install build-essential curl wget file pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev xdg-utils
```

```bash
# 克隆项目
git clone https://github.com/yuxuetr/DataOmni.git
cd DataOmni

# 安装依赖
# npm install 
# pnpm install
bun install

# 开发模式运行
# npm tauri dev
# pnpm tauri dev
bun tauri dev

# 构建生产版本
# npm tauri build
# pnpm tauri build
bun tauri build

# 不带 AI 的构建（内网 / 信创）：发往模型服务的代码整块不编进去
bun tauri build -- --no-default-features

# macOS：构建（带 Oracle Instant Client）并装进 /Applications，装完启动
# --skip-build 只装上次的产物，--no-open 装完不启动，-y 正开着时不问直接结束它
scripts/install-macos.sh
```

### 示例数据

想快速看到 ER 关系图的效果，可以先导入示例 schema（建库 `dataomni_demo`，
11 张表，覆盖链式引用、分叉、自引用、复合外键和孤立表）：

```bash
# MySQL
mysql -h HOST -u USER -p < examples/sample-schema.sql

# PostgreSQL（建库要单独一步，CREATE DATABASE 不能在事务里跑）
createdb -h HOST -U USER dataomni_demo
psql -h HOST -U USER -d dataomni_demo -f examples/sample-schema.postgres.sql
```

## 📖 使用指南

完整的使用说明见 **[用户手册](docs/user-manual.md)**：连接（TLS、SSH 隧道、环境）、
写 SQL 与执行、事务、执行计划、编辑表数据、改表结构、导入导出、ER 关系图、
查询历史、设置、快捷键与常见问题。

## 🛠️ 技术栈

### 前端

- **框架**: React 18 + TypeScript
- **构建工具**: Vite
- **UI组件**: Tailwind CSS + Lucide Icons
- **状态管理**: Zustand
- **代码编辑器**: CodeMirror

### 后端

- **框架**: Tauri 2 (Rust)
- **数据库驱动**: SQLx（MySQL、PostgreSQL、SQLite）、tiberius（SQL Server）、oracle / ODPI-C（Oracle）、
  duckdb、mongodb、redis、neo4j（Bolt）；Elasticsearch 与 ClickHouse 走 HTTP（reqwest）
- **SSH 隧道**: russh；**凭据**: keyring（系统钥匙串）
- **序列化**: Serde（连接配置存成 JSON）

### 开发工具

- **IDE**: VS Code + Tauri插件
- **包管理**: Bun
- **版本控制**: Git

## 🏗️ 项目结构

```bash
DataOmni/
├── src/                   # 前端源码
│   ├── components/        # React 组件
│   ├── stores/            # Zustand 状态
│   ├── utils/             # 纯函数（大部分决策逻辑，旁边是同名测试）
│   ├── contracts/         # 跨层的类型与状态机不变量
│   └── i18n/              # 中英文文案
├── src-tauri/             # 后端源码
│   ├── src/
│   │   ├── commands/      # Tauri命令
│   │   ├── services/      # 业务服务
│   │   └── models/        # 数据模型
│   └── Cargo.toml         # Rust依赖
├── docs/                  # 用户手册
├── rfcs/                  # 设计说明与评估
├── scripts/               # 打包与安装脚本
├── TODOs.md               # 进度、取舍与验证记录
└── README.md              # 项目说明
```

## 🤝 贡献指南

我们欢迎所有形式的贡献！

### 如何贡献

1. Fork 本项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

### 开发环境设置

```bash
# 安装Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 安装Node.js和Bun
curl -fsSL https://bun.sh/install | bash

# 安装Tauri CLI
cargo install tauri-cli

# 克隆项目并安装依赖
git clone https://github.com/yuxuetr/DataOmni.git
cd DataOmni
bun install
```

## 📝 更新日志

### 未发布

（暂无）

### v0.6.0（2026-10-06）

不加功能，为 1.0 打底（`rfcs/roadmap-1.0.md` 的 R0–R5）：

- 🐛 退回旧版不再连累数据：`connections.json` 里有一条旧版读不懂的连接（比如以后新加的数据库类型）时，其余连接照常显示，
  那一条和新版加的字段在保存时原样写回；查询历史与标签快照遇到更新的格式时只读不覆盖。0.5 写下的文件存成固定样本，每次构建都验
- ✨ 日志文件（满 2 MB 换一份，不记口令；有一道门扫描日志调用点）；「设置 → 关于与诊断」可以复制诊断信息、在文件夹中显示日志
- ✨ 启动时检查新版本：每天最多一次，只问 GitHub 最新的版本号，有新版本时在标签栏下面提示，不自动下载；设置里可关
- 📝 GitHub issue 模板：缺陷（附诊断信息）、想连的库或部署形态
- 📦 Windows 安装包每次发版先在 CI 里静默安装、启动、升级、卸载一遍，过了才建 Release；SmartScreen 与界面仍没在真机上走过

### v0.5.1（2026-10-06）

安装包第一次由 GitHub Actions 打：macOS（Apple Silicon）、Linux（x86_64）、Windows（x86_64，还没在 Windows 上装过），均未签名，
首次打开怎么放行见上文「安装方式」。

- 🐛 七十多处缺陷修正，记录见 TODOs「P0-P3 无阻塞级缺陷」，其中会悄悄出错的几处：SQL Server 结果里同名的列互相覆盖；
  风险判定把整张换掉表、清空一列当成非破坏性；块注释、`#` 与反斜杠没按方言读；CSV 导入往自增 / serial 列写 id 不提醒序列不跟着走；
  SQLite 的 rowid 别名写了 NOT NULL 就被当成必填
- 🔁 连接导出 / 导入（首页），文件里不含口令与 SSH 密钥
- 🔤 设置 → 外观：界面字体、代码编辑器字体与字号、界面缩放
- 📦 GitHub Actions 打三个平台的安装包（macOS Apple Silicon、Linux x86_64、Windows x86_64），推 tag 时放进草稿 Release；
  第一次有 Windows 安装包（还没在 Windows 上装过）

### v0.5.0（2026-10-04）

安装包与 v0.4.0 相同：macOS（Apple Silicon）与 Linux（x86_64），均未签名；仍不提供 Windows 安装包。

- 🐛 约 200 处缺陷修正：macOS 与 Linux（GNOME Wayland）打包版逐库回归，类型边界值、导出往返、
  事务与表格写入、各工作区的写法与 mongosh / redis-cli / Kibana / Cypher 对齐，记录见 TODOs「P0-P3 无阻塞级缺陷」
- 🦆 DuckDB：打开文件、查询、对象树与结构页、表格编辑与事务、执行计划、改结构与建表、CSV 导入、整表导出
- 📈 ClickHouse：查询、对象与结构浏览、表数据（一次改一行，前后各核对一次）、执行计划、导出；取消即在服务端停下
- 🔎 Elasticsearch：连接、对象树（索引、别名、数据流）、Dev Tools 写法的控制台（JSON 与表格两种看法，
  大整数不失真，会写的先按门槛确认）；Mapping 结构页、从搜索结果里改删文档、删索引与数据流、
  聚合结果的表格；OpenSearch 验过
- 🍃 MongoDB 命令台（`db.runCommand`）；🔑 Redis stream 条目的添加与删除
- 📝 `.sql` 标签就地保存（⌘S 写回原文件，⇧⌘S 另存为）；Cypher、Elasticsearch、Redis 的执行也进查询历史
- 🎨 只读的代码也上色：执行前确认里的语句、DDL、结果里的 JSON、MongoDB 的文档、语句列表与查询历史，
  颜色和编辑器一致
- 📂 编辑器里多条语句的结果可以逐条或全部收起，收起后标题上留一句摘要
- 🏠 首页连接多时只让连接列表滚动，「新建连接」与「打开数据库文件」留在原地
- 🛠️ `scripts/install-macos.sh`：构建并装进 `/Applications`
- 📤 导出为 `INSERT` 语句（表数据与查询结果，含整表流式导出）
- ✨ AI 设计新表（Anthropic / OpenAI 兼容，默认关，Cargo feature `ai`）；MongoDB 上设计集合与 `$jsonSchema` 校验规则；
  Neo4j 上把图模型画出来并建唯一约束与索引
- 📚 ER 图导出数据字典（Markdown）与 Agent Skill（`SKILL.md`）
- 💾 SQLite / DuckDB / PostgreSQL / MySQL 备份（连接信息与命令面板），MongoDB 按库备份（对象树右键）

### v0.4.0（首个发布版）

版本号对应 [TODOs.md](TODOs.md)「发布里程碑」：v0.2、v0.4 的条件已满足；
v0.3 只差 Windows 安装验证，所以这一版**不提供 Windows 安装包**。

- 🔗 MySQL、PostgreSQL、SQLite、SQL Server、Oracle；MariaDB、TiDB、CockroachDB
  走对应的连接类型，每一格都有真库用例（见兼容性矩阵）
- 🍃 MongoDB：库与集合、文档的条件 / 排序 / 分页、增删改、集合的建与删、执行计划；
  认证库、TLS、客户端证书与 X.509 登录、`mongodb+srv://`、SSH 隧道
- 🔑 Redis：逻辑库、按模式翻键、六种类型的值、redis-cli 写法的命令行，
  键与元素的增删改；口令 / ACL 用户、TLS、SSH 隧道。不含集群与 Sentinel
- 🕸️ Neo4j：连接、按库列出标签与关系类型、Cypher 查询标签（结果按 Cypher 字面量显示，
  写入计数，会写的先按门槛确认）；结果里有节点与关系时画成图；在界面上改属性与标签、删节点
  与关系、建节点；`EXPLAIN` / `PROFILE` 的计划树
- 🛡️ 凭据存入系统钥匙串，TLS 模式可配置，SSH 隧道，日志脱敏
- ⚡ 查询超时、取消、结果截断与流式回传；多标签、脚本、历史
- 📊 表数据浏览与编辑、事务、结构变更、执行计划、导入导出、ER 图
- 📦 macOS（Apple Silicon）与 Linux（x86_64）安装包，均未签名

当前开发进度与阶段划分见 [TODOs.md](TODOs.md)。

## 📄 许可证

本项目采用 [MIT 许可证](LICENSE) - 查看 [LICENSE](LICENSE) 文件了解详情。

## 🙏 致谢

- [Tauri](https://tauri.app/) - 跨平台桌面应用框架
- [React](https://reactjs.org/) - 用户界面库
- [Tailwind CSS](https://tailwindcss.com/) - CSS框架
- [Lucide Icons](https://lucide.dev/) - 图标库

## 📞 联系我们

- **项目主页**: [GitHub](https://github.com/yuxuetr/DataOmni)
- **问题反馈**: [Issues](https://github.com/yuxuetr/DataOmni/issues)
- **功能建议**: [Discussions](https://github.com/yuxuetr/DataOmni/discussions)

---

<div align="center">

**DataOmni** - 让数据操作变得简单高效

⭐ 如果这个项目对您有帮助，请给我们一个星标！

</div>
