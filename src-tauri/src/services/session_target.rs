//! 会话真正落在哪：当前库、当前 Schema、是不是只读。
//!
//! 为什么不直接显示连接配置里的库名：配置说的是「连上去的时候要哪个库」，
//! 而会话可以在之后被改掉——MySQL 的 `USE other_db`、PostgreSQL 的
//! `SET search_path TO ...` 都是一条普通语句。照搬配置的那一行在这之后就是
//! 假的，而它看上去和真的一模一样。
//!
//! 只读取的是**服务端说的话**，不是我们自己推断的。挂在只读副本上时写入会
//! 失败，而失败信息往往只说「不能写」，不说「因为这是个副本」。

use crate::models::DatabaseType;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SessionTargetQuery {
  /// 一行三列：database_name / schema_name / read_only。
  /// 没有对应概念的列返回 NULL，由界面决定不显示。
  pub sql: &'static str,
}

pub fn session_target_query(db_type: &DatabaseType) -> Option<SessionTargetQuery> {
  match db_type {
    DatabaseType::PostgreSQL => Some(SessionTargetQuery { sql: POSTGRES_TARGET }),
    DatabaseType::MySQL => Some(SessionTargetQuery { sql: MYSQL_TARGET }),
    DatabaseType::SQLite => Some(SessionTargetQuery { sql: SQLITE_TARGET }),
    DatabaseType::SqlServer => Some(SessionTargetQuery { sql: SQL_SERVER_TARGET }),
    DatabaseType::Oracle => Some(SessionTargetQuery { sql: ORACLE_TARGET }),
    _ => None,
  }
}

/// `current_schema()` 是 `search_path` 里第一个真实存在的 schema——也就是
/// 不带前缀的 `CREATE TABLE t` 会落到哪里。`search_path` 指向的 schema 全都
/// 不存在时它是 NULL，这时候界面上不显示比显示一个猜测好。
///
/// `transaction_read_only` 在只读副本上是 on。用 `current_setting` 而不是
/// `SHOW`：`SHOW` 的结果列取不到名字（sqlx 按名字找不到列），而这里要的就是
/// 三个具名列。
const POSTGRES_TARGET: &str = r#"
SELECT
  current_database()::text AS database_name,
  current_schema()::text AS schema_name,
  (current_setting('transaction_read_only') = 'on') AS read_only
"#;

/// MySQL 没有独立于库的 schema——`SCHEMA` 就是 `DATABASE` 的同义词，
/// 再显示一层只会让人以为还有一级可选。
///
/// `@@read_only` 在只读副本上是 1。它对 SUPER 权限的连接不生效，但这一栏
/// 要回答的是「这台服务器是不是副本」，不是「我能不能写」。
const MYSQL_TARGET: &str = r#"
SELECT
  CAST(DATABASE() AS CHAR) AS database_name,
  CAST(NULL AS CHAR) AS schema_name,
  (@@read_only = 1) AS read_only
"#;

/// SQLite 的「库」就是那个文件，连接配置里的路径已经说明了一切，
/// 这里不再重复。`query_only` 打开时整个连接拒绝写入。
const SQLITE_TARGET: &str = r#"
SELECT
  NULL AS database_name,
  NULL AS schema_name,
  (SELECT query_only FROM pragma_query_only()) AS read_only
"#;

/// `SCHEMA_NAME()` 是登录用户的默认 schema——不带前缀的 `CREATE TABLE t`
/// 落到哪里。只读看的是库本身（只读库、可用性组里的只读副本）
const SQL_SERVER_TARGET: &str = r#"
SELECT
  DB_NAME() AS database_name,
  SCHEMA_NAME() AS schema_name,
  CAST(CASE WHEN DATABASEPROPERTYEX(DB_NAME(), 'Updateability') = 'READ_ONLY'
    THEN 1 ELSE 0 END AS bit) AS read_only
"#;

/// Oracle 的「库」是可插拔库（PDB）的名字；备库是只读的
const ORACLE_TARGET: &str = r#"
SELECT
  SYS_CONTEXT('USERENV', 'CON_NAME') AS "database_name",
  SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS "schema_name",
  CAST(CASE WHEN SYS_CONTEXT('USERENV', 'DATABASE_ROLE') LIKE '%STANDBY%' THEN 1 ELSE 0 END
    AS NUMBER(1)) AS "read_only"
FROM dual
"#;

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
  fn every_dialect_projects_the_three_columns() {
    for db_type in SUPPORTED {
      let query = session_target_query(&db_type).expect("supported");
      for alias in ["database_name", "schema_name", "read_only"] {
        assert!(
          // Oracle 的别名带引号：它把不带引号的别名折成大写
          query.sql.contains(&format!("AS {alias}"))
            || query.sql.contains(&format!("AS \"{alias}\"")),
          "{db_type:?} 缺少 {alias}：前端按列名取值，少一个就是整列静默为空"
        );
      }
    }
  }

  #[test]
  fn no_query_needs_bound_parameters() {
    // 这一条问的是「会话现在在哪」，答案只能由会话自己给，
    // 绑进去一个库名就变成了「我以为它在哪」
    for db_type in SUPPORTED {
      let query = session_target_query(&db_type).expect("supported");
      assert_eq!(query.sql.matches('?').count(), 0, "{db_type:?} 不该需要参数");
    }
  }

  #[test]
  fn postgres_reads_the_effective_schema_not_the_search_path_text() {
    let query = session_target_query(&DatabaseType::PostgreSQL).expect("supported");
    assert!(
      query.sql.contains("current_schema()"),
      "search_path 原文里可以写不存在的 schema，它回答不了「表会落到哪」"
    );
  }

  #[test]
  fn unsupported_databases_get_no_query() {
    for db_type in [DatabaseType::MongoDB, DatabaseType::Redis] {
      assert!(session_target_query(&db_type).is_none());
    }
  }
}
