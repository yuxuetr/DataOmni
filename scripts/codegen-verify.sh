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
#   不写列类型时（早先的写法）五种驱动都报「Data type "Object" … is not supported」；
# - MikroORM 把一个 mappedBy 改成不存在的属性，实体发现报「has unknown 'mappedBy' reference」；
# - SeaORM 给 orders 写两个 Related<users>（同一对表两条外键时），cargo check 报 E0119。
# sqlx 只验到编译：整数宽度对不对（INT 读进 i64 是运行期错误）由 codegenModel 的类型语料钉住。
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

# --- TypeORM 与 MikroORM：tsc 严格模式编译；TypeORM 在五种驱动上各建一次元数据，MikroORM 在四种驱动上各跑一次实体发现 ---
# 建元数据时 TypeORM 按驱动的 supportedDataTypes 校验列类型、按属性名找关系的对面，tsc 查不出这两样。
# 不连库：buildMetadatas 只要驱动包装得上
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$snapshots"/typeorm-* "$snapshots"/mikroorm-* "$work/"
(
  cd "$work"
  echo '{"name":"codegen-verify","private":true}' > package.json
  bun add typeorm@0.3 reflect-metadata typescript@5 @types/node pg mysql2 sqlite3 mssql oracledb \
    @mikro-orm/core@6 @mikro-orm/postgresql@6 @mikro-orm/mysql@6 @mikro-orm/sqlite@6 @mikro-orm/mssql@6 >/dev/null 2>&1
  cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022", "module": "commonjs", "moduleResolution": "node", "strict": true,
    "experimentalDecorators": true, "emitDecoratorMetadata": true, "skipLibCheck": true,
    "outDir": "dist", "types": ["node"]
  },
  "include": ["typeorm-*/**/*.ts", "mikroorm-*/**/*.ts"]
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
  cat > discovery.js <<'JS'
require('reflect-metadata');
const drivers = {
  postgresql: ['@mikro-orm/postgresql', 'PostgreSqlDriver'],
  mysql: ['@mikro-orm/mysql', 'MySqlDriver'],
  sqlite: ['@mikro-orm/sqlite', 'SqliteDriver'],
  sqlserver: ['@mikro-orm/mssql', 'MsSqlDriver']
};
(async () => {
  let failed = 0;
  for (const [dialect, [pkg, name]] of Object.entries(drivers)) {
    try {
      const { MikroORM, [name]: driver } = require(pkg);
      const { entities } = require(`./dist/mikroorm-${dialect}/index.js`);
      const orm = await MikroORM.init({ driver, entities, dbName: dialect === 'sqlite' ? ':memory:' : 'db', connect: false });
      console.log(`ok    mikroorm ${dialect} (${Object.keys(orm.getMetadata().getAll()).length} entities)`);
    } catch (error) {
      failed = 1;
      console.log(`FAIL  mikroorm ${dialect}: ${error.message}`);
    }
  }
  process.exit(failed);
})();
JS
  if ! node_modules/.bin/tsc -p .; then
    echo "FAIL  typeorm / mikroorm tsc"
    exit 1
  fi
  status=0
  node metadata.js || status=1
  node discovery.js || status=1
  exit "$status"
) || failed=1

# --- SeaORM 与 sqlx：放进一个依赖 sea-orm 1.1、sqlx 0.8 的 crate，cargo check，警告也算失败 ---
crate="$work/rust"
mkdir -p "$crate/src"
cp -R "$snapshots"/seaorm-* "$snapshots"/sqlx-* "$crate/src/"
cat > "$crate/Cargo.toml" <<'TOML'
[package]
name = "codegen_verify"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
sea-orm = { version = "1.1", default-features = false, features = ["macros", "with-chrono", "with-uuid", "with-rust_decimal", "with-json"] }
sqlx = { version = "0.8", default-features = false, features = ["macros", "postgres", "mysql", "sqlite", "chrono", "uuid", "rust_decimal", "json"] }
TOML
{
  echo '#![allow(dead_code)]'
  for dir in "$crate"/src/seaorm-*; do
    name="$(basename "$dir")"
    echo "#[path = \"$name/mod.rs\"] pub mod ${name//-/_};"
  done
  for dir in "$crate"/src/sqlx-*; do
    name="$(basename "$dir")"
    echo "#[path = \"$name/models.rs\"] pub mod ${name//-/_};"
  done
} > "$crate/src/lib.rs"
if (cd "$crate" && CARGO_TERM_COLOR=never RUSTFLAGS="-D warnings" cargo check --quiet); then
  echo "ok    seaorm + sqlx cargo check"
else
  echo "FAIL  seaorm + sqlx cargo check"
  failed=1
fi

exit "$failed"
