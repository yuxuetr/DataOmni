//! 表的索引、外键与检查约束的目录查询。
//!
//! 放在 Rust 而不是前端：这九段目录查询是整个元数据里最容易「看起来能跑、
//! 其实是错的」的部分——复合键的列顺序、schema 过滤、表达式索引、
//! MySQL 函数索引的 COLUMN_NAME 为 NULL。唯一能证明它们对的，是拿真的
//! MySQL 8.4 / PostgreSQL 16 跑一遍（`tests/database_smoke.rs`），
//! 而那只有 SQL 文本住在 Rust 侧时才做得到。
//!
//! 查询一律带占位符，表名与 schema 由调用方绑定，不做字符串拼接。

use crate::models::DatabaseType;
use serde::Serialize;

/// 一个方言的三段目录查询。
///
/// `check_constraints` 是 `Option`：SQLite 根本没有暴露检查约束的目录，
/// 只能从建表语句原文里看。用 `None` 说出这件事，比返回一段查不到东西的
/// SQL 再让前端显示「0 条」要诚实——后者会让人以为这张表没有检查约束。
#[derive(Debug, Clone, Serialize)]
pub struct SchemaMetadataQueries {
  pub columns: &'static str,
  pub indexes: &'static str,
  pub foreign_keys: &'static str,
  pub check_constraints: Option<&'static str>,
  pub ddl: Option<DdlQuery>,
  pub triggers: &'static str,
  /// 每段 `Bound` 查询要绑几个参数。**这一个数管这个方言的全部查询**：
  /// 前端据它构造 `[表名]` 或 `[表名, schema]`，不再自己按方言分支。
  ///
  /// 写成数据而不是让前端记规则，是因为它真的漂过：`ddl` 这一段此前收到的
  /// 是一个参数，而 PostgreSQL 的视图定义要两个。见 `parameter_count` 那条门。
  pub parameter_count: u8,
}

/// 取建表语句的方式。两种形态不是为了对称——它们真的不一样：
/// `SHOW CREATE TABLE` 不接受占位符，表名必须作为**引用过的标识符**插进语句；
/// 而 `sqlite_master` 里表名是一个**字符串字面量**，走绑定参数。
/// 两种引用规则不同，混用会在含特殊字符的表名上出错。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DdlQuery {
  /// 表名走绑定参数
  Bound { sql: &'static str },
  /// 表名要替换 `sql` 里的 `{table}`，调用方负责按方言引用标识符
  Interpolated { sql: &'static str },
}

/// 该方言是否支持目录级的结构浏览。
///
/// 只有已经实现了查询执行层的三种关系型数据库有；其它类型连查询都跑不了，
/// 返回 `None` 让调用方明确处理，而不是给一段注定失败的 SQL。
pub fn schema_metadata_queries(db_type: &DatabaseType) -> Option<SchemaMetadataQueries> {
  match db_type {
    DatabaseType::PostgreSQL => Some(SchemaMetadataQueries {
      columns: POSTGRES_COLUMNS,
      indexes: POSTGRES_INDEXES,
      foreign_keys: POSTGRES_FOREIGN_KEYS,
      check_constraints: Some(POSTGRES_CHECK_CONSTRAINTS),
      // 对**视图**有权威定义（pg_get_viewdef），对**表**没有：查表时返回 0 行。
      // 见 `postgres_has_no_create_table_statement` 上的说明。
      ddl: Some(DdlQuery::Bound { sql: POSTGRES_VIEW_DEFINITION }),
      triggers: POSTGRES_TRIGGERS,
      parameter_count: 2,
    }),
    DatabaseType::MySQL => Some(SchemaMetadataQueries {
      columns: MYSQL_COLUMNS,
      indexes: MYSQL_INDEXES,
      foreign_keys: MYSQL_FOREIGN_KEYS,
      check_constraints: Some(MYSQL_CHECK_CONSTRAINTS),
      ddl: Some(DdlQuery::Interpolated { sql: MYSQL_DDL }),
      triggers: MYSQL_TRIGGERS,
      parameter_count: 2,
    }),
    DatabaseType::SQLite => Some(SchemaMetadataQueries {
      columns: SQLITE_COLUMNS,
      indexes: SQLITE_INDEXES,
      foreign_keys: SQLITE_FOREIGN_KEYS,
      check_constraints: None,
      ddl: Some(DdlQuery::Bound { sql: SQLITE_DDL }),
      triggers: SQLITE_TRIGGERS,
      parameter_count: 1,
    }),
    _ => None,
  }
}

/// 表的列目录。
///
/// 三段查询返回同一组列名与同一种类型，前端不再按方言认字段——此前
/// PostgreSQL 给 `'YES'`/`'NO'`、SQLite 给 `notnull` 的 0/1、MySQL 又给
/// 另一套，合并逻辑写在前端，而三种形状里任何一种漂了都不会有人发现。
///
/// `is_generated` 回答的是「这一列的值由数据库产生」。没有它，
/// `GENERATED ALWAYS AS IDENTITY`（PostgreSQL）与 `AUTO_INCREMENT`（MySQL）
/// 会同时满足「非空」与「无默认值」，新增行时被当成必填项点名，
/// 于是这两种表**一行都插不进去**。它们的自增值不在 `column_default` 里，
/// 只能从 `attidentity` / `EXTRA` 读。
///
/// `attgenerated` / `GENERATION_EXPRESSION` / `hidden` 把计算列也一并算进来：
/// 计算列同样不能由调用方赋值。
///
/// 最后三个字段只有 MySQL 有值，因为只有 MySQL 需要它们：改一列的类型或
/// 可空性只能用 `MODIFY COLUMN`，而 MODIFY **重述整段定义**——没写进去的
/// 排序规则与注释会被静默丢掉。PostgreSQL 与 SQLite 走的是
/// `ALTER COLUMN ... TYPE` 这类窄语法，只改被点名的那一项，用不上这三项。
const POSTGRES_COLUMNS: &str = r#"
SELECT
  a.attname::text AS column_name,
  format_type(a.atttypid, a.atttypmod)::text AS data_type,
  (NOT a.attnotnull) AS is_nullable,
  pg_get_expr(d.adbin, d.adrelid)::text AS column_default,
  (pk.ord IS NOT NULL) AS is_primary_key,
  pk.ord::int AS primary_key_ordinal,
  (a.attidentity <> '' OR a.attgenerated <> '') AS is_generated,
  NULL::text AS collation,
  NULL::text AS comment,
  NULL::text AS column_extra
FROM pg_class t
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN LATERAL (
  SELECT k.ord
  FROM pg_constraint c
  CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
  WHERE c.conrelid = t.oid AND c.contype = 'p' AND k.attnum = a.attnum
) pk ON true
WHERE t.relname = $1
  AND n.nspname = COALESCE($2, current_schema())
ORDER BY a.attnum
"#;

/// `COLUMN_TYPE` 而不是 `DATA_TYPE`：后者只有 `varchar`、`int`，丢掉长度、
/// 精度与 `unsigned`。结构页显示的就是这个字段，也是改结构时唯一的起点。
///
/// `GENERATION_EXPRESSION` 在非计算列上 MySQL 给空串、MariaDB 给 NULL。
/// 只写 `<> ''` 在 MariaDB 上得到 NULL，整个 `OR` 也跟着成了 NULL——
/// 这一列就从布尔变成了三值，所以先 `COALESCE`。
///
/// **默认值在 MariaDB 上要先换成 MySQL 的形状。** 两家的 `COLUMN_DEFAULT`
/// 说的不是同一种东西（MySQL 8.4 与 MariaDB 11.4 上逐类核对过）：
///
/// | 定义 | MySQL | MariaDB |
/// | --- | --- | --- |
/// | `DEFAULT 'it''s'` | `it's` | `'it''s'` |
/// | 可空、无默认值 | NULL | 字符串 `NULL` |
/// | `DEFAULT 'NULL'` | `NULL`（字符串） | `'NULL'` |
/// | `DEFAULT 0` / `b'1'` | `0` / `b'1'` | 同左 |
/// | `DEFAULT CURRENT_TIMESTAMP` | `CURRENT_TIMESTAMP` + EXTRA `DEFAULT_GENERATED` | `current_timestamp()`，EXTRA 里没有标记 |
///
/// 改结构的界面（`tableDdl.ts` 的 `columnDefaultSql`）照 MySQL 的形状把它
/// 重述回 SQL：不带标记的非数字当字符串再引一层。不换的话，在 MariaDB 上
/// 只改一列的注释，`MODIFY` 就会把 `'a'` 写成 `'''a'''`、把「没有默认值」
/// 写成 `DEFAULT 'NULL'`——语句成功，默认值被悄悄换掉。
///
/// 所以这里：带引号的去引号并还原 `''` 与 `\\` 两种转义；裸的 `NULL` 是
/// 没有默认值；其余裸的、又不是数字或位串字面量的，是表达式，补上
/// `DEFAULT_GENERATED`，界面据此拒绝重述（与 MySQL 上同一条理由）。
/// 反过来，没有默认值却带着 `DEFAULT_GENERATED` 的要摘掉：TiDB 给
/// `TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP` 这种列也打这个标记，界面据此
/// 拒绝重述，而那一列根本没有表达式默认值。
///
/// 数字的正则写成 `-{0,1}` 而不是 `-?`：参数个数那道门按问号数占位符。
/// 反斜杠用 `CHAR(92)` 写，不在字面量里转义：`NO_BACKSLASH_ESCAPES` 打开时
/// `'\\'` 就是两个字符了。
const MYSQL_COLUMNS: &str = r#"
SELECT
  CAST(c.COLUMN_NAME AS CHAR) AS column_name,
  CAST(c.COLUMN_TYPE AS CHAR) AS data_type,
  (c.IS_NULLABLE = 'YES') AS is_nullable,
  CAST(CASE
    WHEN VERSION() NOT LIKE '%MariaDB%' THEN c.COLUMN_DEFAULT
    WHEN c.COLUMN_DEFAULT = 'NULL' THEN NULL
    WHEN c.COLUMN_DEFAULT LIKE '''%' THEN REPLACE(REPLACE(
      SUBSTRING(c.COLUMN_DEFAULT, 2, CHAR_LENGTH(c.COLUMN_DEFAULT) - 2),
      '''''', ''''),
      CONCAT(CHAR(92 USING utf8mb4), CHAR(92 USING utf8mb4)), CHAR(92 USING utf8mb4))
    ELSE c.COLUMN_DEFAULT
  END AS CHAR) AS column_default,
  (kcu.ORDINAL_POSITION IS NOT NULL) AS is_primary_key,
  kcu.ORDINAL_POSITION AS primary_key_ordinal,
  (c.EXTRA LIKE '%auto_increment%' OR COALESCE(c.GENERATION_EXPRESSION, '') <> '') AS is_generated,
  CAST(c.COLLATION_NAME AS CHAR) AS collation,
  CAST(NULLIF(c.COLUMN_COMMENT, '') AS CHAR) AS comment,
  CAST(CASE
    WHEN c.COLUMN_DEFAULT IS NULL THEN TRIM(REPLACE(c.EXTRA, 'DEFAULT_GENERATED', ''))
    WHEN VERSION() LIKE '%MariaDB%'
      AND c.COLUMN_DEFAULT <> 'NULL'
      AND c.COLUMN_DEFAULT NOT LIKE '''%'
      AND c.COLUMN_DEFAULT NOT REGEXP '^-{0,1}[0-9]'
      AND c.COLUMN_DEFAULT NOT LIKE 'b''%'
      THEN TRIM(CONCAT('DEFAULT_GENERATED ', c.EXTRA))
    ELSE c.EXTRA
  END AS CHAR) AS column_extra
FROM INFORMATION_SCHEMA.COLUMNS c
LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
  ON kcu.TABLE_SCHEMA = c.TABLE_SCHEMA
 AND kcu.TABLE_NAME = c.TABLE_NAME
 AND kcu.COLUMN_NAME = c.COLUMN_NAME
 AND kcu.CONSTRAINT_NAME = 'PRIMARY'
WHERE c.TABLE_NAME = ?
  AND c.TABLE_SCHEMA = COALESCE(?, DATABASE())
ORDER BY c.ORDINAL_POSITION
"#;

/// `table_xinfo` 而不是 `table_info`：后者**看不见计算列**，于是结构页少一列，
/// 而 `SELECT *` 又把它查得出来——两处对同一张表的列数说法不一致。
/// `hidden` 的取值：0 普通、1 虚表的隐藏列、2 VIRTUAL 计算列、3 STORED 计算列。
/// 只排掉 1，它在 `SELECT *` 里同样取不到。
///
/// `pk` 本身就是键内次序（0 表示不是主键），不需要再算一次。
const SQLITE_COLUMNS: &str = r#"
SELECT
  p.name AS column_name,
  p.type AS data_type,
  (p."notnull" = 0) AS is_nullable,
  p.dflt_value AS column_default,
  (p.pk > 0) AS is_primary_key,
  NULLIF(p.pk, 0) AS primary_key_ordinal,
  (p.hidden IN (2, 3)) AS is_generated,
  NULL AS collation,
  NULL AS comment,
  NULL AS column_extra
FROM pragma_table_xinfo(?1) p
WHERE p.hidden <> 1
ORDER BY p.cid
"#;

/// 列名用 `pg_get_indexdef(oid, colno, true)` 取而不是 join `pg_attribute`：
/// 表达式索引在 `indkey` 里的位置是 0，join 不上任何列，那一列会凭空消失。
/// `k.ord <= ix.indnkeyatts` 排掉 INCLUDE 的附加列——它们不参与键。
///
/// `is_partial` / `is_valid` 是给「拿哪个键定位一行」用的，不是给索引列表看的。
/// 部分索引（`CREATE UNIQUE INDEX ... WHERE`）只在满足谓词的子集上唯一，
/// 拿它拼 `WHERE u = ?` 会命中谓词外的重复行；`indisvalid = false` 的索引则是
/// `CONCURRENTLY` 建失败留下的残骸，**它的唯一性从未在存量数据上验证过**。
/// 两者都不能当行标识，但它们是两个不同的事实，合成一个布尔会让索引列表说谎。
const POSTGRES_INDEXES: &str = r#"
SELECT
  i.relname::text AS index_name,
  pg_get_indexdef(ix.indexrelid, k.ord::int, true)::text AS column_name,
  k.ord::int AS ordinal,
  ix.indisunique AS is_unique,
  ix.indisprimary AS is_primary,
  (ix.indpred IS NOT NULL) AS is_partial,
  ix.indisvalid AS is_valid,
  am.amname::text AS method
FROM pg_class t
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_index ix ON ix.indrelid = t.oid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_am am ON am.oid = i.relam
CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
WHERE t.relname = $1
  AND n.nspname = COALESCE($2, current_schema())
  AND k.ord <= ix.indnkeyatts
ORDER BY i.relname, k.ord
"#;

/// `unnest(conkey, confkey) WITH ORDINALITY` 把本表列与被引用列按同一个下标
/// 配对。分两次 unnest 再按名字拼会在复合外键上错位，而错位后的结果看上去
/// 完全正常。
const POSTGRES_FOREIGN_KEYS: &str = r#"
SELECT
  c.conname::text AS constraint_name,
  k.ord::int AS ordinal,
  a.attname::text AS column_name,
  fn.nspname::text AS referenced_schema,
  ft.relname::text AS referenced_table,
  fa.attname::text AS referenced_column,
  CASE c.confupdtype
    WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_update,
  CASE c.confdeltype
    WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_delete
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_class ft ON ft.oid = c.confrelid
JOIN pg_namespace fn ON fn.oid = ft.relnamespace
CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord)
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
JOIN pg_attribute fa ON fa.attrelid = ft.oid AND fa.attnum = k.fattnum
WHERE c.contype = 'f'
  AND t.relname = $1
  AND n.nspname = COALESCE($2, current_schema())
ORDER BY c.conname, k.ord
"#;

/// 走 `pg_constraint` 而不是 `information_schema.check_constraints`：后者会把
/// 每个 NOT NULL 也列成一条名为 `2200_xxx_1_not_null` 的检查约束，淹掉真正
/// 写在建表语句里的那几条。
const POSTGRES_CHECK_CONSTRAINTS: &str = r#"
SELECT
  c.conname::text AS constraint_name,
  pg_get_constraintdef(c.oid, true)::text AS expression
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE c.contype = 'c'
  AND t.relname = $1
  AND n.nspname = COALESCE($2, current_schema())
ORDER BY c.conname
"#;

/// MySQL 8 的函数索引 `COLUMN_NAME` 为 NULL、表达式在 `EXPRESSION` 里，
/// 只读 COLUMN_NAME 会得到一列空值；那串表达式匹配不上任何列名，
/// 选行标识时自然会被排掉。
///
/// `EXPRESSION` 包在 `/*!80013 */` 里：MariaDB 的 `STATISTICS` 没有这一列，
/// 直接写会让整段报 1054，结构页一条索引都显示不出来。这种注释 MySQL 8.0.13
/// 起执行、MariaDB 跳过、TiDB 不看版本号一律执行（三家都在真库上验过）。
/// MariaDB 没有函数索引，跳过之后 `COALESCE` 只剩 `COLUMN_NAME`，正好。
///
/// `EXPRESSION` 放在前面：TiDB 在函数索引上给的 `COLUMN_NAME` 是**字符串**
/// `NULL` 而不是 NULL，放后面就永远轮不到它。普通列上 `EXPRESSION` 是 NULL，
/// 两种顺序在 MySQL 上等价。
/// MySQL 没有部分索引，`is_partial` 恒假；也没有「未验证的索引」，`is_valid` 恒真。
const MYSQL_INDEXES: &str = r#"
SELECT
  CAST(s.INDEX_NAME AS CHAR) AS index_name,
  CAST(COALESCE(/*!80013 s.EXPRESSION, */ s.COLUMN_NAME) AS CHAR) AS column_name,
  s.SEQ_IN_INDEX AS ordinal,
  (s.NON_UNIQUE = 0) AS is_unique,
  (s.INDEX_NAME = 'PRIMARY') AS is_primary,
  FALSE AS is_partial,
  TRUE AS is_valid,
  CAST(s.INDEX_TYPE AS CHAR) AS method
FROM INFORMATION_SCHEMA.STATISTICS s
WHERE s.TABLE_NAME = ?
  AND s.TABLE_SCHEMA = COALESCE(?, DATABASE())
ORDER BY s.INDEX_NAME, s.SEQ_IN_INDEX
"#;

const MYSQL_FOREIGN_KEYS: &str = r#"
SELECT
  CAST(k.CONSTRAINT_NAME AS CHAR) AS constraint_name,
  k.ORDINAL_POSITION AS ordinal,
  CAST(k.COLUMN_NAME AS CHAR) AS column_name,
  CAST(k.REFERENCED_TABLE_SCHEMA AS CHAR) AS referenced_schema,
  CAST(k.REFERENCED_TABLE_NAME AS CHAR) AS referenced_table,
  CAST(k.REFERENCED_COLUMN_NAME AS CHAR) AS referenced_column,
  CAST(r.UPDATE_RULE AS CHAR) AS on_update,
  CAST(r.DELETE_RULE AS CHAR) AS on_delete
FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r
  ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
 AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
 AND r.TABLE_NAME = k.TABLE_NAME
WHERE k.TABLE_NAME = ?
  AND k.TABLE_SCHEMA = COALESCE(?, DATABASE())
  AND k.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION
"#;

const MYSQL_CHECK_CONSTRAINTS: &str = r#"
SELECT
  CAST(cc.CONSTRAINT_NAME AS CHAR) AS constraint_name,
  CAST(cc.CHECK_CLAUSE AS CHAR) AS expression
FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
  ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
 AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
WHERE tc.TABLE_NAME = ?
  AND tc.TABLE_SCHEMA = COALESCE(?, DATABASE())
ORDER BY cc.CONSTRAINT_NAME
"#;

/// 用 pragma 表值函数而不是 `PRAGMA` 语句：只有函数形态能绑参数，也只有它
/// 能把 index_list 与 index_info 关联起来一次取完。
///
/// 已知缺口：`INTEGER PRIMARY KEY`（rowid 别名）不产生索引，因而不会出现在
/// index_list 里。那种主键在列表里已经标了「主键」，这里不重复。
/// `il.partial` 同 PostgreSQL 的部分索引；SQLite 也支持 `CREATE INDEX ... WHERE`。
/// `is_valid` 恒真：SQLite 没有「建到一半的索引」这种状态。
///
/// 这里查不到 `INTEGER PRIMARY KEY`——它是 rowid 的别名，没有独立索引对象。
/// 主键因此始终从 `PRAGMA table_info` 的 `pk` 列拿，不从这里拿。
const SQLITE_INDEXES: &str = r#"
SELECT
  il.name AS index_name,
  ii.name AS column_name,
  ii.seqno + 1 AS ordinal,
  il."unique" AS is_unique,
  (il.origin = 'pk') AS is_primary,
  il.partial AS is_partial,
  1 AS is_valid,
  NULL AS method
FROM pragma_index_list(?1) il
JOIN pragma_index_info(il.name) ii
ORDER BY il.name, ii.seqno
"#;

/// SQLite 的外键没有名字，用 `fk_<id>` 合成一个稳定标识。
/// `"to"` 为 NULL 表示引用的是父表主键（建表时省略了列名）。
const SQLITE_FOREIGN_KEYS: &str = r#"
SELECT
  'fk_' || fk.id AS constraint_name,
  fk.seq + 1 AS ordinal,
  fk."from" AS column_name,
  NULL AS referenced_schema,
  fk."table" AS referenced_table,
  fk."to" AS referenced_column,
  fk.on_update AS on_update,
  fk.on_delete AS on_delete
FROM pragma_foreign_key_list(?1) fk
ORDER BY fk.id, fk.seq
"#;

/// 对视图返回的列叫 `Create View`，不是 `Create Table`——调用方按候选列名找。
const MYSQL_DDL: &str = "SHOW CREATE TABLE {table}";

/// 一并取出这张表的索引与触发器：它们也是建表脚本的一部分，
/// 只给 CREATE TABLE 的话，照着重建出来的表会少掉所有显式索引。
/// `sql IS NULL` 的是 SQLite 自动建的约束索引，已经含在 CREATE TABLE 里。
const SQLITE_DDL: &str = r#"
SELECT sql
FROM sqlite_master
WHERE tbl_name = ?1
  AND sql IS NOT NULL
ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name
"#;

/// PostgreSQL 唯一权威的「对象定义原文」来源：视图。
///
/// `pg_get_viewdef` 给的是服务器自己反解出来的 SELECT，和 `SHOW CREATE VIEW`
/// 同一性质。查一张普通表时 `relkind` 不匹配，返回 0 行——调用方据此显示
/// 「PostgreSQL 不提供建表语句」，而不是一段我们拼出来的东西。
const POSTGRES_VIEW_DEFINITION: &str = r#"
SELECT
  CASE c.relkind WHEN 'm' THEN 'CREATE MATERIALIZED VIEW ' ELSE 'CREATE OR REPLACE VIEW ' END
  || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || ' AS' || chr(10)
  || pg_get_viewdef(c.oid, true) AS sql
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = $1
  AND n.nspname = COALESCE($2, current_schema())
  AND c.relkind IN ('v', 'm')
"#;

/// `tgisinternal` 的是外键与约束自己建的触发器，不是用户写的。
/// 不排掉的话，每张带外键的表都会凭空多出几条看不懂的「触发器」。
const POSTGRES_TRIGGERS: &str = r#"
SELECT
  tg.tgname::text AS trigger_name,
  NULL AS timing,
  NULL AS event,
  pg_get_triggerdef(tg.oid, true)::text AS definition
FROM pg_trigger tg
JOIN pg_class t ON t.oid = tg.tgrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE NOT tg.tgisinternal
  AND t.relname = $1
  AND n.nspname = COALESCE($2, current_schema())
ORDER BY tg.tgname
"#;

/// MySQL 给的是拆开的组件（时机、事件、语句体），不是一段完整的 CREATE TRIGGER。
/// 这里如实返回组件，由前端分别标出——把它们拼成一条 CREATE TRIGGER 是在
/// 伪造原文，而拼出来的东西未必能照着执行。
const MYSQL_TRIGGERS: &str = r#"
SELECT
  CAST(t.TRIGGER_NAME AS CHAR) AS trigger_name,
  CAST(t.ACTION_TIMING AS CHAR) AS timing,
  CAST(t.EVENT_MANIPULATION AS CHAR) AS event,
  CAST(t.ACTION_STATEMENT AS CHAR) AS definition
FROM INFORMATION_SCHEMA.TRIGGERS t
WHERE t.EVENT_OBJECT_TABLE = ?
  AND t.EVENT_OBJECT_SCHEMA = COALESCE(?, DATABASE())
ORDER BY t.TRIGGER_NAME
"#;

const SQLITE_TRIGGERS: &str = r#"
SELECT
  name AS trigger_name,
  NULL AS timing,
  NULL AS event,
  sql AS definition
FROM sqlite_master
WHERE type = 'trigger'
  AND tbl_name = ?1
ORDER BY name
"#;

#[cfg(test)]
mod tests {
  use super::*;

  /// 占位符里最大的序号，就是这段 SQL 要绑几个参数。
  ///
  /// PostgreSQL 写 `$1`/`$2`；SQLite 写 `?1`；MySQL 写裸 `?`，按出现次数算。
  fn placeholder_count(sql: &str) -> usize {
    let numbered = |marker: char| {
      sql
        .match_indices(marker)
        .filter_map(|(at, _)| {
          sql[at + 1..].chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok()
        })
        .max()
        .unwrap_or(0)
    };

    let dollars = numbered('$');
    if dollars > 0 {
      return dollars;
    }
    let numbered_marks = numbered('?');
    if numbered_marks > 0 {
      return numbered_marks;
    }
    sql.matches('?').count()
  }

  /// 前端按 `parameter_count` 造一份参数，发给这个方言的**每一段**查询。
  /// 这条不变量成立，那份算法才成立。
  ///
  /// 它不是假想的：`ddl` 这一段此前实际收到的是一个参数（前端照 SQLite 的
  /// 形状写死了），而 PostgreSQL 的视图定义要两个。真库上的回答是
  /// `bind message supplies 1 parameters, but prepared statement requires 2`，
  /// 而那条查询和索引、外键、触发器在同一个 `Promise.all` 里——于是
  /// PostgreSQL 上整个「结构」页一条索引都显示不出来。
  #[test]
  fn every_bound_query_of_a_dialect_binds_parameter_count_values() {
    for db_type in [DatabaseType::PostgreSQL, DatabaseType::MySQL, DatabaseType::SQLite] {
      let queries = schema_metadata_queries(&db_type).expect("supported");
      let expected = usize::from(queries.parameter_count);

      let mut bound = vec![
        ("columns", queries.columns),
        ("indexes", queries.indexes),
        ("foreign_keys", queries.foreign_keys),
        ("triggers", queries.triggers),
      ];
      if let Some(sql) = queries.check_constraints {
        bound.push(("check_constraints", sql));
      }
      match queries.ddl {
        // 插值那一种把表名当标识符拼进去，一个占位符都不该有——
        // 把表名当字符串绑进 SHOW CREATE TABLE 是语法错误
        Some(DdlQuery::Interpolated { sql }) => assert_eq!(
          placeholder_count(sql),
          0,
          "{db_type:?} 的 ddl 是插值形态，不该有占位符: {sql}"
        ),
        Some(DdlQuery::Bound { sql }) => bound.push(("ddl", sql)),
        None => {}
      }

      for (name, sql) in bound {
        assert_eq!(
          placeholder_count(sql),
          expected,
          "{db_type:?} 的 {name} 要 {} 个参数，与声明的 {expected} 不符；\
           前端只按 parameter_count 造一份参数发给全部查询: {sql}",
          placeholder_count(sql)
        );
      }
    }
  }

  #[test]
  fn sqlite_reports_no_check_constraint_catalog() {
    let queries = schema_metadata_queries(&DatabaseType::SQLite).expect("sqlite supported");
    assert!(
      queries.check_constraints.is_none(),
      "SQLite 没有检查约束目录，必须用 None 说出来，不能给一段查不到东西的 SQL"
    );
  }

  /// PostgreSQL 的**建表**语句：当前版本不做。
  ///
  /// 它没有 `SHOW CREATE TABLE`，要从目录重建就得覆盖类型、默认值、identity、
  /// 排序规则、存储参数、分区、继承、注释、触发器、RLS。少任何一项，产出的
  /// 就是**看起来权威、照着重建却不等价**的 DDL——那比没有更糟，因为没人会
  /// 去核对它。
  ///
  /// **视图**不同：`pg_get_viewdef` 是服务器自己反解的原文，和其它方言的
  /// `SHOW CREATE VIEW` 同一性质，所以视图有。
  ///
  /// 重估条件（可执行）：这条断言。哪天真的生成了建表语句，它会红，
  /// 逼着回来把这段理由改掉，而不是让一个过期的判断留在代码里。
  #[test]
  fn postgres_has_no_create_table_statement() {
    let queries = schema_metadata_queries(&DatabaseType::PostgreSQL).expect("supported");
    let Some(DdlQuery::Bound { sql }) = queries.ddl else {
      panic!("PostgreSQL 的对象定义走绑定参数");
    };
    assert!(
      sql.contains("relkind IN ('v', 'm')"),
      "只对视图与物化视图返回定义；查表时应返回 0 行: {sql}"
    );
    assert!(!sql.contains("CREATE TABLE"), "不生成建表语句——从目录重建做不到与原表等价: {sql}");
  }

  #[test]
  fn mysql_interpolates_the_table_identifier_because_show_rejects_placeholders() {
    let queries = schema_metadata_queries(&DatabaseType::MySQL).expect("supported");
    match queries.ddl {
      Some(DdlQuery::Interpolated { sql }) => {
        assert!(sql.contains("{table}"), "插值形态必须留出 {{table}}: {sql}")
      }
      other => panic!("MySQL 的 SHOW CREATE TABLE 只能插值，不能绑参: {other:?}"),
    }
  }

  #[test]
  fn sqlite_binds_the_table_name_as_a_string() {
    let queries = schema_metadata_queries(&DatabaseType::SQLite).expect("supported");
    match queries.ddl {
      // sqlite_master.tbl_name 是字符串字面量，按标识符引用会查不到
      Some(DdlQuery::Bound { sql }) => assert!(sql.contains('?'), "绑定形态必须带占位符: {sql}"),
      other => panic!("SQLite 应走绑定参数: {other:?}"),
    }
  }

  /// 少一列不会报错：前端读到 `undefined`，`is_valid` 会被当成 false，
  /// 于是那个方言的唯一索引**全部**悄悄失去行标识资格，表变成只读，
  /// 而没有任何一处会说这是为什么。
  #[test]
  fn every_index_query_reports_whether_the_index_can_identify_a_row() {
    for db_type in [DatabaseType::MySQL, DatabaseType::PostgreSQL, DatabaseType::SQLite] {
      let queries = schema_metadata_queries(&db_type).expect("supported");
      for column in ["is_unique", "is_primary", "is_partial", "is_valid"] {
        assert!(
          queries.indexes.contains(column),
          "{:?} 的索引查询缺少 {}: {}",
          db_type,
          column,
          queries.indexes
        );
      }
    }
  }

  /// 列目录的字段名是前端与三种方言之间唯一的约定。
  ///
  /// 少一个不会报错：`toColumnInfo` 读到 `undefined`，于是
  /// `is_generated` 变成 false、`is_nullable` 变成 false，
  /// 那个方言的自增主键表就再也插不进一行——而错误信息只说「主键必填」。
  #[test]
  fn every_column_query_returns_the_same_shape() {
    for db_type in [DatabaseType::MySQL, DatabaseType::PostgreSQL, DatabaseType::SQLite] {
      let queries = schema_metadata_queries(&db_type).expect("supported");
      for alias in [
        "column_name",
        "data_type",
        "is_nullable",
        "column_default",
        "is_primary_key",
        "primary_key_ordinal",
        "is_generated",
      ] {
        assert!(
          queries.columns.contains(alias),
          "{:?} 的列目录缺少 {}: {}",
          db_type,
          alias,
          queries.columns
        );
      }
    }
  }

  /// 类型必须是数据库自己的声明原文。
  ///
  /// `information_schema.columns.data_type` 给的是类目名：`text[]` 变成
  /// `ARRAY`、`varchar(32)` 变成 `character varying`。结构页显示的就是这个字段，
  /// 显示 `ARRAY` 等于没说。
  #[test]
  fn column_types_come_from_the_authoritative_reverse_parser() {
    let postgres = schema_metadata_queries(&DatabaseType::PostgreSQL).expect("supported");
    assert!(
      postgres.columns.contains("format_type("),
      "PostgreSQL 的类型要用 format_type 反解: {}",
      postgres.columns
    );
    let mysql = schema_metadata_queries(&DatabaseType::MySQL).expect("supported");
    assert!(
      mysql.columns.contains("COLUMN_TYPE"),
      "MySQL 的 DATA_TYPE 丢掉长度与 unsigned: {}",
      mysql.columns
    );
  }

  #[test]
  fn unsupported_databases_get_no_queries() {
    // 这些类型连查询执行层都没有，给出 SQL 只会让前端拿去执行然后失败
    for db_type in [DatabaseType::MongoDB, DatabaseType::Redis, DatabaseType::ClickHouse] {
      assert!(schema_metadata_queries(&db_type).is_none(), "{:?} 不该有目录查询", db_type);
    }
  }

  #[test]
  fn supported_databases_bind_parameters_instead_of_interpolating() {
    for db_type in [DatabaseType::MySQL, DatabaseType::PostgreSQL, DatabaseType::SQLite] {
      let queries = schema_metadata_queries(&db_type).expect("supported");
      for sql in [
        Some(queries.columns),
        Some(queries.indexes),
        Some(queries.foreign_keys),
        Some(queries.triggers),
        queries.check_constraints,
      ]
      .into_iter()
      .flatten()
      {
        assert!(
          sql.contains('?') || sql.contains('$'),
          "{:?} 的目录查询必须带占位符，不能把表名拼进字符串: {}",
          db_type,
          sql
        );
      }
    }
  }
}
