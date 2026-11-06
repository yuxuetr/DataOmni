#!/usr/bin/env bash
# 为一个已发布的版本生成 winget 清单（TODOs「1.x」U2）。
#
#   scripts/winget-manifest.sh 1.0.0
#
# 写到 packaging/winget/manifests/y/yuxuetr/DataOmni/<版本>/，目录结构与 microsoft/winget-pkgs 相同，
# 整个目录拷进那个仓库的同一路径就能提 PR。提 PR 是对外操作，由用户自己做（用户 2026-11-06 定）。
#
# 安装包的 SHA-256 取 GitHub 发布页给的 digest（服务端算的），不重新下载。两种安装包都列上：
# NSIS 按用户装（%LOCALAPPDATA%\DataOmni），MSI 按机器装（C:\Program Files\DataOmni），见 R5。
set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <version>   (a published release such as 1.0.0; prereleases do not go to winget)" >&2
  exit 2
fi

repo="yuxuetr/DataOmni"
tag="v$version"
id="yuxuetr.DataOmni"
manifest_version="1.10.0"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/packaging/winget/manifests/y/yuxuetr/DataOmni/$version"

exe="DataOmni_${version}_x64-setup.exe"
msi="DataOmni_${version}_x64_en-US.msi"

digest_of() {
  local name="$1" digest
  digest="$(gh release view "$tag" --repo "$repo" --json assets \
    -q ".assets[] | select(.name == \"$name\") | .digest")"
  if [[ "$digest" != sha256:* ]]; then
    echo "no sha256 digest for $name in release $tag" >&2
    exit 1
  fi
  echo "${digest#sha256:}" | tr '[:lower:]' '[:upper:]'
}

if [[ "$(gh release view "$tag" --repo "$repo" --json isDraft,isPrerelease -q '.isDraft or .isPrerelease')" != "false" ]]; then
  echo "$tag is a draft or a prerelease; winget only takes published releases" >&2
  exit 1
fi
release_date="$(gh release view "$tag" --repo "$repo" --json publishedAt -q '.publishedAt[:10]')"
exe_sha="$(digest_of "$exe")"
msi_sha="$(digest_of "$msi")"

mkdir -p "$out"
download="https://github.com/$repo/releases/download/$tag"
header="# Created with scripts/winget-manifest.sh"

cat > "$out/$id.yaml" <<EOF
$header
# yaml-language-server: \$schema=https://aka.ms/winget-manifest.version.$manifest_version.schema.json

PackageIdentifier: $id
PackageVersion: $version
DefaultLocale: en-US
ManifestType: version
ManifestVersion: $manifest_version
EOF

cat > "$out/$id.installer.yaml" <<EOF
$header
# yaml-language-server: \$schema=https://aka.ms/winget-manifest.installer.$manifest_version.schema.json

PackageIdentifier: $id
PackageVersion: $version
ReleaseDate: $release_date
Installers:
- Architecture: x64
  InstallerType: nullsoft
  Scope: user
  InstallerUrl: $download/$exe
  InstallerSha256: $exe_sha
  UpgradeBehavior: install
- Architecture: x64
  InstallerType: wix
  Scope: machine
  InstallerLocale: en-US
  InstallerUrl: $download/$msi
  InstallerSha256: $msi_sha
  UpgradeBehavior: install
ManifestType: installer
ManifestVersion: $manifest_version
EOF

cat > "$out/$id.locale.en-US.yaml" <<EOF
$header
# yaml-language-server: \$schema=https://aka.ms/winget-manifest.defaultLocale.$manifest_version.schema.json

PackageIdentifier: $id
PackageVersion: $version
PackageLocale: en-US
Publisher: yuxuetr
PublisherUrl: https://github.com/yuxuetr
PublisherSupportUrl: https://github.com/$repo/issues
PackageName: DataOmni
PackageUrl: https://github.com/$repo
License: MIT
LicenseUrl: https://github.com/$repo/blob/main/LICENSE
ShortDescription: Desktop client for relational databases, MongoDB, Redis, Neo4j and Elasticsearch
Description: |-
  Browse schemas, edit table data, run queries and export results for MySQL, PostgreSQL, SQLite,
  SQL Server, Oracle, DuckDB and ClickHouse, with dedicated workspaces for MongoDB, Redis, Neo4j and
  Elasticsearch. Passwords are kept in the system keychain, never in plain text on disk.
Moniker: dataomni
Tags:
- clickhouse
- database
- database-client
- duckdb
- elasticsearch
- mongodb
- mysql
- neo4j
- oracle
- postgresql
- redis
- sql
- sql-server
- sqlite
ReleaseNotesUrl: https://github.com/$repo/releases/tag/$tag
ManifestType: defaultLocale
ManifestVersion: $manifest_version
EOF

echo "wrote $out"
