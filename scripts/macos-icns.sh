#!/usr/bin/env bash
# 用 macOS 自带的 sips / iconutil 从 src-tauri/app-icon.png 生成 src-tauri/icons/icon.icns。
# 只在 macOS 上跑；换图标时先 `bun tauri icon`（其余平台的图标），再跑这个覆盖 icns。
#
#   scripts/macos-icns.sh
#
# 为什么不用 `bun tauri icon` 出的 icns：它缩出来的 16、128 等几档把不透明一直铺到边角，
# 新版 macOS 判定这种图标不合圆角网格，在 Dock / Finder 里给它套一层灰色底板缩在中间，
# 而且只在部分尺寸上套（256 与 16 有，64 没有）。同一张源图经 sips 缩放，边缘留着一圈透明，
# 每一档都由系统直接切成标准圆角。验法：NSWorkspace.icon(forFile:) 把 .app 的图标按各尺寸画出来看。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
source="$root/src-tauri/app-icon.png"
work="$(mktemp -d)"
trap 'rm -r "$work"' EXIT
iconset="$work/icon.iconset"
mkdir "$iconset"

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$source" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$source" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$root/src-tauri/icons/icon.icns"
echo "wrote src-tauri/icons/icon.icns"
