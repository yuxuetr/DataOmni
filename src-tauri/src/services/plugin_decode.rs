//! 目录查询的解码：`tauri-plugin-sql` 2.4.1 `src/decode/{mysql,postgres}.rs` 的照抄。
//!
//! Copyright 2019-2023 Tauri Programme within The Commons Conservancy
//! SPDX-License-Identifier: Apache-2.0 OR MIT
//!
//! 为什么要抄：插件的 `select` 命令持着 `DbInstances` 的读锁一直到查询回来。
//! 一条查询挂在断掉的连接上，读锁就永远不还；之后任何一次开池子要拿写锁，
//! 于是永远等着，而 tokio 的读写锁是公平的——写者排着队，后来的读者也排在它后面，
//! 所有连接一起卡死（F24，见 `sqlx_pool::shared`）。插件的 `select` 与解码器都是
//! `pub(crate)`，要放掉锁再查，只能把这两段搬过来。
//!
//! **只改了三处，行为不变**：`crate::Error` 换成 `String`（文字与插件的 Display 相同）；
//! PostgreSQL 的 NUMERIC 用 sqlx 已开的 `bigdecimal` 解而不是 `rust_decimal`；
//! 退回按字符串硬解时不打 warn。界面按插件的形状写，形状不能漂——
//! `database_smoke.rs` 的 `PLUGIN_DECODES_*` 类型表钉的就是这里的分支。
use serde_json::Value as JsonValue;
use sqlx::mysql::MySqlValueRef;
use sqlx::postgres::PgValueRef;
use sqlx::types::BigDecimal;
use sqlx::{TypeInfo, Value, ValueRef};
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time};
use uuid::Uuid;

fn unsupported(name: &str) -> String {
  format!("unsupported datatype: {name}")
}

/// 解得出就给值，解不出给 null——插件对每个有分支的类型都是这个规矩
macro_rules! decode_or_null {
  ($value:expr, $ty:ty, $into:expr) => {
    match ValueRef::to_owned(&$value).try_decode::<$ty>() {
      Ok(decoded) => $into(decoded),
      Err(_) => JsonValue::Null,
    }
  };
}

pub fn mysql_to_json(v: MySqlValueRef<'_>) -> Result<JsonValue, String> {
  if v.is_null() {
    return Ok(JsonValue::Null);
  }
  let res = match v.type_info().name() {
    "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" => {
      decode_or_null!(v, String, JsonValue::String)
    }
    "FLOAT" => decode_or_null!(v, f32, JsonValue::from),
    "DOUBLE" => decode_or_null!(v, f64, JsonValue::from),
    "TINYINT" | "SMALLINT" | "INT" | "MEDIUMINT" | "BIGINT" => {
      decode_or_null!(v, i64, JsonValue::from)
    }
    "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "INT UNSIGNED" | "MEDIUMINT UNSIGNED"
    | "BIGINT UNSIGNED" | "YEAR" => decode_or_null!(v, u64, JsonValue::from),
    "BOOLEAN" => decode_or_null!(v, bool, JsonValue::Bool),
    "DATE" => decode_or_null!(v, Date, |d: Date| JsonValue::String(d.to_string())),
    "TIME" => decode_or_null!(v, Time, |t: Time| JsonValue::String(t.to_string())),
    "DATETIME" => {
      decode_or_null!(v, PrimitiveDateTime, |t: PrimitiveDateTime| JsonValue::String(t.to_string()))
    }
    "TIMESTAMP" => {
      decode_or_null!(v, OffsetDateTime, |t: OffsetDateTime| JsonValue::String(t.to_string()))
    }
    "JSON" => ValueRef::to_owned(&v).try_decode().unwrap_or_default(),
    // 插件原文就把 TINYBLOB 拼成了 TINIYBLOB：TINYBLOB 在它那里是不认的，照抄
    "TINIYBLOB" | "MEDIUMBLOB" | "BLOB" | "LONGBLOB" => decode_or_null!(v, Vec<u8>, bytes_array),
    "NULL" => JsonValue::Null,
    other => return Err(unsupported(other)),
  };
  Ok(res)
}

pub fn postgres_to_json(v: PgValueRef<'_>) -> Result<JsonValue, String> {
  if v.is_null() {
    return Ok(JsonValue::Null);
  }
  let res = match v.type_info().name() {
    "CHAR" | "VARCHAR" | "TEXT" | "NAME" => decode_or_null!(v, String, JsonValue::String),
    "UUID" => decode_or_null!(v, Uuid, |u: Uuid| JsonValue::String(u.to_string())),
    "FLOAT4" => decode_or_null!(v, f32, JsonValue::from),
    "FLOAT8" => decode_or_null!(v, f64, JsonValue::from),
    "INT2" => decode_or_null!(v, i16, JsonValue::from),
    "INT4" => decode_or_null!(v, i32, JsonValue::from),
    "INT8" => decode_or_null!(v, i64, JsonValue::from),
    "BOOL" => decode_or_null!(v, bool, JsonValue::Bool),
    "DATE" => decode_or_null!(v, Date, |d: Date| JsonValue::String(d.to_string())),
    "TIME" => decode_or_null!(v, Time, |t: Time| JsonValue::String(t.to_string())),
    "TIMESTAMP" => {
      decode_or_null!(v, PrimitiveDateTime, |t: PrimitiveDateTime| JsonValue::String(t.to_string()))
    }
    "TIMESTAMPTZ" => {
      decode_or_null!(v, OffsetDateTime, |t: OffsetDateTime| JsonValue::String(t.to_string()))
    }
    "JSON" | "JSONB" => ValueRef::to_owned(&v).try_decode().unwrap_or_default(),
    "BYTEA" => decode_or_null!(v, Vec<u8>, bytes_array),
    "NUMERIC" => decode_or_null!(v, BigDecimal, numeric),
    "VOID" => JsonValue::Null,
    // 自定义类型（枚举、domain 等）按字符串硬解
    other => match ValueRef::to_owned(&v).try_decode_unchecked::<String>() {
      Ok(text) => JsonValue::String(text),
      Err(_) => return Err(unsupported(other)),
    },
  };
  Ok(res)
}

fn bytes_array(bytes: Vec<u8>) -> JsonValue {
  JsonValue::Array(bytes.into_iter().map(JsonValue::from).collect())
}

/// 插件：放得进 f64 就给数字，放不进给十进制文本
fn numeric(value: BigDecimal) -> JsonValue {
  let text = value.to_string();
  match text.parse::<f64>().ok().and_then(serde_json::Number::from_f64) {
    Some(number) => JsonValue::Number(number),
    None => JsonValue::String(text),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::str::FromStr;

  #[test]
  fn numeric_is_a_number_when_it_fits_and_text_otherwise() {
    let fits = BigDecimal::from_str("12.5").unwrap();
    assert_eq!(numeric(fits), serde_json::json!(12.5));
    // f64 放不下的（溢出成无穷）按原文给，和插件一样不丢值
    let huge = BigDecimal::from_str(&format!("1{}", "0".repeat(400))).unwrap();
    assert!(numeric(huge).is_string());
  }
}
