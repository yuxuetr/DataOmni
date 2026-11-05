# 编辑器里的绑定参数（D2）

2026-11-06。状态：评估，待用户确认。任务在 `TODOs.md`「1.x」的 D2。

## 1. 要回答的问题

在编辑器里写 `SELECT * FROM orders WHERE customer_id = :customer AND created_at >= :since`，
执行时弹出一张表填 `customer` 和 `since`，值经驱动**绑定**下去，不拼进 SQL。改个值再跑一遍，SQL 不用动。

路线图（`rfcs/roadmap-1.0.md` 四节第 2 条）给这一项挂了两样「随之解锁」，读代码后要修正一样：

| 路线图写的 | 现状（读代码确认过） |
| --- | --- |
| 带参数的查询与查询模板（4.4 的重估条件） | 成立。归档里 4.4 不做的理由正是「`execute_query` 不收参数，做模板只能自己内联字面量」 |
| 表结构查询离开 `tauri-plugin-sql`（2.4 剩下的那项） | **已经大半不成立**：MySQL / PostgreSQL 的目录查询早已改走后端的 `sqlx_select`（带参数，自己解码），SQL Server / Oracle / DuckDB / ClickHouse 本来就在后端。只剩 SQLite 还走插件，而插件的 SQLite 解码没有报过缺口。这一项不再挂在 D2 上 |

所以 D2 的实际价值只有面向用户的那一半：**编辑器里的参数**，以及以后的查询模板。

## 2. 三个事实（实验与读代码确认）

1. **PostgreSQL 的参数只能按二进制格式发。** sqlx 0.8 的 `Bind` 消息把参数格式写死为
   `PgValueFormat::Binary`（`sqlx-postgres-0.8.6/src/connection/executor.rs:244`）。
   文本值绑成 `TEXT`，`WHERE id = $1`（`id` 是 `int`）报 `operator does not exist: integer = text`；
   声明成 `unknown` 让服务端推断也不行，推断出 `int4` 后会拿 int4 的二进制格式去读那几个 UTF-8 字节。
   **结论：PostgreSQL 必须先 describe 拿到每个参数的类型，再按类型把文本值转成对应的 Rust 类型去绑。**
2. **MySQL 的 `LIMIT ?` 不收字符串。** 8.4.11 上 `PREPARE s FROM 'SELECT … LIMIT ?'`，
   `SET @a = '1'`，`EXECUTE s USING @a` 报 `1210 Incorrect arguments to EXECUTE`。
   同一库上 `? + 1` 与 `? = 7` 拿字符串 `'41'` / `'007'` 都正常（隐式转换）。
   **结论：「一律按文本绑」在 MySQL 上撞 `LIMIT` / `OFFSET`；需要「数字」这一种。**
   反过来，「长得像整数就按整数绑」是错的语义：`varchar` 列 `code = '007'` 会变成按数值比较，`'7'` 也匹配，还用不上索引。
3. **其余几家后端都已经有绑定的代码。** 导入（`execute_with_params`）与目录查询（`sqlx_select`、`sql_server_select`、
   `oracle_select`、`duckdb_select`）各自都在绑 `JsonValue` 标量。前端的 SQL 词法（`sqlStatements.ts`）已经认得
   单双引号、反引号、方括号、`$tag$`、Oracle `q'[…]'`、`E'…'`、嵌套块注释，找占位符不用另写一套。

## 3. 两种做法

| | A. 文本替换（DataGrip 的默认做法） | B. 真绑定（推荐） |
| --- | --- | --- |
| 用户填什么 | SQL 字面量：`'abc'`、`42`、`NULL`、`DATE '2026-01-01'` | 值本身：`abc`、`42`，另有「NULL」勾选 |
| 怎么执行 | 前端把 `:name` 换成填的文本，后端不动 | 前端把 `:name` 换成本方言的占位符，后端各方言绑定 |
| 类型 | 用户自己写在字面量里，不用定 | PostgreSQL 由 describe 定；其余默认文本，可改「数字」 |
| 改动 | 前端一处，约 100 行 | 前端同上，加后端 6 条执行路径与 PostgreSQL 的类型转换表 |
| 能撑起查询模板吗 | 能，但模板里存的是「SQL 片段」，就是 4.4 当初拒绝的那种内联 | 能，模板就是「一段 SQL + 一组参数名」 |
| 名副其实吗 | `execute_query` 仍不收参数，D2 字面上没做 | 是 |

A 的风险不是注入（SQL 和值都是用户自己写的），而是引号要用户自己写对，而且模板与以后的 Agent 调用都会继承这个习惯。
**推荐 B**，代价是后端那一块。

## 4. B 的设计

### 4.1 写法

- 只认 **`:name`**：冒号后面跟字母或下划线开头的标识符。理由：
  - `?` 和 PostgreSQL 的 jsonb 运算符 `?` / `?|` / `?&` 冲突；`$1` 是 PostgreSQL 自己的，没有名字，改一处要数位置。
  - `:name` 是 Oracle 与 SQLite 的原生写法，DBeaver、DataGrip 也认它。
- 不当成参数的（词法层面排除，各一条测试）：引号、标识符引号与注释里的；`::type` 强转；MySQL 的 `:=`；
  `:1` 这种数字开头的；后面紧跟 `.` 的（Oracle 触发器里的 `:new.col` / `:old.col`）。
- 已知的误判：PostgreSQL 数组切片写成 `arr[a:b]`（两边都是标识符）时 `:b` 会被当成参数。
  弹框里会列出 `b`，用户看得见；写成 `arr[a : b]` 或数字下标就不会。不为它加规则。

### 4.2 执行

- 运行时前端从这次要跑的语句里收集参数名。有参数就先弹框，没有就照旧，**不带参数的语句一个字节都不变**。
- 同名参数在一次运行里共用一个值（多条语句也是）。
- 前端把每一处 `:name` 换成本方言的占位符，按出现次序生成值数组：MySQL / SQLite / DuckDB 用 `?`，
  PostgreSQL 用 `$n`，SQL Server 用 `@Pn`，Oracle 用 `:n`。同名出现两次就绑两次。
- `execute_query` 的请求加 `params: Vec<JsonValue>`（缺省为空）。值只有三种：`null`、字符串、数字。
- 后端各方言：
  - **PostgreSQL**：已有的 describe 多取参数类型，按 OID 把文本转成对应类型再绑。整数、浮点、`numeric`、`bool`、
    文本类、`uuid`、`date` / `time` / `timestamp` / `timestamptz`、`json` / `jsonb`、`bytea`（十六进制）。
    转不了的，以及不在表里的类型，报错时写明「参数 :x 的类型是 inet，还不能绑定」。
    有参数时只能走扩展协议，结果按二进制解码；结果里有只能文本解码的列（现在那条 `binary = false` 的退路）时如实报错。
  - **MySQL**：走预处理协议，字符串按字符串绑、数字按数字绑。预处理协议不收的语句（`unsupported_by_prepared_protocol`）带参数时报错。
  - **SQLite / SQL Server / Oracle / DuckDB**：照目录查询那一套绑。
  - **ClickHouse 这一版不做**：它的服务端参数要求在 SQL 里写类型（`{name:UInt64}`），与 `:name` 对不上。
    带参数时报「ClickHouse 还不支持参数」。重估条件：有人要。
- 风险确认（`statementRisk`）看的是替换前的 SQL，判定不变。
- 查询历史记替换前的 SQL（带 `:name`），不记值。

### 4.3 弹框

- 每个参数一行：名字、值输入框、类型（**文本** / **数字**，默认文本）、「NULL」勾选。
  PostgreSQL 连接上不显示类型选择，由驱动定。
- 值按标签页记在内存里，下次运行预填；**不写进工作区快照**，值里可能有敏感数据。
- 回车执行，Esc 取消。

## 5. 验收

- 词法：4.1 里每种「不是参数」各一条用例。去掉其中任一条规则，对应用例该红。
- 真库：PostgreSQL、MySQL、SQLite、SQL Server 各跑一组：
  - 整数列等值比较；
  - 文本列 `'007'`（不能被当成 7）；
  - `LIMIT`（MySQL 选数字时通过，选文本时报 1210）；
  - NULL；
  - 同名参数出现两次；
  - PostgreSQL 再加 `uuid`、`timestamptz`、`jsonb`，以及一个不支持的类型报错。

  Oracle 与 DuckDB 用本地容器或本地库各跑一组基本用例。
- 真应用：在编辑器里写带参数的查询，弹框，执行，改值再跑。

## 6. 不做

- 查询模板本身（4.4）：用户说「其余先留着」。D2 之后它的前置条件就满足了，重估条件改成「有人要」。
- `?` 和 `$1` 写法。重估条件：有人从别的工具贴过来的 SQL 因此跑不了。
- 结果集里按参数筛选、参数的历史下拉。
