# CLAUDE.md

DataOmni：Tauri 2 + React 18 + TypeScript 的桌面数据库客户端，支持 MySQL、
PostgreSQL、SQLite。Rust 后端在 `src-tauri/`，前端在 `src/`。

本文件只记**仓库自身的事实与约定**。通用的代码风格、提交规范与工程取向在
`~/.claude/CLAUDE.md`，不在这里重复。

## 权威来源

| 想知道 | 看哪里 |
| --- | --- |
| 做到哪了、为什么这么选、哪些明确不做 | `TODOs.md`（活文档，每条带判据与反向验证记录） |
| 对外的能力说明 | `README.md` |
| Tauri 命令清单 | `src-tauri/src/lib.rs` 的 `invoke_handler` |
| 立项时的设计意图 | `rfcs/design.md`（2025-06，**已不跟代码走**，开头有说明） |

`fix_docs/` 是早期的一次性排查记录，已被后续改动大量推翻，不要据它判断现状。

## 命令

包管理器是 **bun**（`bun.lock`）。

```bash
bun run check        # 完整闸门：lint → typecheck → vitest → cargo fmt/clippy/test
bun tauri dev        # 开发（前后端一起）
bun tauri build      # 打包
```

单项：`bun run test`（vitest）、`bun run typecheck`、`bun run lint`、
`bun run rust:test`、`bun run rust:clippy`。

**改了 Rust 必须重新构建**才生效——`bun run dev` 只重载前端，新增的 Tauri
命令在 `bun tauri dev` 重启前调不到。

### 连真库的冒烟测试

`src-tauri/tests/database_smoke.rs` 里连网络数据库的用例默认**静默跳过**。
要跑就设这三个环境变量，只在 shell 里传，**不要写进任何文件**：

```
DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS=1
DATAOMNI_MYSQL_TEST_URL=...
DATAOMNI_POSTGRES_TEST_URL=...
```

用真表（不能用临时表：导出等路径会另开连接），所以用例开头会清掉同前缀的
残留——测试库是共享的，一次断言失败留下的表会一直攒着。

SQL Server、Oracle、MongoDB 各有独立的用例文件（`sql_server_smoke.rs`、
`oracle_smoke.rs`、`mongodb_smoke.rs`），规矩相同，连接串分别是
`DATAOMNI_SQLSERVER_TEST_URL`、`DATAOMNI_ORACLE_TEST_URL`、
`DATAOMNI_MONGODB_TEST_URL`（`mongodb://user:password@host:port/authSource`）。

## 目录

```
src/
  components/   React 组件（TableDataViewer 与 QueryResultScrollTable 是两张主网格）
  stores/       Zustand：app / connection / query / history / workspace / settings / theme / language
  utils/        纯函数，绝大多数决策逻辑在这里，旁边就是同名 .test.ts
  contracts/    跨层的类型与状态机不变量
  i18n/         zh.ts 是源语言，en.ts 声明为 Translations——多一个键少一个键都编译不过
src-tauri/src/
  commands/     Tauri 命令（connection_commands / database_commands / file_commands）
  services/     真正做事的地方（query_executor / write_batch / export_writer / schema_metadata …）
  models/       与前端 contracts 对应的类型
```

**决策逻辑尽量落在 `src/utils/` 的纯函数里**，组件只做渲染。判断「这一行靠哪几
列定位」「这条 SQL 能不能就地改」「这批变更要发哪些语句」都是纯函数加一份测试，
不是组件里的条件分支。

`services/database_service.rs` 只**生成 SQL 文本**，不执行；执行在
`query_executor.rs`。别被名字误导。

## 几条容易踩的

- **不要给表格加虚拟滚动。** 已经测过：最坏 100 行 × 20 列整次重渲染中位数
  25ms，而两张网格本来就分页。重估判据是可执行的——`gridPagination.test.ts`
  断言所有档位不超过 `MAX_UNVIRTUALIZED_ROWS`（200）。见 TODOs 5.4。
- **对象树也不要加虚拟化。** 同样测过：单组 200 项展开 24.8ms，2000 项 183.5ms，
  5000 项 300.1ms。做的是筛选框加单组上限 200（`MAX_RENDERED_TREE_ITEMS`），
  因为滚 185 屏找一张表本来就不是找东西的方式。门同样是可执行的：
  `databaseObjects.test.ts` 断言这个常量不超过**字面量** 200。
- **性能指标定成「驱动量的上限」，不定成毫秒阈值。** 毫秒数跟机器、构建和
  WebView 版本走，照它设阈值要么处处红要么处处绿；而「一次交互画多少个节点」
  是确定的，能在 `bun run check` 里判。四条基线见 TODOs 5.4。
- **界面改动必须真的渲染出来看。** 有过四轮教训：typecheck、lint、单测全绿，
  而界面上印着字面的 `{count}`、把 `unset` 画成 "DEFAULT"、时间戳被截断，
  以及表的列读不到时**整个窗口白屏**（渲染期抛异常会卸掉整棵 React 树）。
  这类缺陷单测抓不到。
- **i18n 占位符**：`t()` 故意保留没替换掉的占位符，所以传错参数名会在界面上留下
  `{count}`。`i18n/catalog.test.ts` 有一道门扫描所有调用点比对，改文案时留意它。
- **导出的格式化有两份实现**（预览在 `utils/exportResult.ts`，写文件在
  `services/export_writer.rs`），靠 `fixtures/export-conformance.json` 这份共用
  语料钉住。改任何一侧都要同时过两边的测试。
- **`bun tauri build` 报 `failed to run bundle_dmg.sh` 时先看 `/Volumes`。**
  上一次失败留下的 `dmg.*` 还挂着就会再失败，而那句报错不说原因。
  `hdiutil detach /Volumes/dmg.*` 再删掉 `bundle/macos/rw.*.dmg` 即可。
- **验打包后的应用要用 `open -a`，别从终端直接跑那个二进制。** 这台机器的 shell
  里有 `LD_LIBRARY_PATH=/opt/homebrew/lib`，而 macOS 的 dyld 认这个变量：
  Homebrew 的 libpng 会抢在 Apple 内部那份前面加载，ImageIO 解 PNG 时跳进
  ABI 不兼容的实现，启动一秒多就 SIGBUS。堆栈全在 ShareKit / ImageIO 里，
  看起来跟我们毫无关系，实际也确实不是我们的 bug。A/B 验过：带这个变量 3 次崩
  3 次，只摘掉它 3 次都不崩。`open -a` 走 launchd，不继承 shell 环境。
- 凭据走系统钥匙串（`services/connection_service.rs` 的 keyring），不落盘明文。
