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
- **仅有连接表单，尚不能执行查询**: MongoDB, Redis, Neo4j, DuckDB, ClickHouse, Elasticsearch

  这些类型目前只有连接串拼装和字段校验，查询执行层（`DbPool`）仅实现了
  SQLite / MySQL / PostgreSQL 三种，选择其它类型无法真正读写数据。

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
- SQL 草稿按连接恢复（**尚无独立的执行历史：时间、耗时、状态、影响行数均未留存**）

### 📊 数据浏览与编辑

- 表格视图浏览表数据，服务端 LIMIT / OFFSET 分页并采用稳定排序
- BigInt、Decimal 保持精度，时间类型保留时区语义
- 无法唯一定位记录时结果只读，不允许写入
- 更新、删除后校验影响行数，异常时明确报错
- 结果导出为 CSV / JSON，可选分隔符、表头、NULL 写法与 UTF-8 BOM
  （查询结果导出排序后的整份；表数据服务端分页，导出的是当前页，对话框写明范围）

- ER 关系图：整库的表都画出来（含没有外键的），每张列出全部字段与类型，
  有外键的表之间按具体字段连线；可搜索表名与列名、缩放平移、自由拖动卡片、
  导出为 SVG / PNG / PDF；执行 DDL 后自动刷新

> 尚未实现：服务端排序与筛选、变更集与差异预览、整表流式导出。

### 🛡️ 凭据与传输安全

- 密码存入系统钥匙串（macOS Keychain / Windows Credential Manager / Linux Secret Service），
  配置文件只保存凭据引用，不落明文
- 支持「不保存密码」，每次连接时输入
- 明确的 TLS 模式（禁用 / 优先 / 要求 / 校验证书 / 校验主机名），支持 CA 与客户端证书
- 日志统一脱敏，不打印密码、Token 和完整连接串
- 标识符由数据库方言安全引用，保留字与特殊字符表名可安全使用

- 破坏性语句执行前二次确认：不带 WHERE 的 UPDATE / DELETE 与
  DROP / TRUNCATE / ALTER … DROP COLUMN 在任何环境都拦；带 WHERE 的写入只在
  生产环境拦；SELECT 与 INSERT 不拦
- 生产 / 预发连接常驻文字标识，不只靠颜色区分

> 尚未实现：确认策略的用户可配置化（目前是固定规则），以及权限层面的写保护。

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

1. 在表格视图中直接编辑数据
2. 支持新增、修改、删除操作
3. 每次提交即时写入数据库（变更集与差异预览尚未实现）
4. 点「导出」把当前结果写成 CSV 或 JSON（整表流式导出尚未实现）

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
