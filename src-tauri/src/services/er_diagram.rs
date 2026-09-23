//! 整库的 ER 关系图数据：所有表的列，以及所有表之间的外键。
//!
//! 与 `schema_metadata` 的分界：那个按**单张表**查结构，这个一次查**整个库**。
//! 不复用的理由是实际的：ER 图要在一次往返里拿到全部，按表逐个查在几十张表
//! 的库上就是几十次往返。
//!
//! 表用 `schema` + `name` 两段标识：PostgreSQL 的一个库里可以有
//! `public.orders` 和 `billing.orders` 两张不同的表，只按名字会把它们画成一个。

use crate::models::DatabaseType;
use crate::services::sql_server::sql_server_type_name;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ErDiagramQueries {
  /// 所有表的列：table_schema / table_name / column_name / data_type /
  /// ordinal / is_primary_key / is_nullable
  pub columns: &'static str,
  /// 所有外键：table_schema / table_name / column_name /
  /// referenced_schema / referenced_table / referenced_column /
  /// constraint_name / ordinal
  pub foreign_keys: &'static str,
  /// 两段查询各需要绑定几个参数（都是库名）
  pub parameter_count: u8,
}

pub fn er_diagram_queries(db_type: &DatabaseType) -> Option<ErDiagramQueries> {
  match db_type {
    DatabaseType::PostgreSQL => Some(ErDiagramQueries {
      columns: POSTGRES_COLUMNS,
      foreign_keys: POSTGRES_FOREIGN_KEYS,
      parameter_count: 0,
    }),
    DatabaseType::MySQL => Some(ErDiagramQueries {
      columns: MYSQL_COLUMNS,
      foreign_keys: MYSQL_FOREIGN_KEYS,
      parameter_count: 1,
    }),
    DatabaseType::SQLite => Some(ErDiagramQueries {
      columns: SQLITE_COLUMNS,
      foreign_keys: SQLITE_FOREIGN_KEYS,
      parameter_count: 0,
    }),
    DatabaseType::SqlServer => Some(ErDiagramQueries {
      columns: SQL_SERVER_COLUMNS,
      foreign_keys: SQL_SERVER_FOREIGN_KEYS,
      parameter_count: 0,
    }),
    _ => None,
  }
}

/// `format_type` 给的是 `character varying(32)` 这种带长度的完整写法，
/// 比 `information_schema.columns.data_type` 的 `character varying` 有用——
/// 图上要显示的就是「字段和类型」，丢掉长度等于丢掉一半信息。
///
/// `attnum > 0 AND NOT attisdropped` 排掉系统列与已删除列的墓碑。
const POSTGRES_COLUMNS: &str = r#"
SELECT
  n.nspname::text AS table_schema,
  c.relname::text AS table_name,
  a.attname::text AS column_name,
  format_type(a.atttypid, a.atttypmod)::text AS data_type,
  a.attnum::int AS ordinal,
  EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)
  ) AS is_primary_key,
  (NOT a.attnotnull) AS is_nullable
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'crdb_internal', 'pg_extension')
  AND n.nspname NOT LIKE 'pg\_toast%'
  AND n.nspname NOT LIKE 'pg\_temp%'
ORDER BY n.nspname, c.relname, a.attnum
"#;

/// 与单表版本同样的要点：`unnest(conkey, confkey) WITH ORDINALITY` 把本表列
/// 与被引用列按同一个下标配对，分两次 unnest 会在复合外键上错位。
const POSTGRES_FOREIGN_KEYS: &str = r#"
SELECT
  n.nspname::text AS table_schema,
  t.relname::text AS table_name,
  a.attname::text AS column_name,
  fn.nspname::text AS referenced_schema,
  ft.relname::text AS referenced_table,
  fa.attname::text AS referenced_column,
  c.conname::text AS constraint_name,
  k.ord::int AS ordinal
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_class ft ON ft.oid = c.confrelid
JOIN pg_namespace fn ON fn.oid = ft.relnamespace
CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord)
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
JOIN pg_attribute fa ON fa.attrelid = ft.oid AND fa.attnum = k.fattnum
WHERE c.contype = 'f'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'crdb_internal', 'pg_extension')
ORDER BY n.nspname, t.relname, c.conname, k.ord
"#;

/// 取 `COLUMN_TYPE` 而不是 `DATA_TYPE`：前者是 `varchar(32)`、`int unsigned`，
/// 后者只有 `varchar`、`int`。
///
/// join TABLES 是为了排掉视图——ER 图画的是表之间的外键，视图没有外键。
const MYSQL_COLUMNS: &str = r#"
SELECT
  CAST(c.TABLE_SCHEMA AS CHAR) AS table_schema,
  CAST(c.TABLE_NAME AS CHAR) AS table_name,
  CAST(c.COLUMN_NAME AS CHAR) AS column_name,
  CAST(c.COLUMN_TYPE AS CHAR) AS data_type,
  c.ORDINAL_POSITION AS ordinal,
  (c.COLUMN_KEY = 'PRI') AS is_primary_key,
  (c.IS_NULLABLE = 'YES') AS is_nullable
FROM INFORMATION_SCHEMA.COLUMNS c
JOIN INFORMATION_SCHEMA.TABLES t
  ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
 AND t.TABLE_NAME = c.TABLE_NAME
 AND t.TABLE_TYPE = 'BASE TABLE'
WHERE c.TABLE_SCHEMA = ?
ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
"#;

const MYSQL_FOREIGN_KEYS: &str = r#"
SELECT
  CAST(k.TABLE_SCHEMA AS CHAR) AS table_schema,
  CAST(k.TABLE_NAME AS CHAR) AS table_name,
  CAST(k.COLUMN_NAME AS CHAR) AS column_name,
  CAST(k.REFERENCED_TABLE_SCHEMA AS CHAR) AS referenced_schema,
  CAST(k.REFERENCED_TABLE_NAME AS CHAR) AS referenced_table,
  CAST(k.REFERENCED_COLUMN_NAME AS CHAR) AS referenced_column,
  CAST(k.CONSTRAINT_NAME AS CHAR) AS constraint_name,
  k.ORDINAL_POSITION AS ordinal
FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
WHERE k.TABLE_SCHEMA = ?
  AND k.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION
"#;

/// pragma 表值函数可以拿 sqlite_master 的列当参数，于是整库的列能一次查完，
/// 不用对每张表各跑一次 PRAGMA。
const SQLITE_COLUMNS: &str = r#"
SELECT
  NULL AS table_schema,
  m.name AS table_name,
  p.name AS column_name,
  p.type AS data_type,
  p.cid + 1 AS ordinal,
  (p.pk > 0) AS is_primary_key,
  (p.[notnull] = 0) AS is_nullable
FROM sqlite_master m
JOIN pragma_table_info(m.name) p
WHERE m.type = 'table'
  AND m.name NOT LIKE 'sqlite\_%' ESCAPE '\'
ORDER BY m.name, p.cid
"#;

/// SQLite 的外键没有名字，用 `fk_<id>` 合成；`"to"` 为 NULL 表示引用父表主键。
const SQLITE_FOREIGN_KEYS: &str = r#"
SELECT
  NULL AS table_schema,
  m.name AS table_name,
  f.[from] AS column_name,
  NULL AS referenced_schema,
  f.[table] AS referenced_table,
  f.[to] AS referenced_column,
  'fk_' || f.id AS constraint_name,
  f.seq + 1 AS ordinal
FROM sqlite_master m
JOIN pragma_foreign_key_list(m.name) f
WHERE m.type = 'table'
  AND m.name NOT LIKE 'sqlite\_%' ESCAPE '\'
ORDER BY m.name, f.id, f.seq
"#;

/// 连接本身就落在一个库上，`sys.*` 只看得到这个库，不用再绑库名
const SQL_SERVER_COLUMNS: &str = concat!(
  r#"
SELECT
  s.name AS table_schema,
  o.name AS table_name,
  c.name AS column_name,
  "#,
  sql_server_type_name!(),
  r#" AS data_type,
  CAST(c.column_id AS int) AS ordinal,
  CAST(CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS bit) AS is_primary_key,
  c.is_nullable AS is_nullable
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.columns c ON c.object_id = o.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN (
  SELECT ic.object_id, ic.column_id
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  WHERE i.is_primary_key = 1
) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
WHERE o.type = 'U'
  AND o.is_ms_shipped = 0
ORDER BY s.name, o.name, c.column_id
"#
);

const SQL_SERVER_FOREIGN_KEYS: &str = r#"
SELECT
  s.name AS table_schema,
  o.name AS table_name,
  pc.name AS column_name,
  rs.name AS referenced_schema,
  rt.name AS referenced_table,
  rc.name AS referenced_column,
  fk.name AS constraint_name,
  CAST(fkc.constraint_column_id AS int) AS ordinal
FROM sys.foreign_keys fk
JOIN sys.objects o ON o.object_id = fk.parent_object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.objects rt ON rt.object_id = fkc.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN sys.columns rc
  ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE o.is_ms_shipped = 0
ORDER BY s.name, o.name, fk.name, fkc.constraint_column_id
"#;

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn declared_parameter_count_matches_the_placeholders() {
    for db_type in
      [DatabaseType::MySQL, DatabaseType::PostgreSQL, DatabaseType::SQLite, DatabaseType::SqlServer]
    {
      let queries = er_diagram_queries(&db_type).expect("supported");
      for sql in [queries.columns, queries.foreign_keys] {
        assert_eq!(
          sql.matches('?').count(),
          usize::from(queries.parameter_count),
          "{db_type:?} 声明的参数个数必须和语句里的占位符个数一致"
        );
      }
    }
  }

  #[test]
  fn mysql_reports_the_full_column_type_not_just_the_base_type() {
    let queries = er_diagram_queries(&DatabaseType::MySQL).expect("supported");
    assert!(
      queries.columns.contains("COLUMN_TYPE"),
      "DATA_TYPE 只给 varchar，丢掉长度等于丢掉一半信息"
    );
  }

  #[test]
  fn postgres_pairs_composite_foreign_keys_by_key_order() {
    let queries = er_diagram_queries(&DatabaseType::PostgreSQL).expect("supported");
    assert!(
      queries.foreign_keys.contains("unnest(c.conkey, c.confkey) WITH ORDINALITY"),
      "分两次 unnest 会让复合外键错位，且错位后看上去完全正常"
    );
  }

  #[test]
  fn unsupported_databases_get_no_queries() {
    for db_type in [DatabaseType::MongoDB, DatabaseType::Redis] {
      assert!(er_diagram_queries(&db_type).is_none());
    }
  }
}
