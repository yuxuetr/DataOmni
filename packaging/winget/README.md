# winget 清单

`manifests/` 下的目录结构与 [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) 相同。

## 发一个新版本

1. 版本在 GitHub 上正式发布（不是草稿、不是预发布）。
2. `scripts/winget-manifest.sh <版本>`：从发布页取安装包的 SHA-256，写出
   `manifests/y/yuxuetr/DataOmni/<版本>/` 下的三个文件。
3. 提交 PR（对外操作，由维护者自己做）：
   - 用 [wingetcreate](https://github.com/microsoft/winget-create)：
     `wingetcreate submit --token <GitHub token> packaging/winget/manifests/y/yuxuetr/DataOmni/<版本>`；
   - 或者 fork winget-pkgs，把这个目录拷到同一路径，再手动提 PR。
   - 提交前可以在 Windows 上跑 `winget validate --manifest <目录>` 与
     `winget install --manifest <目录>` 先试一遍。

## 说明

- 两种安装包都列上了：NSIS 按用户装（`%LOCALAPPDATA%\DataOmni`），MSI 按机器装（`C:\Program Files\DataOmni`）。
  `winget install yuxuetr.DataOmni` 默认装哪种由 winget 决定，`--scope user` / `--scope machine` 可以指定。
- 没写 `LicenseUrl`：仓库里还没有 `LICENSE` 文件（README 写的是 MIT）。补上之后在脚本的 locale 清单里加
  `LicenseUrl: https://github.com/yuxuetr/DataOmni/blob/main/LICENSE`。
- 清单对着 winget 官方的 1.10.0 JSON Schema 校验过（2026-11-06）。
