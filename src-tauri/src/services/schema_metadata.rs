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
  pub indexes: &'static str,
  pub foreign_keys: &'static str,
  pub check_constraints: Option<&'static str>,
}

/// 该方言是否支持目录级的结构浏览。
///
/// 只有已经实现了查询执行层的三种关系型数据库有；其它类型连查询都跑不了，
/// 返回 `None` 让调用方明确处理，而不是给一段注定失败的 SQL。
pub fn schema_metadata_queries(db_type: &DatabaseType) -> Option<SchemaMetadataQueries> {
  match db_type {
    DatabaseType::PostgreSQL => Some(SchemaMetadataQueries {
      indexes: POSTGRES_INDEXES,
      foreign_keys: POSTGRES_FOREIGN_KEYS,
      check_constraints: Some(POSTGRES_CHECK_CONSTRAINTS),
    }),
    DatabaseType::MySQL => Some(SchemaMetadataQueries {
      indexes: MYSQL_INDEXES,
      foreign_keys: MYSQL_FOREIGN_KEYS,
      check_constraints: Some(MYSQL_CHECK_CONSTRAINTS),
    }),
    DatabaseType::SQLite => Some(SchemaMetadataQueries {
      indexes: SQLITE_INDEXES,
      foreign_keys: SQLITE_FOREIGN_KEYS,
      check_constraints: None,
    }),
    _ => None,
  }
}

/// 列名用 `pg_get_indexdef(oid, colno, true)` 取而不是 join `pg_attribute`：
/// 表达式索引在 `indkey` 里的位置是 0，join 不上任何列，那一列会凭空消失。
/// `k.ord <= ix.indnkeyatts` 排掉 INCLUDE 的附加列——它们不参与键。
const POSTGRES_INDEXES: &str = r#"
SELECT
  i.relname::text AS index_name,
  pg_get_indexdef(ix.indexrelid, k.ord::int, true)::text AS column_name,
  k.ord::int AS ordinal,
  ix.indisunique AS is_unique,
  ix.indisprimary AS is_primary,
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
/// 只读 COLUMN_NAME 会得到一列空值。
const MYSQL_INDEXES: &str = r#"
SELECT
  CAST(s.INDEX_NAME AS CHAR) AS index_name,
  CAST(COALESCE(s.COLUMN_NAME, s.EXPRESSION) AS CHAR) AS column_name,
  s.SEQ_IN_INDEX AS ordinal,
  (s.NON_UNIQUE = 0) AS is_unique,
  (s.INDEX_NAME = 'PRIMARY') AS is_primary,
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
const SQLITE_INDEXES: &str = r#"
SELECT
  il.name AS index_name,
  ii.name AS column_name,
  ii.seqno + 1 AS ordinal,
  il."unique" AS is_unique,
  (il.origin = 'pk') AS is_primary,
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

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn sqlite_reports_no_check_constraint_catalog() {
    let queries = schema_metadata_queries(&DatabaseType::SQLite).expect("sqlite supported");
    assert!(
      queries.check_constraints.is_none(),
      "SQLite 没有检查约束目录，必须用 None 说出来，不能给一段查不到东西的 SQL"
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
      for sql in [Some(queries.indexes), Some(queries.foreign_keys), queries.check_constraints]
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
