//! 「这个库里有哪些对象」——库级目录查询。
//!
//! 与 `schema_metadata` 的分界：那个回答「这**张表**的结构是什么」，
//! 这个回答「这个**库**里有什么」。两者的参数、缓存时机和失效条件都不同。

use crate::models::DatabaseType;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ObjectCatalogQueries {
  /// 列出库里的所有对象，返回 object_schema / object_name / object_kind / object_id
  pub objects: &'static str,
  /// 绑定 `object_id`，取函数或存储过程的定义原文
  pub routine_definition: &'static str,
  /// 绑定 `object_id`，取序列的属性；`None` 表示该方言没有序列
  pub sequence_properties: Option<&'static str>,
  /// `objects` 需要绑定几个参数（MySQL 的 UNION 两边各要一次库名）
  pub object_parameter_count: u8,
}

pub fn object_catalog_queries(db_type: &DatabaseType) -> Option<ObjectCatalogQueries> {
  match db_type {
    DatabaseType::PostgreSQL => Some(ObjectCatalogQueries {
      objects: POSTGRES_OBJECTS,
      routine_definition: POSTGRES_ROUTINE_DEFINITION,
      sequence_properties: Some(POSTGRES_SEQUENCE_PROPERTIES),
      object_parameter_count: 0,
    }),
    DatabaseType::MySQL => Some(ObjectCatalogQueries {
      objects: MYSQL_OBJECTS,
      routine_definition: MYSQL_ROUTINE_DEFINITION,
      // MySQL 没有序列，AUTO_INCREMENT 是列属性不是独立对象
      sequence_properties: None,
      object_parameter_count: 2,
    }),
    DatabaseType::SQLite => Some(ObjectCatalogQueries {
      objects: SQLITE_OBJECTS,
      // SQLite 的函数是宿主程序注册的，目录里查不到；这段永远不会被调用到，
      // 因为列不出任何 function / procedure 对象
      routine_definition: SQLITE_NO_ROUTINES,
      sequence_properties: None,
      object_parameter_count: 0,
    }),
    DatabaseType::SqlServer => Some(ObjectCatalogQueries {
      objects: SQL_SERVER_OBJECTS,
      routine_definition: SQL_SERVER_ROUTINE_DEFINITION,
      sequence_properties: Some(SQL_SERVER_SEQUENCE_PROPERTIES),
      object_parameter_count: 0,
    }),
    DatabaseType::Oracle => Some(ObjectCatalogQueries {
      objects: ORACLE_OBJECTS,
      routine_definition: ORACLE_ROUTINE_DEFINITION,
      sequence_properties: Some(ORACLE_SEQUENCE_PROPERTIES),
      object_parameter_count: 0,
    }),
    _ => None,
  }
}

/// `object_id` 用 oid：**函数是可以重载的**，`proname` 不唯一，
/// 拿名字去取定义会取到同名的另一个重载。显示名带上参数签名，
/// 让用户也能分辨是哪一个。
///
/// 序列这里不过滤 serial / identity 列自动建的那些——它们是真实存在的对象，
/// 用户按名字（`users_id_seq`）找得到才有意义。
///
/// 系统 schema 除了 PostgreSQL 自己的两个，还排掉 CockroachDB 的
/// `crdb_internal` 与 `pg_extension`：不排的话对象树里多出 91 张系统表、
/// 20 个视图和 133 个内建函数，内建函数的参数签名还是 NULL，整行名字跟着
/// 成了 NULL。这两个名字在 PostgreSQL 上不存在（`pg_` 前缀是保留的），
/// 排了等于没排。补全目录与 ER 图用的是同一份清单。
const POSTGRES_OBJECTS: &str = r#"
SELECT
  n.nspname::text AS object_schema,
  c.relname::text AS object_name,
  CASE c.relkind
    WHEN 'v' THEN 'view'
    WHEN 'm' THEN 'materialized-view'
    WHEN 'S' THEN 'sequence'
    ELSE 'table'
  END AS object_kind,
  c.oid::text AS object_id
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'crdb_internal', 'pg_extension')
  AND n.nspname NOT LIKE 'pg\_toast%'
  AND n.nspname NOT LIKE 'pg\_temp%'
UNION ALL
SELECT
  n.nspname::text,
  (p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')::text,
  CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,
  p.oid::text
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prokind IN ('f', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'crdb_internal', 'pg_extension')
ORDER BY 1, 3, 2
"#;

const POSTGRES_ROUTINE_DEFINITION: &str = "SELECT pg_get_functiondef($1::oid)::text AS definition";

/// 序列没有 `CREATE SEQUENCE` 的反解函数，但 pg_sequences 直接给出定义它的
/// 全部属性。如实列出属性，不去拼一条可能不等价的 CREATE SEQUENCE。
const POSTGRES_SEQUENCE_PROPERTIES: &str = r#"
SELECT
  s.start_value::text AS start_value,
  s.increment_by::text AS increment_by,
  s.min_value::text AS min_value,
  s.max_value::text AS max_value,
  s.cache_size::text AS cache_size,
  s.cycle::text AS cycles,
  s.data_type::text AS data_type,
  s.last_value::text AS last_value
FROM pg_sequences s
JOIN pg_class c ON c.relname = s.sequencename
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = s.schemaname
WHERE c.oid = $1::oid
"#;

/// CAST 不是装饰：MySQL 8 的 information_schema 以 VARBINARY 返回标识符列，
/// 而 tauri-plugin-sql 的解码器类型表里没有 VARBINARY，会直接报
/// 「unsupported datatype: VARBINARY」。
///
/// 两个 `?` 都是库名：UNION 两边各要绑一次。
const MYSQL_OBJECTS: &str = r#"
SELECT
  CAST(t.TABLE_SCHEMA AS CHAR) AS object_schema,
  CAST(t.TABLE_NAME AS CHAR) AS object_name,
  CASE t.TABLE_TYPE WHEN 'VIEW' THEN 'view' ELSE 'table' END AS object_kind,
  CAST(t.TABLE_NAME AS CHAR) AS object_id
FROM INFORMATION_SCHEMA.TABLES t
WHERE t.TABLE_SCHEMA = ?
UNION ALL
SELECT
  CAST(r.ROUTINE_SCHEMA AS CHAR),
  CAST(r.ROUTINE_NAME AS CHAR),
  CASE r.ROUTINE_TYPE WHEN 'PROCEDURE' THEN 'procedure' ELSE 'function' END,
  CAST(r.ROUTINE_NAME AS CHAR)
FROM INFORMATION_SCHEMA.ROUTINES r
WHERE r.ROUTINE_SCHEMA = ?
ORDER BY 3, 2
"#;

/// MySQL 的 `ROUTINE_DEFINITION` 只有语句体，没有参数与返回类型。
/// 权威原文要 `SHOW CREATE FUNCTION`，但那不接受占位符、还要先知道是函数
/// 还是存储过程；语句体已经是用户真正想看的部分。
const MYSQL_ROUTINE_DEFINITION: &str = r#"
SELECT CAST(r.ROUTINE_DEFINITION AS CHAR) AS definition
FROM INFORMATION_SCHEMA.ROUTINES r
WHERE r.ROUTINE_NAME = ?
  AND r.ROUTINE_SCHEMA = COALESCE(?, DATABASE())
"#;

const SQLITE_OBJECTS: &str = r#"
SELECT
  NULL AS object_schema,
  name AS object_name,
  CASE type WHEN 'view' THEN 'view' ELSE 'table' END AS object_kind,
  name AS object_id
FROM sqlite_master
WHERE type IN ('table', 'view')
  AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
ORDER BY 3, 2
"#;

const SQLITE_NO_ROUTINES: &str = "SELECT NULL AS definition WHERE 0";

/// `object_id` 用 `sys.objects.object_id`：函数与存储过程不能重载，但不同
/// schema 下可以同名，按 id 取定义才不会取错。`is_ms_shipped` 排掉系统对象。
/// 函数有三种：标量（FN）、内联表值（IF）、多语句表值（TF）。
const SQL_SERVER_OBJECTS: &str = r#"
SELECT
  s.name AS object_schema,
  o.name AS object_name,
  CASE o.type
    WHEN 'U' THEN 'table'
    WHEN 'V' THEN 'view'
    WHEN 'P' THEN 'procedure'
    WHEN 'SO' THEN 'sequence'
    ELSE 'function'
  END AS object_kind,
  CAST(o.object_id AS nvarchar(20)) AS object_id
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'SO')
  AND o.is_ms_shipped = 0
ORDER BY 1, 3, 2
"#;

/// 前端对非 PostgreSQL 的方言绑两个参数（名字、库名）；这里的第一个参数
/// 就是 object_id，第二个 SQL Server 用不上，`sp_executesql` 允许多声明的参数不用
const SQL_SERVER_ROUTINE_DEFINITION: &str =
  "SELECT OBJECT_DEFINITION(CAST(@P1 AS int)) AS definition";

/// 值是 `sql_variant`，一律转成文本；列名与 PostgreSQL 那一份对齐
const SQL_SERVER_SEQUENCE_PROPERTIES: &str = r#"
SELECT
  CAST(sq.start_value AS nvarchar(40)) AS start_value,
  CAST(sq.increment AS nvarchar(40)) AS increment_by,
  CAST(sq.minimum_value AS nvarchar(40)) AS min_value,
  CAST(sq.maximum_value AS nvarchar(40)) AS max_value,
  CAST(sq.cache_size AS nvarchar(20)) AS cache_size,
  CASE WHEN sq.is_cycling = 1 THEN 'true' ELSE 'false' END AS cycles,
  TYPE_NAME(sq.system_type_id) AS data_type,
  CAST(sq.current_value AS nvarchar(40)) AS last_value
FROM sys.sequences sq
WHERE sq.object_id = CAST(@P1 AS int)
"#;

/// Oracle：只列用户自己的 schema（见 `oracle_user_schemas!`）；`BIN$` 开头的是回收站
/// 里的表。包（PACKAGE）归在过程一组里——它不是函数，也没有更近的一组，而不列
/// 出来就等于告诉用户这个库里没有包。`object_id` 是 `owner.name`：Oracle 的对象
/// 没有可以拿来取定义的数字 id（`OBJECT_ID` 在导出导入之后会变）
const ORACLE_OBJECTS: &str = concat!(
  r#"
SELECT
  o.owner AS "object_schema",
  o.object_name AS "object_name",
  CASE o.object_type
    WHEN 'TABLE' THEN 'table'
    WHEN 'VIEW' THEN 'view'
    WHEN 'SEQUENCE' THEN 'sequence'
    WHEN 'FUNCTION' THEN 'function'
    ELSE 'procedure'
  END AS "object_kind",
  o.owner || '.' || o.object_name AS "object_id"
FROM all_objects o
JOIN all_users u ON u.username = o.owner
WHERE "#,
  crate::services::oracle::oracle_user_schemas!(),
  r#"
  AND o.object_type IN ('TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'SEQUENCE')
  AND o.object_name NOT LIKE 'BIN$%'
  AND o.secondary = 'N'
ORDER BY 1, 3, 2
"#
);

/// `ALL_SOURCE` 一行一行地存，拼起来会超过 VARCHAR2 的 4000 字节；`GET_DDL`
/// 给的是一整段 CLOB，还带着 `CREATE OR REPLACE` 头
const ORACLE_ROUTINE_DEFINITION: &str = r#"
SELECT DBMS_METADATA.GET_DDL(o.object_type, o.object_name, o.owner) AS "definition"
FROM all_objects o
WHERE o.owner || '.' || o.object_name = :1
  AND o.object_type IN ('PROCEDURE', 'FUNCTION', 'PACKAGE')
"#;

/// 数值都转成文本：序列的上限默认是 28 个 9，超出 JavaScript 能精确表示的范围。
/// `ALL_SEQUENCES` 没有起始值
const ORACLE_SEQUENCE_PROPERTIES: &str = r#"
SELECT
  CAST(NULL AS VARCHAR2(1)) AS "start_value",
  TO_CHAR(s.increment_by) AS "increment_by",
  TO_CHAR(s.min_value) AS "min_value",
  TO_CHAR(s.max_value) AS "max_value",
  TO_CHAR(s.cache_size) AS "cache_size",
  CASE WHEN s.cycle_flag = 'Y' THEN 'true' ELSE 'false' END AS "cycles",
  'NUMBER' AS "data_type",
  TO_CHAR(s.last_number) AS "last_value"
FROM all_sequences s
WHERE s.sequence_owner || '.' || s.sequence_name = :1
"#;

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn mysql_binds_the_database_name_on_both_sides_of_the_union() {
    let queries = object_catalog_queries(&DatabaseType::MySQL).expect("supported");
    assert_eq!(
      queries.objects.matches('?').count(),
      usize::from(queries.object_parameter_count),
      "声明的参数个数必须和语句里的占位符个数一致，否则绑定会错位或报错"
    );
  }

  #[test]
  fn dialects_without_sequences_say_so() {
    // MySQL 的 AUTO_INCREMENT 是列属性，不是独立对象；SQLite 同理
    for db_type in [DatabaseType::MySQL, DatabaseType::SQLite] {
      let queries = object_catalog_queries(&db_type).expect("supported");
      assert!(queries.sequence_properties.is_none(), "{db_type:?} 没有序列对象");
    }
    assert!(object_catalog_queries(&DatabaseType::PostgreSQL)
      .expect("supported")
      .sequence_properties
      .is_some());
  }

  #[test]
  fn postgres_identifies_routines_by_oid_because_they_can_be_overloaded() {
    let queries = object_catalog_queries(&DatabaseType::PostgreSQL).expect("supported");
    assert!(
      queries.objects.contains("p.oid::text"),
      "重载的函数同名，按名字取定义会取到另一个重载"
    );
    assert!(
      queries.objects.contains("pg_get_function_identity_arguments"),
      "显示名要带参数签名，否则重载的几个在树里长得一模一样"
    );
  }

  #[test]
  fn unsupported_databases_get_no_catalog() {
    for db_type in [DatabaseType::MongoDB, DatabaseType::Redis, DatabaseType::Neo4j] {
      assert!(object_catalog_queries(&db_type).is_none(), "{db_type:?} 不该有目录查询");
    }
  }
}
