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

- **可连接并执行查询**: MySQL, PostgreSQL, SQLite
- **计划中，当前版本连不上**: MongoDB, Redis, Neo4j, DuckDB, ClickHouse, Elasticsearch

  不是「能连上但不能查」——`tauri-plugin-sql` 与 `sqlx` 都只编入了
  sqlite / mysql / postgres 三个驱动，这些 scheme 建连这一步就认不出来。
  连接表单里它们可见但置灰，选中不了；后端 `test_connection` 也会直接拒绝，
  免得手改过的存档绕过界面去撞一句驱动层的报错。

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
  注释 ⌘/、块注释 ⌥A；查找与跳转面板跟随界面语言
- 查询失败时显示数据库原话：SQLSTATE、出错行列（PostgreSQL 可一键跳过去）、
  DETAIL、HINT、约束与表名，可一键复制完整详情
- 危险语句执行前确认，门槛按环境可配（设置 → 危险语句确认）；确认不代替数据库权限
- 把当前标签存成 `.sql` 文件（⌘S），或打开一个 `.sql` 到新标签（标签栏 📂）
- SQL 草稿随工作区恢复；执行历史是独立的一份，记录时间、连接、数据库、语句、
  耗时、状态与影响行数（失败 / 取消 / 超时一样记），可按文本、连接、日期与状态
  搜索，可收藏、命名和打标签，保留周期与条数上限可配（设置 → 查询历史保留）
- 历史里**不存任何结果行**；语句里的口令在写入前就被替换成 `'***'`，
  `IDENTIFIED BY`、`PASSWORD =`、敏感列名赋值与 `INSERT` 的对应列都覆盖到

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
- 结果导出为 CSV / JSON，可选分隔符、表头、NULL 写法与 UTF-8 BOM，
  对话框带真实输出预览
- 整表流式导出：行从数据库直接落盘，不受行数上限截断，带进度、可取消、失败可
  重试；中途停下不会留下一份看上去完整的文件

- ER 关系图：整库的表都画出来（含没有外键的），每张列出全部字段与类型，
  有外键的表之间按具体字段连线；可搜索表名与列名、缩放平移、自由拖动卡片、
  导出为 SVG / PNG / PDF；执行 DDL 后自动刷新

- 表结构编辑：结构页上直接改列名、类型、可空、默认值，加列删列改表名；
  对象树里新建表（填列与主键）。**一律先出预览 SQL 再执行**——预览里分开列出
  会丢什么、会跑什么、哪几项这个方言做不到（带理由）。删列走二次确认，
  并逐条点名受影响的列
- 主键、索引、约束的增删改还要去 SQL 编辑器；SQLite 改列类型、MySQL 改带
  表达式默认值的列类型都明确不做，界面上写明原因

- 事务控制：自动提交开关、开始 / 提交 / 回滚，工作台头部常驻事务状态与计时。
  状态由执行语句的那条连接给出，所以你自己在编辑器里写的 `BEGIN` 一样算数。
  切换连接、断开或退出前若事务还开着，先问一句提交还是回滚，而不是让数据库
  默默回滚掉

- 执行计划：PostgreSQL / MySQL / SQLite 各自的 EXPLAIN，解析成同一棵可展开的树，
  也能看数据库返回的原文。PostgreSQL 还能「真的执行一遍」拿到每一步的实际行数
  与耗时——树上会直接点名估算差了一个数量级以上的那个节点，那通常就是慢的原因
- 慢查询不被时间淘汰，可在历史里单独筛出来；历史从不保存查询结果行

- CSV 导入：三步向导（选文件与读法 → 字段映射 → 策略与执行）。分隔符自动嗅探，
  字段按列名配对、配不上就留空而不按位置猜。导入前分两档提示——会失败的拦住，
  可能不对的只提醒。批量大小、事务策略（整份一个事务 / 每批一个事务）与错误行
  处理（停下 / 跳过）可选；失败的行按**文件里的行号**列出来，连同原始字段值
- 导出：整表、查询结果、或者网格里选中的那一块矩形
- 后台任务：导入与导出都在后台跑，右下角的面板里看进度、暂停（导入）、取消、
  重试与日志。已经写进数据的任务不给「重试」——那只会重复写入

- ER 关系图可按 Schema、以某张表为中心（走 N 跳关系）、只看有关联的表来过滤。
  过滤与搜索是两件事：搜索压暗保住图的形状，过滤直接把表拿掉并重排——
  两百张表的库里，把不相干的压暗仍然什么都看不清

> 尚未实现：筛选的 OR / IN、CSV 导入。

### 🛡️ 凭据与传输安全

- 密码存入系统钥匙串（macOS Keychain / Windows Credential Manager / Linux Secret Service），
  配置文件只保存凭据引用，不落明文
- 支持「不保存密码」，每次连接时输入
- 明确的 TLS 模式（禁用 / 优先 / 要求 / 校验证书 / 校验主机名），支持 CA 与客户端证书
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
- ⌘K / Ctrl+K 命令面板：模糊搜索连接与表，新建查询、打开 SQLite、切换外观
- 数据网格按内容估算列宽、可拖动调整、双击恢复；点表头三态排序；
  键盘选区与 ⌘C 复制为 TSV
- 侧边栏与编辑器高度可拖动并持久化

## 🚀 快速开始

### 构建与验证状态

Tauri 本身跨平台，但**本项目只在下表记录的环境上实际验证过**。未列为「已验证」的
平台不代表不能用，而是**我们没有验证过，不作任何保证**。

| 平台 | 产出安装包 | 状态 | 依据 |
|---|---|---|---|
| macOS (Apple Silicon / aarch64) | `DataOmni.app`、`DataOmni_0.1.0_aarch64.dmg` | ✅ 已验证 | 2026-09-20 于 macOS 27.0 / arm64 执行 `bun tauri build`，退出码 0 |
| macOS (Intel / x86_64) | — | ⚠️ 未验证 | 无 x86_64 机器，也未做交叉编译 |
| Linux (Ubuntu) | — | ⚠️ 仅编译检查 | CI 在 ubuntu-latest 上跑 `bun run build`、`cargo clippy`、`cargo test` 与三库冒烟测试，但**不执行 `tauri build`，从未产出过安装包** |
| Windows | — | ❌ 未验证 | 既无 CI job，也无本地构建记录 |

应用未签名 / 未公证，macOS 首次打开需在「系统设置 → 隐私与安全性」中放行。

### 系统要求

- **操作系统**: 见上表；目前仅 macOS (aarch64) 经过验证
- **内存**: 最低 4GB RAM，推荐 8GB+
- **存储**: 至少 500MB 可用空间

### 安装方式

> 目前尚未发布任何 [Releases](https://github.com/yuxuetr/DataOmni/releases)，
> 没有预编译安装包可下载，只能从源码构建。

#### 从源码构建

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

### 1. 创建数据库连接

1. 启动DataOmni
2. 点击"连接到数据库"按钮
3. 选择数据库类型
4. 填写连接信息
5. 测试连接并保存

### 2. 执行SQL查询

1. 在SQL编辑器中输入查询语句
2. 点击执行按钮或按 `Ctrl+Enter`
3. 查看查询结果
4. 保存常用查询到历史记录

### 3. 浏览数据库结构

1. 在侧边栏查看数据库和表列表
2. 点击表名查看表结构
3. 双击表名快速查看表数据
4. 使用元数据浏览器探索数据库

### 4. 数据操作

1. 在表格视图中直接编辑数据，NULL、空字符串、默认值、SQL 表达式分开表达
2. 新增、修改、删除都先进待提交列表，可逐条撤销
3. 点「提交」一个事务发出去，行数在事务内核对，不对就整批回滚
4. 点「导出」选范围：当前页（内存里那份）或整张表（流式，不分页）

## 🛠️ 技术栈

### 前端

- **框架**: React 18 + TypeScript
- **构建工具**: Vite
- **UI组件**: Tailwind CSS + Lucide Icons
- **状态管理**: Zustand
- **代码编辑器**: CodeMirror

### 后端

- **框架**: Tauri (Rust)
- **数据库驱动**: SQLx
- **序列化**: Serde
- **配置管理**: TOML

### 开发工具

- **IDE**: VS Code + Tauri插件
- **包管理**: Bun
- **版本控制**: Git

## 🏗️ 项目结构

```bash
DataOmni/
├── src/                   # 前端源码
│   ├── components/        # React组件
│   ├── stores/            # 状态管理
│   └── assets/            # 静态资源
├── src-tauri/             # 后端源码
│   ├── src/
│   │   ├── commands/      # Tauri命令
│   │   ├── services/      # 业务服务
│   │   └── models/        # 数据模型
│   └── Cargo.toml         # Rust依赖
├── docs/                  # 文档
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

### v0.1.0（开发中，尚未发布）

- 🔗 MySQL、PostgreSQL、SQLite 的连接、查询与分页
- 🛡️ 凭据存入系统钥匙串，TLS 模式可配置，日志脱敏
- ⚡ 查询超时、取消、结果截断与流式回传
- 📊 表数据浏览与行级增删改

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
