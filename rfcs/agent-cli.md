# 命令行接口（给 Agent 与终端用）设计说明

> 这份文档**跟着代码走**，写法同 `rfcs/ssh-tunnel.md`：验收标准写成可执行的门。
>
> 立项日期：2026-10-10。当前状态：**设计，未实现**。§3 的 E1、E3、E4、E5 已做（2026-10-10），
> E2、E6 要有子命令才能测，放在第一批实现时做。用户定了排在 1.0 之前。
>
> 它取代 `TODOs.md` 里的 A8（DataOmni 作为 MCP 服务）作为第一步：A8 要回答的问题
> （开放哪些连接、怎么保证只读、生产库怎么挡）CLI 一样要回答，回答完了 MCP 只是外面一层协议。

## 1. 为什么做

- **用户要。** 2026-10-10 用户提出「提供一个 CLI，方便之后给 AI 智能体访问」，参照 Android CLI。
  这满足了 A8 写下的重估条件（「让 Agent 直接查自己配好的库」是日常工作流）。
- **CLI 比 MCP 先做的理由**：Claude Code、Codex 之类的 Agent 本来就会跑 shell 命令，一个输出 JSON、
  退出码有意义的 CLI 不需要安装 MCP、不占 Agent 上下文里的工具说明，人在终端里也能用。
- **和现成工具比的增量**：psql、mysql、mongosh、redis-cli 早就有了。我们多的是
  「一处配置管 14 种库」，SSH 隧道、TLS、钥匙串里的口令都现成，**加上一道应用自己的权限门**——
  Agent 拿不到口令，也看不到没开放的连接。

## 2. 已经确认的事实（读代码）

| 事实 | 出处 | 影响 |
| --- | --- | --- |
| 后端 33 个 service 里只有 `connection_service` 依赖 `AppHandle`，而且只用来取配置目录 | `ConnectionService::new`；`from_path` 已经是不依赖 Tauri 的入口 | CLI 能直接复用连接、隧道、查询、导出、备份的代码，缝只有一处 |
| 连接串在 Rust 里拼（含隧道端口） | `models/mod.rs` 的 `to_connection_string`、`connection_string_via` | CLI 不需要移植前端代码就能连上全部 14 种库 |
| 连接有 `environment` 字段，`Production` 是其中一档 | `ConnectionEnvironment` | 「生产连接不可见」有现成的依据 |
| `connections.json` 会把不认得的字段原样写回 | `unknown_fields`、`newer_entries` | 新增「Agent 访问」字段后，退回旧版再升回来不会丢 |
| **判断语句是否写操作的逻辑只在前端** | `src/utils/statementRisk.ts`（277 行），Rust 端没有 | CLI 的只读门要在后端重做，见 §5 |
| 表结构查询的 SQL 在后端生成，**解析结果的代码在前端** | `schema_metadata.rs` 出 SQL，`src/utils/tableMetadata.ts`（100 行）解析 | 要移植到 Rust，量小 |
| DDL 生成、数据字典、改行语句、SQL 格式化都只在前端 | `tableDdl.ts`（787）、`schemaDraft.ts`（508）、`dataDictionary.ts`（112）、`rowStatements.ts`（490）、`formatSql.ts`（289） | 移植成本差别很大，按 §6 分批 |
| 查询历史、工作区、设置都存在 WebView 的 localStorage 里 | `queryHistoryStorage.ts`、`workspacePersistence.ts` | CLI 读不到，也不打算读 |
| Neo4j 已有「先 EXPLAIN 问查询类型」 | `neo4j_query_type` | Neo4j 的只读判断由服务器回答 |
| Windows 发布版的主程序是 GUI 子系统 | `main.rs` 的 `windows_subsystem = "windows"` | Windows 上主程序打印不到终端，见 §4 |

## 3. 动手前要做的实验

每条都要先有结果再写对应的代码；结果填回这一节。

| 编号 | 问题 | 怎么验 | 结果决定什么 |
| --- | --- | --- | --- |
| E1 | macOS 上，**同一个二进制**带子命令运行时读钥匙串会不会弹授权框？另编的 `dataomni-cli` 会不会弹？ | 在 `main` 里临时加一个读条目的分支，打包、`open -a` 跑一次 GUI 存口令，再从终端跑子命令；同样的事换一个独立二进制做一遍 | §4 的进程形态 |
| E2 | 从终端直接跑应用二进制的子命令，会不会撞上 `LD_LIBRARY_PATH` 那次 SIGBUS？ | 带着这个变量跑 3 次 | 要不要在入口清掉这个变量再继续 |
| E3 | MySQL、Oracle 的只读事务里发 DDL，是被拒，还是先隐式提交再执行？ | 本地 Docker 起库，`START TRANSACTION READ ONLY; DROP TABLE om_x;` | 这两家能不能只靠数据库挡，还是必须加文本分类 |
| E4 | SQLite / DuckDB 以只读方式打开后，`ATTACH` 一个新文件能不能写？ | 临时目录里试 | 只读打开是不是绝对的 |
| E5 | PostgreSQL 只读事务挡不住哪些有副作用的函数（`pg_terminate_backend`、`dblink` 之类）？ | 本地库里列出来试 | 写进 §5 的「数据库挡不住的」那一栏 |
| E6 | 每次调用都新建连接（含 SSH 隧道）要多久？ | 对 cu 上的 MySQL 经隧道连 10 次取中位数 | 要不要常驻进程。没超过 1 秒就不做 |


### 3.1 结果（2026-10-10）

**E1 钥匙串**：用和应用相同的 `keyring 4.2.0`（macOS 上是旧式钥匙串，条目带访问控制表）写了个探针，
只用一个专门的测试条目 `DataOmni-cli-probe-E1`，测完已删。

| 情形 | 结果 |
| --- | --- |
| 同一个程序写入后，从终端反复读 | 不弹框 |
| 另一个程序读同一条目 | 弹框，进程卡在读口令那一步直到有人回答 |
| 同一路径的程序重新构建（cdhash 变了）后再读 | 弹框 |
| 弹框里点过「允许」的那个构建再读 | 不弹框 |

结论：访问控制认的是**代码身份**（ad-hoc 签名下就是 cdhash），不认路径，也不管是怎么启动的。
所以 CLI 做成**主程序的子命令**，与界面共用身份。应用升级后界面本来就要弹一次框（GUI 测试时已经见过），
用户点「始终允许」之后 CLI 跟着能用；另编一个程序就是每次升级弹两次，而且第二次会在 Agent 调用时冒出来。
**E1b**（2026-10-10，打包的 hardened 版，`open -a` 起界面）：在界面里给一个 PostgreSQL 连接存口令、设成只读，
从终端用同一个包里的 `dataomni cli query` 连读 3 次，**不弹框**，3 次都读到了数据（没有 SecurityAgent 进程）。
界面里改成生产环境后，存下来的命令行访问是「关」、开放凭证从钥匙串删掉了，`connections` 里没有它，`query` 报 `not_found`。
顺带发现并修了一个表单缺陷：先选「命令行与 Agent 访问」再点类型，这一项被类型的默认值盖回「关」。

**E3 MySQL、Oracle 的只读事务挡不住 DDL**（本地 Docker：`mysql:8.4`、`gvenzl/oracle-free:23-slim`）：

- MySQL：`START TRANSACTION READ ONLY` 之后 `INSERT` 被拒（1792），但 `CREATE TABLE`、`DROP TABLE` 都执行了，
  事后 `ROLLBACK` 也撤不回来（DDL 隐式提交）。`get_lock()` 照样能拿锁。
- Oracle：`SET TRANSACTION READ ONLY` 之后 `INSERT` 被拒（ORA-01456），`CREATE TABLE`、`DROP TABLE` 照样执行。
- 所以这两家**必须**加语句分类，而且是白名单（只放行读语句），不是黑名单。

**E4 SQLite、DuckDB 的只读打开**：

- SQLite（3.54，`-readonly` / `mode=ro`）：原库改不动，再 `ATTACH` 一次原库也还是只读；但
  `ATTACH '新文件'` 之后能在新文件里建表写数据，`VACUUM INTO '文件'` 能复制出整个库——**能在磁盘上任意写文件**。
  要靠语句分类拒绝 `ATTACH` 和 `VACUUM`，或者把连接的 `SQLITE_LIMIT_ATTACHED` 设成 0（实现时看哪个能做成门）。
- DuckDB（CLI 1.5.6；应用用的 crate 是 1.10505，即 1.5.5，实现时要用它复测）：只读打开挡住改库，
  `ATTACH` 新文件也被拒；但 `COPY … TO '文件'` 能写文件，`read_text('任意路径')` 能**读本机任意文件**。
  加上 `SET enable_external_access = false; SET lock_configuration = true;` 后三者都被拒，且这两项之后改不回来。

**E5 PostgreSQL 的只读事务**（`postgres:16-alpine`，超级用户连的，所以是最坏情况）：

- 挡住：建表、删表、`INSERT`、`nextval()`、临时表；`DO` 块里 `SET TRANSACTION READ WRITE` 也被拒（「必须在任何查询之前」）。
- 挡不住，但结尾的 `ROLLBACK` 会撤掉：事务里**第一条**就是 `SET TRANSACTION READ WRITE`，之后的写能执行。
  CLI 每次只发一条语句并且永远 `ROLLBACK`，所以这条路写不进去。
- 挡不住，`ROLLBACK` 也撤不掉：`pg_terminate_backend` / `pg_cancel_backend`、`COPY … TO '服务器文件'`、
  `pg_read_file`、`set_config`（只影响本会话）、会话级的 `pg_advisory_lock`、`LOCK TABLE`（事务结束就放）。
  前三类要超级用户或 `pg_signal_backend`、`pg_write_server_files` 之类的角色——**只读账号**能防住。

**ClickHouse 的 `readonly=1`**（`clickhouse-server` 26.9，用客户端设这个设置，等同于 HTTP 参数）：
DDL、DML、`url()` / `file()` / `s3()` 表函数、`INSERT INTO FUNCTION`、`SET`、`SETTINGS readonly=0`、`SYSTEM` 全被拒，
只有 `KILL QUERY` 能执行。这是几家里最严的。

**E2**（2026-10-10，debug 构建）：带着 `LD_LIBRARY_PATH=/opt/homebrew/lib` 从终端跑 `dataomni cli connections` 3 次，
3 次都正常退出。子命令不起窗口，碰不到 ImageIO。打包版上再验一次。

**E6**（2026-10-10，经 SSH 隧道连 cu 上只监听 127.0.0.1 的 MySQL，`cli::session::tests::e6_*`）：
每次调用（建隧道、开连接、只读执行 `SELECT 1`、回滚、关掉）中位数 **4.2～4.4 秒**，超过了原定的 1 秒。
拆开看几乎全是网络往返：这台机器到 cu 经本机代理，一个往返 170～250 ms（ping 只有 0.3 ms，是代理在本地回的，不能信）。

| 阶段 | 耗时 | 约合往返 |
| --- | --- | --- |
| SSH 握手与公钥认证 | 1.6～1.7 s | 8～9 |
| 开连接（通道、MySQL 握手与认证、sqlx 与我们各一句 `SET`） | 1.3～1.7 s | 7～9 |
| 取连接（sqlx 取连接前 ping） | 0.18～0.27 s | 1 |
| `START TRANSACTION READ ONLY` | 0.18 s | 1 |
| 查询（预处理、执行） | 0.54～0.65 s | 3 |
| `ROLLBACK` | 0.18 s | 1 |

便宜能省的只有取连接前的 ping 与末尾的 `ROLLBACK`，约 10%，前者要改界面共用的 `sqlx_pool::open`，后者要拿掉一道保险，
没做。查询那 3 个往返要换文本协议、另写一套解码，也没做。真正的杠杆是复用：常驻进程把每次降到 5 个往返左右。
**用户定了 1.0 之前不做常驻**，判据从「1 秒」改成按往返算（毫秒跟网络走：同地域的跳板机一个往返 20～50 ms，
同样的调用是 0.4～1.2 秒）。门是每次调用不超过 32 个「已连上之后的查询」，实测 22～26，几次运行之间差 15%，
门调到 15 会红。常驻放到 MCP（A8）一起做：那里本来就是一个长驻的进程。

## 4. 进程形态

**倾向：主程序带一个子命令**，`dataomni cli <命令>`，在 `tauri::Builder` 之前分流，不起窗口。

- **为什么不另编一个程序**：E1 证实钥匙串认代码身份，另一个程序读应用存的条目会弹框（§3.1）。
- **读口令要有时限**：弹框时读口令的调用会一直卡住。CLI 把这一步放到单独的线程里，等 10 秒没结果就退出，
  退出码 4，提示「钥匙串在等你授权：请在弹框里点『始终允许』后重试」。框留给人点，Agent 不会卡死。
- 退路（没用上，留着备查）：CLI 不碰钥匙串，改成连接正在运行的应用，凭据留在应用进程里；代价是应用不开着就用不了。
- **Linux、Windows 没有这个问题**：Secret Service 与 Windows 凭据管理器不按程序区分访问权限。
  Windows 因为 GUI 子系统打印不到终端，到时要么启动时 `AttachConsole(ATTACH_PARENT_PROCESS)`，
  要么另出一个控制台程序 `dataomni-cli.exe`。Windows 按用户的安排后放。
- **每次调用一个进程**：读 `connections.json`（只读，CLI 从不写它）、取口令、开连接或隧道、执行、关掉。
  E6：经隧道到远处的跳板机每次要几秒（§3.1），用户定了 1.0 之前不做常驻，放到 MCP（A8）一起做。
- **找得到它**：macOS 上是 `/Applications/DataOmni.app/Contents/MacOS/dataomni`。
  `scripts/install-macos.sh` 顺手建一个 `~/.local/bin/dataomni` 的软链；应用内不加「安装命令行工具」按钮，
  有人要再加。
- **只在会话里输的口令拿不到**：GUI 里选「不保存口令」的连接，CLI 报「这个连接需要口令」，
  不提供 `--password`（会进 shell 历史和 Agent 的上下文）。

## 5. 权限模型

### 5.1 谁决定开放

- 每个连接新增一个字段「Agent 访问」：**关（默认）/ 只读 / 读写**，只能在 GUI 的连接设置里改。
  CLI **没有任何参数能放宽权限**——加个 `--allow-write` 等于没有门，Agent 会照着报错信息加上它。
- `environment = production` 的连接这一项固定为「关」，界面上置灰，CLI 里**看不到**（不是「拒绝」，是不出现）。
- 「读写」第一版不开放，见 §6 第三批。

### 5.2 只读怎么保证

两层，**以数据库自己拒绝为主，文本分类为辅**，并且如实告诉用户哪一层都不是绝对的：

每次调用**只发一条语句**（扩展协议 / 预处理语句，多条语句直接拒绝），并且**永远以 `ROLLBACK` 结束**，不提交。

| 库 | 数据库层 | 语句分类（白名单，只放行读） | 依据 |
| --- | --- | --- | --- |
| PostgreSQL 系（含 CockroachDB、openGauss） | `BEGIN READ ONLY` … `ROLLBACK` | 有，作为第二层 | E5：DDL、DML 都被数据库拒 |
| MySQL 系（含 MariaDB、TiDB、OceanBase） | `START TRANSACTION READ ONLY` … `ROLLBACK`，挡 DML | **必须**：DDL 不受只读事务约束 | E3 |
| Oracle | `SET TRANSACTION READ ONLY` … `ROLLBACK`，挡 DML | **必须**，同上 | E3 |
| SQLite | 只读打开 | **必须**拒绝 `ATTACH`、`VACUUM` | E4 |
| DuckDB | 只读打开，加 `enable_external_access = false` 与 `lock_configuration = true` | 有，作为第二层 | E4 |
| ClickHouse | 每条查询带 `readonly=1` | 有，作为第二层 | §3.1 |
| SQL Server | **没有会话级只读** | 只有这一层，第一版不开放 | — |
| MongoDB | 只暴露读的接口：`find`、`count`、`aggregate`（拒绝含 `$out` / `$merge` 的管道）、`explain` | 不暴露 `runCommand` | — |
| Redis | — | 用服务器的 `COMMAND INFO` 查命令旗标，只放行带 `readonly` 的 | — |
| Neo4j | 读模式的会话 | 先问 `neo4j_query_type`，只放行 `r` | — |
| Elasticsearch | — | 按方法加路径的白名单：`GET`，以及 `POST` 到 `_search`、`_count`、`_msearch` 等（不含 `_mapping`：`POST` 到它是改映射，见 §6） | — |

语句分类要在 Rust 里重写，可以照着 `statementRisk.ts` 的词法处理（引号、注释、美元引号），
但判据换成白名单：去掉注释后的第一个关键字是 `SELECT`、`WITH`（且没有嵌套的写）、`SHOW`、`DESCRIBE`、`EXPLAIN`（不带 `ANALYZE`）、`VALUES`、`TABLE`，
其余一律拒绝。前后两份分类要有一份共用语料钉住，仿 `fixtures/export-conformance.json`。

**数据库层挡不住的**（§3.1）：PostgreSQL 的 `pg_terminate_backend`、`COPY … TO` 服务器文件、`pg_read_file`；
MySQL 的 `get_lock()`；ClickHouse 的 `KILL QUERY`。
所以文档和 `--help` 都要写明：**真正的边界是给 Agent 配一个只读数据库账号**，应用的门是第二道。

### 5.4 配置文件能被改（2026-10-10 补）

§5.1 说「只能在 GUI 里改」，但这条**挡不住和用户同一身份运行的 Agent**：它能直接编辑
`connections.json`，把一个生产连接改成「开发环境 + 只读」。而命令行是应用自己的二进制，
读这个连接在钥匙串里的口令不弹框（§3.1 E1）——于是 Agent 拿到了生产库的只读查询权，
而它自己去读钥匙串（`security find-generic-password`）是要弹框的。命令行成了一个**替人开门的代理**。
这是读代码推出来的（`open_to_agents` 只看文件里的两个字段，`resolve_for_connection` 按 id 取口令），
没有拿真实连接演示。

修法（已实现，`ConnectionService::resolve_for_agents`）：**开放凭证绑在连接自己的口令上**。界面保存「只读」时，用这个连接的口令对它的指纹
（id、类型、主机、端口、库、用户名、环境、隧道的主机端口与用户）算 HMAC-SHA256，存进钥匙串
（`<id>#agent`）；命令行读出口令后重算比对，对不上就当作没开放。

- Agent 不知道口令，算不出凭证；改了文件里的环境或主机，指纹变了，旧凭证作废。
- 钥匙串里的条目能被 `security` 删掉、换成任何程序都能读的新条目（实验 E1 收尾时删测试条目没弹框）——
  所以凭证本身不保密也没关系，保密的是算它用的口令。
- **挡不住的**：没有口令的连接（SQLite、DuckDB 文件，免密的库，只用无口令私钥的隧道）。这些 Agent
  不经过命令行也能直接用——文件它读得到，免密的库它连得上——命令行没有替它多开一扇门。
- 以后有了 Developer ID，可以换成按团队标识隔离的钥匙串，到时再看这一节。
- **还挡不住代码注入**（E7，2026-10-10 实测）：现在的包是 ad-hoc 签名、没开 hardened runtime，
  `DYLD_INSERT_LIBRARIES` 能把任意动态库注进应用的进程（界面和命令行都是），注进去的代码就用应用的身份
  读钥匙串。这个洞在命令行出现之前就有。用 E1 的探针验过：同一个程序 ad-hoc 签名时注入成功，
  加上 `--options runtime` 重签之后注入被系统忽略。所以凭证把门槛从「改一个字段」抬到了「写一个动态库并注入」，
  挡得住手滑和被诱导着改配置，挡不住存心的程序。
  - 要堵上就要开 hardened runtime。代价是库校验：Instant Client 不是我们签的，要加
    `com.apple.security.cs.disable-library-validation`。加了之后，`DATAOMNI_ORACLE_CLIENT_DIR` 就是一条新的注入路，
    所以命令行已经不认它，只认安装包里那一份（`oracle::pin_client_dir`）。
  - 这是打包上的改动，要在打包版上验：应用起得来、Oracle 能连、钥匙串照常、`DYLD_INSERT_LIBRARIES` 进不去。


### 5.3 留痕

每次调用写一行进现有的日志文件（`tauri-plugin-log` 那份；CLI 进程里用同一个目录）：
时间、连接名、命令、语句的第一个关键字、长度与 SHA-256、结果（成功 / 被拒 / 出错）、行数、耗时。
**不记完整语句**：字面量里可能有个人数据，而现有的日志门本来就不许记敏感字段。
要排查时，Agent 那一侧有完整的语句。

## 6. 功能盘点

把应用现有的功能逐项过一遍，按「后端是否已经能独立做完」和「风险」分成四批。

### 第一批：只读的核心，后端已经现成

| 命令 | 复用 | 新写的 |
| --- | --- | --- |
| `connections` | `ConnectionService::from_path` | 按 §5.1 过滤；不输出口令、私钥路径 |
| `test <连接>` | `session::open`（与 `query` 同一种只读打开）、`connection_probe::diagnose` | 连不上时把诊断（解析、TCP）放进错误的 `diagnosis`，没有单独的 `diagnose`；文件库与经隧道的连接不附诊断（前者报错里已有路径与原因，后者探到的是隧道后面的地址）。建立连接另有 10 秒上限，与语句超时分开：库没起来时 sqlx 对「连接被拒」退避重试到 30 秒，等满了会被报成语句超时 |
| `query <连接> <SQL>` | `query_executor::execute_query_with_limits` | §5.2 的只读包装；默认最多 200 行、30 秒，`--limit` 上限 10000；输出里带 `truncated` |
| `explain <连接> <SQL>` | `explain::explain_statement`、`parse_plan` | 不带 `ANALYZE`（它会真的执行语句）；语句先过语句门再包进 EXPLAIN，同样在只读事务里、以回滚结束。例外是 Oracle：`EXPLAIN PLAN` 要写会话的 `PLAN_TABLE`，只读事务里报 ORA-01456（23ai 实测），所以不开只读事务——它只编译不执行，计划行读完即回滚 |
| `schema <连接> [--table T]` | `schema_metadata`、`object_catalog` 生成的 SQL | 把 `tableMetadata.ts` 的解析移植到 Rust：表、列、索引、外键 |
| `version` | `diagnostics` | 无 |

第一批只覆盖 §5.2 里数据库层能挡住写的那几类关系库（具体哪几类等 E3、E4 的结果）。

### 第二批：其余的只读能力

| 命令 | 复用 | 新写的 / 说明 |
| --- | --- | --- |
| `export <连接> <SQL> --out 文件 [--format csv\|json]` | `export_writer::export_in`（和界面共用 `export-conformance.json`） | 已实现：先过语句门，在只读事务里导出、以回滚结束（PG 上 `nextval()` 过得了语句门、过不了这一层，拿它验的）。只写**新**文件，已有的不覆盖。`sql` 格式没做：要知道哪些是计算列、自增列与序列，界面另查表的元数据——有人要再加。默认 300 秒 |
| `backup <连接> --out 路径 [--database D]` | `backup.rs`（SQLite / DuckDB 内置，其余调 `pg_dump` / `mysqldump` / `mongodump`） | 已实现：对库只读。SQLite 在只读打开的库上 `VACUUM INTO`（实测可行，源文件逐字节不变）；DuckDB 的 `EXPORT DATABASE` 要写 Parquet，被命令行的「关外部访问」挡住（实测），所以另开一条只读、不关外部访问的连接，只跑这一句，Agent 的语句不经过它。只写新路径。不设时限：外部工具跑在阻塞线程里，到点也停不下它 |
| `dictionary <连接>` | `er_diagram_queries`（ER 图那两段整库查询，不是逐表调 `schema`） | 已实现（`cli/dictionary.rs`）：移植 `dataDictionary.ts`，输出 Markdown（不包 JSON：整份就是给 Agent 读的文档）。与界面导出的英文版逐字相同，由 `fixtures/dictionary-conformance.json` 钉住。**这对 Agent 最有用**：一次拿到整库说明 |
| `ddl <连接> <表>` | `schema_metadata` 的 `ddl` 查询（界面结构页「对象定义」那一条） | 已实现：给**数据库自己的**定义原文（`SHOW CREATE TABLE`、`sqlite_master` 连索引与触发器、`DBMS_METADATA`、DuckDB 与 ClickHouse 的目录），不移植 `tableDdl.ts`——从目录重建的看着权威、照着建却不等价，界面也是这么取舍的。PostgreSQL 只有视图有原文，表报「找不到」并指向 `schema`。MySQL 的表名作为引用过的标识符拼进 `SHOW CREATE TABLE`（它不收占位符） |
| MongoDB：`mongo <连接> collections / find / count / aggregate / explain / structure` | `services/mongodb.rs` | 已实现（`cli/mongo.rs`）：§5.2 的接口白名单，管道里有 `$out` / `$merge` 解析时就拒（退出码 3，不读钥匙串）。条件与管道用 mongosh 写法（同界面），文档按 relaxed Extended JSON 输出；默认 200 个、上限 10000、合计 16 MB，同 `query`。`explain` 带 `executionStats`，即真的跑一遍查询但不取回文档——读语句跑一遍不改数据，与 SQL 的 `explain` 不带 ANALYZE 的理由（会执行写）不冲突 |
| Redis：`redis <连接> keyspaces / scan / get / command` | `services/redis.rs` | 已实现（`cli/redis.rs`）：`command` 先问服务器 `COMMAND INFO`，有子命令的按 `名字\|子命令` 查（Redis 7 起各有旗标），只放行带 `readonly` 的；名单不写在应用里，服务器的版本与模块决定有哪些命令。会阻塞的、改连接状态的照界面的规矩另拒。`INFO`、`PING` 这类不带 `readonly` 旗标，也被拒——宁可严 |
| Neo4j：`neo4j <连接> labels / run` | `services/neo4j.rs` | 已实现（`cli/neo4j.rs`）：`run` 先 `EXPLAIN` 问查询类型，只放行 `r`；再在读模式的事务里跑（驱动的 `RoutingControl::Read`，协议里是 `mode: r`），服务端拒绝其中的写（`Neo.ClientError.Statement.AccessMode`，2026.09 与 5.26 实测）。两层各自单独验过。挡不住的：`TERMINATE TRANSACTIONS` 这类管理命令不是对图的写，同 §5.2 末尾——真正的边界是只读账号 |
| Elasticsearch：`es <连接> indices / request` | `services/elasticsearch.rs` | 已实现（`cli/elasticsearch.rs`）：方法加路径白名单，按段比对。`GET` / `HEAD` 放行，但 `_refresh`、`_flush`、`_forcemerge`、`_cache` 除外（不改文档，但让集群干活）；`POST` 只放行查询类端点，路径从第一个 `_` 段起要整段等于名单里的一项；`PUT` / `DELETE` 一律拒。**更正 §5.2**：那里列了 `POST … _mapping`，而 `POST /索引/_mapping` 是改映射，不放行，读映射用 `GET`。按段比对而不是按子串的理由，ES 8.19 实测：`POST /索引/_doc/_search` 建了索引，还写进一个 id 为 `_search` 的文档 |
| `csv-preview <文件>` | `csv_import::preview_csv` | 已实现：只读本机文件，嗅探分隔符与编码（UTF-8，否则 gb18030），列出字段数对不上的行。不碰连接，不留痕 |

### 第三批：写，只给「读写」档的非生产连接

只在前两批用过一阵、确实有人要 Agent 改数据时再做。

| 命令 | 复用 | 说明 |
| --- | --- | --- |
| `exec <连接> <SQL>` | `execute_write_batch`（一次一个事务） | 需要先把 `statementRisk.ts` 移植成 Rust，并沿用界面的分级：`DROP` / `TRUNCATE` / 不带 `WHERE` 的 `DELETE` / `FLUSHDB` 之类**CLI 永远不做**，只在 GUI 里经确认做 |
| `import <连接> <CSV> --table T` | `csv_import` | 列映射用参数给出 |
| MongoDB / Redis / Neo4j / ES 的写 | 各自 service | 与 `exec` 同样的分级 |

### 不做成 CLI 的

| 功能 | 理由 | 重估条件 |
| --- | --- | --- |
| 新建、修改、删除连接；连接导入导出 | 让 Agent 能改「哪些连接开放」就绕过了 §5.1 的门 | 不重估。用户自己在终端里要批量导入时，另议一个不经 Agent 的入口 |
| AI 设计新表、AI 补全 | 调用 CLI 的就是 AI，再套一层模型没有意义 | — |
| SQL 格式化 | Agent 自己会格式化；移植 289 行没有收益 | 有人要在脚本里格式化 |
| 改单元格生成的语句（`rowStatements.ts`） | 那是网格交互的产物；Agent 直接写 SQL | — |
| ER 图、图表、PDF、SVG | 是画出来给人看的 | 有人要在流水线里出图 |
| 查询历史、工作区、设置 | 在 WebView 的 localStorage 里，CLI 读不到；也不该让 Agent 读用户的历史 | — |
| 结构比对与同步脚本 | 应用里还没有，先在 GUI 里做（路线图第四节） | GUI 里做完后再看 |

## 7. 输出约定

- 默认输出 JSON，顶层带 `"schema": 1`，改格式时升这个数。`--format table` 给人看。
- 结果写 stdout，错误写 stderr，也是 JSON：`{"error": {"kind": "...", "message": "..."}}`。
- 退出码：`0` 成功，`1` 数据库报错，`2` 参数错，`3` 被权限门拒绝，`4` 连不上或缺凭据。
  Agent 靠 `3` 区分「换个写法」和「这条路不通」。
- 被拒时的信息要说清楚改哪里：「这个连接没有开放给 Agent，请在 DataOmni 的连接设置里打开」，
  **不提示任何能绕过的参数**。
- `dataomni cli guide` 打印一份给 Agent 读的使用说明（命令、输出格式、权限的意思），
  可以直接存成 Claude Code 的 Skill。

## 8. 验收门

先写出来、确认它们是红的，再实现。

1. **写语句被拒**：对开放为「只读」的 SQLite 测试库发 `DELETE`、`DROP TABLE`、`INSERT … SELECT`、
   `WITH x AS (DELETE …) SELECT`、`ATTACH '新文件'`、`VACUUM INTO '文件'`，退出码都是 3，表里的行数不变，
   目录里没有多出文件。DuckDB 另加 `COPY … TO`、`read_text()`。MySQL、Oracle 的真库用例里要有 `CREATE TABLE`、`DROP TABLE`（E3 证明只靠数据库挡不住）。
2. **多条语句被拒**：`SELECT 1; DELETE FROM t` 退出码 3。
3. **生产连接不可见**：`environment = production` 且「Agent 访问」被手工改成「只读」的配置，
   `connections` 里没有它，`query` 它报「找不到连接」而不是「被拒」。
4. **没开放的连接不可见**：同上，「Agent 访问」为「关」。
5. **行数上限**：1000 行的表，默认只回 200 行，`truncated` 为真。
6. **不泄露凭据**：`connections` 与任何报错的输出里，扫不到测试用的口令字符串。
7. **CLI 不写配置**：跑完全部用例，`connections.json` 的内容逐字节不变。
8. **改文件开不了门**：手改 `connections.json`，把一个存了口令的生产连接改成开发环境并开放，`query` 报「找不到」。
9. 各家真库的只读门放在已有的 `*_smoke.rs` 里，规矩照旧：环境变量只在 shell 里传。

每条都要反向验证：拿掉对应的那段实现，确认它变红。

## 9. 顺序

1. ~~§3 的实验~~（E1、E3、E4、E5 已做；E2、E6 随第一批）。
2. 拆出 `ConnectionService` 不依赖 `AppHandle` 的构造入口；加「Agent 访问」字段与连接设置里的选项（界面改动要在打包版里看）。
3. 第一批，连同 §8 的门。
4. 第二批，先做 `dictionary` 和 MongoDB / Redis 的读。
5. 有人用了一阵、提出要写，再做第三批。
6. 有 Agent 不能跑 shell 的场景，再在外面套 MCP（A8）。

和 1.0 的关系：路线图里 1.0 冻结功能；用户 2026-10-10 定为**排在 1.0 之前**。
