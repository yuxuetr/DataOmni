#!/usr/bin/env bash
# 代码生成的语料（src/utils/__snapshots__/codegen/）交给各目标自己的工具检查：生成出来的代码要真的能用，
# 不只是和上一次一样。这些工具太重（要下载 Prisma 引擎、npm 包与 crate），不进 `bun run check`；
# 改了 src/utils/codegen*.ts、快照跟着变时跑一次，见 rfcs/codegen.md §8。
#
#   scripts/codegen-verify.sh
#
# 反向验证（2026-11-05）：从 Prisma 快照里删掉一条反向关系，`prisma validate` 报
# 「missing an opposite relation field」。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
snapshots="$root/src/utils/__snapshots__/codegen"
failed=0

# --- Prisma：prisma validate 也查连接串的形状，给每种 provider 一个像样的假地址 ---
declare_url() {
  case "$1" in
    postgresql) echo 'postgresql://user:password@localhost:5432/db' ;;
    mysql) echo 'mysql://user:password@localhost:3306/db' ;;
    sqlite) echo 'file:./dev.db' ;;
    sqlserver) echo 'sqlserver://localhost:1433;database=db' ;;
  esac
}
for file in "$snapshots"/prisma-*.prisma; do
  dialect="$(basename "$file" .prisma)"
  dialect="${dialect#prisma-}"
  if DATABASE_URL="$(declare_url "$dialect")" bunx --bun prisma@6 validate --schema "$file" >/dev/null 2>"$file.err"; then
    echo "ok    prisma $dialect"
    rm -f "$file.err"
  else
    echo "FAIL  prisma $dialect"
    cat "$file.err"
    rm -f "$file.err"
    failed=1
  fi
done

exit "$failed"
