//! 查询失败时，数据库自己说了什么。
//!
//! 以前这条路径上是 `error.to_string()`，只留下一句 message。数据库给的其余
//! 信息全在那一步丢掉了——PostgreSQL 的 SQLSTATE、**出错字符位置**、DETAIL、
//! HINT、违反了哪条约束、哪张表。丢掉之后的症状是：报错说「syntax error at or
//! near "form"」，而一条三百字符的语句里到底是哪个 `form`，只能自己找。

use serde::Serialize;

/// 超时与取消不是数据库给的错，用这两个码和真正的数据库错误区分开。
/// 前端按 `code` 判断，不再按消息前缀去匹配字符串。
pub const QUERY_TIMEOUT_CODE: &str = "QUERY_TIMEOUT";

#[derive(Debug, Clone, Default, Serialize)]
pub struct QueryError {
  pub message: String,
  /// PostgreSQL 的 SQLSTATE、MySQL 的错误号、SQLite 的扩展结果码；
  /// 超时这类我们自己造的错用上面那个常量。
  pub code: Option<String>,
  /// 数据库额外给的那几项。
  ///
  /// 装箱是因为 `Result<T, QueryError>` 的大小是每一次**成功**返回也要付的，
  /// 而解码结果集里的每一个单元格都要经过这样一个 Result——把五个
  /// `Option<String>` 摊在这里会让它从 56 字节涨到 152。
  /// `flatten` 让序列化出来的 JSON 仍然是平的，前端读法不变。
  #[serde(flatten)]
  pub details: Option<Box<QueryErrorDetails>>,
}

/// 只有数据库报错时才有的那几项。
#[derive(Debug, Clone, Default, Serialize)]
pub struct QueryErrorDetails {
  /// 出错处在语句里的**字符**下标，从 1 开始（PostgreSQL 的约定）。
  ///
  /// 只有 PostgreSQL 给。而且只取 `Original`——`Internal` 指向的是服务端
  /// 内部生成的语句（比如 PL/pgSQL 函数体里的那条），拿它去标用户编辑器里的
  /// 位置会精确地指错地方。
  pub position: Option<u32>,
  pub detail: Option<String>,
  pub hint: Option<String>,
  pub constraint: Option<String>,
  pub table: Option<String>,
}

impl QueryError {
  pub fn message(message: impl Into<String>) -> Self {
    Self { message: message.into(), ..Default::default() }
  }

  pub fn with_code(code: &str, message: impl Into<String>) -> Self {
    Self { message: message.into(), code: Some(code.to_string()), ..Default::default() }
  }

  pub fn position(&self) -> Option<u32> {
    self.details.as_ref().and_then(|details| details.position)
  }

  pub fn detail(&self) -> Option<&str> {
    self.details.as_ref().and_then(|details| details.detail.as_deref())
  }

  pub fn hint(&self) -> Option<&str> {
    self.details.as_ref().and_then(|details| details.hint.as_deref())
  }

  pub fn constraint(&self) -> Option<&str> {
    self.details.as_ref().and_then(|details| details.constraint.as_deref())
  }

  pub fn table(&self) -> Option<&str> {
    self.details.as_ref().and_then(|details| details.table.as_deref())
  }
}

impl From<String> for QueryError {
  fn from(message: String) -> Self {
    Self::message(message)
  }
}

impl From<&str> for QueryError {
  fn from(message: &str) -> Self {
    Self::message(message)
  }
}

impl From<sqlx::Error> for QueryError {
  fn from(error: sqlx::Error) -> Self {
    let Some(database_error) = error.as_database_error() else {
      // 连接断了、解码失败这类：没有数据库侧的结构可取，只有一句话
      return Self::message(error.to_string());
    };

    let mut details = QueryErrorDetails {
      constraint: database_error.constraint().map(str::to_string),
      table: database_error.table().map(str::to_string),
      ..Default::default()
    };

    if let Some(postgres) = database_error.try_downcast_ref::<sqlx::postgres::PgDatabaseError>() {
      details.detail = postgres.detail().map(str::to_string);
      details.hint = postgres.hint().map(str::to_string);
      details.position = match postgres.position() {
        Some(sqlx::postgres::PgErrorPosition::Original(position)) => u32::try_from(position).ok(),
        _ => None,
      };
    }

    Self {
      message: database_error.message().to_string(),
      code: database_error.code().map(|code| code.to_string()),
      details: Some(Box::new(details)),
    }
  }
}

impl std::fmt::Display for QueryError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(formatter, "{}", self.message)
  }
}

impl std::error::Error for QueryError {}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_plain_message_carries_no_structure() {
    let error = QueryError::message("连接已断开");
    assert_eq!(error.message, "连接已断开");
    assert!(error.code.is_none());
    assert!(error.position().is_none());
  }

  #[test]
  fn our_own_errors_carry_a_code() {
    // 前端据此判断「这是超时」而不是去匹配消息前缀——消息是要翻译的，
    // 按它匹配等于把判断逻辑绑在某一种语言上
    let error = QueryError::with_code(QUERY_TIMEOUT_CODE, "查询执行超过 5000 毫秒");
    assert_eq!(error.code.as_deref(), Some(QUERY_TIMEOUT_CODE));
  }

  #[test]
  fn non_database_errors_keep_their_message() {
    let error = QueryError::from(sqlx::Error::RowNotFound);
    assert!(!error.message.is_empty());
    assert!(error.code.is_none());
  }

  #[test]
  fn the_error_stays_small_enough_for_the_hot_path() {
    // 解码结果集里的每一个单元格都要经过一个 `Result<_, QueryError>`，
    // 而 Result 的大小是成功路径也要付的。clippy 的阈值是 128 字节。
    assert!(
      std::mem::size_of::<QueryError>() <= 128,
      "QueryError 有 {} 字节，成功路径要跟着一起变大",
      std::mem::size_of::<QueryError>()
    );
  }

  #[test]
  fn no_details_serializes_without_the_optional_fields() {
    let json = serde_json::to_value(QueryError::message("boom")).expect("serialize");
    assert!(json.get("position").is_none(), "没有细节时不该冒出一堆 null");
  }

  #[test]
  fn display_is_just_the_message() {
    // 既有的字符串化路径（日志、`expect`）要能原样继续用
    assert_eq!(QueryError::message("boom").to_string(), "boom");
  }

  #[test]
  fn serializes_with_the_field_names_the_frontend_reads() {
    let error = QueryError {
      message: "syntax error".into(),
      code: Some("42601".into()),
      details: Some(Box::new(QueryErrorDetails {
        position: Some(8),
        detail: Some("d".into()),
        hint: Some("h".into()),
        constraint: Some("c".into()),
        table: Some("t".into()),
      })),
    };
    let json = serde_json::to_value(&error).expect("serialize");
    // 内部装了箱，序列化出来必须还是平的——前端按顶层字段名取值
    for field in ["message", "code", "position", "detail", "hint", "constraint", "table"] {
      assert!(json.get(field).is_some(), "缺少 {field}：前端按字段名取值");
    }
  }
}
