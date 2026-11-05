#!/usr/bin/env bash
# 代码生成的语料（src/utils/__snapshots__/codegen/）交给各目标自己的工具检查：生成出来的代码要真的能用，
# 不只是和上一次一样。这些工具太重（要下载 Prisma 引擎、npm 包与 crate），不进 `bun run check`；
# 改了 src/utils/codegen*.ts、快照跟着变时跑一次，见 rfcs/codegen.md §8。
#
#   scripts/codegen-verify.sh
#
# 反向验证（2026-11-05）：
# - 从 Prisma 快照里删掉一条反向关系，`prisma validate` 报「missing an opposite relation field」；
# - TypeORM 把一个 referencedColumnName 改成不存在的属性，建元数据报「Referenced column nope was not found」；
#   不写列类型时（早先的写法）五种驱动都报「Data type "Object" … is not supported」。
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

# --- TypeORM：tsc 严格模式编译，再交给五种驱动各建一次元数据 ---
# 建元数据时 TypeORM 按驱动的 supportedDataTypes 校验列类型、按属性名找关系的对面，tsc 查不出这两样。
# 不连库：buildMetadatas 只要驱动包装得上
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$snapshots"/typeorm-* "$work/"
(
  cd "$work"
  echo '{"name":"codegen-verify","private":true}' > package.json
  bun add typeorm@0.3 reflect-metadata typescript@5 @types/node pg mysql2 sqlite3 mssql oracledb >/dev/null 2>&1
  cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022", "module": "commonjs", "moduleResolution": "node", "strict": true,
    "experimentalDecorators": true, "emitDecoratorMetadata": true, "skipLibCheck": true,
    "outDir": "dist", "types": ["node"]
  },
  "include": ["typeorm-*/**/*.ts"]
}
JSON
  cat > metadata.js <<'JS'
require('reflect-metadata');
const { DataSource } = require('typeorm');
const drivers = { postgresql: 'postgres', mysql: 'mysql', sqlite: 'sqlite', sqlserver: 'mssql', oracle: 'oracle' };
(async () => {
  let failed = 0;
  for (const [dialect, type] of Object.entries(drivers)) {
    try {
      const { entities } = require(`./dist/typeorm-${dialect}/index.js`);
      const dataSource = new DataSource({ type, entities, database: type === 'sqlite' ? ':memory:' : 'db' });
      await dataSource.buildMetadatas();
      console.log(`ok    typeorm ${dialect} (${dataSource.entityMetadatas.length} entities)`);
    } catch (error) {
      failed = 1;
      console.log(`FAIL  typeorm ${dialect}: ${error.message}`);
    }
  }
  process.exit(failed);
})();
JS
  if ! node_modules/.bin/tsc -p .; then
    echo "FAIL  typeorm tsc"
    exit 1
  fi
  node metadata.js
) || failed=1

exit "$failed"
