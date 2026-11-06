# DataOmni 作为 MCP 服务（C2）

2026-11-06。状态：用户 2026-11-06 确认，已实现，跟代码走（`src-tauri/src/cli/mcp.rs`）。任务在 `TODOs.md`「1.x」的 C2；前身是归档里的 A8，命令行（`rfcs/agent-cli.md`）是它的地基。

实现时与下文有出入的几处（§3.7）：`instructions` 不放 `guide.md`；钥匙串到点不退出；`-` 与像选项的值在 MCP 层拒掉。

## 1. 要回答的问题

不能跑 shell 的 Agent（Claude Desktop、一些 IDE 里的助手）也能用用户在 DataOmni 里配好的连接查库，
而且守的是同一道门：只读，没开放的、生产环境的连接看不见。

## 2. 已有的（读代码确认过）

- 命令行的每个命令都从一个入口进：`cli::dispatch(args, dirs) -> Result<Output, CliError>`（`src-tauri/src/cli/mod.rs`）。
  权限门全在它后面：
  - 连接要开放给 Agent，并且开放凭证要验得过（`resolve_for_agents`，§5.4）；
  - 生产连接看不见；
  - 每次只收一条语句，按白名单分类；
  - 在只读事务里执行，最后回滚；
  - 每次调用写一条留痕。
- 输出已经是给 Agent 读的 JSON（顶层 `"schema": 1`），错误带 `kind`。退出码 3 的那类错误就是「被权限门拒绝」。
- `guide.md` 是一份给 Agent 读的使用说明。

所以 MCP 这一层**不碰任何权限逻辑**。它只做三件事：把工具调用拼成 `dispatch` 的参数，调用，把结果包成 MCP 的回包。
权限门只有一份，命令行和 MCP 不会各走各的。

## 3. 设计

### 3.1 进程

- `dataomni mcp`：与 `dataomni cli` 同一个二进制、同样在 `tauri::Builder` 之前分流，不起窗口。
  同一个二进制的理由同命令行：钥匙串按代码身份放行（agent-cli §3.1 E1）。
- 走 stdio 传输：标准输入每行一条 JSON-RPC 请求，标准输出每行一条回包，日志不写标准输出。
- 一次处理一个请求，按顺序回。MCP 允许乱序回包，但并不要求并发。

### 3.2 协议：手写，不引 SDK

用到的只有五个方法：
- `initialize`：回协议版本、`serverInfo`、`capabilities.tools`，`instructions` 放 `guide.md`；
- `notifications/initialized`：忽略；
- `ping`；
- `tools/list`；
- `tools/call`。

其余方法回 `-32601`。这些方法加起来约一百多行 `serde_json`。官方 Rust SDK（`rmcp`）带进来的东西（宏、`schemars`、异步传输层）
比这一百多行大得多，而我们用不上 resources、prompts、sampling、HTTP 传输。

重估条件：要支持 HTTP 传输、进度通知或取消，或者协议版本变了、手写那部分要跟着改两次以上。

### 3.3 工具

一个工具对应一个命令行命令，入参是有类型的 JSON，拼成参数后交给 `dispatch`：

| 工具 | 对应 | 入参 |
| --- | --- | --- |
| `connections` | `connections` | — |
| `test` | `test` | `connection` |
| `query` | `query` | `connection`、`sql`、`limit?`、`timeout_seconds?` |
| `explain` | `explain` | `connection`、`sql` |
| `schema` | `schema` | `connection`、`table?` |
| `ddl` | `ddl` | `connection`、`table` |
| `dictionary` | `dictionary` | `connection` |
| `mongo` | `mongo` | `connection`、`action`（collections / find / count / aggregate / explain / structure）及其参数 |
| `redis` | `redis` | `connection`、`action`（keyspaces / scan / get / command）及其参数 |
| `neo4j` | `neo4j` | `connection`、`action`（labels / run）及其参数 |
| `es` | `es` | `connection`、`action`（indices / request）及其参数 |

各家的子命令收在一个工具里，不拆成二十几个：工具列表会进 Agent 的上下文，多一个工具就多一段描述。

**这一版不给的**：`export`、`backup`、`csv-preview`。它们对库只读，但会在用户磁盘上写新文件，或读任意本机文件。
不能跑 shell 的 Agent 原本碰不到用户的文件系统，经 MCP 拿到这个能力等于多开了一扇门。
重估条件：有人要经 MCP 导出。到时再定写到哪个目录。

### 3.4 回包

- 成功：`content` 里放一段文本，内容是命令行 stdout 的那份 JSON（`dictionary` 是 Markdown）。
- 失败：`isError: true`，文本是命令行 stderr 的那份 `{"schema":1,"error":{"kind":…,"message":…}}`，Agent 照样能按 `kind` 区分。
  入参缺了或类型不对也是 `isError`，`kind` 为 `usage`，不当成 JSON-RPC 协议错误：MCP 的规定是工具自己的错误放进结果里，
  好让模型看到并改正。

### 3.5 每次调用都重新过门

不在进程里缓存「哪些连接开放」或口令：用户在界面里关掉一个连接的 Agent 访问，下一次调用就看不见它。
这也是 `dispatch` 本来的做法：每次读 `connections.json`、取口令、验开放凭证。

**这一版不复用连接**：命令行设计里写过「常驻（E6：经隧道每次几秒）放到 MCP 一起做」，
但复用连接就要回答「用户在界面里改了开放设置，留着的连接何时作废」。先按每次新开做，量过再说。
重估条件：经隧道的连接上，一次 `query` 的总耗时里建连超过一半，并且有人嫌慢。

### 3.6 怎么接

文档里给 Claude Desktop / Claude Code 的配置示例，例如
`claude mcp add dataomni -- /Applications/DataOmni.app/Contents/MacOS/dataomni mcp`。
Windows、Linux 给各自安装位置的路径。

### 3.7 实现时补的

- **`instructions` 是单独写的一段**（`mcp.rs` 的 `INSTRUCTIONS`），不是 `guide.md`：那份写的是 `dataomni cli …` 的调用方式，
  还教 Agent 用 `export`、`backup` 和从标准输入读，在 MCP 里都不成立。
- **`-` 一律不收**：命令行里 `-` 表示「从标准输入读」（语句、条件、管道、请求体），而 MCP 的标准输入是协议本身，
  读了就把后面的请求吃掉。报 `usage`。
- **恰好像选项的位置参数拒掉**：命令行的解析器把恰好等于 `--limit` 这类名字的参数当成选项。位置参数是不带空白、
  以 `--` 开头的值时报 `usage`（SQL 注释 `-- …` 带空格，不受影响）。选项的值紧跟选项名，解析器原样收，不受影响；
  Redis `command` 之后的参数原样交给服务器，也不查。
- **钥匙串到点不退出**：命令行等 10 秒没回来就退出（免得 Agent 一直等）；常驻的服务退出了，客户端只看到「服务没了」。
  MCP 下只在 stderr 提一句、接着等，用户点了「始终允许」这次调用接着跑。
- **协议版本**：认 2025-11-25、2025-06-18、2025-03-26、2024-11-05，客户端要的在其中就照回，否则回最新的。
  `tools/list` 给每个工具标 `readOnlyHint: true`。不认得的工具名回 `-32602`（协议错误），其余入参问题都是 `isError`。
- **入参多给了也报错**：给了这个工具或这个操作不用的键（例如 `count` 带 `sort`、`collections` 带 `namespace`）报 `usage`，
  同命令行「给了不认的选项就报错」。

## 4. 验收门

先写出来、确认是红的，再实现。用例在 Rust 里直接喂 JSON-RPC 请求给处理函数，配置目录用临时目录：

1. **写语句被拒**：开放为「只读」的 SQLite 测试库，`tools/call query` 发 `DELETE`、`DROP TABLE`、`ATTACH`，
   以及 `SELECT 1; DELETE …`。回包都是 `isError: true`、`kind` 为拒绝那一类；表里的行数不变。
2. **生产连接不可见**：`environment = production`、「Agent 访问」被手工改成「只读」的配置，
   `tools/call connections` 的结果里没有它，`tools/call query` 它报「找不到连接」，不报「被拒」。
3. `tools/list` 里每个工具都有 `inputSchema`；没有 `export`、`backup`、`csv-preview`。
4. 协议：`initialize` 回的版本、未知方法 `-32601`、通知不回包、坏 JSON 回 `-32700`。
5. 跑完全部用例，`connections.json` 逐字节不变。

反向验证：
- 第 1、2 条：让 MCP 层把命令行的错误当成功包回去，两条该红。
- 第 3 条：把 `export` 加进工具表，该红。

真机：在 Claude Code 里用 `claude mcp add` 接上打包版（或开发构建），让它列连接、查一张表、试一条 `DELETE` 被拒。

## 5. 不做

- 写（命令行的第三批也没做）。
- resources、prompts、HTTP 传输、进度与取消。
- 在应用界面里加「复制 MCP 配置」按钮。重估条件：有人要。
