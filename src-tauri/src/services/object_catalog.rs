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
  /// `routine_definition` 绑几个参数：`[object_id]`，MySQL 另要库名 `[object_id, 库名]`。
  ///
  /// 写成数据而不是让前端按方言猜：前端原先写的是「PostgreSQL 一个，其余两个」，
  /// SQL Server 与 Oracle 的驱动不计较多给的那一个，DuckDB 计较——「Wrong number of
  /// parameters passed to query. Got 2, needed 1」，宏的定义打不开
  pub routine_parameter_count: u8,
}

pub fn object_catalog_queries(db_type: &DatabaseType) -> Option<ObjectCatalogQueries> {
  match db_type {
    DatabaseType::PostgreSQL => Some(ObjectCatalogQueries {
      objects: POSTGRES_OBJECTS,
      routine_definition: POSTGRES_ROUTINE_DEFINITION,
      sequence_properties: Some(POSTGRES_SEQUENCE_PROPERTIES),
      object_parameter_count: 0,
      routine_parameter_count: 1,
    }),
    DatabaseType::MySQL => Some(ObjectCatalogQueries {
      objects: MYSQL_OBJECTS,
      routine_definition: MYSQL_ROUTINE_DEFINITION,
      // MySQL 没有序列，AUTO_INCREMENT 是列属性不是独立对象
      sequence_properties: None,
      object_parameter_count: 2,
      routine_parameter_count: 2,
    }),
    DatabaseType::SQLite => Some(ObjectCatalogQueries {
      objects: SQLITE_OBJECTS,
      // SQLite 的函数是宿主程序注册的，目录里查不到；这段永远不会被调用到，
      // 因为列不出任何 function / procedure 对象
      routine_definition: SQLITE_NO_ROUTINES,
      sequence_properties: None,
      object_parameter_count: 0,
      routine_parameter_count: 0,
    }),
    DatabaseType::SqlServer => Some(ObjectCatalogQueries {
      objects: SQL_SERVER_OBJECTS,
      routine_definition: SQL_SERVER_ROUTINE_DEFINITION,
      sequence_properties: Some(SQL_SERVER_SEQUENCE_PROPERTIES),
      object_parameter_count: 0,
      routine_parameter_count: 1,
    }),
    DatabaseType::Oracle => Some(ObjectCatalogQueries {
      objects: ORACLE_OBJECTS,
      routine_definition: ORACLE_ROUTINE_DEFINITION,
      sequence_properties: Some(ORACLE_SEQUENCE_PROPERTIES),
      object_parameter_count: 0,
      routine_parameter_count: 1,
    }),
    DatabaseType::DuckDB => Some(ObjectCatalogQueries {
      objects: DUCKDB_OBJECTS,
      routine_definition: DUCKDB_ROUTINE_DEFINITION,
      sequence_properties: Some(DUCKDB_SEQUENCE_PROPERTIES),
      object_parameter_count: 0,
      routine_parameter_count: 1,
    }),
    DatabaseType::ClickHouse => Some(ObjectCatalogQueries {
      objects: CLICKHOUSE_OBJECTS,
      routine_definition: CLICKHOUSE_ROUTINE_DEFINITION,
      sequence_properties: None,
      object_parameter_count: 0,
      routine_parameter_count: 1,
    }),
    _ => None,
  }
}
/// PostgreSQL 系的库里，不进对象树、补全目录与 ER 图的系统 schema（`AND` 接在 `WHERE` 的条件后面，
/// schema 的别名必须是 `n`）。
///
/// 除了 PostgreSQL 自己的两个，还排掉 CockroachDB 的 `crdb_internal` 与 `pg_extension`：不排的话
/// 对象树里多出 91 张系统表、20 个视图和 133 个内建函数，内建函数的参数签名还是 NULL，整行名字跟着
/// 成了 NULL。这两个名字在 PostgreSQL 上不存在（`pg_` 前缀是保留的），排了等于没排。
///
/// openGauss 自带的十个 schema（`db4ai`、`dbe_perf` 等）按名字**并且** OID 小于 16384 排：
/// 名字是普通的词，PostgreSQL 上用户完全可能建一个叫 `snapshot` 的 schema，而用户建的对象
/// OID 从 16384（FirstNormalObjectId）起。不能只看 OID：CockroachDB 的用户 schema OID 是
/// 一百出头的小数。
macro_rules! postgres_hidden_schemas {
  () => {
    "  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'crdb_internal', 'pg_extension')
  AND NOT (n.oid < 16384 AND n.nspname IN ('cstore', 'pkg_service', 'dbe_perf', 'snapshot', 'blockchain',
    'db4ai', 'dbe_pldebugger', 'dbe_pldeveloper', 'sqladvisor', 'dbe_sql_util'))
"
  };
}
pub(crate) use postgres_hidden_schemas;

/// `object_id` 用 oid：**函数是可以重载的**，`proname` 不唯一，
/// 拿名字去取定义会取到同名的另一个重载。显示名带上参数签名，
/// 让用户也能分辨是哪一个。
///
/// 序列这里不过滤 serial / identity 列自动建的那些——它们是真实存在的对象，
/// 用户按名字（`users_id_seq`）找得到才有意义。
///
/// 系统 schema 的排法见 `postgres_hidden_schemas`。
const POSTGRES_OBJECTS: &str = concat!(
  r#"
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
"#,
  postgres_hidden_schemas!(),
  r#"  AND n.nspname NOT LIKE 'pg\_toast%'
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
"#,
  postgres_hidden_schemas!(),
  r#"ORDER BY 1, 3, 2
"#
);

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
///
/// 例程的 `object_id` 带上类型（`FUNCTION f` / `PROCEDURE f`）：函数与存储过程各有各的
/// 名字空间，同一个库里可以同名，只拿名字去取定义会取到两行。
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
  CAST(CONCAT(r.ROUTINE_TYPE, ' ', r.ROUTINE_NAME) AS CHAR)
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
WHERE CONCAT(r.ROUTINE_TYPE, ' ', r.ROUTINE_NAME) = ?
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

/// DuckDB：表、视图、序列与宏（`CREATE MACRO`，它唯一的「用户函数」）。只看当前库，
/// `ATTACH` 进来的库也在这些表函数里。`object_id` 是 `schema.name`，和 Oracle 一样；
/// 同名的宏可以有几个重载，树里算一个，定义里全列出来
const DUCKDB_OBJECTS: &str = r#"
SELECT object_schema, object_name, object_kind, object_id FROM (
  SELECT t.schema_name AS object_schema, t.table_name AS object_name, 'table' AS object_kind,
    t.schema_name || '.' || t.table_name AS object_id
  FROM duckdb_tables() t
  WHERE t.database_name = current_database() AND NOT t.internal
  UNION ALL
  SELECT v.schema_name, v.view_name, 'view', v.schema_name || '.' || v.view_name
  FROM duckdb_views() v
  WHERE v.database_name = current_database() AND NOT v.internal
  UNION ALL
  SELECT s.schema_name, s.sequence_name, 'sequence', s.schema_name || '.' || s.sequence_name
  FROM duckdb_sequences() s
  WHERE s.database_name = current_database()
  UNION ALL
  SELECT DISTINCT f.schema_name, f.function_name, 'function', f.schema_name || '.' || f.function_name
  FROM duckdb_functions() f
  WHERE f.database_name = current_database() AND NOT f.internal
    AND f.function_type IN ('macro', 'table_macro')
)
ORDER BY 1, 3, 2
"#;

/// 宏没有存原文，由参数与定义拼回 `CREATE MACRO`——这两样都是 DuckDB 自己给的，
/// 不是猜的；重载的几个用空行隔开。参数带上类型（`a INTEGER` 会先把实参转成整数，
/// 丢了就换了语义）；名字不是普通标识符或是保留字时加引号，不然拼出来的跑不了。
///
/// 参数的默认值（`b := 5`）目录里没有，只有 `EXPORT DATABASE` 写得出来，这里拼不回
const DUCKDB_ROUTINE_DEFINITION: &str = r#"
WITH reserved AS (
  SELECT list(keyword_name) AS words FROM duckdb_keywords() WHERE keyword_category = 'reserved'
)
SELECT string_agg(
  'CREATE MACRO '
    || CASE WHEN regexp_full_match(f.schema_name, '[A-Za-z_][A-Za-z0-9_]*')
        AND NOT list_contains(r.words, lower(f.schema_name))
      THEN f.schema_name ELSE '"' || replace(f.schema_name, '"', '""') || '"' END
    || '.'
    || CASE WHEN regexp_full_match(f.function_name, '[A-Za-z_][A-Za-z0-9_]*')
        AND NOT list_contains(r.words, lower(f.function_name))
      THEN f.function_name ELSE '"' || replace(f.function_name, '"', '""') || '"' END
    || '(' || array_to_string(list_transform(list_zip(f.parameters, f.parameter_types), lambda p:
      CASE WHEN regexp_full_match(p[1], '[A-Za-z_][A-Za-z0-9_]*') AND NOT list_contains(r.words, lower(p[1]))
        THEN p[1] ELSE '"' || replace(p[1], '"', '""') || '"' END
      || coalesce(' ' || p[2], '')), ', ') || ') AS '
    || CASE f.function_type WHEN 'table_macro' THEN 'TABLE ' ELSE '' END
    || f.macro_definition,
  ';' || chr(10) || chr(10)
) AS definition
FROM duckdb_functions() f, reserved r
WHERE f.schema_name || '.' || f.function_name = $1
  AND f.database_name = current_database()
  AND f.function_type IN ('macro', 'table_macro')
"#;

/// 序列都是 BIGINT；没有缓存这一项
const DUCKDB_SEQUENCE_PROPERTIES: &str = r#"
SELECT
  s.start_value::VARCHAR AS start_value,
  s.increment_by::VARCHAR AS increment_by,
  s.min_value::VARCHAR AS min_value,
  s.max_value::VARCHAR AS max_value,
  NULL::VARCHAR AS cache_size,
  s.cycle::VARCHAR AS cycles,
  'BIGINT' AS data_type,
  s.last_value::VARCHAR AS last_value
FROM duckdb_sequences() s
WHERE s.schema_name || '.' || s.sequence_name = $1
  AND s.database_name = current_database()
"#;

/// ClickHouse：一个「库」就是 schema 那一层。种类按引擎分：视图、物化视图、字典，其余是表。
/// 物化视图背后的存储表（`.inner.…`、`.inner_id.…`）是它的内部细节，不进树。
///
/// 用户函数（`CREATE FUNCTION`）这一版不进树：它不属于哪个库，而树的第一层就是库，放进来是
/// 一个没有名字的分组。重估条件：有人要在树里看它（那时给它一个自己的顶层分组）。
/// `routine_definition` 照样给着——结构体要它，也不妨碍以后接上
const CLICKHOUSE_OBJECTS: &str = r#"
SELECT
  t.database AS object_schema,
  t.name AS object_name,
  multiIf(t.engine = 'View', 'view', t.engine = 'MaterializedView', 'materialized-view',
    t.engine = 'Dictionary', 'dictionary', 'table') AS object_kind,
  concat(t.database, '.', t.name) AS object_id
FROM system.tables t
WHERE t.database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
  AND NOT t.is_temporary
  AND NOT startsWith(t.name, '.inner')
ORDER BY object_schema, object_kind, object_name
"#;

const CLICKHOUSE_ROUTINE_DEFINITION: &str = r#"
SELECT f.create_query AS definition
FROM system.functions f
WHERE f.name = {p1:String} AND f.origin = 'SQLUserDefined'
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

  /// 前端按 `routine_parameter_count` 造参数：多一个少一个都是错。SQL Server 与 Oracle 的
  /// 驱动对多给的参数不计较，所以这条门之前那一个多给的参数一直没人发现
  #[test]
  fn routine_definitions_declare_how_many_values_they_bind() {
    let count = |sql: &str| {
      let numbered = ["$", "@P", ":", "{p"]
        .iter()
        .flat_map(|marker| {
          sql.match_indices(marker).filter_map(|(at, _)| {
            sql[at + marker.len()..]
              .chars()
              .take_while(char::is_ascii_digit)
              .collect::<String>()
              .parse::<usize>()
              .ok()
          })
        })
        .max()
        .unwrap_or(0);
      numbered.max(sql.matches('?').count())
    };
    for db_type in [
      DatabaseType::PostgreSQL,
      DatabaseType::MySQL,
      DatabaseType::SQLite,
      DatabaseType::SqlServer,
      DatabaseType::Oracle,
      DatabaseType::DuckDB,
      DatabaseType::ClickHouse,
    ] {
      let queries = object_catalog_queries(&db_type).expect("supported");
      assert_eq!(
        count(queries.routine_definition),
        usize::from(queries.routine_parameter_count),
        "{db_type:?}: {}",
        queries.routine_definition
      );
    }
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

  /// DuckDB 的宏没有存原文，定义是拼回来的。参数类型与要加引号的名字丢了，拼出来的
  /// 要么跑不了、要么换了语义：照着定义删掉重建一遍，调用结果不变才算拼对
  #[test]
  fn duckdb_macro_definitions_rebuild_the_same_macro() {
    let connection = duckdb::Connection::open_in_memory().expect("in-memory DuckDB");
    connection
      .execute_batch(
        "CREATE SCHEMA sales;
         CREATE MACRO typed(a DOUBLE, b VARCHAR) AS a || b;
         CREATE MACRO sales.\"My Macro\"(\"the x\") AS \"the x\" * 2;
         CREATE MACRO \"select\"(n) AS TABLE SELECT n AS r;",
      )
      .expect("fixture");
    for (id, drop, call, expected) in [
      ("main.typed", "DROP MACRO typed", "SELECT typed(7, 'x')", "7.0x"),
      (
        "sales.My Macro",
        "DROP MACRO sales.\"My Macro\"",
        "SELECT sales.\"My Macro\"(21)::VARCHAR",
        "42",
      ),
      ("main.select", "DROP MACRO TABLE \"select\"", "SELECT r::VARCHAR FROM \"select\"(5)", "5"),
    ] {
      let definition: String = connection
        .query_row(DUCKDB_ROUTINE_DEFINITION, [id], |row| row.get(0))
        .expect("definition");
      connection.execute_batch(drop).expect("drop");
      connection.execute_batch(&definition).unwrap_or_else(|error| panic!("{definition}: {error}"));
      let result: String = connection.query_row(call, [], |row| row.get(0)).expect("call");
      assert_eq!(result, expected, "{definition}");
    }
  }

  #[test]
  fn unsupported_databases_get_no_catalog() {
    for db_type in [DatabaseType::MongoDB, DatabaseType::Redis, DatabaseType::Neo4j] {
      assert!(object_catalog_queries(&db_type).is_none(), "{db_type:?} 不该有目录查询");
    }
  }
}
