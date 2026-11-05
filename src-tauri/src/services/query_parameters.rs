//! 编辑器里的绑定参数落到 sqlx 三家的绑定上（rfcs/bind-parameters.md §4.2）。
//!
//! 前端已经把 `:name` 换成了本方言的占位符，送来的值只有三种：`null`、字符串、数字。
//! SQLite 与 MySQL 照值本身的种类绑。PostgreSQL 不行：sqlx 把参数一律按二进制格式发
//! （`sqlx-postgres` 的 `Bind` 写死了 `PgValueFormat::Binary`），文本绑成 `TEXT` 撞上 `int` 列就报
//! 「operator does not exist」，所以先 prepare 拿到每个参数的类型，再把文本转成那个类型去绑。

use serde_json::Value as JsonValue;
use sqlx::encode::IsNull;
use sqlx::error::BoxDynError;
use sqlx::mysql::{MySql, MySqlArguments};
use sqlx::postgres::{PgArgumentBuffer, PgArguments, PgTypeInfo, PgTypeKind, Postgres};
use sqlx::query::Query;
use sqlx::sqlite::{Sqlite, SqliteArguments};
use sqlx::{Encode, Type, TypeInfo};

use crate::services::QueryError;

/// MySQL 只能按文本协议执行的那几类语句（`SHOW WARNINGS`、`LOCK TABLES`……）：参数只能经预处理协议绑
pub const PARAMETERS_NEED_PREPARED: &str = "DATAOMNI_PARAMETERS_NEED_PREPARED";
/// PostgreSQL 结果里有只能按文本读的列：带参数只能走扩展协议，结果按二进制读
pub const PARAMETERS_TEXT_RESULTS: &str = "DATAOMNI_PARAMETERS_TEXT_RESULTS";
/// ClickHouse 的服务端参数要在 SQL 里写类型（`{name:UInt64}`），对不上编辑器的 `:name`
pub const PARAMETERS_UNSUPPORTED_DIALECT: &str = "DATAOMNI_PARAMETERS_UNSUPPORTED_DIALECT";
/// PostgreSQL 上参数的类型还不能绑。细节是「第几个 · 类型」
pub const PARAMETER_TYPE_UNSUPPORTED: &str = "DATAOMNI_PARAMETER_TYPE_UNSUPPORTED";
/// 值转不成参数的类型。细节是「第几个 · 类型 · 值」
pub const PARAMETER_NOT_CONVERTIBLE: &str = "DATAOMNI_PARAMETER_NOT_CONVERTIBLE";

/// 整数按 `i64` 绑：MySQL 的 `LIMIT ?` 收 `f64` 也报 1210
macro_rules! bind_scalars {
  ($query:expr, $params:expr) => {{
    let mut query = $query;
    for param in $params {
      query = match param {
        JsonValue::Null => query.bind(None::<String>),
        JsonValue::Bool(value) => query.bind(*value),
        JsonValue::Number(number) => match number.as_i64() {
          Some(integer) => query.bind(integer),
          None => query.bind(number.as_f64()),
        },
        JsonValue::String(text) => query.bind(text.clone()),
        other => {
          return Err(QueryError::message(format!(
            "{}: {other}",
            crate::services::write_batch::UNSUPPORTED_PARAMETER_TYPE
          )))
        }
      };
    }
    Ok(query)
  }};
}

pub(crate) fn bind_sqlite<'q>(
  query: Query<'q, Sqlite, SqliteArguments<'q>>,
  params: &[JsonValue],
) -> Result<Query<'q, Sqlite, SqliteArguments<'q>>, QueryError> {
  bind_scalars!(query, params)
}

pub(crate) fn bind_mysql<'q>(
  query: Query<'q, MySql, MySqlArguments>,
  params: &[JsonValue],
) -> Result<Query<'q, MySql, MySqlArguments>, QueryError> {
  bind_scalars!(query, params)
}

/// 按 prepare 出来的参数类型绑。`types` 与 `params` 一一对应；数目对不上让服务端去报
pub(crate) fn bind_postgres<'q>(
  mut query: Query<'q, Postgres, PgArguments>,
  params: &[JsonValue],
  types: &[PgTypeInfo],
) -> Result<Query<'q, Postgres, PgArguments>, QueryError> {
  for (index, (param, type_info)) in params.iter().zip(types).enumerate() {
    let text = match param {
      JsonValue::Null => None,
      JsonValue::String(text) => Some(text.clone()),
      JsonValue::Number(number) => Some(number.to_string()),
      JsonValue::Bool(value) => Some(value.to_string()),
      other => {
        return Err(QueryError::message(format!(
          "{}: {other}",
          crate::services::write_batch::UNSUPPORTED_PARAMETER_TYPE
        )))
      }
    };
    query = bind_postgres_value(query, index + 1, text, type_info)?;
  }
  Ok(query)
}

fn bind_postgres_value<'q>(
  query: Query<'q, Postgres, PgArguments>,
  position: usize,
  text: Option<String>,
  type_info: &PgTypeInfo,
) -> Result<Query<'q, Postgres, PgArguments>, QueryError> {
  // 域按底层类型绑，服务端自己转成域（约束照查）
  if let PgTypeKind::Domain(base) = type_info.kind() {
    return bind_postgres_value(query, position, text, base);
  }
  let name = type_info.name().to_ascii_uppercase();
  let Some(text) = text else {
    // NULL 也带上参数原本的类型，不让服务端拿 `text` 去比
    return Ok(query.bind(PgText { type_info: type_info.clone(), bytes: None }));
  };
  let failed = || {
    QueryError::message(format!(
      "{PARAMETER_NOT_CONVERTIBLE}: {position} · {} · {text}",
      type_info.name()
    ))
  };
  macro_rules! parsed {
    ($value:expr) => {
      query.bind($value.map_err(|_| failed())?)
    };
  }
  let trimmed = text.trim();
  Ok(match name.as_str() {
    "INT2" => parsed!(trimmed.parse::<i16>()),
    "INT4" => parsed!(trimmed.parse::<i32>()),
    "INT8" => parsed!(trimmed.parse::<i64>()),
    "FLOAT4" => parsed!(trimmed.parse::<f32>()),
    "FLOAT8" => parsed!(trimmed.parse::<f64>()),
    "NUMERIC" => parsed!(trimmed.parse::<sqlx::types::BigDecimal>()),
    "BOOL" => parsed!(parse_bool(trimmed).ok_or(())),
    "UUID" => parsed!(sqlx::types::Uuid::parse_str(trimmed)),
    "DATE" => parsed!(trimmed.parse::<chrono::NaiveDate>()),
    "TIME" => parsed!(parse_time(trimmed).ok_or(())),
    "TIMESTAMP" => parsed!(parse_timestamp(trimmed).ok_or(())),
    // 带时区的按给的时区；没写时区的按 `timestamp` 绑，服务端照会话的 TimeZone 转——与写字面量一样
    "TIMESTAMPTZ" => match parse_timestamptz(trimmed) {
      Some(value) => query.bind(value),
      None => parsed!(parse_timestamp(trimmed).ok_or(())),
    },
    "BYTEA" => parsed!(parse_hex(trimmed).ok_or(())),
    // 这几种的二进制格式就是文本本身（jsonb 前面多一个版本号 1）。按参数原本的类型声明，
    // `varchar` 列不会被当成 `text` 比较，枚举也不用一个个认
    "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "JSON" | "XML" | "CITEXT" => {
      query.bind(PgText { type_info: type_info.clone(), bytes: Some(text.into_bytes()) })
    }
    "JSONB" => {
      serde_json::from_str::<JsonValue>(&text).map_err(|_| failed())?;
      let mut bytes = vec![1];
      bytes.extend(text.into_bytes());
      query.bind(PgText { type_info: type_info.clone(), bytes: Some(bytes) })
    }
    _ if matches!(type_info.kind(), PgTypeKind::Enum(_)) => {
      query.bind(PgText { type_info: type_info.clone(), bytes: Some(text.into_bytes()) })
    }
    _ => {
      return Err(QueryError::message(format!(
        "{PARAMETER_TYPE_UNSUPPORTED}: {position} · {}",
        type_info.name()
      )))
    }
  })
}

/// 照 PostgreSQL 自己认的写法
fn parse_bool(text: &str) -> Option<bool> {
  match text.to_ascii_lowercase().as_str() {
    "t" | "true" | "y" | "yes" | "on" | "1" => Some(true),
    "f" | "false" | "n" | "no" | "off" | "0" => Some(false),
    _ => None,
  }
}

fn parse_time(text: &str) -> Option<chrono::NaiveTime> {
  chrono::NaiveTime::parse_from_str(text, "%H:%M:%S%.f")
    .or_else(|_| chrono::NaiveTime::parse_from_str(text, "%H:%M"))
    .ok()
}

/// `2026-11-06 08:30:00`、`2026-11-06T08:30`，或者只写日期
fn parse_timestamp(text: &str) -> Option<chrono::NaiveDateTime> {
  let text = text.replacen('T', " ", 1);
  ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M"]
    .iter()
    .find_map(|format| chrono::NaiveDateTime::parse_from_str(&text, format).ok())
    .or_else(|| {
      text.parse::<chrono::NaiveDate>().ok().map(|date| date.and_time(chrono::NaiveTime::MIN))
    })
}

/// 写了时区的：`Z`、`+08`、`+0800`、`+08:00`（PostgreSQL 自己输出的就是 `+08` 这种）
fn parse_timestamptz(text: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
  let text = text.replacen('T', " ", 1);
  let text = text.strip_suffix(['Z', 'z']).map_or(text.clone(), |local| format!("{local}+00"));
  ["%Y-%m-%d %H:%M:%S%.f%#z", "%Y-%m-%d %H:%M%#z"]
    .iter()
    .find_map(|format| chrono::DateTime::parse_from_str(&text, format).ok())
}

/// 十六进制，`\x` 前缀可有可无（结果网格里 bytea 就是这么显示的）
fn parse_hex(text: &str) -> Option<Vec<u8>> {
  let digits = text.strip_prefix("\\x").unwrap_or(text);
  if !digits.len().is_multiple_of(2) {
    return None;
  }
  (0..digits.len())
    .step_by(2)
    .map(|start| u8::from_str_radix(digits.get(start..start + 2)?, 16).ok())
    .collect()
}

/// 二进制格式与文本相同的那几种：字节原样发，类型按参数原本的声明
struct PgText {
  type_info: PgTypeInfo,
  bytes: Option<Vec<u8>>,
}

impl Type<Postgres> for PgText {
  fn type_info() -> PgTypeInfo {
    PgTypeInfo::with_name("text")
  }

  fn compatible(_: &PgTypeInfo) -> bool {
    true
  }
}

impl Encode<'_, Postgres> for PgText {
  fn encode_by_ref(&self, buffer: &mut PgArgumentBuffer) -> Result<IsNull, BoxDynError> {
    match &self.bytes {
      Some(bytes) => {
        buffer.extend_from_slice(bytes);
        Ok(IsNull::No)
      }
      None => Ok(IsNull::Yes),
    }
  }

  fn produces(&self) -> Option<PgTypeInfo> {
    Some(self.type_info.clone())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_the_spellings_postgres_reads() {
    assert_eq!(parse_bool("Yes"), Some(true));
    assert_eq!(parse_bool("off"), Some(false));
    assert_eq!(parse_bool("maybe"), None);
    assert_eq!(parse_hex("\\x00ff"), Some(vec![0, 255]));
    assert_eq!(parse_hex("abc"), None);
    assert_eq!(parse_hex("zz"), None);
    assert!(parse_time("08:30").is_some());
    assert!(parse_time("08:30:15.25").is_some());
    assert_eq!(
      parse_timestamp("2026-11-06T08:30"),
      chrono::NaiveDate::from_ymd_opt(2026, 11, 6).and_then(|date| date.and_hms_opt(8, 30, 0))
    );
    for text in [
      "2026-11-06 08:30:00+08",
      "2026-11-06T00:30:00Z",
      "2026-11-06 08:30+08:00",
      "2026-11-06 08:30:00.5+0800",
    ] {
      let parsed = parse_timestamptz(text).unwrap_or_else(|| panic!("{text}"));
      assert_eq!(parsed.naive_utc().format("%H:%M").to_string(), "00:30", "{text}");
    }
    assert_eq!(parse_timestamptz("2026-11-06 08:30"), None, "没写时区的留给会话时区");
    assert_eq!(
      parse_timestamp("2026-11-06"),
      chrono::NaiveDate::from_ymd_opt(2026, 11, 6).and_then(|date| date.and_hms_opt(0, 0, 0))
    );
  }
}
