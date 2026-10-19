# Windows 验证清单

`bun tauri build` 能出 MSI 与 NSIS 之后，还没在 Windows 上验过的事。构建步骤见 `windows-build.md`。
每项后面写了**期望**；不符合时记下：哪一项、Windows 版本（`winver`）、安装包种类（MSI / NSIS）、
界面上的原话（截图最好），回来对着修。

macOS 与 Linux 上验过的功能逻辑不必在这里逐项重来，这份只列**跟平台有关**的部分。

## 0. 准备

- 一台干净的 Windows 11（虚拟机最好，能回到快照）；有条件再来一台 Windows 10。
- 安装包不必在 Windows 上自己打：GitHub 的 Actions → Release → Run workflow，跑完在那次运行的 Artifacts 里下载
  `DataOmni-windows-x64`（MSI 与 NSIS 都在，带 Instant Client）。验升级要两个版本时仍照下面在本机打。
- 构建两个版本，用来验升级（版本号只在命令行改，不改仓库）：
  ```powershell
  bun tauri build --config '{\"version\":\"0.5.0\"}'
  # 把 bundle\msi 与 bundle\nsis 里的安装包挪走，再打一个高版本
  bun tauri build --config '{\"version\":\"0.5.1\"}'
  ```
- 要验 Oracle 的话另打一份带 Instant Client 的（见 `windows-build.md`「带上 Oracle Instant Client」）。
- 测试库：手边任何一台 MySQL / PostgreSQL 都行；SQLite 用应用自己新建的文件。

## 1. 安装、升级、卸载（MSI 与 NSIS 各做一遍）

| # | 操作 | 期望 |
|---|---|---|
| 1.1 | 双击安装包 | SmartScreen 拦一下（「Windows 已保护你的电脑」→ 更多信息 → 仍要运行）。**这是没签名的预期**，记下即可 |
| 1.2 | 装完 | 开始菜单有 DataOmni，图标不是默认的方块；「设置 → 应用」里名称、版本、发布者看着对 |
| 1.3 | 从开始菜单启动 | 一个窗口，**没有**多出来的黑色控制台窗口 |
| 1.4 | 在**没装 WebView2 的机器**上装（Win10 老镜像才有这种情况） | 安装包自己去下 WebView2；断网时给出能看懂的失败提示 |
| 1.5 | 建一个连接、存密码、调一下窗口大小后关掉，装 0.5.1 覆盖 | 没有要求先卸载；版本号变了；连接、密码、窗口大小都还在 |
| 1.6 | 反过来：已装 0.5.1 再装 0.5.0 | 拒绝降级，或者明确提示（不要装出两个 DataOmni） |
| 1.7 | MSI 装的用 NSIS 再装一遍（混装） | 记下实际发生了什么：两份并存、还是覆盖 |
| 1.8 | 卸载 | 开始菜单、`C:\Program Files\DataOmni` 都没了。**记下**这两处还在不在：`%APPDATA%\com.dataomni.app`（连接配置）与「凭据管理器」里的 `DataOmni` 条目——留下是常见做法，但要知道是哪种 |
| 1.9 | 卸载后重新安装 | 1.8 留下了配置时，连接与密码直接回来；没留下就是全新状态 |

## 2. 窗口与界面

| # | 操作 | 期望 |
|---|---|---|
| 2.1 | 显示缩放调到 125% / 150%，再在两块不同缩放的屏幕间拖窗口 | 字不糊、不重叠；表格列宽、工具栏不折字 |
| 2.2 | 系统切深色 / 浅色（外观设为「跟随系统」） | 应用实时跟着变 |
| 2.3 | 中文界面看一圈：对象树、表格、对话框 | 没有方块字（豆腐块）；SQL 编辑器是等宽字体 |
| 2.4 | 窗口最大化、还原、贴靠（Win+←）、最小化后再打开 | 标题栏按钮正常；关掉再开，大小和位置恢复 |
| 2.5 | 快捷键：Ctrl+Enter 执行、Ctrl+S 保存脚本、Ctrl+W 关标签、Ctrl+K 命令面板、Ctrl+B 收起侧栏 | 都是 Ctrl（不是 Win 键），且不被系统抢走 |
| 2.6 | 微软拼音输入法：在 SQL 编辑器、表格单元格、筛选框里打中文，**选字时按回车与 Esc** | 回车只上屏字母、不执行 / 不提交单元格；Esc 只取消选字、不关对话框 |

## 3. 密码与凭据

| # | 操作 | 期望 |
|---|---|---|
| 3.1 | 建连接、勾选保存密码，关掉应用再打开连接 | 不用再输密码 |
| 3.2 | 「控制面板 → 凭据管理器 → Windows 凭据 → 普通凭据」 | 有 `DataOmni` 开头的条目；配置文件里**没有**明文密码（打开 `%APPDATA%\com.dataomni.app` 下的 json 搜一下密码） |
| 3.3 | 删除这个连接 | 凭据管理器里对应条目一起消失 |
| 3.4 | 用一个很长的密码（200 个字符以上）存一次 | 能存能连；存不下时要有说明，不能静默丢掉 |

## 4. 文件与路径

| # | 操作 | 期望 |
|---|---|---|
| 4.1 | 新建 SQLite 库，存到**带中文和空格的路径**（如 `D:\测试 数据\a.db`），关掉重开 | 能建、能连、重开后还在 |
| 4.2 | DuckDB 同上 | 同上 |
| 4.3 | 打开一个用记事本存的 `.sql`（CRLF、带 BOM），选中一段执行，再保存 | 「执行选中」截的是选中的那段；存回去后用记事本打开没乱码、BOM 还在 |
| 4.4 | 导入一个中文 Excel「另存为 CSV（逗号分隔）」的文件（GBK） | 中文不乱码 |
| 4.5 | 结果导出 CSV 到桌面，双击用 Excel 打开 | 中文不乱码、列对齐 |
| 4.6 | 表格多选几格 Ctrl+C，粘进 Excel | 按格子贴开，带换行的格子不串行 |
| 4.7 | 把一个 `.sql` 文件从资源管理器拖进窗口 | 应用不支持拖入；窗口不能跳走、不能白屏 |

## 5. 网络与连接

| # | 操作 | 期望 |
|---|---|---|
| 5.1 | 连 MySQL、PostgreSQL，各跑一条查询、改一格提交 | 正常 |
| 5.2 | 第一次运行时 Windows 防火墙弹框 | 记下有没有弹（应用只出站连接，正常不该弹；用 SSH 隧道时会在本机开端口，可能弹） |
| 5.3 | SSH 隧道，私钥用「浏览」选 `C:\Users\<你>\.ssh\id_ed25519` | 连得上。主机不在 `C:\Users\<你>\.ssh\known_hosts` 里时报「未知主机」并给出指纹（应用不提供「信任」按钮，要自己把主机公钥加进 known_hosts），加好后连得上 |
| 5.4 | 同上，私钥一格手打 `~\.ssh\id_ed25519`（反斜杠） | 连得上（`~\` 与 `~/` 都展开，2026-10 修） |
| 5.5 | 开着系统代理（Clash 之类）时连 Elasticsearch / 用 AI | 记下走没走代理、有没有报错 |

## 6. 备份（本轮刚改的，`eccf578`）

| # | 操作 | 期望 |
|---|---|---|
| 6.1 | 装 PostgreSQL 官方安装包（默认位置，**不**改 PATH），在应用里备份一个 PG 库 | 找得到 `pg_dump`，备份成功；**全程不闪黑窗口** |
| 6.2 | 同上，MySQL 官方安装包，备份 MySQL 库 | 找得到 `mysqldump`，成功，不闪窗 |
| 6.3 | 一个都没装时备份 | 报「没找到 pg_dump」，提示里有 Windows 那一句 |

## 7. Oracle（只在带 Instant Client 的安装包上）

| # | 操作 | 期望 |
|---|---|---|
| 7.1 | 在**干净**的虚拟机（没装过 VS / VC++ 运行库）上连 Oracle | 记下结果。Instant Client 依赖 VC++ 2017+ 运行库，缺的话会报加载失败——那就要在安装包里带上或在提示里说明 |
| 7.2 | 装好 VC++ 运行库再连 | 能连、能查、能看表结构 |
| 7.3 | 卸载 | `C:\Program Files\DataOmni\instantclient` 一起删掉，不留空目录 |

## 结果怎么交回

逐项写「过 / 不过 / 没测」，不过的附原话或截图。第 1 节 MSI 与 NSIS 分开写。

## 记录

### 2026-10：Windows 11 专业版 10.0.26300，WebView2 155，100% 缩放，非管理员账户

本机打的 0.6.0 / 0.6.1（带 Instant Client，`--config src-tauri/tauri.oracle.conf.json`）。不是干净虚拟机：
VC++ 运行库已装，账户不是管理员（MSI 要 UAC，没测）。界面项是开着
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 用 Playwright 连上去、
直接调 Tauri 命令与截图做的，**没有真人点**；要真键盘、真输入法、多屏的项都记「没测」。

| # | NSIS | MSI | 说明 |
|---|---|---|---|
| 1.1 | 没测 | 没测 | 本机打的包没有网络来源标记，SmartScreen 不会拦 |
| 1.2 | 过 | 没测 | 开始菜单 `DataOmni.lnk`；「应用」里恰好一条、版本对。发布者显示小写 `dataomni`（取自 identifier），不影响使用，没改 |
| 1.3 | 过 | 没测 | `dataomni.exe` 是 GUI 子系统，不出控制台窗口 |
| 1.4 | 没测 | 没测 | 没有不带 WebView2 的机器 |
| 1.5 | 过 | 没测 | 0.6.0 → 0.6.1 静默覆盖：仍一条、版本 0.6.1；连接、钥匙串里的密码（直接连上）、窗口位置与大小都在 |
| 1.6 | 过（静默） | 没测 | 静默装 0.6.0 覆盖 0.6.1：原地换成 0.6.0，仍只有一条，不出两份。交互安装时的提示页没看 |
| 1.7 | 没测 | 没测 | 要 MSI |
| 1.8 | 过 | 没测 | `%LOCALAPPDATA%\DataOmni`（含 `instantclient`）、开始菜单、注册项都没了；`%APPDATA%\com.dataomni.app` 与凭据管理器条目**保留** |
| 1.9 | 过 | 没测 | 重装后连接回来，存的密码直接能连（含 SSH 隧道那条） |
| 2.1 | 没测 | | 只有 100%，没有第二块屏 |
| 2.2 | 过 | | 模拟 `prefers-color-scheme` 深 / 浅，外观「跟随系统」时实时跟着变；没在系统设置里真切 |
| 2.3 | 过 | | 中文无豆腐块；SQL 编辑器 `font-family: monospace` |
| 2.4 | 部分 | | 调了窗口位置与大小后关掉、升级后再开，恢复到同一位置与大小；最大化 / 贴靠没点 |
| 2.5 | 没测 | | CDP 发的按键不经过系统，测不出被系统抢 |
| 2.6 | 没测 | | 要真输入法 |
| 3.1 | 过 | | 关掉应用、甚至升级与重装后，存的密码直接能连 |
| 3.2 | 过 | | 凭据管理器有 `{连接 id}.DataOmni` 普通凭据；`connections.json` 里搜不到密码 |
| 3.3 | 过 | | 删连接后对应凭据一起没了 |
| 3.4 | 过 | | 240 个字符的密码能存进凭据管理器、读回来能连（TLS）。不加密连 MySQL 8 会报 `message too long`：`caching_sha2_password` 在明文连接上用 RSA-OAEP 加密口令，2048 位密钥最多约 214 字节——是协议的上限，与平台无关 |
| 4.1 | 过 | | `D:\测试 数据\a.db` 建表、写中文、关掉重开都在 |
| 4.2 | 过 | | `D:\测试 数据\b.duckdb` 同上 |
| 4.3 | 过（打包版） | | 记事本格式（UTF-8 BOM + CRLF）的 `.sql` 经 `read_text_file` / `write_text_file` 往返，字节完全一致、BOM 与 CRLF 都在；中文空格路径、UNC、超 260 字符路径都过。「执行选中」没真点 |
| 4.4 | 过（打包版） | | GBK 的 CSV 预览识别成 `gb18030`，中文正确；三类路径都过 |
| 4.5 | 过（打包版，没开 Excel） | | 导出到桌面 `dataomni-导出 测试.csv`：有 EF BB BF，带换行的格子加了引号；本机没有 Excel |
| 4.6 | 没测 | | |
| 4.7 | 没测 | | `dragDropEnabled: false`（2026-10 加，不再让 WebView 接管拖入），没真拖 |
| 5.1 | 过 | | `database_smoke` 103 项（MySQL、PostgreSQL）全过 |
| 5.2 | 过 | | 跑过 SSH 隧道后没有为 `dataomni.exe` 生成防火墙规则——没弹（隧道只听 127.0.0.1） |
| 5.3 | 过（完整路径）；**预期已过时** | | 完整路径 `D:\用户 测试\.ssh\id_ed25519`（中文、空格的家目录）连通并查询。应用**没有**「信任新主机」这一步：known_hosts 里没有时直接报 `DATAOMNI_SSH_HOST_KEY_UNKNOWN: SHA256:…`，指纹与 `ssh-keygen -lf` 一致；手动把那行加进 `%USERPROFILE%\.ssh\known_hosts` 后连通。「浏览」按钮没真点 |
| 5.4 | 过 | | 原先不认 `~\`，已修；打包版手打 `~\.ssh\id_ed25519` 连通，家目录是中文带空格时也展开对 |
| 5.5 | 没测 | | |
| 6.1 / 6.2 | 过（工具在 PATH 上） | | 用官方 Windows 包里的 `pg_dump` 16.4、`mysqldump` 8.4.3，放在 `D:\测试 PF\…\bin`（中文空格目录）。备份成 `PGDMP` 自定义格式与 `MySQL dump` 文本，目标路径 `D:\测试 数据\pg 备份.dump` 这类；两个工具进程都没有窗口（`MainWindowHandle` 为 0），没闪黑窗。**`Program Files` 下的查找没在真位置测**：没有管理员权限写不进 `C:\Program Files`，而 Windows 会给每个子进程重置 `ProgramFiles`，改环境变量模拟不了；目录规则由单测 `tools_under_program_files_are_found_newest_first` 覆盖 |
| 6.3 | 过（冒烟） | | 冒烟用例走到「没找到工具」那条路 |
| 7.1 | 没测 | | 不是干净机器 |
| 7.2 | 过 | | 本地 Docker `gvenzl/oracle-free:23-slim` + Windows Instant Client：`oracle_smoke` 28 项过（要给测试用户 `SELECT ANY DICTIONARY`、`ALTER SYSTEM`，并 `--test-threads=1`，否则 om_write 几条互相抢表） |
| 7.3 | 过 | 没测 | NSIS 卸载后 `instantclient` 一起删掉 |

**MSI（2026-10-14 补）**：用户人工验过 MSI 安装，没问题。上表 MSI 一列的细项没有逐条回填，1.7 混装的结果未记录。

路径专项（打包版 0.6.1 NSIS，直接调 Tauri 命令）：

| 路径 | SQLite 建库、重开、导出、备份 | DuckDB 建库、重开、备份 | `.sql` 读写 | GBK CSV 预览 |
| --- | --- | --- | --- | --- |
| `D:\测试 数据\…`（中文、空格） | 过 | 过 | 过 | 过 |
| UNC `\\localhost\D$\测试 数据\unc\…` | 过 | 过 | 过 | 过 |
| 超 260 字符（`LongPathsEnabled` = 0） | 0.6.1 **不过**：`(code: 14) unable to open database file`；rc.1 之后修了（单测：打开、写、备份） | **不过**：「系统找不到指定的路径」 | 过 | 过 |

- 超长路径：Rust 标准库自己加 `\\?\`，所以读写文件没事；SQLite 与 DuckDB 的 C 库不加。sqlx 的连接串里
  `?` 会被当成参数、路径还会被百分号解码，所以直接拼 `\\?\` 不行。现在 SQLite 把过长的路径写成 `\\%3F\C:\…`
  （sqlx 解码回 `\\?\`），路径里的 `%` 写成 `%25`，备份目标与 `dataomni cli` 也一样改写（`services/sqlite_path.rs`）。
  DuckDB 打开前规范化路径（`CanonicalizePath`）时会剥掉 `\\?\`，加了也没用，仍是已知限制；根因与修法见 `TODOs.md` G13。
- 中文用户名：把 `USERPROFILE` 指到 `D:\用户 测试` 启动（要先建好 `AppData\Local`、`AppData\Roaming`，
  否则 log 插件取不到目录直接 panic——这是模拟手法本身的问题，真账户不会缺这两个目录）。应用数据、
  `~` 展开、known_hosts 都跟着走，见 5.3、5.4。
- 一次启动时进程以 0xc0000409 退出：父 shell 退出后、标准输出管道已关的情况下启动，疑是 log 插件写已关闭的
  stdout。把 stderr 重定向到文件启动就不再出现；双击启动不受影响。没再深究。

顺带在 Windows 上发现并修掉的：

- **拒绝连接要 30 秒才报**：Windows 收到 RST 后还会重发 SYN，连一个没人听的端口要约 2 秒（本机）到 3 秒多（远端）
  才失败，而探测超时只给了 1 秒，于是「端口拒绝」永远判不出来，落到 30 秒的连接池超时。探测超时改成 5 秒
  （`sqlx_pool.rs` 的 `REFUSAL_PROBE_TIMEOUT`）。
- 系统错误文字是本地化的（「由于目标计算机积极拒绝，无法连接。 (os error 10061)」），两条断言英文 `refused`
  的测试改成也认 `os error 10061`；前端按错误种类判断，不受影响。
- 三个 vitest 用 `new URL(..).pathname` 拼路径，Windows 上成了 `C:\C:\...`，改用 `fileURLToPath`。
- 发布版是 GUI 子系统，`dataomni cli` 在 Windows 终端里看不到输出。2026-10-14 改成启动时借用终端的控制台
  （`rfcs/agent-cli.md` §4）：隐藏的 PowerShell 窗口里直接跑 `cli --help`，读屏幕缓冲区看到全文；管道调用的 JSON、
  标准输入与退出码 2 都照旧。

### 2026-10-14：打包版界面回归（`release-regression.md` 的 R7-windows）

装的是用户人工验过的 MSI 版（`D:\software_install\DataOmni`）。清空应用数据从零开始，开 CDP 端口用 Playwright
**点界面**（不再直接调 Tauri 命令）；原生文件对话框用 Win32 窗口消息填路径、点按钮。仍不发系统级按键（机器上开着交易软件），
所以快捷键是否被系统抢、输入法照旧没测。库：本机 Docker（SQL Server、Oracle、MongoDB、Redis、Neo4j、Elasticsearch、
ClickHouse），cu 上的 MySQL / PostgreSQL，以及走 SSH 隧道的 MySQL。

- PostgreSQL 走满第一到第八节，都过：连接管理（新建、改名、删除连同凭据）、编辑器（执行全部、报错定位、危险语句确认、
  停止长查询、补全、格式化）、Win32 对话框存 / 开 `.sql`、标签与草稿恢复、结果复制与导出、表数据编辑（数组、jsonb、
  时间戳、numeric、新增、删行、冲突回滚）、结构与 ER 图、事务、CSV 导入、`pg_dump` 备份与还原、执行计划、外观与设置。
- 方言项都过：
  - MySQL：要求 TLS、SSH 隧道（cu）、改一格只动这一行。SQLite / DuckDB：经文件对话框打开、改数。ClickHouse：浏览、查询。
  - SQL Server：对象树、改 `NVARCHAR`（预览 `N'…'`，服务端是正确的 UTF-16LE）、执行计划。
  - Oracle：MSI 版不带 `oci.dll`，下 Instant Client 23 Basic Light 设 `DATAOMNI_ORACLE_CLIENT_DIR` 后连上；建表、
    `TIMESTAMP(6)` 显示到微秒、改 `VARCHAR2` 中文（`DUMP` 核对 AL32UTF8 字节）、执行计划树。
  - MongoDB：库列表、ISODate / Decimal128 / 数组 / 嵌套显示、筛选、新增 / 整文档替换 / 删除（有确认）、聚合、命令台。
  - Redis：只列非空逻辑库、六种类型、改字符串、命令行中文；**`FLUSHALL` 的确认框这次点了**（取消后键都在），
    之前一直留给人工的那一项补上。
  - Neo4j：Cypher、图视图、点节点改属性（中文写回、`size()` 对得上）。Elasticsearch：索引浏览、控制台 `_search`、
    `_update` 写中文后读回一致。
- 修了：**两条配置算出同一个连接串时，切过去后对象树报未连接**。SQL Server、Oracle、DuckDB、ClickHouse、MongoDB、
  Redis、Neo4j、Elasticsearch 的后端池子按连接串登记：切换时先测试连接（登记新池子），再断开旧配置——旧配置的串
  与新的一样，于是把刚登记的池子摘掉。界面显示「已连接」，树报 `DATAOMNI_DB_SESSION_NOT_CONNECTED`，重试无效。
  同一条断线重连也会这样。改成同一个池子时只释放会话、不关池子（`databaseHandle.ts` 的 `sharesRegisteredPool`）。
  在打包版上复验：两条都指 `master` 来回切四次，树正常，查询返回 `master`。与平台无关，只是在 Windows 上先撞到。
- 小问题（与平台无关）：后台任务的标题按创建时的语言定下，切语言后不变；连接改名后已开标签的标题还是旧名。
  rc.1 之后都修了：任务与标签一样存文案键、按当前语言译（`taskTitle`）；改名时 `renameProfileInTabs` 换掉标签标题里的连接名。
