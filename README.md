# DataOmni - 现代化的数据库管理工具

<div align="center">

![DataOmni Logo](https://img.shields.io/badge/DataOmni-数据库管理工具-blue?style=for-the-badge&logo=database)
![Platform](https://img.shields.io/badge/平台-Windows%20%7C%20macOS%20%7C%20Linux-green?style=for-the-badge)
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

### 🔗 多数据库支持

- **关系型数据库**: MySQL, PostgreSQL, SQLite
- **非关系型数据库**: MongoDB, Redis, Neo4j
- **分析平台**: DuckDB, ClickHouse, Elasticsearch

### ⚡ 高性能查询

- 优化的SQL编辑器，支持语法高亮
- 智能提示和自动补全
- 查询历史记录和保存功能
- 实时查询执行和结果展示

### 📊 数据可视化

- 直观的表格视图，快速浏览数据
- 支持大数据量的分页显示
- 数据编辑和实时更新
- 导出功能支持多种格式

### 🛡️ 安全可靠

- 本地存储连接信息，保护数据安全
- 连接加密和SSL支持
- 查询验证和危险操作防护

### 🎨 现代化界面

- 基于Tauri构建，原生性能
- 响应式设计，适配不同屏幕
- 深色/浅色主题支持
- 流畅的动画和交互体验

## 🚀 快速开始

### 系统要求

- **操作系统**: Windows 10+, macOS 10.15+, Linux (Ubuntu 18.04+)
- **内存**: 最低 4GB RAM，推荐 8GB+
- **存储**: 至少 500MB 可用空间

### 安装方式

#### 方式一：下载预编译版本

1. 访问 [Releases](https://github.com/yuxuetr/DataOmni/releases) 页面
2. 下载对应平台的安装包
3. 运行安装程序

#### 方式二：从源码构建

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
3. 实时保存更改
4. 导出数据到CSV、JSON等格式

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

### v0.1.0 (2025-06-20)

- ✨ 初始版本发布
- 🎨 现代化UI界面设计
- 🔗 支持MySQL、PostgreSQL、SQLite
- 📊 基础数据查询和展示功能
- 🛡️ 连接管理和安全功能

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
