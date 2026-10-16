# DataOmni 开发路线与完成度追踪

> **归档**：本文件只留**还没做完的**和**接下来要做的**。做完的条目怎么做、怎么取舍、怎么反向验证，都原样留在归档里：
> - [`docs/archive/TODOs-2026-10-06.md`](docs/archive/TODOs-2026-10-06.md)：到 v0.5.1 发布为止。代码与测试里写的「TODOs A6b」「TODOs B2b」
>   「TODOs「P0-P3 无阻塞级缺陷」」这类章节号指这一份。
> - [`docs/archive/TODOs-2026-09-27.md`](docs/archive/TODOs-2026-09-27.md)：更早的记录。「TODOs 4.2「ClickHouse」」这类章节号指这一份。
>
> 原则不变：动手前先评估，结论要带「当前版本」的限定；「不做」要写成可执行的重估条件；做完先提交，再回来改这里的状态。

## 使用规则

- `[ ]` 未开始　`[-]` 进行中　`[x]` 已完成并通过验收　`[!]` 阻塞（条目下说明原因）
- 完成时在条目末尾补上提交号和验证方式；做法、取舍和反向验证的记录写在条目下面
- 新接一种库，要补齐连接、元数据、执行、分页、导入导出和测试，达到核心验收标准后才标「已支持」
- 这份文件长到约 100 KB 时，照原样再归档一次
- **收到缺陷报告先搜归档**：回归时看到但没修的约 60 处，每处都写了重估条件，多半是「有人报」。
  有人报了，对应的条件就触发了

## 总体进度

| 阶段 | 目标 | 状态 |
|---|---|---|
| P0–P4 | 质量基线、连接与查询内核、日常工作闭环、管理与数据工程、外围与扩展 | [x] |
| P5 | 统一桌面 UI 与交互 | [ ]（只差 5.4 的 Windows 安装验证） |
| P6 | AI 设计、导出与备份 | [x] A0–A6c、A9 完成（A2b / A7 / A8 当前版本不做） |
| P7 | 更多数据库：国产库与云库 | [-] OceanBase、openGauss 完成；KingbaseES 缺安装包；B3 不做；B4 按触发条件 |
| v1.0 | 稳定桌面客户端（`rfcs/roadmap-1.0.md`） | [-] v0.6.0 已发布（2026-10-07，tag 重打在 2b62b5f，含 R6、R7-mac 的修正）；v0.6.1 已发布（2026-10-07，2bf2499，R7-linux 的修正；CI 里 Windows 0.6.0 → 0.6.1 升级通过）；R5 的 CI 部分与 R6 完成；R7 的 macOS 与 Linux 部分完成；R7 Windows 2026-10-14 完成，R5 只剩要真人的项 |

---

## v1.0：稳定桌面客户端

规划与理由见 `rfcs/roadmap-1.0.md`（2026-10-06）。1.0 不加功能，只兑现四条承诺：

- 能装、能升、能卸干净
- 升级不丢东西，降级不毁东西
- 出了问题说得清
- 有新版会知道

路径：v0.6.0 → v1.0.0-rc.1 → v1.0.0。

### v0.6.0：稳定化

- [x] R0 TODOs.md 再归档（2026-10-06）
  - 归档前 250 KB，其中 213 KB 是 v1.0 一节里 P0–P3 的回归记录。原文整份移到 `docs/archive/TODOs-2026-10-06.md`。
    本文件只留没做完的、「不做」的结论和它们的重估条件。
- [x] R1 落盘格式盘点与兼容门（`6711b78`）
  - 先写测试证实了路线里的推断：`connections.json` 里一条 `db_type: "dameng"` 让连接服务整个建不起来，所有连接都不见了。
  - 现在 `connections.json` 逐条解析：
    - 读不懂的那条（新的连接类型、新的环境档位）界面上看不到，保存时原样写回。
    - 读得懂的连接上，不认识的字段按 id 补回去。这里比的是「这一版自己会写出哪些键」，所以老版本落下的明文 `password` 不会被当成未知字段补回去。
  - 查询历史与工作区快照遇到更新的版本号时，这一轮不回写。原先退回旧版启动一次，首帧的空工作区就会把新版的快照整份盖掉。
  - 样本：`fixtures/on-disk-0.5/` 下 `connections.json`（五种库，含隧道、TLS、SRV、生产环境）、`workspace.json`（五种标签，含来源文件
    与最近关闭）、`query-history.json`（收藏、脱敏、截断、Mongo 语言）。三条「0.5 写的读得出来」永久保留。
  - 反向验过：去掉「原样写回」与「补回字段」各一次，对应测试各红一次。前端两条在实现之前是红的。
  - 盘点到的、这次没管的：
    - 其余设置键（AI、确认策略、字体、主题、语言、密度、历史保留）读到认不得的值就退回默认；只有用户改了那一项时才写回，
      降级后改设置会丢掉新版本独有的字段。
    - 隧道（`ssh_tunnel`）里嵌套的未知字段不补回。
    - 读不懂的连接在界面上不提示。
    - 钥匙串条目名（`DataOmni` / 连接 id、`{id}#ssh`、`#ai`）与导出连接文件（带 `format`、`version`）本来就有固定格式。
    - 重估条件：某个版本要给设置或隧道加字段时，先在样本里加一份再改。
  - 打包版验过（rpm 0.5.0，GNOME 容器，与 R2 / R3 同一个包）：配置里放了 0.5 的样本，外加一条 `dameng` 和一个 `folder` 字段。
    欢迎页照常列出 5 个连接，日志里记了一行「读不懂，保留原样」。导入一个连接触发保存后，文件里有 7 条，`dameng` 原样保留，`folder` 也还在。
- [x] R2 日志文件与「复制诊断信息」（`d685efb`）
  - 日志：用 `tauri-plugin-log` 写进系统的应用日志目录（`dataomni.log`），单个 2 MB，轮转后留两份，用本地时间。
    后端 14 处 `println!` / `eprintln!` 改成 `log::`（`获取所有连接` 那句纯噪音，删了）。加了 panic 钩子。
    前端的 `warn` / `error`、没接住的异常和被拒的 Promise，先脱敏再写进日志；`log` / `info` 不写。
  - 设置里新增「关于与诊断」：显示版本和日志路径；「复制诊断信息」复制出版本、系统、架构、WebView 版本、AI 是否编入和界面语言，
    固定用英文，不带日志路径（路径里有用户名）；「在文件夹中显示日志」走 opener 的 `reveal_item_in_dir`。
  - 门（`logging.test.ts`）：后端不许往标准输出打印；日志宏的参数里不许出现 password / secret / api key / token。
    后一条反向验过：塞进一条跨行的 `log::warn!(…, password)`，门变红。前端的脱敏与转发由 `logForwarding.test.ts` 管。
  - 「后端字符串字面量不许有中文」那道门的例外从 `println!` 改成日志宏：日志是给维护者读的。
  - 打包版验过（rpm 0.5.0，GNOME 容器）：`~/.local/share/com.dataomni.app/logs/dataomni.log` 里依次是启动、读不懂的连接、问到的最新版本三行。
    设置最后一节中英文都显示正常，「复制诊断信息」点了显示「已复制」。
    「在文件夹中显示日志」在容器里报 `ServiceUnknown`（没有 `org.freedesktop.FileManager1`），错误按翻译显示在原处。
    真实桌面有文件管理器，但 macOS / Windows 上还没点过。
- [x] R3 新版本提示（2026-10-06 确认；`bd1a728`）
  - 后端 `latest_release` 去问 GitHub 的 latest release：走系统代理，10 秒超时，带 User-Agent（不带的话 GitHub 回 403）。
    预发布和草稿本来就不在 latest 里。
  - 前端在启动时判断：没关掉检查、并且距上次问满一天才去问。没问成也记为查过，当天不再问。
    问到的版本比自己新、而且不是用户关掉过的那一版，就在标签栏下面提一句，链接到发布页。
  - 发布页的网址在后端拼，前端只传版本号，版本号只认字母、数字、`.` 和 `-`。
  - 设置 → 关于与诊断：「启动时检查新版本」，默认开。
  - 单测：版本比较（数字比较、预发布、认不出的写法）、一天一次（含时钟回拨）、关掉过的版本，以及回答的解析与网址字符限制。
  - 打包版验过：测试包版本号设成 0.5.0，启动后真的问到 GitHub，标签栏下面显示「DataOmni 0.5.1 is available.」；设置里的开关默认是开的。
    没验：「查看发布说明」打开浏览器（容器里没有浏览器）、点关闭之后重启不再提示（逻辑由单测覆盖）。
- [x] R4 GitHub issue 模板（`5594451`）
  - 两种模板，中英双语：
    - 缺陷：必填「复制诊断信息」、复现步骤、期望与实际；日志可选。
    - 想连的库或部署形态：库与版本、部署与认证、主要用途。标签用已有的 `enhancement`，没在公开仓库新建标签。
  - YAML 能解析，GitHub 上也能列出三个文件。2026-10-06 登录后在网页上核对过「想连的库或部署形态」：说明文字、三个必填项、占位提示与 `enhancement` 标签都按预期渲染；缺陷模板同一套写法，没单独截图。

### v1.0.0-rc.1：三平台验收

- [x] 打 `v1.0.0-rc.1`（`387bb28`，2026-10-16；Release run 38907400889）
  - 预发布 tag 先修了工作流（`a1b7855`）：MSI 版本号不收 `rc.1`，另给 `1.0.0.1`；冒烟按它核对；Release 标 prerelease。
  - 结果：三个平台的包都打出来；Windows 冒烟全过，含从已发布的 0.6.1 MSI 升级上来、两种安装包日志里都是「DataOmni 1.0.0-rc.1 启动」。
    草稿 Release（prerelease）挂着 dmg、msi、setup.exe、deb、rpm，等用户看过手动发布。
  - 接下来：在这批包上走 R5 人工项与 R7 回归，修完打 `v1.0.0`。

- [ ] R5 Windows 验证
  - [x] CI 跑静默的安装、升级、卸载（`1825cd5`、`30fef3b`）
    - `scripts/windows-install-smoke.ps1`；`release.yml` 里打完包先跑 `windows-install`，过了才建草稿 Release；`windows-install.yml` 可对已发布的 tag 手动跑。
    - 查：「应用」里恰好一条且版本对、开始菜单项、主程序与 `instantclient\oci.dll`、启动 20 秒后进程还在、日志里有启动那一行；卸载后注册项、主程序、开始菜单都没了。
    - MSI 装在 `C:\Program Files\DataOmni`；NSIS 按用户装在 `%LOCALAPPDATA%\DataOmni`，静默卸载要轮询（`uninstall.exe` 自己会再起一个进程）。用户配置 `%APPDATA%\com.dataomni.app` 卸载后保留，这是有意的。
    - 结果：已发布的 v0.5.1 上除「日志」外都过（那时还没有日志）；新代码打的包（run 37484423539）全部通过，Windows 日志在 `%LOCALAPPDATA%\com.dataomni.app\logs`，联网检查也写进了日志。
    - 升级那一步只在新包版本高于已发布版本时跑，这次两边都是 0.5.1 所以跳过；推 `v0.6.0` 时第一次真跑（run 37489377113）：先装 0.5.1 的 MSI、新版直接装在上面，「应用」里仍只有一条且版本是 0.6.0，其余各项全部通过。
  - [ ] 人工走一遍 SmartScreen、界面与 Oracle，按 `docs/windows-checklist.md`。
    - 2026-10 在一台 Windows 11（非干净、非管理员）上走了 NSIS 与大部分平台项，结果记在清单末尾「记录」：
      NSIS 安装 / 升级 / 降级 / 卸载 / 重装、凭据、中文路径、隧道、Oracle 都过；顺带修了 Windows 上「拒绝连接」
      判不出来（探测超时 1 秒短于 Windows 的 SYN 重试）与 `~\` 私钥路径。
    - 路径专项也走了：中文空格路径、UNC、中文用户名（模拟）、完整私钥路径、备份工具（中文空格目录、不闪窗）都过。
      **已知限制**：SQLite / DuckDB 库文件放在超 260 字符的路径下打不开（两家 C 库不加 `\\?\`），没修。
      清单 5.3 的预期原先写着「提示信任新主机」，应用实际没有这一步（未知主机直接报错给指纹），预期已改。
    - MSI：用户 2026-10-14 在 Windows 上人工验过安装，没问题（逐项结果没单独记；1.7 混装未说明）。
    - 还没测：SmartScreen、缩放与多屏、真键盘快捷键、输入法、拖入、真 `C:\Program Files`
      下的备份工具查找（要管理员）、干净机器上的 7.1。
  - 需要一台干净的 Windows。本机 Parallels 的虚拟机开着交易软件，不在上面做自动化。
- [x] R6 兼容库与 SSH 隧道的打包版回归
  - [x] SSH 隧道（CI 打的 rpm 0.6.0，GNOME 容器；修复在本地 rpm 0.6.1–0.6.3 上复验）
    - 环境：本地一次性跳板机（alpine + openssh，只认一把现生成的带口令 ed25519 钥匙），MySQL 8.4 放在只有跳板机够得着的内网（`--internal`），应用所在的容器直连不到它。以前写的「经 SSH 隧道」是在 Mac 上 `ssh -L`，应用自己的隧道这是第一次连真跳板机。
    - 过：known_hosts 里没有时拒连并报出指纹（与服务端 `ssh-keygen -l` 一致），补上后测试连接通过；私钥路径写 `~/.ssh/om_key` 能展开；口令只进钥匙串（`{id}#ssh`），`connections.json` 里搜不到；查询结果 `@@hostname` 是内网那台；表格改一格提交，服务端是新值；重启应用后不输口令连上，标签与草稿都在。
    - **修了两处**：
      - 跳板机重启后执行查询，报「没有隧道在运行，请重新连接」，头部却仍是「已连接」、没有重连按钮（`47854d1`）：这个错不带 `CONNECTION_LOST`。
      - 「重新连接」拿第一次连接时的连接串去连，串里是旧的本地端口，隧道重建后永远连不上（`05d9640`）：驱动报 `expected to read 4 bytes, got 0 bytes at EOF`；网络恢复后的自动重连同一个毛病。现在先让后端重算（会重建隧道）；跳板机还没起来时，错误显示在「连不上」横幅里（原先只进日志）。
    - 没改：只有 SQL 编辑器的执行会把状态切成「已断开」，表格提交、导出遇到断线只报错——普通断线也是这样，不是隧道特有的。重估条件：有人报在表格里遇到断线不知道该重连。
  - [x] 兼容库：OceanBase、openGauss、MariaDB、TiDB、CockroachDB（同一套环境，2026-10-07；英文界面）
    - 每个库都走了：从各自的入口新建（MariaDB / TiDB / CockroachDB 有入口且填好默认端口，OceanBase、openGauss 走 MySQL / PostgreSQL 入口）、测试连接、保存、连上，对象树，查询，表格或结果里改一格提交（都在服务端读回核对），结构页与 DDL，执行计划。
    - CockroachDB 25.2（本地）：数组与 JSONB 显示，结果里直接改；「真的执行一遍」；结构页触发器一段单独说明读不到（已写明的缺口）；改结构加一列，预览后执行。
    - MariaDB 11.4（cu）：JSON 列在表格页是 `longtext`，按文本改，提交后 `JSON_VALID` 为 1；结构页列出隐含的 `json_valid` 检查约束。
    - TiDB 8.5（cu）：在编辑器里建表写入；DROP 的确认框单独说「TiDB 上 DROP 不受事务保护」；执行计划树，「真的执行一遍」按文档灰掉；JSON 列有 JSON 编辑器。
    - openGauss 5.0.3（cu）：数组改成 `{b,c,d}` 提交，服务端一致。
    - OceanBase 4.4.2（本地）：MySQL 入口默认「要求 TLS」，对着不带 TLS 的服务端报「server does not support TLS」，说得清；改成「优先」即可。执行计划树、结构页与 DDL。
    - **修了一处**：openGauss 自带的系统 schema（`db4ai`、`dbe_perf` 等七个）进了对象树，默认展开的是 `db4ai`（`db4ff46`）。按名字并且 OID < 16384 排（CockroachDB 的用户 schema OID 也小，只看 OID 会误排）；对象树、补全、ER 图共用一份条件。真库用例 PostgreSQL 16 41/41；CockroachDB 40/41、openGauss 39/41。
    - 没修：
      - MariaDB 查询结果的表头把 JSON 列标成 `BLOB`（表格页是 `longtext`），值照常显示、可改。重估条件：有人因此误以为是二进制。
      - `postgres_exported_inserts_carry_every_value_back`（后加的导出语料）在 CockroachDB 与 openGauss 上建夹具就失败：`INT[][]`、`XML`（openGauss-lite 没带 libxml）它们不支持。是用例夹具的缺口，不是导出的缺陷；`postgres_abandoned_statement_stops_on_the_server` 在 openGauss 上并发跑时偶发超过 8 秒，单独跑两次都过。重估条件：下次动这两条用例，或 B2b 再推进时，把夹具按库裁剪。
      - 本地新起的 CockroachDB 要先开 `sql.defaults.experimental_temporary_tables.enabled`，两条用例的夹具用了临时表；cu 上那台早就开着。
    - 测试残留：MariaDB、TiDB（`test` 库）、openGauss、OceanBase 上各留一张 `om_r6`。
- [ ] R7 拿 CI 产出的三平台包，按 `docs/release-regression.md` 完整回归 → 勾下面两条 → 打 `v1.0.0`
  - 2026-10-07 定：先把 macOS 做完整，Windows 之后再说（R5 人工部分与 R7 的 Windows 部分都后放）。2026-10-14 R7-windows 补完。
  - [x] R7-mac：CI 从 `main` 手动打的 macOS 包（含 v0.6.0 之后的三处修复），PostgreSQL 走满第一到第八节，其余各库走方言项；
    另补 macOS 上没验过的：日志路径与「在访达中显示」、新版本提示、从 0.5.1 升上来连接 / 标签 / 历史 / 设置都在。
    - 过：0.5.1 → CI 0.6.0（run 37564801937）升级后连接、两个标签与草稿、深色主题、查询历史都在；
      日志在 `~/Library/Logs/com.dataomni.app/dataomni.log`，「在访达中显示」打开该目录并选中文件；
      新版本提示：本地按 0.5.0 打的包显示「0.5.1 可用」，「发布说明」打开 v0.5.1 的发布页，× 关掉后重启不再出现
      （0.6.0 自己没有更新的版本可提示，只能这样验）。
    - 升级后第一次读钥匙串弹系统授权框（ad-hoc 签名，新旧版本被当成两个应用）：文档补上（3aafbd9），
      「拒绝」落到 credentialStoreRejected，那条提示改为也覆盖升级的情况。拒绝这条路径是读 keyring 源码确认的
      （-25293 / -128 → PlatformFailure），界面上没点过拒绝。
    - 修了：PostgreSQL 连接串里 sqlx 不认的 `connect_timeout`，每次连接留一条 WARN（b868d6e）；
      三张网格的翻页按钮没有可读名字（78e858c）；jsonb 那一格被 macOS 换成弯引号，JSON 失效（3a1c4e3，
      formInputs 门扩到 textarea）；DDL / DML 结果上的复制提示与灰掉的图表、导出（ab76327）。
    - PostgreSQL 第一到第八节在 run 37573210684（9b7ba90）上走完：
      - 过：新建 / 改名 / 删除（应用内确认，钥匙串条目一并删掉）；错主机、错口令、错库名各一次；
        执行全部 / 当前 / 选中、DROP 先确认、取消长查询、补全（表名，`别名.` 补列）、格式化、查找替换、
        存 / 开 .sql、⌘W、⇧⌘T（带草稿的）、⌘1、历史搜索与取回；结果排序、TSV 复制、复制行、导出 INSERT；
        表数据翻页、改数组 / jsonb / 时间戳并提交、别处改过时提交被拒并能全部撤销、无主键表说明原因；
        看结构、加列（预览→执行）、ER 图；事务回滚（另一会话看不到未提交的值）、失败事务（25P02）、
        CSV 导入（预检提示坏值、跳过坏行 3/1）、pg_dump 备份并在新库 pg_restore 还原核对、执行计划；
        浅色 / 中文、命令面板、AI 设计新表（DeepSeek，建成后已删钥匙串 `#ai`）；断线重连。
      - 修了：失败的红字被半秒后的自动解析抹掉（e68bd15，断线时最显眼）；重连后跳到第一个查询标签、
        接着敲的字盖掉那里的草稿（7c47263）；主机不回应时印驱动原话（9f65603）；钥匙串里没有口令时
        不给输入处（71e36ce）；别处连上后旧的连接失败红字不收（4c4b75b）；连接列表上右键弹 WebKit 菜单
        （f2085ec）；后台任务按钮盖住翻页栏（d578f97）；⇧⌘T 只拿回带草稿的标签写进手册（59dc08a）。
      - 没修：不带别名时列补全只给关键字（lang-sql 只在有 defaultTable 时补裸列；手册写的是 `o.` 的用法，
        与实现一致）。重估：有人报「补不出列」时，按光标所在语句的 FROM 推 defaultTable。
      - run 37577230988（9b0fd5e）上复验：上面八处都过（钥匙串缺口令直接开表单、保存后自动连上；断线红字留着；
        重连停在原标签；右键无 WebKit 菜单；主机不回应的提示；任务按钮让开翻页栏）。
    - 方言项：MySQL（要求 TLS 连上、会话 Ssl_cipher 为 TLS_AES_256_GCM_SHA384；`_bin` 列大小写区分、改一格只动这一行；
      执行计划树；mysqldump 备份含 utf8mb4_bin 与改后的值）、SQLite（打开文件、无类型列混存、VACUUM INTO 备份）、
      DuckDB（打开文件、导入跳过坏行只能每批一个事务并说明原因，读 3 写 2 败 1）、ClickHouse（经 ssh -L 连 HTTP 口、
      浏览、聚合查询、改一行提交）都过。
      - 修了：SQLite 无类型列里改一个数存成了文本。8196625 按「原值是数」判断，包上复验仍是文本（原值拆包后是字符串，
        单测拿数字当原值、没照真实数据的形状）；35ac374 改为看新值，新增行同样。run 37582872763 上复验存成 integer。
      - Neo4j 连接超时的措辞（0a36fb7）只有单测：要在服务端「接了 TCP 但还没起好」时才走到，打包版上没再造出来。
      - MongoDB（命令台 insert、浏览、整篇替换保存且 ISODate 存成日期、聚合、删文档走确认）、Redis（只列非空逻辑库、
        六种类型、hash 加字段、命令行）、Neo4j（Cypher、图视图、改属性保持 INTEGER）、Elasticsearch（自签 HTTPS：
        失败提示指明选「要求 TLS」，改后连上；索引浏览、查询台、改文档）、SQL Server（经 ssh -L；nvarchar 改中文、
        执行计划 Clustered Index Seek）都过。
      - 修了：Neo4j 服务端还在启动时测试连接，提示「超过了查询时限……可以在工具栏调大」（0a36fb7）。
      - 没测：Redis 危险命令确认（FLUSHDB 这类命令本机的自动执行权限拦下了，留给人工点一次）。
      - Oracle：cu 上起 Oracle 把机器压到 load 114、SSH 连不上（8 GB 里别的项目已占 5 GB），立刻停掉；改在本机 Docker
        起 gvenzl/oracle-free:23-slim（arm64），连接、浏览、改 VARCHAR2 与 DATE 并提交、执行计划都过，用完删掉容器。
        以后 Oracle 在本机起，不在 cu 上起。
    - 收尾（2026-10-07）：测试连接的钥匙串条目已删，cu 上的 om_r7* 表已删、各测试容器已停，本机 Oracle 容器已删；
      用户自己的 DataOmni 数据（21 个连接、偏好）已从备份放回。
    - 遗留：Redis 危险命令确认要人工点一次；v0.6.0 按决定删掉旧草稿与 tag，重打在 2b62b5f（run 37586095917 全绿，Windows 安装冒烟过），2026-10-07 发布为 Latest。
  - [x] R7-linux：v0.6.0 发布的 rpm / deb，外加 v0.6.0 之后的 CI 包（run 37593477681、37599923690、37602025075）复验修复。
    - 装包：Ubuntu 22.04、Ubuntu 24.04（deb）与 Fedora 42（rpm）各一个干净容器：装 0.5.1 → 放一份用户数据 → 升到 0.6.0 →
      依赖齐全（ldd 无缺）、desktop 文件与图标在、Xvfb 下起得来 → 卸载，用户数据都还在。
    - 图形回归在本机 Docker 的 Fedora 42 + GNOME Shell（Wayland，x86_64 经 Rosetta）里，PostgreSQL 走满第一到第八节：
      - 过：新建 / 改名 / 删除（应用内确认，Secret Service 里的条目一并删掉）；口令进 gnome-keyring、`connections.json` 里搜不到，
        重启后免输入连上；错主机、错口令、错库名各一次；右键菜单只出应用自己的（没有 WebKitGTK 的系统菜单）；执行全部、
        报错跳到第 3 行、DROP 先确认、`pg_sleep` 停下后服务端也结束；补全（表名、`别名.` 补列）、格式化、查找替换；
        GTK 文件对话框存 / 开 .sql；Ctrl+W 问草稿、Ctrl+Shift+T 找回、Ctrl+1、重启后标签与草稿都在、历史搜索；
        TSV 复制（中文完整）、图表、导出 CSV / INSERT；表数据翻页、筛选、改数组 / jsonb（带转义引号）/ 时间戳 / numeric、
        新增、删行、撤销单条、别处改过时整批回滚、无主键说明原因；看结构、加列、ER 图（PNG 导出是 2 倍分辨率）、数据字典；
        事务回滚（另一会话看不到）、关窗口时问事务、CSV 导入跳过坏行（读 3 写 2 败 1）、pg_dump 备份在新库还原逐行一致、
        执行计划；深色 / 中文、命令面板（快捷键显示为 Ctrl）、设置、诊断信息、日志在 `~/.local/share/com.dataomni.app/logs/`。
      - 修了：Ubuntu 22.04 最小安装没有 ca-certificates，检查更新只记一句 builder error（e62dc26 声明依赖，816fbd9 报错带原因链；
        新包上 apt 自动带上、问到了版本）；包说明还写着只支持 MySQL / PostgreSQL / SQLite（bb8fe6d）；停掉长查询后把语句整个
        换掉，卡片仍写「已停止 / 重新执行」（ad8c81f、b7569cb）；表数据页选「紧凑」行高不变（d543a4d，操作列写死了 py-1）。
        这几处都在新包上复验过。
      - 清单改了一句（af32274）：事务开着时网格、结构变更与 CSV 导入的提交被拒并说明原因（9250dc2 的设计），不是「走同一会话」。
      - 「在文件夹中显示日志」：容器里没有 FileManager1 时报 `ServiceUnknown`（说得出原因）；装上 Nautilus 后打开日志目录并选中文件。
    - 方言项（Linux 上有平台差异的先走）：SQLite 经 GTK 对话框打开、无类型列改数存成 integer；Oracle 用包里的 Linux 版
      Instant Client（加上系统 libaio）连上、浏览、改 VARCHAR2 与 DATE、执行计划；MySQL 要求 TLS（会话 Ssl_cipher 为
      TLS_AES_256_GCM_SHA384）、`_bin` 列改一格只动这一行；Redis 只列非空逻辑库、六种类型、命令行。
      - 修了：用 SYSTEM 登录 Oracle 时对象树是空的（37eb07f：当前登录的 schema 即使是 Oracle 自带的也列出；冒烟用例拿 SYSTEM
        改前红、改后绿，拿普通用户串行跑整套 28 条全过）。新包上复验 SYSTEM 名下的表出现了。
      - 没测：MongoDB、Neo4j、Elasticsearch、ClickHouse、SQL Server、DuckDB 在 Linux 上没再走——这几家的驱动与界面代码
        与 macOS 同一份，没有按平台分的路径，R7-mac 已走过；Redis 危险命令确认照旧留给人工。
    - 收尾：本机测试容器（PostgreSQL、Oracle、MySQL、Redis、GNOME）已删。
  - [x] R7-windows：2026-10-14 在 Windows 11 上用人工验过的 MSI 版走了一遍，记录在 `docs/windows-checklist.md`「记录」末节。
    - PostgreSQL 走满第一到第八节；MySQL（TLS、SSH 隧道）、SQLite、DuckDB、ClickHouse、SQL Server、Oracle、MongoDB、Redis、
      Neo4j、Elasticsearch 走方言项，都过。Redis 危险命令确认这次在界面上点了（取消后数据在）。
    - 修了：两条配置算出同一个连接串时，切过去后对象树报未连接（新池子被断开旧配置时摘掉）；打包版复验过。
    - 没测（要真人）：系统级快捷键、输入法、多屏与缩放、拖入文件、Excel 打开导出的 CSV。

### 里程碑条目

- [ ] 完成 P5
  - 只剩 5.4 的 Windows 安装验证（R5）。5.1 结果区拖动、5.2 间距与字号 token 属「当前版本不做」，不算欠账。
- [ ] P0–P3 无阻塞级缺陷
  - 2026-09-24 至 10-06，在 macOS 与 Linux 打包版上做了多轮回归。2026-10-06 发版前按 `docs/release-regression.md` 完整走了一遍：
    PostgreSQL 走满，其余各库走方言项。修过的每一处都在新包上复验过，记录在归档的同名条目里。
  - 还不能勾：Windows 的安装、升级、卸载，以及带 Instant Client 的 Oracle（R5）；兼容库与隧道的打包版回归（R6）。
  - 2026-10-15 实际使用中发现并修了：经 SSH 隧道连 MySQL 5.7.44，TLS「要求」只报 `HandshakeFailure`（`08b842d`）。rustls 只有 ECDHE 套件而 5.7 不开 ECDH，「优先」也一样失败；现在提示改成「禁用」或升级到 8.0。真库用例在本机 `mysql:5.7.44` 上过；用户在自己的 5.7 上看到了新提示，改「禁用」后正常使用。
  - 2026-10-16 macOS：升级后删旧版本存的连接，报「没能从系统钥匙串删掉这条密码… Invalid attempt to change the owner of this item」，连接删不掉。ad-hoc 签名换了 cdhash，`SecItemDelete` 报 -25244；只在这个码上改用 `/usr/bin/security` 删（`cc22d79`）。真钥匙串单测做过反向验证；装进 /Applications 的新包上，用户删掉了一条由 `security` 写入的口令所属的连接（T1），没报错，钥匙串里那条也没了。
  - 2026-10-16 做 G3 时撞上：PostgreSQL / MySQL 的 TLS 选「校验 CA」一连就 panic。rustls 的 ring 与 aws-lc 两个 feature 都开着（reqwest、neo4j、tiberius 带进 aws-lc），不挑进程级默认的加密实现，sqlx 的 verify-ca 校验器要它。`sqlx_pool::open` 先把 ring 装成默认（`6fbfa9c`）。单测做过反向验证；本机 openGauss 开 TLS，verify-ca 改前 panic、改后握手通过。打包版上没看过。
  - 同日同一台 5.7：结构页「检查约束」段印红字 `Unknown table 'CHECK_CONSTRAINTS'`（8.0.16 起才有）。现在按 SQLSTATE 42S02 当作「没有检查约束目录」，说明 5.7 不执行 CHECK（`2e5227c`）。真库用例与组件渲染测试都做过反向验证；打包版上没看过。
- [ ] v0.3：三平台基础安装与冒烟测试
  - macOS 与 Linux（容器）已验。Windows 能构建，GitHub Actions 也出 MSI / NSIS，但还没装过、没做冒烟，与 R5 一起做。
  - Windows ARM64 原生包**当前版本不做**（2026-10-06 定）：ARM 上的 Windows 11 靠系统转译跑 x64 包；Oracle 也没有 Windows ARM64 的
    Instant Client。重估条件：有 ARM Windows 用户反馈转译下慢或装不上。

---

## 兼容性矩阵里的缺口（2026-10-16 盘点）

按 README「兼容性矩阵」逐条分了类。服务端本身没有的（MySQL 5.7 的检查约束目录、函数索引、表达式默认值；
TiDB 的触发器与存储过程；openGauss 违反约束时不给约束名；CockroachDB 错误里没有位置；ClickHouse 没有通用事务）
**不算缺口**，界面上说清楚即可，已经在说。

### 1.0 之内修（生成了错的语句或连不上，按缺陷算）

- [x] G1 MySQL 5.7：结构编辑里只改列名生成 `RENAME COLUMN`（8.0 语法），5.7 报语法错（`7e81f01`）
  - `renamesByChange` 按 `VERSION()` 判：MySQL 8.0 之前、MariaDB 10.5 之前为真（TiDB、OceanBase 报的是兼容版本，排除；
    没读到版本时照旧发 `RENAME COLUMN`）。为真时只改名也走 `CHANGE COLUMN` 重述，计算列、表达式默认值、空间列点名拒绝。
  - 验证：单测、语料（`mysql57-renames-columns-by-restating-them`，所有 MySQL 连接上都跑）、5.7 专用真库用例
    `mysql_57_renames_columns_by_restating_them`（同时钉住 `RENAME COLUMN` 报 1064）各做过反向验证；本机 5.7.44 与 8.4 上通过。
    打包版上没看过。
- [x] G2 MariaDB：查询结果表头把 JSON 列标成 BLOB（`3ca8469`）
  - 根因在 sqlx：MySQL 列的类型名只凭 BINARY 标志定，`_bin` 排序规则的文本列都带这个标志，字符集在协议里有、它解析了但不公开。
    所以不只 MariaDB 的 JSON，大小写敏感的 varchar 也是 `VARBINARY`。
  - 做法：认得出来源表的查询（单表、裸列名）表头用目录里的声明类型，与表数据页一致；挑编辑器本来就用这一份。
  - 剩下的：JOIN、表达式这类认不出来源表的查询，表头照旧是驱动的类型（值按内容判，显示与编辑都是文本）。
    要彻底修得改 sqlx 把字符集带出来（`[patch]` 一份 sqlx-mysql）。重估条件：有人因为这类查询的表头误以为是二进制。
  - 验证：组件渲染测试（happy-dom）做过反向验证；真应用里没渲染看过。

### 1.0 之后，按这个次序

- [x] G3 openGauss：只存 sha256 口令的用户连不上（默认安装常常就是这样，信创用户第一次连就撞上）（`be3872a`）
  - 实验：手写握手直连服务端，认证成功。算法是官方驱动的 RFC 5802 变体（PBKDF2-HMAC-SHA1 → HMAC-SHA256）。
    协议 3.0（sqlx 发的）时服务端**不带迭代次数**（这台是 10000，可配），客户端只能猜；声明 3.51 才带。
  - 所以不改 sqlx：普通连接报了 `unsupported SASL authentication mechanisms` 之后，在本机开转发口（`opengauss_relay`），
    它声明 3.51、答掉认证、再原样转发；到服务端那一段照连接串的 sslmode 与证书加密（配法照 sqlx）。改 sqlx 的话还得让它
    对 openGauss 改协议版本，等于长期维护一份 sqlx 的分叉。
  - 验证：见提交说明（五种 sslmode、错 CA、只收 hostssl、整套 PostgreSQL 冒烟经转发口 40 / 41）。打包版上没连过。
  - 顺带修了「校验 CA」panic（`6fbfa9c`，见 P0–P3 那条）。
  - 剩下的：口令存成 md5 的用户服务端不发这种请求，照旧由 sqlx 处理；SM3（`password_encryption_type = 3`）没做。
    重估条件：有人的服务端用 SM3。
- [x] G4 Elasticsearch：API Key 认证（多一个请求头）（`e52ab71`）
  - 表单「认证方式」选 API Key，key 存口令那一格（进钥匙串），`options.auth = apiKey`；encoded 与 `id:api_key` 都收。
  - 池子的键里用户那一段是 key 的 SHA-256 前 8 字节：同一台服务端两把 key 不共用池子。401 单独报「API Key 不对」。
  - 验证：ES 9.5.3（HTTPS）与 8.19（HTTP）整套 7 / 7；表单在浏览器里看过。OpenSearch 没有 API Key，跳过。打包版上没连过。
- [x] G5 Oracle：按 SID 连接（换一种连接描述符）（`a3ef45e`）
  - 表单「连接方式」选 SID，`options.connectBy = sid`；后端换成完整的连接描述符（Easy Connect 写不了 SID）。
    池子的键末尾加 `?sid`，同名的 SID 与服务名不共用池子。切到 SID 时预填的 FREEPDB1 清掉（PDB 没有 SID）。
  - 验证：本地 Oracle Free 23ai，按 SID（`FREE`）连上、不存在的 SID 报 ORA-12505；整套 29 / 29（`--test-threads=1`：
    几条用例共用表名，并行跑会互相撞，与这次改动无关）。表单在浏览器里看过。打包版上没连过；11g 的真库没有，没连过。
- [x] G6 CockroachDB：结构页的触发器改用 `SHOW CREATE TRIGGER` 读（`79b75d7`）
  - 实验（25.2）：`pg_trigger`、`information_schema.triggers` 都是空的；`SHOW TRIGGERS FROM 表` 列名字、`SHOW CREATE TRIGGER 名 ON 表`
    给原文，对表有任一权限就能读（没有权限报 42501）。`system.descriptor` 里也有，但要管理员权限，不用。两条 SHOW 都不收占位符。
  - 做法：目录查询报 42883 时改走这两条（SQL 在 `schema_metadata.rs` 的 `triggers_by_show`，前端 `readTriggersByShow` 插引用过的
    标识符）；不认 `SHOW TRIGGERS`（42601，24.3 之前没有触发器）照旧说「列不出」。
  - 验证：真库用例在 CockroachDB 25.2 与 PostgreSQL 16 上通过，去掉 `ON {table}` 变红；前端单测与结构页渲染用例（happy-dom）反向验证过。
    真应用里没渲染看过（这段的界面没改，画的还是 PostgreSQL 那份完整原文）。
  - 顺带看到：整套 PostgreSQL 冒烟在 CockroachDB 上 39 / 41，`postgres_exported_inserts_carry_every_value_back` 建表用了它没有的
    多维数组（用例遗漏，见下一个提交）；`postgres_session_recovers_after_the_server_drops_it_mid_transaction` 并行跑偶发失败，单独跑通过。
- [x] G7 openGauss：序列属性页（没有 `pg_sequences`，直接查序列关系）（`7e3ffd2`）
  - 序列关系自己那一行有 start / increment / min / max / cache_value / is_cycled / last_value，没有 data_type（5.0.3 上核对）。
    按 oid 查 `pg_sequences` 报 42P01 时改查 `{sequence}`（`object_catalog.rs` 的 `sequence_properties_by_relation`，
    前端 `readSequenceProperties` 插引用过的带 schema 的名字），别名与 PostgreSQL 那条一致。
  - 验证：本地 openGauss-lite 5.0.3 上两条真库用例从「钉住报错」改成核对值，改错列名变红；PostgreSQL 16 整套 40 / 41
    （pg_dump 那条并行时撞上别的用例删表，单独跑通过）；前端单测与对话框渲染用例（happy-dom）旧代码上红。真应用里没渲染看过。
  - 顺带：openGauss-lite 上导出往返那条建表报 `unsupported XML feature`（lite 版没编 libxml），同 CockroachDB 那条，下一个提交处理。
- [x] G8 Redis 集群与 Sentinel（redis-rs 有 `cluster-async` / `sentinel` feature；工作量在键浏览要跨节点扫）
  - Sentinel 已做（`8cd7ea1`）：每开一条连接先问哨兵主节点地址再照单机连（没用驱动的 sentinel feature）；哨兵不设口令时
    不带口令再问；经 SSH 隧道拒。主从切换后要「重新连接」（`ConnectionManager` 断线重连仍连旧地址）——重估条件：有人切换后撞上
    `READONLY`。只填一个哨兵地址：重估条件：有人要列多个哨兵。验证：本地一主一从一哨兵，含一次 `SENTINEL FAILOVER`；打包版上没连过。
  - 集群已做（`037eab0`）：连接是单机 / 集群两种的枚举，读写照用（按键的槽位路由）；键浏览按 `CLUSTER NODES` 的主节点逐个点名
    `SCAN`，游标「第几个主节点:游标」（两页之间扩缩容会错开，可能漏或重）；类型与 TTL 一个键一条流水线（跨槽的流水线报 CROSSSLOT）；
    只有 0 号库；经隧道拒。改名跨槽时服务端报 CROSSSLOT，原话照报。验证：本地三主节点，300 个键翻页每个恰好一次，三处变异各自变红；
    打包版上没连过，集群与 Sentinel 的 TLS 没测过。
  - 顺带修了（`99c8d75`）：进程里没先连过 MySQL / PostgreSQL 时，加密的 Redis 连接一连就 panic（rustls 没有进程级默认实现）。
- [x] G9 Neo4j 集群路由 `neo4j://`（用的 `neo4j` crate 已有 routing）（`e73adca`）
  - 表单勾「按集群路由连接」（`options.neo4jRouting`），驱动 `with_routing(true)`；键带 `?routing`；经隧道拒。结果摘要带 `server`
    （跑在哪个成员上，只在路由时给），工作台结果下方显示。
  - 验证：本地 5.26 社区版单实例，整套用例经 `neo4j://` 与 `bolt://` 各 10 / 10。**没验证成员之间的分派**：单实例把客户端发来的
    地址原样当路由表报回，要企业版集群（Docker 镜像要接受 Neo4j 的商业或评估许可，留给用户决定）。打包版上没连过。
- [x] G10 SQL Server「真的执行一遍」（`SET STATISTICS XML ON`）（`f71316d`）
  - 语句照常执行，只收 showplan 那几个结果集；`explain_plan` 换成 `ExplainPlan { Off, Estimated, Actual }`。实际行数按每次执行
    折算（与估算可比），没执行过的不给；耗时取最慢的线程，`QueryTimeStats` 记为总耗时。
  - 验证：SQL Server 2022（cu）显式事务里真跑 SELECT / DELETE，同一事务里看得到效果、之后不再多回计划、回滚后复原；两处变异各自变红；
    整套 31 / 31。打包版上没跑过。
- [x] G11 Neo4j：界面上建关系（`a76dc40`）
  - 节点编辑框「从这个节点建关系」→ 在结果里点终点 → 填类型与属性、可换方向；两头按 `elementId` 定位，有一头没了就什么也不建。
  - 验证：单测与工作台渲染用例（旧代码上红），生成的语句在本地 Neo4j 5.26 上跑过（方向、自环、终点不存在）。打包版上没跑过。
- [x] G12 ClickHouse：表格改一行按物理位置定位，堵上「数完到执行之间别处写进一模一样的一行会被一起改」（`3133216`）
  - 现在按整行的值定位，先数后改再核对。ClickHouse 服务端没有行锁（没有 `SELECT … FOR UPDATE`），通用事务只有实验版
    （`allow_experimental_transactions`，要 Keeper、要改服务端配置），所以这不是客户端没实现。应用这边加锁只挡得住本应用，
    挡不住别的写入方。
  - 想法：WHERE 里再加 `_part = … AND _part_offset = …`（读的时候一起取）。新写进来的行在新的 part 里，不会被匹配；
    中间发生合并时 part 名变了，匹配 0 行，核对报「没有执行」，安全。
  - 先做实验：mutation 与 lightweight `DELETE` / `UPDATE` 的 WHERE 收不收这两个虚拟列，25.8 上各跑一次。不收就不做。
  - 实验结果：都收。但每次 mutation 给全部 part 名加版本号，所以比 part 名前四段（`rowPosition.ts` 的 `PART_BLOCK_EXPRESSION`）加偏移；
    mutation 不挪行，合并后旧位置匹配 0 行（报「没有执行」）。只对 MergeTree 一族（列目录多给 `table_engine`）；Memory 等没有 `_part`。
    顺带：两行一模一样时也能只改其中一行。验证：25.8 真库用例（双胞胎、后插入的同样一行、合并）与整套 16 / 16；打包版上没改过。
- [x] README 兼容性矩阵按现在的用例重跑（2026-10-16，`902f27b`）
  - 表头原写「一组 23 条」，实际 MySQL 一组 42 条、PostgreSQL 一组 39 条。各库全部重跑：MySQL 8.4、PG16、MariaDB、
    CockroachDB、openGauss 全过；TiDB 40 / 42、OceanBase 39 / 42，挂的是夹具（`HANDLER`、`wait_timeout`），不是应用；
    MySQL 5.7 与 10-15 一致。独立用例：SQL Server 31、Oracle 29、DuckDB 18、ClickHouse 16 + 1、MongoDB 34。
  - VECTOR 导入那条在 TiDB（网格给文本）与 OceanBase（不收 `HEX()`）上原先是夹具错，改了用例（`4fed247`），应用没问题。
  - cu 上的 `dataomni-mongo-rs` 自 9-25 起重启就退出（入口脚本重写 `/tmp/key`，被 `protected_regular` 挡住），
    SRV 那 3 条这期间一直没真跑。按原配置与原数据卷重建，启动前先删 key；重启一次验过，3 / 3。

### 要自己实现、当前版本不做

- Oracle 原生 JSON / VECTOR 的读取（已有 `JSON_SERIALIZE` 绕法）；SQL Server `money` 超过约 9×10¹¹ 的精度（要 fork tiberius，
  表数据页与导出不受影响）；MongoDB `db.coll.find()` 的 JS 写法（要 JS 引擎或子集解析器）；Oracle TLS（要钱包，现走 SSH 隧道）；
  OceanBase 表达式默认值（要解析 `SHOW CREATE TABLE`，预览里看得见）。
- 重估条件：有人报。

---

## 还没做完的旧条目

### 2.4 表数据浏览

- [-] 元数据与表数据查询改走自建 query_executor
  - 剩余：表结构查询仍走 tauri-plugin-sql，因为 `execute_query` 不收绑定参数。
  - PostgreSQL 的 `BIT`、`INET` / `CIDR` 这类解码器白名单以外的类型，表数据页与 SQL 标签都按服务端文本显示，不再报错（`39bb53d`、`039ee4a`）。
  - 重估条件：真需要时给 `execute_query` 补绑定参数（1.0 之后的候选，见路线第四节第 2 条）。

### 3.1 结构与对象管理

- [-] 查看建表 DDL
  - MySQL / SQLite 已完成（`e7b6bc1`）；**PostgreSQL 当前版本不做**。
  - 理由：PostgreSQL 没有 `SHOW CREATE TABLE`，从目录重建很难覆盖全部属性，不等价的 DDL 比没有更糟。
  - 重估条件（可执行）：`services::schema_metadata::tests::postgres_has_no_ddl_query` 变红。

### 4.3 非关系型数据库专属工作区

- [ ] MongoDB 文档浏览与查询模型
  - 明确不做：
    - JS 写法的 mongosh，一个标签里写多条命令
    - LDAP、Kerberos、AWS IAM 认证
    - 删库、改集合名
    - 导出聚合结果；JSON 数组 / CSV 的导入导出
    - 用 `hidden`、`collMod` 改索引
    - 生产库批量写再加一道门；乐观锁以外的并发控制
  - 重估条件：有人拿着 mongosh 脚本、这类账号或 `--jsonArray` 文件来，或有人要。
- [ ] Redis 键空间、类型和值浏览
  - 集群与 Sentinel 已做（G8，`8cd7ea1`、`037eab0`）；这两种的 TLS 没测过。
  - 还没做：
    - 客户端证书（要先定读文件的规矩）
    - RESP3 推送与发布订阅
  - 重估条件：有人拿着这种部署来。
- [ ] 每种数据库有独立的能力声明
  - 能力清单仍不抽，维度只有 `speaksSql`、`hasQueryEditor`。
  - 理由：前后端各一份判断，只是改的时候多动几处，从没出过不一致的缺陷。
  - 重估条件：出现第一个前后端不一致的缺陷，届时做一份共用语料（仿 `fixtures/export-conformance.json`）。

### 4.4 可选外围能力

- [ ] ~~连接和查询模板~~ **当前版本不做**
  - 重估条件：`execute_query` 补上绑定参数之后。
- [ ] ~~插件或扩展机制~~ **评估完成：不做**
  - 重估条件：出现第一个「想改而改不动」的具体诉求时，先做配置点；同类诉求到第三个，再谈机制。
- [ ] ~~团队配置同步~~ **当前版本不做**
  - 理由：需要服务端；连接导出 / 导入已经做了（`cd1c442`）。
  - 重估条件：有明确的多人场景，并且说得清要同步什么。
- 连接导出 / 导入的后续（只导出选中的几个、带口令导出、从 DBeaver / Navicat 导入）：有人提出具体的来源格式或「只导出几个」的场景时再做。

### 5.1 工作区布局

- [x] 启动页的连接列表每行都能直接编辑（`80373d3`；组件测试 + 打包版点过）
  - 理由：用户反馈只在左侧下拉框里悬停才出现的编辑按钮难找。按钮常显，和整行的连接按钮是兄弟，
    点编辑不会顺带连接——测试钉住，把编辑改成顺带连接会变红。
  - 打包版验证换了 bundle id（`com.dataomni.guitest`）和临时 HOME：WebKit 存储按 bundle id 存、
    不跟 HOME 走，只换 HOME 会读到真实工作区的标签而看不到启动页。验完删了副本与它的 WebKit 数据。
- [-] 多条结果之间单独拖动调整
  - 理由：结果区高度的公式自带上限，各条结果互不挤占，而且能逐条收起（`a26cf41`）。
  - 重估条件：有人说得出这个需求。

### 5.2 设计系统

- [-] 间距、字号、阴影、层级 token **当前版本不做**（颜色与圆角已完成，`1cdcd61`）
  - 理由：没有消费者。层级守的是隐式约定，门是 `designTokens.test.ts`。
  - 重估条件：密度要铺到工具栏、对话框、侧边栏时，密度不变量的断言先红。
- 字体设置的后续（编辑器 Tab 宽度、自动换行、快捷键改键）：有人提再做。
  网格的字体与字号不开放，因为列宽是按 13px 等宽字体估算的。

### 5.3 桌面交互

- [x] 一条语句返回几个结果集时逐个显示（`83dfc59`，2026-10-16；归档里「把每个结果集都画出来」那条的后续）
  - SQL Server（`sp_help`、`EXEC`）与 MySQL `CALL`：第一个照旧流式，后面的随摘要带回、画成只读表格。每个的行数上限同第一个，
    字节上限合用一份，最多 20 个（`MAX_EXTRA_RESULT_SETS`），超出的仍报个数。MySQL 空结果集 sqlx 给不出列，只报个数。
  - 没做：Oracle 的隐式结果集（后台线程到上限就丢接收端，要改那套设计）。重估条件：有人要看 Oracle 过程的第二个结果集。
    命令行 `query` 也只输出第一个。打包版上用户看过（MySQL `CALL` 两个结果集，2026-10-16）。
  - 打包版上看出的两处已改（2026-10-16）：第二个起结果头写明只读（`later-result-set`），耗时只在第一个上印。

- [x] 勾一批表一次导出建表语句或数据字典（`82e3e33`，2026-10-16）
  - 理由：用户三百多张表要导其中一百张的结构，此前只能逐张看「对象定义」或命令行 `ddl` 逐张调。
    对象树「表」那一组右键「导出表结构…」；SQL 用 `SHOW CREATE TABLE` 原文（同时 4 条），Markdown 复用数据字典。
    组件测试两条加纯函数五条；「全选只选画出来的」「字典不筛表」「不列失败」三处改坏各自红。渲染看过中英文；打包版上用户在真实 MySQL 库上导过（2026-10-16）。
  - 扩到全部走 SQL 的库（2026-10-16）：SQLite、Oracle、DuckDB、ClickHouse 用 `ddl` 那条原文查询；CockroachDB 拿第一张表试
    `SHOW CREATE TABLE`，认就用；PostgreSQL、openGauss、SQL Server 用结构页四段目录查询重建（`reconstructTableDdl.ts`），
    外键放文件最后，建不出来的（读不到表达式的计算列、部分索引、特殊索引、序列、identity 种子）逐表注明。表按外键依赖排序
    （`orderByDependencies`，外键取 ER 那条整库查询）。
  - 真库核对：cu 的 PostgreSQL 16 与 SQL Server 2022 上建一组刁钻表，重建后在另一个 schema 执行，两份目录逐条比：
    PG 只差部分索引、唯一约束变唯一索引、serial 指原序列；SQL Server 只差计算列与筛选索引——都是文件里注明的。
    CockroachDB 25.2 上 `SHOW CREATE TABLE` 那条路走通。有原文的几家沿用结构页已在用的查询，没另起库验。打包版上没点过。

- [x] 表数据页右键菜单里「编辑这一行」（`c58190d`，2026-10-16）
  - 理由：用户问过单行怎么改——操作列在最右边，列多时在屏幕外，右键菜单只有复制。条件与操作列的编辑按钮同一份；
    组件测试两条（能进编辑、排了队的行不给），各去掉一半条件都红。菜单单独渲染看过中英文；打包版上用户点过（2026-10-16）。

- [-] 应用菜单
  - 命令面板已覆盖可发现性。应用自身的动作不搬进原生菜单：菜单项的启用、禁用状态做不准，就成了「撒谎的菜单」。
  - 门：`shortcuts.test.ts`、`windowCapabilities.test.ts`。

### 5.4 性能与体验验收

- [x] macOS 图标在 Dock / Finder 里被套灰色底板（`d30075c`，2026-10-16）
  - `bun tauri icon` 出的 icns 在 256、16 两档被系统套底板（64 没有）；同一源图经 sips / iconutil 每档都正常。
    tauri 那份用 iconutil 原样重打仍有底板，所以是像素（小尺寸不透明铺到边角）。`scripts/macos-icns.sh` 重出。
  - 验法：NSWorkspace.icon(forFile:) 在 scratchpad 的 .app 副本上按尺寸画出来看；重装后 /Applications 那份同样画过，五档都没有底板（2026-10-16）。

- [-] 三平台安装、升级、卸载验证
  - 已验：Linux（rpm、deb；X11、Wayland、真实输入法、密钥环）与 macOS。Windows 见 R5。
  - macOS 的缺口：
    - 没有 Developer ID，只能 ad-hoc 签名，首次打开要手动放行
    - 只有 arm64
    - 没有应用内更新（R3 只做提示）
  - 已知不修：Secret Service 在应用运行中重启后，钥匙串会话失效，要重启应用。重估条件：有人报告。
  - 带 Oracle 的 AppImage 不发。重估条件：AppImage 打包可以排除目录而不改 ELF，且 `sha256sum` 比对 AppDir 与
    `src-tauri/vendor/instantclient` 一致。
  - CJK 与彩色 emoji 字体靠发行版桌面自带。

---

## P6 / P7 还开着的

- [ ] ~~A2b 整库结构导出~~ **当前版本不做**
  - 理由：用 ER 查询拼出来的脚本和原库不等价。
  - 重估条件：有人要整库建表脚本。届时 MySQL / SQLite 用原生 DDL，PostgreSQL 等用 `pg_dump --schema-only`。
- [ ] ~~A7 框架代码生成~~ **当前版本不做**
  - 重估条件：到时先只做 Prisma 一种。
- [ ] ~~A8 DataOmni 作为 MCP 服务~~ **当前版本不做**
  - 重估条件：确认「让 Agent 直接查自己配好的库」是日常工作流。届时先单独写设计说明，验收门里要有两条该红的用例：
    「写语句被拒」和「生产连接不可见」。
- [x] A8a 命令行接口（给 Agent 与终端用）**1.0 范围已完成**（第三批「写」等有人要再做，见设计文档 §6）
  - 2026-10-10 用户提出，满足了 A8 的重估条件；先做 CLI，MCP 以后在外面套一层。设计见 `rfcs/agent-cli.md`。
  - 用户 2026-10-10 定：排在 1.0 之前。
  - 实验 E1、E3、E4、E5 已做（2026-10-10，结果在设计文档 §3.1）：
    - 钥匙串认代码身份，所以 CLI 做成主程序的子命令。
    - MySQL、Oracle 的只读事务挡不住 DDL；SQLite 只读打开后 `ATTACH` / `VACUUM INTO` 能写出新文件；
      DuckDB 要关掉外部访问。所以语句白名单是必须的，不是第二层。
  - [x] 只读语句门 `services/read_only_gate.rs`：白名单加每种词法规矩各扫一遍；共用语料 `fixtures/agent-read-only.json`
    （放行的界面也必须判成 read）。逐条拿掉一种规矩，对应的拒绝用例都变红（13 种）。
  - [x] 连接的「命令行与 Agent 访问」（关 / 只读，默认关）：生产连接一律看不见、表单里置灰；导入的连接一律是关。
    界面还没在打包版里看，随第一批一起验。
  - [x] 入口 `dataomni cli`（主程序的子命令）与 `connections`、`version`、`help`：只读打开配置，不迁移明文口令、不回写；
    输出 JSON，错误走 stderr 加退出码。E2 在 debug 构建上过了。
  - [x] `query`：PostgreSQL 系、MySQL 系、SQLite、DuckDB。语句门 → 只读会话（只读事务 / 只读打开）→ 永远回滚；
    默认 200 行、30 秒；读口令最多等 10 秒（钥匙串弹框时直接退出并说明）；留痕写 `dataomni-cli.log`，不记原文。
    真库：本地 Docker 的 PostgreSQL 16、MySQL 8.4 上，去掉只读事务时写能进去（测试变红），加上就被数据库拒绝。
  - [x] 开放凭证绑在连接自己的口令上（设计文档 §5.4）：界面保存时用口令对指纹算 HMAC 存进钥匙串，命令行重算比对；
    只改 `connections.json` 开不了门。免密的连接不需要凭证（Agent 不经过命令行也能用）。逐一拿掉校验、指纹里的主机、
    关闭时删凭证，对应的测试都变红。
  - [x] `query` 支持 ClickHouse：每条请求带 `readonly=1`；账号本身已是 1 或 2 时不带（2 的账号收到 1 会报 164，本地 26.9 实测）。
    真库：本地 26.9 上不带时写能进去、一律带时 `readonly=2` 账号读不了，两个方向都变红。
  - [x] `query` 支持 Oracle：`SET TRANSACTION READ ONLY` 挡 DML，DDL 靠语句门。命令行只认安装包里的 Instant Client，
    不认 `DATAOMNI_ORACLE_CLIENT_DIR`（调用方给的环境变量能让进程加载它的库）。真库：本地 23ai 上去掉只读事务时写能进去。
  - [x] `schema`：不带表名列表与视图，带表名给列、索引（每个索引的每一列一行）、外键。用后端现成的目录查询，
    表名与 schema 走绑定参数；SQLite 的目录查询补了后端解码（界面仍走插件）。
  - [x] 开 hardened runtime（设计文档 §5.4 E7）：ad-hoc 签名加 `--options runtime`，entitlement 只放宽库校验（给 Instant Client）。
    打包版验过：签名带 runtime、`codesign --verify --deep --strict` 通过、`DYLD_INSERT_LIBRARIES` 注不进去、应用起得来、
    Oracle 走安装包里的 Instant Client 加载成功（连空端口报 ORA-12541），`DATAOMNI_ORACLE_CLIENT_DIR` 指向别处也不认、
    带 `LD_LIBRARY_PATH` 从终端跑命令行 3 次都正常（E2）、连接表单里「命令行与 Agent 访问」渲染正常。
    E1b 验过（设计文档 §3.1）：界面存的口令，命令行连读 3 次不弹框；改成生产环境后命令行看不见。Windows、Linux 不受影响但没跑 CI。
  - [x] 修：先选「命令行与 Agent 访问」再点数据库类型，这一项被类型的默认值盖回「关」（8cc16e5）。E1b 手动建连接时发现：
    界面上选过只读，存下来是关。测试照表单从上往下的顺序走一遍并检查交给后端的配置，去掉修复会红。
    同一次存下来的「保存口令」也是关：用户没勾，不是缺陷。
  - [x] 开了只读却不保存口令时，表单提醒命令行连不上（563a7a5）。打包版里看过：提醒显示，勾上保存口令后消失。
  - [x] `explain <连接> <SQL>`：计划树加数据库原文，永不 ANALYZE；语句先过语句门（去掉这一步测试会红）。
    PostgreSQL、MySQL、ClickHouse（cu）与 Oracle（本机 Docker）真库取到计划；Oracle 不开只读事务，理由见设计文档 §6。
  - [x] `test <连接>`：与 `query` 同样只读地打开，连得上回 `ok`；网络库连不上时错误里带诊断（解析、TCP）。
    同时修了：库没起来时 `query` 等满 30 秒、报成语句超时（退出码 1）——建立连接另设 10 秒上限，报「连不上」（4）。
    反向验证：上限调到 60 秒，测试红在退出码 1。
  - CI：从 83a1bc9 起一直红在 `logging.test.ts`「后端不往标准输出打印」（命令行的 `eprintln!`），371e3f7 修好：
    门对 `src-tauri/src/cli/` 只放行 println!/eprintln!。教训：每次提交前跑全量 `bun run check`，不只跑单个文件。
    这道门一挡，Rust 测试在 CI 上就没跑过；371e3f7 之后露出第二处：两条命令行测试读的是真钥匙串，Linux 上
    没有凭据库，读取报错，退出码成了 4。改成测试里用内存凭据库（本机也就不再去读用户的钥匙串）；
    让内存库对缺失项报错，复现出同样的 4 对 2。
    hardened runtime 的打包只在 release.yml（打 tag）里跑，CI 不打 macOS 包，要到下一次发版才在 CI 上第一次用到。
  - [x] E6（设计文档 §3.1）：经隧道连 cu 每次 4.2～4.4 秒，几乎全是网络往返（一个往返 170～250 ms），合 22～26 个单位。
    用户定了 1.0 之前**不做常驻进程**，放到 A8（MCP）一起做；判据改成按往返算，门是不超过 32（调到 15 会红）。
  - 第一批做完（`connections`、`query`、`schema`、`explain`、`test`、`version`）。第二批见下：
  - [x] `dictionary <连接>`：整库的数据字典，Markdown（与界面导出的英文版逐字相同，共用语料
    `fixtures/dictionary-conformance.json`；分别改坏两边，各自的语料测试都变红）。目录用 ER 图那两段整库查询，
    PostgreSQL、MySQL（cu）、Oracle（本机 Docker）、ClickHouse（cu）真库上读到了探针表。输出是 Markdown 不是 JSON，
    帮助里写明了。
  - [x] `mongo <连接> collections / find / count / aggregate / explain / structure`：只有读的接口，管道里有 `$out` / `$merge`
    解析时就拒（拿掉这道拦截，两条测试变红）。文档按 relaxed Extended JSON 输出，数量与字节上限同 `query`。
    SQL 命令遇到 Mongo 连接时指向 `mongo`。cu 上的 MongoDB 8.0 真库：六个操作都读到探针集合，被拒的 `$out` 没写出集合。
  - [x] `redis <连接> keyspaces / scan / get / command`：`command` 只放行服务器 `COMMAND INFO` 里带 `readonly` 旗标的
    （子命令按 `名字|子命令` 查）。cu 上的 Redis 7.4 真库：`SET`、`DEL`、`FLUSHDB`、`CONFIG SET`、会写的 `EVAL`、`SELECT`、
    `BLPOP` 都被拒、值不变；`GET`、`OBJECT ENCODING` 照常。拿掉旗标检查，`SET` 真的写了进去，测试变红。
  - [x] `neo4j <连接> labels / run`：先 `EXPLAIN` 问查询类型只放行 `r`，再在读模式的事务里跑。cu 上的 Neo4j 2026.09 与 5.26：
    `CREATE`、`SET`、`DETACH DELETE`、建索引都被拒，节点不变；绕过第一层直接在读模式里写，服务端报 AccessMode。
    去掉第一层，测试红在退出码（读模式仍挡住了写）。
  - [x] `es <连接> indices / request`：方法加路径白名单，按段比对（`GET` / `HEAD` 放行但不含 `_refresh` 这类运维端点，
    `POST` 只到查询类端点，`PUT` / `DELETE` 一律拒）。设计文档里 `POST … _mapping` 放行是错的（那是改映射），已更正。
    cu 上的 ES 8.19：`_search`、`_count`、`_msearch` 读到数据，写的六种被拒、文档数不变；实测 `POST /索引/_doc/_search`
    真的写进一个 id 为 `_search` 的文档，所以不按子串判。放宽 `POST`，两条测试变红。ES 9 与 OpenSearch 没跑（门是纯函数，传输层是界面那份）。
  - [x] `csv-preview <文件>`：复用导入的预览（嗅探分隔符与编码、参差行）。
  - [x] `export <连接> <SQL> --out 文件`（csv、json）：语句门 → 只读事务里导出 → 回滚；只写新文件。`export_query` 拆出
    `export_in`（在给定连接上导出），界面那条路不变。去掉语句门测试红；cu 的 PG 上去掉只读事务，`nextval()` 真的跑了、测试红。
    `sql` 格式没做（缺计算列、自增列的元数据）。
  - [x] `ddl <连接> <表>`：数据库自己的定义原文（同界面「对象定义」），不移植 `tableDdl.ts`。SQLite 端到端；cu 的 MySQL 上
    `SHOW CREATE TABLE` 与带反引号的表名、PG 上表没有原文时指向 `schema`。顺带：sqlx 给 MySQL 的错误码是 SQLSTATE（`42S02`），
    不是错误号，`QueryError.code` 的注释原先写错了。Oracle、ClickHouse、DuckDB 的定义查询命令行没单独跑（界面在用）。
  - [x] `backup <连接> --out 路径`：同界面的 `services::backup`。SQLite 在只读打开的库上 `VACUUM INTO`（源文件逐字节不变）；
    DuckDB 被命令行的「关外部访问」挡住（实测），备份另开一条只读、不关外部访问的连接，只跑 `EXPORT DATABASE`。
    PG / MySQL / MongoDB 走外部工具，服务层已有真库冒烟；命令行这边用连不上的 PG 验了接线（pg_dump 报错、不留文件）。
  - 第二批做完。
  - [x] `guide`：给 Agent 读的说明，格式是 Claude Code 的 Skill（`SKILL.md`），源文件 `src-tauri/src/cli/guide.md` 编进二进制。
    门：每个命令都要在 `help` 与 `guide` 里出现、dispatch 认得它——写的时候就红过一次（`ddl`、`backup` 没写全调用形式）。
  - [x] `scripts/install-macos.sh` 装完建 `~/.local/bin/dataomni` → 应用里的二进制（同名的不是软链接就不动；不在 PATH 里时提示）。
    三种情况在临时 HOME 里跑过。顺带修：macOS 上经软链接启动时 `current_exe` 给的是软链接自己的路径（实测），
    命令行照它找不到安装包里的 Instant Client；先解析软链接，去掉这一步测试变红。
  - [x] README（特性一节、安装后的软链接、更新日志）与用户手册（「命令行与 Agent」一章）。
  - [x] 打包版抽查（2026-10-12，`/Applications` 里 10-10 构建的 0.6.1）：临时 HOME 里放免密的测试连接（不碰钥匙串，
    不动用户的 `connections.json`），本机 Docker 的 PG 16、MySQL 8.4、Redis 7、ES 8.19、Neo4j 5，cu 上用完即删的 MongoDB 8.0，
    加 SQLite、DuckDB 文件。全部命令都跑了：读的照常；`DELETE`、多条语句、`nextval()`、CTE 里的写、`EXPLAIN ANALYZE`、
    `$out`、`SET` / `FLUSHDB`、Cypher `CREATE`、ES 的 `PUT` 与 `/_doc/_search` 都是退出码 3，数据不变；生产与关闭的连接看不见；
    连不上是 4 并带诊断；留痕里没有语句原文。发现两处：
    - [x] JSON 导出里 MySQL 的所有整数（含 32 位 `INT`）与 SQLite 的 `INTEGER` 写成字符串（`"1"`），PG 的 `int4`、DuckDB、Oracle、
      ClickHouse 的小整数写成数字；`query` 输出两边都是数字。原因：这两家解码一律标 `bigint`，`json_field` 把 `bigint` 一律加引号。
      界面导出同一条路径。修（`bffc111`）：不超过 ±(2^53−1) 的 bigint 写成数字，与 DuckDB / Oracle / ClickHouse 同一判据；
      前后端同改，共用语料加边界用例（改前两边都红）。MySQL 8.4 经命令行复验。代价：同一个 bigint 列里，小值是数、
      大值是字符串（那三家本来就这样）；PG 的 `int8` 小值也从字符串变成数。
    - [x] 端口直接拒绝连接（诊断里 TCP 0 ms）时，命令行仍等满 10 秒的连接上限才报错。根因在共用的 `sqlx_pool::open`：
      sqlx 把 `ConnectionRefused` 当成库在启动、退避重试到 acquire 超时，所以界面上是等 30 秒、报成「主机没回应」。
      修（`c85a272`）：开池子的同时，一秒后还没连上就探一次端口，被拒就立刻报 sqlx 的原话。新测试改前红、探测延迟调到
      10 秒也红；本机 MySQL / PG 上正常连接不变，停库后 1.3 秒报出。界面上的报错没在打包版里看过。
  - A8a 的 1.0 范围做完（第一、二批 + guide + 安装）。第三批（写）按设计文档 §6 等有人要再做；MCP 见 A8。
    还没在 CI 上跑过的：打 tag 时 release.yml 的 hardened runtime 打包（要用户批准打 tag）。
- [!] B1b KingbaseES：**阻塞，没有安装包**。解除条件：拿到试用安装包。
- [ ] ~~B3 云库认证~~ **不做**（2026-10-05 定）
- [ ] B4 驱动按 Cargo feature 拆分
  - 重估条件，满足任一条：
    - 出现第一个不许随包分发、或只在部分平台有客户端库的数据库（多半是达梦）
    - 包大小成了问题（现在 171 MB）
  - 做法：
    - `DatabaseType` 不加 `cfg`
    - 后端报告驱动清单
    - 门按 feature 成立
    - CI 构建两套组合

## 暂不优先

- [ ] 团队实时协作
- [ ] 云端数据同步
- [ ] AI 自动执行写操作
- [ ] 大型 BI 仪表盘
- [ ] 在适配器体系完成前继续增加数据库图标
