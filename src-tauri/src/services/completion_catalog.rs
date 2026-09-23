//! SQL 编辑器补全用的整库目录：所有**关系**（表与视图）及其列。
//!
//! 与 `er_diagram` 的分界不是「查的东西像」，而是问题不同：ER 图画的是表之间
//! 的外键，视图没有外键，混进去只会多出一堆孤立的框（`er_diagram` 里有一条
//! 专门断言视图不出现的测试）。补全要的恰恰相反——视图一样能 `SELECT`，
//! 漏掉它等于对一半可查对象一无所知。所以这里单独一份查询，并带上
//! `relation_kind` 让界面把两者区分开。
//!
//! 函数与存储过程不在这里：对象目录（`object_catalog`）已经把它们拉下来缓存了，
//! 再查一次只是多一次往返。

use crate::models::DatabaseType;
use crate::services::oracle::{oracle_type_name, oracle_user_schemas};
use crate::services::sql_server::sql_server_type_name;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CompletionCatalogQuery {
  /// 每行一列：relation_schema / relation_name / relation_kind /
  /// column_name / data_type。同一个关系的列按表内顺序相邻返回，
  /// 补全列表照抄这个次序——按字母排会把 `id` 冲到中间去。
  pub relations: &'static str,
  /// 需要绑定几个参数（库名）
  pub parameter_count: u8,
}

pub fn completion_catalog_query(db_type: &DatabaseType) -> Option<CompletionCatalogQuery> {
  match db_type {
    DatabaseType::PostgreSQL => {
      Some(CompletionCatalogQuery { relations: POSTGRES_RELATIONS, parameter_count: 0 })
    }
    DatabaseType::MySQL => {
      Some(CompletionCatalogQuery { relations: MYSQL_RELATIONS, parameter_count: 1 })
    }
    DatabaseType::SQLite => {
      Some(CompletionCatalogQuery { relations: SQLITE_RELATIONS, parameter_count: 0 })
    }
    DatabaseType::SqlServer => {
      Some(CompletionCatalogQuery { relations: SQL_SERVER_RELATIONS, parameter_count: 0 })
    }
    DatabaseType::Oracle => {
      Some(CompletionCatalogQuery { relations: ORACLE_RELATIONS, parameter_count: 0 })
    }
    _ => None,
  }
}

/// `relkind` 取全了能 `SELECT` 的五种：普通表、分区表、视图、物化视图、外部表。
/// 分区表与外部表在补全里就是表，不值得再分一档。
///
/// 类型用 `format_type` 而不是 `information_schema` 的 `data_type`：补全项的
/// 说明里写 `character varying(32)` 才有用，`character varying` 等于没说长度。
const POSTGRES_RELATIONS: &str = r#"
SELECT
  n.nspname::text AS relation_schema,
  c.relname::text AS relation_name,
  CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS relation_kind,
  a.attname::text AS column_name,
  format_type(a.atttypid, a.atttypmod)::text AS data_type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'crdb_internal', 'pg_extension')
  AND n.nspname NOT LIKE 'pg\_toast%'
  AND n.nspname NOT LIKE 'pg\_temp%'
ORDER BY n.nspname, c.relname, a.attnum
"#;

/// `CAST(... AS CHAR)`：`information_schema` 的标识符列是 VARBINARY，
/// 插件的解码器不认。`relation_kind` 也要 CAST——CASE 的结果会跟着
/// 参与比较的列走成二进制串。
const MYSQL_RELATIONS: &str = r#"
SELECT
  CAST(c.TABLE_SCHEMA AS CHAR) AS relation_schema,
  CAST(c.TABLE_NAME AS CHAR) AS relation_name,
  CAST(CASE WHEN t.TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS CHAR) AS relation_kind,
  CAST(c.COLUMN_NAME AS CHAR) AS column_name,
  CAST(c.COLUMN_TYPE AS CHAR) AS data_type
FROM INFORMATION_SCHEMA.COLUMNS c
JOIN INFORMATION_SCHEMA.TABLES t
  ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
 AND t.TABLE_NAME = c.TABLE_NAME
WHERE c.TABLE_SCHEMA = ?
ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
"#;

/// `pragma_table_info` 对视图同样给列，所以表和视图能用同一条查询取完。
/// `m.type` 本身就是 'table' / 'view'，不需要再 CASE 一次。
const SQLITE_RELATIONS: &str = r#"
SELECT
  NULL AS relation_schema,
  m.name AS relation_name,
  m.type AS relation_kind,
  p.name AS column_name,
  p.type AS data_type
FROM sqlite_master m
JOIN pragma_table_info(m.name) p
WHERE m.type IN ('table', 'view')
  AND m.name NOT LIKE 'sqlite\_%' ESCAPE '\'
ORDER BY m.name, p.cid
"#;

const SQL_SERVER_RELATIONS: &str = concat!(
  r#"
SELECT
  s.name AS relation_schema,
  o.name AS relation_name,
  CASE WHEN o.type = 'V' THEN 'view' ELSE 'table' END AS relation_kind,
  c.name AS column_name,
  "#,
  sql_server_type_name!(),
  r#" AS data_type
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.columns c ON c.object_id = o.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE o.type IN ('U', 'V')
  AND o.is_ms_shipped = 0
ORDER BY s.name, o.name, c.column_id
"#
);

const ORACLE_RELATIONS: &str = concat!(
  r#"
SELECT
  c.owner AS "relation_schema",
  c.table_name AS "relation_name",
  CASE WHEN o.object_type = 'VIEW' THEN 'view' ELSE 'table' END AS "relation_kind",
  c.column_name AS "column_name",
  "#,
  oracle_type_name!(),
  r#" AS "data_type"
FROM all_tab_columns c
JOIN all_objects o ON o.owner = c.owner AND o.object_name = c.table_name
  AND o.object_type IN ('TABLE', 'VIEW')
JOIN all_users u ON u.username = c.owner
WHERE "#,
  oracle_user_schemas!(),
  r#"
  AND c.table_name NOT LIKE 'BIN$%'
ORDER BY c.owner, c.table_name, c.column_id
"#
);

#[cfg(test)]
mod tests {
  use super::*;

  const SUPPORTED: [DatabaseType; 5] = [
    DatabaseType::MySQL,
    DatabaseType::PostgreSQL,
    DatabaseType::SQLite,
    DatabaseType::SqlServer,
    DatabaseType::Oracle,
  ];

  #[test]
  fn declared_parameter_count_matches_the_placeholders() {
    for db_type in SUPPORTED {
      let query = completion_catalog_query(&db_type).expect("supported");
      assert_eq!(
        query.relations.matches('?').count(),
        usize::from(query.parameter_count),
        "{db_type:?} 声明的参数个数必须和语句里的占位符个数一致"
      );
    }
  }

  #[test]
  fn every_dialect_projects_the_columns_the_frontend_reads() {
    for db_type in SUPPORTED {
      let query = completion_catalog_query(&db_type).expect("supported");
      for alias in ["relation_schema", "relation_name", "relation_kind", "column_name", "data_type"]
      {
        assert!(
          // Oracle 的别名带引号：它把不带引号的别名折成大写
          query.relations.contains(&format!("AS {alias}"))
            || query.relations.contains(&format!("AS \"{alias}\"")),
          "{db_type:?} 缺少 {alias}：前端按列名取值，少一个就是整列静默为空"
        );
      }
    }
  }

  #[test]
  fn views_are_included_unlike_the_er_diagram() {
    let postgres = completion_catalog_query(&DatabaseType::PostgreSQL).expect("supported");
    assert!(
      postgres.relations.contains("'v', 'm'"),
      "视图与物化视图一样能 SELECT，补全漏掉它们等于只认识一半对象"
    );
    let mysql = completion_catalog_query(&DatabaseType::MySQL).expect("supported");
    assert!(!mysql.relations.contains("BASE TABLE"), "按 BASE TABLE 过滤会把视图挡在补全之外");
    let sqlite = completion_catalog_query(&DatabaseType::SQLite).expect("supported");
    assert!(sqlite.relations.contains("'table', 'view'"), "SQLite 同样要连视图一起取");
  }

  #[test]
  fn unsupported_databases_get_no_query() {
    for db_type in [DatabaseType::MongoDB, DatabaseType::Redis] {
      assert!(completion_catalog_query(&db_type).is_none());
    }
  }
}
