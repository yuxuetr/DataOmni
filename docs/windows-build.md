# Windows 开发、编译与打包指南
本指南适用于在 Windows 上构建 DataOmni 的开发版可执行程序和发布安装包。项目使用 Bun、Vite、Rust 与 Tauri 2。
## 产物说明
当前打包配置位于 `src-tauri/tauri.conf.json`，`bundle.targets` 为 `all`。执行完整发布构建后会生成：
- 未安装的发布版可执行程序：`src-tauri/target/release/dataomni.exe`
- MSI 安装包：`src-tauri/target/release/bundle/msi/DataOmni_0.1.0_x64_en-US.msi`
- NSIS 安装程序：`src-tauri/target/release/bundle/nsis/DataOmni_0.1.0_x64-setup.exe`

版本号与产品名来自 `src-tauri/tauri.conf.json`；版本变更后，安装包文件名会相应变化。
## 前置环境
建议使用 64 位 Windows 10 或 Windows 11，并在 PowerShell 中执行以下命令。
### 必需软件
- Git：用于获取项目源码。
- Bun：项目的 JavaScript 包管理器与脚本运行时。
- Rust：安装稳定版 MSVC 工具链，目标为 `x86_64-pc-windows-msvc`。
- Visual Studio 2022 Build Tools 或 Visual Studio 2022：必须安装 **使用 C++ 的桌面开发** 工作负载，至少包含 MSVC x64/x86 C++ 生成工具与 Windows SDK。
- Microsoft Edge WebView2 Runtime：开发机应已安装；Windows 10/11 通常自带。默认安装包会在终端用户机器缺失运行时时下载并安装它。

VS Code 不是 C++ 构建工具，单独安装它不会提供 Rust 所需的 `link.exe`。
### 安装与检查
安装 Bun 与 Rust 后，确认工具可用：
```powershell
bun --version
rustc --version
cargo --version
rustup show active-toolchain
```

如果没有 MSVC Rust 工具链，安装并设为默认：
```powershell
rustup toolchain install stable-x86_64-pc-windows-msvc
rustup default stable-x86_64-pc-windows-msvc
```

使用 Windows Package Manager 安装 Visual Studio Build Tools 与 C++ 工作负载：
```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --source winget --override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

安装或修改 Visual Studio Build Tools 后，请关闭并重新打开终端，再继续执行构建命令。这样新的终端才能发现 MSVC 的 `link.exe`。
## 初始化项目
在仓库根目录执行：
```powershell
bun install
```

该命令会根据锁文件安装前端、Tauri CLI 与其余依赖。不要用 `npm install` 或 `pnpm install` 混用包管理器，以免改变锁文件与依赖解析结果。
## 开发模式
启动 Vite 开发服务器和 Tauri 桌面窗口：
```powershell
bun tauri dev
```

Tauri 会先运行 `bun run dev`，再使用 Rust 的开发配置编译和启动原生后端。前端开发服务器默认地址为 `http://localhost:1420/`。

若首次执行时提示 `link.exe not found`，说明当前终端没有找到 MSVC 链接器；检查 Visual Studio Build Tools 的 C++ 工作负载是否安装完成，并重新打开终端。
## 仅生成可执行文件
如只需要发布版 `.exe`，不需要安装程序：
```powershell
bun tauri build --no-bundle
```

产物位于：
```text
src-tauri/target/release/dataomni.exe
```

该文件不是安装包。运行它的机器仍需满足 Tauri 所需的 WebView2 Runtime 条件。
## 生成 Windows 安装包
### 完整构建
执行：
```powershell
bun tauri build
```

该命令依次执行：
1. `bun run build`：运行 TypeScript 检查与 Vite 生产构建，输出到 `dist/`。
2. `cargo build --release`：编译 Rust/Tauri 可执行文件。
3. Tauri bundler：按当前 `targets: "all"` 生成 MSI 与 NSIS 两种安装包。

产物目录：
```text
src-tauri/target/release/bundle/msi/
src-tauri/target/release/bundle/nsis/
```

### 只生成一种安装包
仅生成 MSI：
```powershell
bun tauri build --bundles msi
```

仅生成 NSIS 安装程序：
```powershell
bun tauri build --bundles nsis
```

MSI 便于企业软件分发、组策略或软件管理系统部署；NSIS 的 `-setup.exe` 更适合直接向个人用户分发。
## 构建前检查
完整检查会运行前端静态检查、单元测试、Rust 格式检查、Clippy 和 Rust 测试：
```powershell
bun run check
```

发布前建议至少执行：
```powershell
bun run check
bun tauri build
```

`dist/` 与 `src-tauri/target/` 是生成目录，不应手动加入 Git。
## 常见问题
### `link.exe not found`
原因：Rust 的 `x86_64-pc-windows-msvc` 目标需要 Microsoft C++ 链接器。

处理：
1. 安装 Visual Studio 2017 或更高版本，或 Visual Studio Build Tools。
2. 安装 **使用 C++ 的桌面开发** / `Microsoft.VisualStudio.Workload.VCTools` 工作负载。
3. 重新打开终端并再次执行 `bun tauri build`。

### `protocol: http response missing version`
原因：Tauri 在第一次打包 MSI/NSIS 时需要从 GitHub 下载 WiX 或 NSIS 工具。某些代理、网络拦截设备或损坏的 HTTP 响应会导致 Tauri 内置下载器无法解析响应。

处理建议：
1. 确认浏览器和 PowerShell 可以访问 GitHub Release 资源。
2. 清理不完整的 Tauri 工具缓存后重试：
   ```powershell
   Remove-Item "$env:LOCALAPPDATA\tauri\WixTools314" -Recurse -Force -ErrorAction SilentlyContinue
   Remove-Item "$env:LOCALAPPDATA\tauri\NSIS" -Recurse -Force -ErrorAction SilentlyContinue
   bun tauri build
   ```
3. 若问题持续，在可访问 GitHub Release 的网络环境中预下载与当前 Tauri CLI 版本匹配的 WiX 和 NSIS 工具，校验发布方提供的哈希后放入 `%LOCALAPPDATA%\tauri` 缓存目录，或改用可直接访问 GitHub 的网络/代理。

不要从不可信镜像下载 WiX、NSIS 或 DLL 插件，也不要跳过哈希校验。
### Vite 的大包警告
`Some chunks are larger than 500 kB after minification` 只是一条构建警告，不会阻止生成安装包。需要优化启动体积时，可将大型功能改为动态导入，或在 Vite 配置中设置 Rollup 的 `manualChunks`。
### Rust 的 future-incompatibility 警告
`num-bigint-dig` 的 future-incompatibility 提示不阻止当前构建。可使用以下命令查看 Cargo 报告：
```powershell
cargo report future-incompatibilities --manifest-path src-tauri/Cargo.toml
```
## 发布前核对
1. 在干净或测试 Windows 虚拟机上安装 MSI 和 NSIS 安装包，验证启动、卸载与升级行为。
2. 确认应用版本、图标、产品名称和安装包架构正确。
3. 如需减少 SmartScreen 提示，应为 `.exe`、MSI 以及安装程序配置代码签名；当前构建流程不会自动签名。
4. 不要提交 `dist/`、`src-tauri/target/` 或用户目录下的 Tauri 工具缓存。
