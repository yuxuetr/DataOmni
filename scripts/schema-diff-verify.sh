#!/usr/bin/env bash
# 结构比对的往返验收：建两份不同的结构，比出同步脚本，执行，再比一次必须为空（rfcs/schema-diff.md §6）。
# 要连真库，不进 `bun run check`；改了 schemaDiff / schemaSync / schemaSnapshot 或目录查询时跑一次。
#
#   scripts/schema-diff-verify.sh                       # SQLite 总是跑
#   DATAOMNI_POSTGRES_TEST_URL=… DATAOMNI_MYSQL_TEST_URL=… DATAOMNI_SQLSERVER_TEST_URL=… scripts/schema-diff-verify.sh
#   scripts/schema-diff-verify.sh --skip-kind=column-changed   # 反向验证：该红
#
# 连接串同冒烟测试，只在 shell 里传。PostgreSQL 与 SQL Server 在测试库里建 sd_src / sd_dst 两个 schema，
# MySQL 建 dataomni_sd_src / dataomni_sd_dst 两个库，跑完删掉。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 目录查询从 Rust 那边取：应用跑的就是这一份
(cd "$root/src-tauri" && DATAOMNI_DUMP_CATALOG_QUERIES="$work/queries.json" cargo test --quiet --test catalog_queries_dump >/dev/null)

if [[ -n "${DATAOMNI_SQLSERVER_TEST_URL:-}" ]]; then
  (cd "$work" && echo '{"name":"schema-diff-verify","private":true}' > package.json && bun add mssql@11 >/dev/null 2>&1)
  export MSSQL_MODULE="$work/node_modules/mssql/index.js"
fi

QUERIES="$work/queries.json" bun "$root/scripts/schema-diff-verify.ts" "$@"
