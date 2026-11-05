# 代码生成（ORM 实体与结构体）设计说明

> 2026-11-05。TODOs「1.x」的 C1；A7 的重估条件满足（用户要，并且不只 Prisma）。
> 本文跟代码走。用户 2026-11-05 确认照此动手；NestJS 一档做 TypeORM 与 MikroORM；命名按语言惯例并映射回原名。

## 1. 要回答的问题

用户问的是：除了 Prisma，能不能生成 NestJS 用的 ORM、SeaORM、sqlx 的代码？

**能。** 四种都是「表、列、类型、主键、外键 → 文本」的确定性映射，和 `rfcs/ai-design-and-export.md` §5
当初的判断一致：**不用 AI**。用 AI 做，同一个库每次生成的都不一样，也没法测。

难点不在模板，在三处：

- 类型映射：方言的类型对到目标的类型。
- 名字转换：表名、列名转成目标语言的标识符，还要把原名映射回去。
- 关系：外键转成目标 ORM 的关系声明。四种 ORM 各有硬性规则，写错了编不过或校验不过。

## 2. 目标与支持矩阵

| 目标 | 是什么 | 支持的方言（目标自己支持的） |
| --- | --- | --- |
| Prisma | `schema.prisma` 一个文件 | PostgreSQL、MySQL、SQLite、SQL Server（CockroachDB 走 PostgreSQL） |
| TypeORM | 每张表一个 `*.entity.ts`（NestJS 官方文档的首选 ORM） | PostgreSQL、MySQL、SQLite、SQL Server、Oracle |
| MikroORM | 每张表一个 `*.entity.ts`（装饰器写法，NestJS 的另一个常用选择） | PostgreSQL、MySQL、SQLite、SQL Server |
| SeaORM | 每张表一个模块，外加 `mod.rs` 与 `prelude.rs`（与 `sea-orm-cli generate entity` 同布局） | PostgreSQL、MySQL、SQLite |
| sqlx | 一个 `.rs` 文件，每张表一个 `#[derive(sqlx::FromRow)]` 结构体 | PostgreSQL、MySQL、SQLite |

MariaDB、TiDB、OceanBase 存下来就是 MySQL 连接，按 MySQL 生成；openGauss 同理按 PostgreSQL。
DuckDB、ClickHouse 这四个目标都不支持，入口不出现。

NestJS 那一档做 TypeORM 与 MikroORM 两种（用户 2026-11-05 定）。Sequelize、Drizzle、JPA 等先不做：有人要再加，一种目标只是多一个渲染函数。

## 3. 输入：一份模型，两个来源

```ts
interface CodegenSchema {
  dialect: SqlDialect;
  tables: CodegenTable[];
}
interface CodegenTable {
  schema: string | null;
  name: string;
  columns: { name; dataType; nullable; autoIncrement; defaultValue: string | null }[];
  primaryKey: string[];
  unique: string[][];
  foreignKeys: { name; columns: string[]; referencedSchema; referencedTable; referencedColumns: string[] }[];
}
```

- **已有的库**：读 ER 图那两段整库查询（`services/er_diagram.rs`）。列查询要多给两项，
  其中 `is_auto_increment` 是必须的：没有它，Prisma 的 `@default(autoincrement())`、TypeORM 的
  `@PrimaryGeneratedColumn` 都给不出来，新增一行时就得自己填主键。
  - `is_auto_increment`：
    - PostgreSQL：`attidentity <> ''`，或者默认值是 `nextval(…)`（`serial`）。
    - MySQL：`EXTRA` 含 `auto_increment`。
    - SQLite：唯一的 `INTEGER PRIMARY KEY` 列（rowid 别名）。
    - SQL Server：`is_identity`。
    - Oracle：`identity_column = 'YES'`。
  - `column_default`：默认值的原文，给 Prisma 的 `@default` 用。
  - ER 图与数据字典不读这两项，多两列不影响它们。

  唯一约束这一版**不读**。外键列上有唯一约束时，生成的是一对多而不是一对一。这样写不错，只是不够准。
  外键列正好是主键时按一对一处理，因为主键本来就在模型里。
  重估条件：有人要一对一。
- **AI 设计的新表**：`SchemaDraft` 直接转成这份模型。默认值、唯一约束都有，自增没有（AI 给的是类型与默认值原文，
  `serial`、`GENERATED … AS IDENTITY`、`AUTO_INCREMENT` 这些从类型或默认值里认）。

## 4. 类型：两层映射

先把方言的原文类型解析成一个**逻辑类型**，各目标再从逻辑类型映射到自己的写法。方言和目标分开解析，
避免每对「方言 × 目标」各写一份。

逻辑类型：`int16 / int32 / int64 / decimal(p, s) / float32 / float64 / bool / string(len?) / text /
uuid / json / bytes / date / time / timestamp / timestamptz / unknown(原文)`。

- 带长度、精度的保留下来，Prisma 要写 `@db.VarChar(64)`、`@db.Decimal(10, 2)`。
- **认不出的不猜**：映射成 `unknown`。
  - Prisma 有现成的写法 `Unsupported("原文")`。
  - TypeORM、MikroORM 写原文类型，TS 类型用 `string`。
  - SeaORM 写 `custom("原文")`，Rust 类型用 `String`。
  - sqlx 用 `String`。
  - 无论哪种，生成结果的开头都列出这些列，对话框里也列出来。**不悄悄略过**。
- MySQL 的 `tinyint(1)` 是布尔：MySQL 驱动与 Prisma、TypeORM 的惯例都这样处理。
- 无符号整数往上提一级（`int unsigned` → int64），避免装不下。

## 5. 名字

- 类型名（Prisma model、TS class、Rust struct）用 PascalCase，字段名按目标语言的惯例：TS 用 camelCase，Rust 用 snake_case。
  **和原名不同就显式映射回原名**：`@@map` / `@map`、`@Entity("原名")` / `@Column({ name })`（MikroORM 是 `tableName` / `fieldName`）、
  `#[sea_orm(table_name, column_name)]`、`#[sqlx(rename)]`。
- **不做单复数转换**：没有词典就会把 `status` 变成 `statu`，变错了比不变更糟。
- 名字变成非法标识符时要处理：以数字开头的加 `_` 前缀，转换后撞上关键字的另行处理，同一张表里两列转成同一个名字的加序号区分，
  这些都有用例。
- 多个 schema（PostgreSQL、SQL Server）里有同名表时，类型名前面加上 schema 名。

## 6. 关系（各目标的硬规则）

- **Prisma**：
  - 关系必须两边都写。
  - 同一对表之间有多条外键时要加 `@relation("名")`；外键列和关系字段名冲突时也要处理。
  - 外键列是主键或唯一时，对面那一侧必须写成可选的单个，不能是列表。
  - 自引用要两个字段。
  - 没有主键、也没有唯一约束的表 Prisma 不收：照 `prisma db pull` 的做法加 `@@ignore`，并写一行注释说明原因。
- **TypeORM**：
  - 有外键的一侧写 `@ManyToOne` 加 `@JoinColumn`（复合外键用数组），对面写 `@OneToMany`。
  - 外键列同时保留成普通的 `@Column`，因为读写外键 id 是常见用法。
  - 没有主键的表 TypeORM 不收：跳过，写明原因。
- **MikroORM**：外键一侧写 `@ManyToOne`（复合外键用 `joinColumns`），对面写 `@OneToMany` 加 `Collection`。
  外键列不另写成普通属性（MikroORM 里一列只映射一个属性）。没有主键的表跳过，写明原因。
- **SeaORM**：`Relation` 枚举用 `belongs_to` 和 `has_many`，加上 `Related<…>` 实现；同一对表之间有多条外键时，
  不生成 `Related` 实现（SeaORM 要求唯一），只留 `Relation`。没有主键的表跳过并写明原因（SeaORM 要求主键）。
- **sqlx**：只生成结构体，没有关系。

## 7. 入口

- **ER 图的导出菜单加「生成代码…」**：对话框里选目标，带预览（只读编辑器，带高亮），可以复制，也可以保存。
  - 单文件的目标存为一个文件。
  - 多文件的（TypeORM、MikroORM、SeaORM）选一个目录，只写新文件、不覆盖已有的，与 CLI 的 `export` 同一个规矩。
  - ER 图当前有筛选时，只生成筛出来的那些表。外键指向筛掉的表时，这一端的关系不生成，并在开头的说明里列出来。
- **AI 设计的结果页**同样有这个入口，来源是当前的设计。
- CLI 这一版不加：Agent 自己就能写代码。重估条件：有人要在脚本里批量生成。

## 8. 验收

- **单测**：
  - 类型映射的语料，覆盖每种方言 × 每个逻辑类型。
  - 名字转换的边界。
  - 每个目标对一份固定模型生成的输出逐字比对。固定模型照 `examples/sample-schema.sql`：
    链式引用、分叉、自引用、复合外键、孤立表、无主键表。
- **生成出来的代码真的能用**：这些工具太重，不进 `bun run check`，写成脚本 `scripts/codegen-verify.sh`。
  它把语料的输出写到临时目录，然后分别跑：
  - `prisma validate`；
  - 带 `typeorm`、`@mikro-orm/core` 和 `reflect-metadata` 的 `tsc --noEmit`；
  - 带 `sea-orm`、`sqlx` 依赖的 `cargo check`。

  另外用 `prisma db pull` 与 `sea-orm-cli` 在真库上生成一份当参照，比对类型映射。这一步只在动手前做一次，结果记在本文。
- **反向验证**：
  - 去掉 Prisma 反向关系的生成，`prisma validate` 要变红；
  - 把 SeaORM 的 `Related` 生成成重复的，`cargo check` 要变红。

## 9. 不做（当前版本）

- **双向同步**：改了生成的代码再回写库结构。这是迁移工具的事，比如 `prisma migrate`。
- **视图、枚举类型、存储过程**：PostgreSQL 的 enum 现在当 `unknown` 处理，有人要再做。
- **索引的生成**：`@@index` 不影响查询代码能不能用，有人要再加。
