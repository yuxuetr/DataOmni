//! 一批写入，要么全成要么全不成。
//!
//! 网格里的编辑此前是一改一提交：每次按保存就是一条自动提交的 UPDATE。
//! 改三行就是三次独立提交，中间任何一条失败，前面几条已经落库了——用户看到
//! 一句错误，而数据停在一个他没打算要的中间状态，还没有任何地方说清停在哪。
//!
//! 放进一个事务之后，「提交失败」就只有一种结果：数据库里什么都没变，
//! 待提交的变更原样还在，可以改完再提交一次。

use crate::services::query_error::QueryError;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{Executor, MySql, Postgres, Sqlite, Transaction};
use tauri_plugin_sql::DbPool;

/// 这条语句必须影响的行数。
///
/// 检查放在**事务里**做，不是拿回执之后在前端判：一条本该改一行的 UPDATE
/// 改到了零行（那一行被别人改了或删了）或者好几行（键不唯一），在提交之后
/// 才发现就只能报告，已经改不回来了。放进事务里，不对就整批回滚。
pub const ROW_COUNT_MISMATCH_CODE: &str = "ROW_COUNT_MISMATCH";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteStatement {
  pub sql: String,
  #[serde(default)]
  pub params: Vec<JsonValue>,
  /// `None` = 不检查（INSERT 这类行数本来就由语句决定的）
  #[serde(default)]
  pub expect_rows: Option<u64>,
}

/// 出错的是第几条。
///
/// 只给一句数据库的错，用户还得自己数是哪一条语句出的问题——而一次提交
/// 可能有十几条，它们长得还很像。
#[derive(Debug, Serialize)]
pub struct WriteBatchError {
  pub statement_index: usize,
  #[serde(flatten)]
  pub error: QueryError,
}

impl WriteBatchError {
  fn at(statement_index: usize, error: impl Into<QueryError>) -> Self {
    Self { statement_index, error: error.into() }
  }
}

/// 绑定一个 JSON 值。
///
/// 只认标量：前端的 `CellInput` 只会产出字符串、数字、布尔和 null。数组和
/// 对象走到这里说明两边漂开了，点名报错比绑成一段 JSON 文本强——后者会
/// 悄悄存进去一串看上去像数据的字符。
macro_rules! bind_params {
  ($query:expr, $params:expr, $index:expr) => {{
    let mut query = $query;
    for param in $params {
      query = match param {
        JsonValue::Null => query.bind(None::<String>),
        JsonValue::Bool(value) => query.bind(*value),
        JsonValue::Number(number) => match number.as_i64() {
          Some(value) => query.bind(value),
          None => query.bind(number.as_f64().unwrap_or(f64::NAN)),
        },
        JsonValue::String(value) => query.bind(value.clone()),
        other => {
          return Err(WriteBatchError::at(
            $index,
            QueryError::message(format!("不支持的参数类型: {other}")),
          ))
        }
      };
    }
    query
  }};
}

macro_rules! run_in_transaction {
  ($pool:expr, $statements:expr) => {{
    let mut transaction: Transaction<'_, _> =
      $pool.begin().await.map_err(|error| WriteBatchError::at(0, error))?;
    let mut affected = Vec::with_capacity($statements.len());

    for (index, statement) in $statements.iter().enumerate() {
      let query = bind_params!(sqlx::query(&statement.sql), &statement.params, index);
      let result =
        transaction.execute(query).await.map_err(|error| WriteBatchError::at(index, error))?;
      let rows = result.rows_affected();
      if let Some(expected) = statement.expect_rows {
        if rows != expected {
          return Err(WriteBatchError::at(
            index,
            QueryError::with_code(
              ROW_COUNT_MISMATCH_CODE,
              format!("这条语句应当影响 {expected} 行，实际影响 {rows} 行"),
            ),
          ));
        }
      }
      affected.push(rows);
    }

    // 回滚由 Drop 负责：上面任何一步 `?` 返回时事务都还没提交，
    // 连接归还前 sqlx 会把它滚掉
    transaction.commit().await.map_err(|error| WriteBatchError::at($statements.len(), error))?;
    Ok(affected)
  }};
}

/// 在一个事务里按顺序执行，返回每条语句影响的行数。
///
/// 顺序是有意义的：同一行先改后删、先删后插，换个次序结果就不同。
pub async fn execute_write_batch(
  pool: &DbPool,
  statements: &[WriteStatement],
) -> Result<Vec<u64>, WriteBatchError> {
  if statements.is_empty() {
    return Ok(Vec::new());
  }

  match pool {
    DbPool::Sqlite(pool) => {
      let _: &sqlx::Pool<Sqlite> = pool;
      run_in_transaction!(pool, statements)
    }
    DbPool::MySql(pool) => {
      let _: &sqlx::Pool<MySql> = pool;
      run_in_transaction!(pool, statements)
    }
    DbPool::Postgres(pool) => {
      let _: &sqlx::Pool<Postgres> = pool;
      run_in_transaction!(pool, statements)
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use sqlx::sqlite::SqlitePoolOptions;
  use sqlx::Row;

  async fn sqlite_pool() -> sqlx::Pool<Sqlite> {
    let pool = SqlitePoolOptions::new()
      .max_connections(1)
      .connect("sqlite::memory:")
      .await
      .expect("connect to SQLite");
    sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
      .execute(&pool)
      .await
      .expect("create table");
    pool
  }

  fn statement(sql: &str, params: Vec<JsonValue>) -> WriteStatement {
    WriteStatement { sql: sql.to_string(), params, expect_rows: None }
  }

  fn expecting(sql: &str, params: Vec<JsonValue>, rows: u64) -> WriteStatement {
    WriteStatement { sql: sql.to_string(), params, expect_rows: Some(rows) }
  }

  async fn row_count(pool: &sqlx::Pool<Sqlite>) -> i64 {
    sqlx::query("SELECT COUNT(*) AS n FROM t")
      .fetch_one(pool)
      .await
      .expect("count")
      .get::<i64, _>("n")
  }

  #[tokio::test]
  async fn runs_every_statement_and_reports_affected_rows() {
    let pool = sqlite_pool().await;
    let affected = execute_write_batch(
      &DbPool::Sqlite(pool.clone()),
      &[
        statement("INSERT INTO t (id, name) VALUES (?, ?)", vec![1.into(), "a".into()]),
        statement("INSERT INTO t (id, name) VALUES (?, ?)", vec![2.into(), "b".into()]),
        statement("UPDATE t SET name = ? WHERE id = ?", vec!["c".into(), 1.into()]),
      ],
    )
    .await
    .expect("batch succeeds");

    assert_eq!(affected, vec![1, 1, 1]);
    assert_eq!(row_count(&pool).await, 2);
  }

  /// 这一条是整个模块存在的理由：第三条失败时，前两条**也不能留下**。
  #[tokio::test]
  async fn a_failure_leaves_the_database_untouched() {
    let pool = sqlite_pool().await;
    let error = execute_write_batch(
      &DbPool::Sqlite(pool.clone()),
      &[
        statement("INSERT INTO t (id, name) VALUES (?, ?)", vec![1.into(), "a".into()]),
        statement("INSERT INTO t (id, name) VALUES (?, ?)", vec![2.into(), "b".into()]),
        // name 是 NOT NULL
        statement("INSERT INTO t (id, name) VALUES (?, ?)", vec![3.into(), JsonValue::Null]),
      ],
    )
    .await
    .expect_err("batch fails");

    assert_eq!(error.statement_index, 2, "要说得出是第几条出的问题");
    assert!(!error.error.message.is_empty(), "数据库说了什么要原样带出来");
    assert_eq!(row_count(&pool).await, 0, "前两条也必须回滚");
  }

  #[tokio::test]
  async fn an_empty_batch_touches_nothing() {
    let pool = sqlite_pool().await;
    let affected =
      execute_write_batch(&DbPool::Sqlite(pool.clone()), &[]).await.expect("empty batch");
    assert!(affected.is_empty());
  }

  #[tokio::test]
  async fn a_non_scalar_parameter_is_named_instead_of_stringified() {
    // 绑成一段 JSON 文本会悄悄存进去一串看上去像数据的字符
    let pool = sqlite_pool().await;
    let error = execute_write_batch(
      &DbPool::Sqlite(pool.clone()),
      &[statement(
        "INSERT INTO t (id, name) VALUES (?, ?)",
        vec![1.into(), serde_json::json!([1])],
      )],
    )
    .await
    .expect_err("rejects a non-scalar parameter");

    assert_eq!(error.statement_index, 0);
    assert_eq!(row_count(&pool).await, 0);
  }

  /// 并发冲突：那一行在我们读到它之后被别人改了或删了，条件不再匹配。
  /// 检查必须在事务里做——提交之后才发现就只能报告，已经改不回来了。
  #[tokio::test]
  async fn a_row_count_mismatch_rolls_the_whole_batch_back() {
    let pool = sqlite_pool().await;
    let error = execute_write_batch(
      &DbPool::Sqlite(pool.clone()),
      &[
        statement("INSERT INTO t (id, name) VALUES (?, ?)", vec![1.into(), "a".into()]),
        expecting("UPDATE t SET name = ? WHERE id = ?", vec!["x".into(), 99.into()], 1),
      ],
    )
    .await
    .expect_err("mismatch fails the batch");

    assert_eq!(error.statement_index, 1);
    assert_eq!(
      error.error.code.as_deref(),
      Some(ROW_COUNT_MISMATCH_CODE),
      "要和数据库自己的错分开"
    );
    assert_eq!(row_count(&pool).await, 0, "前面那条插入也必须回滚");
  }

  #[tokio::test]
  async fn a_matching_row_count_passes() {
    let pool = sqlite_pool().await;
    execute_write_batch(
      &DbPool::Sqlite(pool.clone()),
      &[
        statement("INSERT INTO t (id, name) VALUES (?, ?)", vec![1.into(), "a".into()]),
        expecting("UPDATE t SET name = ? WHERE id = ?", vec!["x".into(), 1.into()], 1),
      ],
    )
    .await
    .expect("batch succeeds");
    assert_eq!(row_count(&pool).await, 1);
  }

  #[tokio::test]
  async fn a_missing_row_reports_zero_affected_instead_of_failing() {
    // 并发冲突就长这样：语句本身没错，只是一行都没匹配上。
    // 判断交给调用方，这里只如实报数
    let pool = sqlite_pool().await;
    let affected = execute_write_batch(
      &DbPool::Sqlite(pool.clone()),
      &[statement("UPDATE t SET name = ? WHERE id = ?", vec!["x".into(), 99.into()])],
    )
    .await
    .expect("statement is valid");

    assert_eq!(affected, vec![0]);
  }
}
