#!/usr/bin/env bash
# 构建 DataOmni 并装进 /Applications（macOS）。
#
#   scripts/install-macos.sh               # 构建 → 装 → 启动
#   scripts/install-macos.sh --skip-build  # 不构建，装上一次构建出来的 .app
#   scripts/install-macos.sh --no-open     # 装完不启动
#   scripts/install-macos.sh -y            # 装好的那份正开着时不问，直接结束它
#
# 构建与 `bun run package` 相同（带 Oracle Instant Client），只是只出 .app、不出 dmg：
# 装到本机用不着 dmg，而 dmg 那一步会因为上次失败留下的挂载再失败（见 CLAUDE.md）。
set -euo pipefail

app_name=DataOmni
destination="/Applications/$app_name.app"
root="$(cd "$(dirname "$0")/.." && pwd)"

build=1
open_after=1
assume_yes=0
for argument in "$@"; do
  case "$argument" in
    --skip-build) build=0 ;;
    --no-open) open_after=0 ;;
    -y|--yes) assume_yes=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不认识的参数：${argument}（--help 看用法）" >&2; exit 2 ;;
  esac
done

[ "$(uname -s)" = Darwin ] || { echo "只用于 macOS" >&2; exit 1; }
cd "$root"

# 产物在 cargo 的 target 目录下；它可能被 ~/.cargo/config.toml 挪到了别处，问 cargo 最准
target_dir="$(cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 --no-deps \
  | python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')"
bundle="$target_dir/release/bundle/macos/$app_name.app"

if [ "$build" = 1 ]; then
  bash scripts/fetch-oracle-client.sh
  bun tauri build --bundles app --config src-tauri/tauri.oracle.conf.json
fi
[ -d "$bundle" ] || { echo "没找到构建产物：$bundle" >&2; exit 1; }

# 只认装在 /Applications 的那一份：开发时打包目录里跑着的实例不关我们的事
running() { pgrep -f "^$destination/Contents/MacOS/" >/dev/null; }
if running; then
  if [ "$assume_yes" = 0 ]; then
    read -r -p "$app_name 正在运行，结束它再安装？草稿会随工作区保存。[y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || { echo "没装。"; exit 1; }
  fi
  # 不用 AppleScript 的 quit：有未保存草稿时应用会拦下退出，旧进程留着、新包白装
  pkill -f "^$destination/Contents/MacOS/" || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do running || break; sleep 0.5; done
  running && { echo "$app_name 没有退出，没装。" >&2; exit 1; }
fi

# 先拷到旁边再换，拷到一半失败时原来那份还在
staging="$destination.installing"
rm -rf "$staging"
ditto "$bundle" "$staging"
rm -rf "$destination"
mv "$staging" "$destination"
echo "已安装：${destination}（$(defaults read "$destination/Contents/Info" CFBundleShortVersionString)）"

# 命令行（dataomni cli）就是应用自己的二进制：软链接过去，钥匙串认的还是它的代码身份。
# 同名的不是软链接（别的程序装的）就不动它
link_cli() {
  local link="$HOME/.local/bin/dataomni" target="$destination/Contents/MacOS/dataomni"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "没建命令行的软链接：$link 已经是别的文件"
    return
  fi
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$target" "$link"
  echo "命令行：$link → $target"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "  ~/.local/bin 不在 PATH 里，加上它才能直接敲 dataomni cli" ;;
  esac
}
link_cli

# 用 open 启动，别直接跑二进制：shell 里的 LD_LIBRARY_PATH 会让它启动就崩（见 CLAUDE.md）
[ "$open_after" = 1 ] && open "$destination"
exit 0
