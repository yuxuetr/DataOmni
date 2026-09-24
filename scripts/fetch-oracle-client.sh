#!/usr/bin/env bash
# 取 Oracle Instant Client（Basic Light）的最小文件集，放进 src-tauri/vendor/instantclient，
# 打包时由 src-tauri/tauri.oracle.conf.json 带进安装包。
#
#   scripts/fetch-oracle-client.sh            # 按本机平台
#   scripts/fetch-oracle-client.sh linux-x64  # 或者点名
#
# 许可：Basic Light 附带的 BASIC_LITE_LICENSE 是「Oracle Free Distribution, Hosting, and
# Use Terms」，允许原样随应用分发——不收费、附上许可、不改文件。所以这里只挑文件、不改
# 文件，许可原文一起拷进去。
#
# 只挑能连上、能出错误消息的那几个：libclntsh / libclntshcore / libnnz / libociicus，外加
# fips / fips1403 / legacy 三个加密模块（少了它们登录报 ORA-28041，错误里不提缺文件）。
# JDBC、OCCI、SQL*Plus 之类不要。
set -euo pipefail

version=23.26.3.0.0
mac_version=23.26.2.0.0
root="$(cd "$(dirname "$0")/.." && pwd)"
target="$root/src-tauri/vendor/instantclient"
cache="${DATAOMNI_ORACLE_CACHE:-$HOME/.cache/dataomni/instantclient}"

platform="${1:-}"
if [ -z "$platform" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) platform=linux-x64 ;;
    Darwin-arm64) platform=macos-arm64 ;;
    MINGW*|MSYS*|CYGWIN*) platform=windows-x64 ;;
    *) echo "不认识的平台 $(uname -s)-$(uname -m)，请点名：linux-x64 / macos-arm64 / windows-x64" >&2; exit 1 ;;
  esac
fi

case "$platform" in
  linux-x64)
    url="https://download.oracle.com/otn_software/linux/instantclient/2326300/instantclient-basiclite-linux.x64-$version.zip"
    sha=88c2b59d473f0d34615556dbee51cb90cce61a9104b4c1c772d13c344fba19c9
    files="libclntsh.so.23.1 libclntshcore.so.23.1 libnnz.so libociicus.so fips.so fips1403.so legacy.so"
    ;;
  macos-arm64)
    url="https://download.oracle.com/otn_software/mac/instantclient/2326200/instantclient-basiclite-macos.arm64-$mac_version.dmg"
    sha=54defa9e957da0aef6219965da3cb2d22ac19bfb20f168741b424c89e90d47ea
    files="libclntsh.dylib.23.1 libclntshcore.dylib.23.1 libnnz.dylib libociicus.dylib fips.dylib fips1403.dylib legacy.dylib"
    ;;
  windows-x64)
    # 未在 Windows 上验证过：文件集照 Linux 那一份的对应物挑，没有可对照的校验和
    url="https://download.oracle.com/otn_software/nt/instantclient/2326300/instantclient-basiclite-windows.x64-$version.zip"
    sha=""
    files="oci.dll oraociicus23.dll orannzsbb.dll oraons.dll fips.dll legacy.dll"
    ;;
  *) echo "不认识的平台 $platform" >&2; exit 1 ;;
esac

mkdir -p "$cache"
archive="$cache/$(basename "$url")"
if [ ! -f "$archive" ]; then
  echo "下载 $(basename "$url") …"
  curl -fSL --retry 3 -o "$archive.part" "$url"
  mv "$archive.part" "$archive"
fi
if [ -n "$sha" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$archive" | cut -d' ' -f1)"
  else
    actual="$(shasum -a 256 "$archive" | cut -d' ' -f1)"
  fi
  if [ "$actual" != "$sha" ]; then
    echo "校验和不对：$archive（期望 $sha，实际 $actual）" >&2
    exit 1
  fi
else
  echo "警告：$platform 没有可对照的校验和，未校验" >&2
fi

rm -rf "$target"
mkdir -p "$target"
case "$archive" in
  *.zip)
    work="$(mktemp -d)"
    unzip -q "$archive" -d "$work"
    source_dir="$(find "$work" -maxdepth 1 -type d -name 'instantclient_*' | head -1)"
    ;;
  *.dmg)
    work="$(mktemp -d)"
    hdiutil attach -nobrowse -readonly -mountpoint "$work/mnt" "$archive" >/dev/null
    source_dir="$work/mnt"
    ;;
esac
for file in $files BASIC_LITE_LICENSE BASIC_LITE_README; do
  cp "$source_dir/$file" "$target/"
done
# mac 那份是只读的 dmg，拷出来的文件也不可写；打包时 tauri 把它们原样拷进
# target/release/instantclient，于是第二次打包覆盖不了上一次的，报一句不带文件名的
# Permission denied。只改权限位，不改文件内容。
chmod u+w "$target"/*
case "$archive" in
  *.dmg) hdiutil detach "$work/mnt" >/dev/null ;;
esac
rm -rf "$work"
echo "Instant Client（$platform）已放到 $target：$(du -sh "$target" | cut -f1)"
