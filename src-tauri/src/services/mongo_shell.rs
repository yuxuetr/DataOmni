//! MongoDB 值的文字写法：mongosh 的那一套。
//!
//! 界面上显示文档、用户输入筛选条件与改文档，用的是**同一种写法**，而且
//! `parse(format(x)) == x`——显示出来的东西原样粘回筛选框就能用，改一个文档
//! 再存回去，没动过的字段类型一个不变。
//!
//! 为什么不用 Extended JSON：canonical 形态无损，但 `{ "age": { "$numberInt": "30" } }`
//! 不是给人看的；relaxed 形态好看，可 `Long(41)` 回来就成了 `Int32(41)`，改一个
//! 字段会悄悄换掉别的字段的类型。mongosh 的写法两头都占，唯一的例外是整数值的
//! 双精度数：mongosh 显示成 `3`，读回来是 Int32。这里显示成 `3.0`，读回来还是
//! Double——多一个 `.0`，换来往返不丢类型。
//!
//! 解析器也收 Extended JSON 的包装（`{ $oid: '…' }`、`{ $date: … }`），从别处
//! 复制来的条件照样能用。

use mongodb::bson::{
  oid::ObjectId, spec::BinarySubtype, Binary, Bson, DateTime, Decimal128, Document,
  JavaScriptCodeWithScope, Regex, Timestamp,
};
use std::fmt::Write;
use std::str::FromStr;

/// 语法错误：`行:列` 附近
pub const MONGO_SYNTAX: &str = "DATAOMNI_MONGO_SYNTAX";
/// 认不出的构造函数，比如 `ObjectID(…)` 写错了大小写
pub const MONGO_UNKNOWN_FUNCTION: &str = "DATAOMNI_MONGO_UNKNOWN_FUNCTION";
/// 构造函数认得，参数不对：`ObjectId('xyz')`、`ISODate('昨天')`
pub const MONGO_BAD_ARGUMENT: &str = "DATAOMNI_MONGO_BAD_ARGUMENT";
/// 这里要一个文档，给的是别的（数组、数字）
pub const MONGO_NOT_DOCUMENT: &str = "DATAOMNI_MONGO_NOT_DOCUMENT";

#[derive(Debug, Clone, PartialEq)]
pub struct ParseError {
  pub code: &'static str,
  /// 冒号后面那段数据：位置，以及认不出的名字
  pub detail: String,
}

impl std::fmt::Display for ParseError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}: {}", self.code, self.detail)
  }
}

/// 解析一个文档。空白（或只有注释）是空文档：筛选框空着就是「全部」。
pub fn parse_document(text: &str) -> Result<Document, ParseError> {
  let mut parser = Parser::new(text);
  parser.skip_trivia()?;
  if parser.at_end() {
    return Ok(Document::new());
  }
  let start = parser.position();
  let value = parser.value()?;
  parser.skip_trivia()?;
  if !parser.at_end() {
    return Err(parser.syntax_error());
  }
  match value {
    Bson::Document(document) => Ok(document),
    _ => Err(ParseError { code: MONGO_NOT_DOCUMENT, detail: parser.location_of(start) }),
  }
}

/// 解析任意一个值。聚合管道（数组）和 `_id` 的写法走这里
pub fn parse_value(text: &str) -> Result<Bson, ParseError> {
  let mut parser = Parser::new(text);
  parser.skip_trivia()?;
  let value = parser.value()?;
  parser.skip_trivia()?;
  if !parser.at_end() {
    return Err(parser.syntax_error());
  }
  Ok(value)
}

struct Parser {
  chars: Vec<char>,
  index: usize,
}

impl Parser {
  fn new(text: &str) -> Self {
    Self { chars: text.chars().collect(), index: 0 }
  }

  fn position(&self) -> usize {
    self.index
  }

  fn at_end(&self) -> bool {
    self.index >= self.chars.len()
  }

  fn peek(&self) -> Option<char> {
    self.chars.get(self.index).copied()
  }

  fn peek_at(&self, offset: usize) -> Option<char> {
    self.chars.get(self.index + offset).copied()
  }

  /// 字符下标 → `行:列`，都从 1 数。报给人看的位置
  fn location_of(&self, index: usize) -> String {
    let mut line = 1;
    let mut column = 1;
    for character in self.chars.iter().take(index) {
      if *character == '\n' {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
    format!("{line}:{column}")
  }

  fn syntax_error(&self) -> ParseError {
    self.syntax_error_at(self.index)
  }

  fn syntax_error_at(&self, index: usize) -> ParseError {
    ParseError { code: MONGO_SYNTAX, detail: self.location_of(index) }
  }

  fn bad_argument(&self, name: &str, index: usize) -> ParseError {
    ParseError { code: MONGO_BAD_ARGUMENT, detail: format!("{name} ({})", self.location_of(index)) }
  }

  /// 空白与注释。`//` 与 `/* */` 都收：从脚本里拷一段条件出来常常带着它们
  fn skip_trivia(&mut self) -> Result<(), ParseError> {
    loop {
      match (self.peek(), self.peek_at(1)) {
        (Some(character), _) if character.is_whitespace() => self.index += 1,
        (Some('/'), Some('/')) => {
          while let Some(character) = self.peek() {
            if character == '\n' {
              break;
            }
            self.index += 1;
          }
        }
        (Some('/'), Some('*')) => {
          let start = self.index;
          self.index += 2;
          loop {
            match (self.peek(), self.peek_at(1)) {
              (Some('*'), Some('/')) => {
                self.index += 2;
                break;
              }
              (Some(_), _) => self.index += 1,
              (None, _) => return Err(self.syntax_error_at(start)),
            }
          }
        }
        _ => return Ok(()),
      }
    }
  }

  fn expect(&mut self, expected: char) -> Result<(), ParseError> {
    self.skip_trivia()?;
    if self.peek() == Some(expected) {
      self.index += 1;
      Ok(())
    } else {
      Err(self.syntax_error())
    }
  }

  fn value(&mut self) -> Result<Bson, ParseError> {
    self.skip_trivia()?;
    match self.peek() {
      Some('{') => self.object(),
      Some('[') => self.array(),
      Some('"') | Some('\'') => Ok(Bson::String(self.string()?)),
      Some('/') => self.regex_literal(),
      Some(character) if character == '-' || character == '+' || character.is_ascii_digit() => {
        self.number()
      }
      Some('.') if self.peek_at(1).is_some_and(|next| next.is_ascii_digit()) => self.number(),
      Some(character) if is_identifier_start(character) => self.identifier_value(),
      _ => Err(self.syntax_error()),
    }
  }

  fn object(&mut self) -> Result<Bson, ParseError> {
    self.expect('{')?;
    let mut document = Document::new();
    loop {
      self.skip_trivia()?;
      if self.peek() == Some('}') {
        self.index += 1;
        break;
      }
      let key = self.key()?;
      self.expect(':')?;
      let value = self.value()?;
      document.insert(key, value);
      self.skip_trivia()?;
      match self.peek() {
        Some(',') => self.index += 1,
        Some('}') => {
          self.index += 1;
          break;
        }
        _ => return Err(self.syntax_error()),
      }
    }
    Ok(extended_json_wrapper(document))
  }

  /// 键：带引号的字符串，或不带引号的名字。名字里允许 `.` 与 `$`，于是
  /// `address.city: 'x'` 与 `$gt: 1` 不用加引号——JS 里前者要加，这里不为难人
  fn key(&mut self) -> Result<String, ParseError> {
    self.skip_trivia()?;
    match self.peek() {
      Some('"') | Some('\'') => self.string(),
      Some(character) if is_key_char(character) => {
        let start = self.index;
        while self.peek().is_some_and(is_key_char) {
          self.index += 1;
        }
        Ok(self.chars[start..self.index].iter().collect())
      }
      _ => Err(self.syntax_error()),
    }
  }

  fn array(&mut self) -> Result<Bson, ParseError> {
    self.expect('[')?;
    let mut items = Vec::new();
    loop {
      self.skip_trivia()?;
      if self.peek() == Some(']') {
        self.index += 1;
        break;
      }
      items.push(self.value()?);
      self.skip_trivia()?;
      match self.peek() {
        Some(',') => self.index += 1,
        Some(']') => {
          self.index += 1;
          break;
        }
        _ => return Err(self.syntax_error()),
      }
    }
    Ok(Bson::Array(items))
  }

  fn string(&mut self) -> Result<String, ParseError> {
    let start = self.index;
    let Some(quote) = self.peek() else {
      return Err(self.syntax_error());
    };
    self.index += 1;
    let mut text = String::new();
    loop {
      let Some(character) = self.peek() else {
        return Err(self.syntax_error_at(start));
      };
      self.index += 1;
      match character {
        _ if character == quote => return Ok(text),
        '\n' => return Err(self.syntax_error_at(start)),
        '\\' => {
          let escape_at = self.index - 1;
          let Some(escaped) = self.peek() else {
            return Err(self.syntax_error_at(start));
          };
          self.index += 1;
          match escaped {
            'n' => text.push('\n'),
            't' => text.push('\t'),
            'r' => text.push('\r'),
            'b' => text.push('\u{8}'),
            'f' => text.push('\u{c}'),
            'v' => text.push('\u{b}'),
            '0' => text.push('\0'),
            'u' => text.push(self.unicode_escape(escape_at)?),
            other => text.push(other),
          }
        }
        other => text.push(other),
      }
    }
  }

  /// `\uXXXX`，以及代理对拼成的一个字符（JSON 对 BMP 之外的字符就是这么写的）
  fn unicode_escape(&mut self, escape_at: usize) -> Result<char, ParseError> {
    let high = self.hex4().ok_or_else(|| self.syntax_error_at(escape_at))?;
    if (0xd800..0xdc00).contains(&high) && self.peek() == Some('\\') && self.peek_at(1) == Some('u')
    {
      self.index += 2;
      let low = self.hex4().ok_or_else(|| self.syntax_error_at(escape_at))?;
      let combined = 0x10000 + ((high - 0xd800) << 10) + (low.wrapping_sub(0xdc00) & 0x3ff);
      return char::from_u32(combined).ok_or_else(|| self.syntax_error_at(escape_at));
    }
    char::from_u32(high).ok_or_else(|| self.syntax_error_at(escape_at))
  }

  fn hex4(&mut self) -> Option<u32> {
    let digits: String = self.chars.get(self.index..self.index + 4)?.iter().collect();
    let value = u32::from_str_radix(&digits, 16).ok()?;
    self.index += 4;
    Some(value)
  }

  /// `/pattern/flags`。模式原样保留，反斜杠不解释——`/a\.b/` 存进去就是 `a\.b`，
  /// 与 mongosh 一致（它存的是 JS 正则的 `source`）
  fn regex_literal(&mut self) -> Result<Bson, ParseError> {
    let start = self.index;
    self.index += 1;
    let mut pattern = String::new();
    let mut in_class = false;
    loop {
      let Some(character) = self.peek() else {
        return Err(self.syntax_error_at(start));
      };
      self.index += 1;
      match character {
        '\n' => return Err(self.syntax_error_at(start)),
        '\\' => {
          pattern.push('\\');
          let Some(escaped) = self.peek() else {
            return Err(self.syntax_error_at(start));
          };
          self.index += 1;
          pattern.push(escaped);
        }
        '[' => {
          in_class = true;
          pattern.push('[');
        }
        ']' => {
          in_class = false;
          pattern.push(']');
        }
        '/' if !in_class => break,
        other => pattern.push(other),
      }
    }
    if pattern.is_empty() {
      return Err(self.syntax_error_at(start));
    }
    let flags_start = self.index;
    while self.peek().is_some_and(|character| character.is_ascii_alphabetic()) {
      self.index += 1;
    }
    let flags: String = self.chars[flags_start..self.index].iter().collect();
    regex(pattern, &flags).ok_or_else(|| self.bad_argument("RegExp", flags_start))
  }

  /// 数字。整数装得下 Int32 就是 Int32，装不下是 Int64（不是 mongosh 那样变成
  /// 双精度：大整数变成浮点会丢末几位）；带小数点或指数的是 Double
  fn number(&mut self) -> Result<Bson, ParseError> {
    let start = self.index;
    let negative = match self.peek() {
      Some('-') => {
        self.index += 1;
        true
      }
      Some('+') => {
        self.index += 1;
        false
      }
      _ => false,
    };
    // 前面有符号，后面跟的是名字：`-Infinity`
    if self.peek().is_some_and(is_identifier_start) {
      let name_start = self.index;
      let name = self.identifier();
      return match name.as_str() {
        "Infinity" => Ok(Bson::Double(if negative { f64::NEG_INFINITY } else { f64::INFINITY })),
        _ => Err(self.syntax_error_at(name_start)),
      };
    }
    let mut is_float = false;
    while let Some(character) = self.peek() {
      match character {
        '0'..='9' | '_' => self.index += 1,
        '.' => {
          is_float = true;
          self.index += 1;
        }
        'e' | 'E' => {
          is_float = true;
          self.index += 1;
          if matches!(self.peek(), Some('+') | Some('-')) {
            self.index += 1;
          }
        }
        _ => break,
      }
    }
    let text: String =
      self.chars[start..self.index].iter().filter(|character| **character != '_').collect();
    if is_float {
      return text.parse::<f64>().map(Bson::Double).map_err(|_| self.syntax_error_at(start));
    }
    if let Ok(value) = text.parse::<i32>() {
      return Ok(Bson::Int32(value));
    }
    if let Ok(value) = text.parse::<i64>() {
      return Ok(Bson::Int64(value));
    }
    // 连 Int64 都装不下：只能是双精度，和 JS 一样
    text.parse::<f64>().map(Bson::Double).map_err(|_| self.syntax_error_at(start))
  }

  fn identifier(&mut self) -> String {
    let start = self.index;
    while self.peek().is_some_and(is_identifier_part) {
      self.index += 1;
    }
    self.chars[start..self.index].iter().collect()
  }

  /// 关键字，或 `名字(参数)` 形式的构造函数（前面可以有 `new`，名字可以带点：
  /// `Binary.createFromBase64`）
  fn identifier_value(&mut self) -> Result<Bson, ParseError> {
    let start = self.index;
    let mut name = self.identifier();
    match name.as_str() {
      "true" => return Ok(Bson::Boolean(true)),
      "false" => return Ok(Bson::Boolean(false)),
      "null" => return Ok(Bson::Null),
      "undefined" => return Ok(Bson::Undefined),
      "NaN" => return Ok(Bson::Double(f64::NAN)),
      "Infinity" => return Ok(Bson::Double(f64::INFINITY)),
      "new" => {
        self.skip_trivia()?;
        if !self.peek().is_some_and(is_identifier_start) {
          return Err(self.syntax_error());
        }
        name = self.identifier();
      }
      _ => {}
    }
    while self.peek() == Some('.') && self.peek_at(1).is_some_and(is_identifier_start) {
      self.index += 1;
      name.push('.');
      name.push_str(&self.identifier());
    }
    self.skip_trivia()?;
    if self.peek() != Some('(') {
      return Err(ParseError {
        code: MONGO_UNKNOWN_FUNCTION,
        detail: format!("{name} ({})", self.location_of(start)),
      });
    }
    let arguments_at = self.index;
    let arguments = self.arguments()?;
    self.construct(&name, arguments, start, arguments_at)
  }

  fn arguments(&mut self) -> Result<Vec<Bson>, ParseError> {
    self.expect('(')?;
    let mut arguments = Vec::new();
    loop {
      self.skip_trivia()?;
      if self.peek() == Some(')') {
        self.index += 1;
        break;
      }
      arguments.push(self.value()?);
      self.skip_trivia()?;
      match self.peek() {
        Some(',') => self.index += 1,
        Some(')') => {
          self.index += 1;
          break;
        }
        _ => return Err(self.syntax_error()),
      }
    }
    Ok(arguments)
  }

  fn construct(
    &self,
    name: &str,
    arguments: Vec<Bson>,
    name_at: usize,
    arguments_at: usize,
  ) -> Result<Bson, ParseError> {
    let bad = || self.bad_argument(name, arguments_at);
    let built = match (name, arguments.as_slice()) {
      ("ObjectId", []) => Some(Bson::ObjectId(ObjectId::new())),
      ("ObjectId", [Bson::String(hex)]) => ObjectId::parse_str(hex).ok().map(Bson::ObjectId),
      ("ISODate" | "Date", []) => Some(Bson::DateTime(DateTime::now())),
      ("ISODate" | "Date", [Bson::String(text)]) => parse_date(text).map(Bson::DateTime),
      ("ISODate" | "Date", [millis]) => {
        integral(millis).map(|ms| Bson::DateTime(DateTime::from_millis(ms)))
      }
      ("Long" | "NumberLong", [Bson::String(text)]) => {
        text.trim().parse::<i64>().ok().map(Bson::Int64)
      }
      ("Long" | "NumberLong", [number]) => integral(number).map(Bson::Int64),
      ("Int32" | "NumberInt", [Bson::String(text)]) => {
        text.trim().parse::<i32>().ok().map(Bson::Int32)
      }
      ("Int32" | "NumberInt", [number]) => {
        integral(number).and_then(|value| i32::try_from(value).ok()).map(Bson::Int32)
      }
      ("Double", [Bson::String(text)]) => text.trim().parse::<f64>().ok().map(Bson::Double),
      ("Double", [number]) => as_f64(number).map(Bson::Double),
      ("Decimal128" | "NumberDecimal", [Bson::String(text)]) => {
        Decimal128::from_str(text.trim()).ok().map(Bson::Decimal128)
      }
      (
        "Decimal128" | "NumberDecimal",
        [number @ (Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_))],
      ) => Decimal128::from_str(&number.to_string()).ok().map(Bson::Decimal128),
      ("UUID", [Bson::String(text)]) => {
        parse_uuid(text).map(|bytes| Bson::Binary(Binary { subtype: BinarySubtype::Uuid, bytes }))
      }
      ("BinData", [subtype, Bson::String(base64)])
      | ("Binary.createFromBase64", [Bson::String(base64), subtype]) => binary(base64, subtype),
      ("Binary.createFromBase64", [Bson::String(base64)]) => binary(base64, &Bson::Int32(0)),
      ("Timestamp", [Bson::Document(parts)]) => {
        match (parts.get("t").and_then(integral), parts.get("i").and_then(integral)) {
          (Some(time), Some(increment)) => timestamp(time, increment),
          _ => None,
        }
      }
      ("Timestamp", [time, increment]) => match (integral(time), integral(increment)) {
        (Some(time), Some(increment)) => timestamp(time, increment),
        _ => None,
      },
      ("MinKey", []) => Some(Bson::MinKey),
      ("MaxKey", []) => Some(Bson::MaxKey),
      ("BSONRegExp" | "RegExp", [Bson::String(pattern)]) => regex(pattern.clone(), ""),
      ("BSONRegExp" | "RegExp", [Bson::String(pattern), Bson::String(flags)]) => {
        regex(pattern.clone(), flags)
      }
      ("Code", [Bson::String(code)]) => Some(Bson::JavaScriptCode(code.clone())),
      ("Code", [Bson::String(code), Bson::Document(scope)]) => {
        Some(Bson::JavaScriptCodeWithScope(JavaScriptCodeWithScope {
          code: code.clone(),
          scope: scope.clone(),
        }))
      }
      _ if KNOWN_FUNCTIONS.contains(&name) => None,
      _ => {
        return Err(ParseError {
          code: MONGO_UNKNOWN_FUNCTION,
          detail: format!("{name} ({})", self.location_of(name_at)),
        })
      }
    };
    built.ok_or_else(bad)
  }
}

/// 认得的构造函数。名字认得、参数不对时报「参数不对」，而不是「认不出」——
/// 后者会让人去查自己是不是把名字拼错了
const KNOWN_FUNCTIONS: [&str; 19] = [
  "ObjectId",
  "ISODate",
  "Date",
  "Long",
  "NumberLong",
  "Int32",
  "NumberInt",
  "Double",
  "Decimal128",
  "NumberDecimal",
  "UUID",
  "BinData",
  "Binary.createFromBase64",
  "Timestamp",
  "MinKey",
  "MaxKey",
  "BSONRegExp",
  "RegExp",
  "Code",
];

fn is_identifier_start(character: char) -> bool {
  character.is_alphabetic() || character == '_' || character == '$'
}

fn is_identifier_part(character: char) -> bool {
  character.is_alphanumeric() || character == '_' || character == '$'
}

fn is_key_char(character: char) -> bool {
  is_identifier_part(character) || character == '.' || character == '-'
}

fn integral(value: &Bson) -> Option<i64> {
  match value {
    Bson::Int32(value) => Some(i64::from(*value)),
    Bson::Int64(value) => Some(*value),
    Bson::Double(value) if value.fract() == 0.0 && value.abs() < 9.0e15 => Some(*value as i64),
    _ => None,
  }
}

fn as_f64(value: &Bson) -> Option<f64> {
  match value {
    Bson::Int32(value) => Some(f64::from(*value)),
    Bson::Int64(value) => Some(*value as f64),
    Bson::Double(value) => Some(*value),
    _ => None,
  }
}

fn timestamp(time: i64, increment: i64) -> Option<Bson> {
  Some(Bson::Timestamp(Timestamp {
    time: u32::try_from(time).ok()?,
    increment: u32::try_from(increment).ok()?,
  }))
}

fn binary(base64: &str, subtype: &Bson) -> Option<Bson> {
  let subtype = u8::try_from(integral(subtype)?).ok()?;
  Binary::from_base64(base64, BinarySubtype::from(subtype)).ok().map(Bson::Binary)
}

/// 选项按字母排：BSON 规范要求如此，服务端对乱序的选项会报错
fn regex(pattern: String, flags: &str) -> Option<Bson> {
  if !flags.chars().all(|flag| "gilmsux".contains(flag)) {
    return None;
  }
  // `g` 是 JS 的全局匹配，服务端不认；mongosh 同样把它丢掉
  let mut options: Vec<char> = flags.chars().filter(|flag| *flag != 'g').collect();
  options.sort_unstable();
  options.dedup();
  Some(Bson::RegularExpression(Regex { pattern, options: options.into_iter().collect() }))
}

/// `ISODate` 收的写法：完整的 RFC 3339；不带时区的按 UTC（与 mongosh 一致）；
/// 只有日期的是当天零点
fn parse_date(text: &str) -> Option<DateTime> {
  let text = text.trim();
  if let Ok(date) = DateTime::parse_rfc3339_str(text) {
    return Some(date);
  }
  if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f") {
    return Some(DateTime::from_millis(naive.and_utc().timestamp_millis()));
  }
  if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f") {
    return Some(DateTime::from_millis(naive.and_utc().timestamp_millis()));
  }
  let date = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?;
  Some(DateTime::from_millis(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis()))
}

fn parse_uuid(text: &str) -> Option<Vec<u8>> {
  let hex: String = text.chars().filter(|character| *character != '-').collect();
  if hex.len() != 32 {
    return None;
  }
  (0..16).map(|index| u8::from_str_radix(hex.get(index * 2..index * 2 + 2)?, 16).ok()).collect()
}

/// Extended JSON 的包装键。一个只有这些键的对象按 EJSON 读成对应的值
const EXTENDED_JSON_KEYS: [&str; 16] = [
  "$oid",
  "$date",
  "$numberLong",
  "$numberInt",
  "$numberDouble",
  "$numberDecimal",
  "$binary",
  "$uuid",
  "$regularExpression",
  "$timestamp",
  "$minKey",
  "$maxKey",
  "$undefined",
  "$symbol",
  "$code",
  "$dbPointer",
];

/// `{ $oid: '…' }` 这类对象换成它表示的值；不是包装的原样返回。
///
/// 只看**第一个键**是不是包装键：`{ $gt: 1 }` 是查询运算符，不能碰。转换走
/// canonical EJSON——它无损，relaxed 会把包装里嵌着的 Int64 读回成 Int32
fn extended_json_wrapper(document: Document) -> Bson {
  let is_wrapper = document
    .keys()
    .next()
    .is_some_and(|key| EXTENDED_JSON_KEYS.contains(&key.as_str()) || key == "$scope");
  if !is_wrapper {
    return Bson::Document(document);
  }
  let json = Bson::Document(document.clone()).into_canonical_extjson();
  match Bson::try_from(json) {
    Ok(Bson::Document(_)) | Err(_) => Bson::Document(document),
    Ok(value) => value,
  }
}

/// 格式化：一行的（网格单元格）与缩进的（文档详情、编辑框）
#[derive(Clone, Copy, PartialEq)]
pub enum Layout {
  OneLine,
  Indented,
}

pub fn format_value(value: &Bson, layout: Layout) -> String {
  let mut output = String::new();
  write_value(&mut output, value, layout, 0);
  output
}

pub fn format_document(document: &Document, layout: Layout) -> String {
  let mut output = String::new();
  write_document(&mut output, document, layout, 0);
  output
}

fn write_value(output: &mut String, value: &Bson, layout: Layout, depth: usize) {
  match value {
    Bson::Double(value) => output.push_str(&format_double(*value)),
    Bson::String(text) => write_string(output, text),
    Bson::Document(document) => write_document(output, document, layout, depth),
    Bson::Array(items) => write_array(output, items, layout, depth),
    Bson::Boolean(value) => output.push_str(if *value { "true" } else { "false" }),
    Bson::Null => output.push_str("null"),
    Bson::Undefined => output.push_str("undefined"),
    Bson::Int32(value) => {
      let _ = write!(output, "{value}");
    }
    Bson::Int64(value) => {
      let _ = write!(output, "Long('{value}')");
    }
    Bson::Decimal128(value) => {
      let _ = write!(output, "Decimal128('{value}')");
    }
    Bson::ObjectId(id) => {
      let _ = write!(output, "ObjectId('{}')", id.to_hex());
    }
    Bson::DateTime(date) => match date.try_to_rfc3339_string() {
      Ok(text) => {
        let _ = write!(output, "ISODate('{text}')");
      }
      // RFC 3339 表示不了的年份（负数、一万年以后）：退回毫秒数，照样读得回来
      Err(_) => {
        let _ = write!(output, "ISODate({})", date.timestamp_millis());
      }
    },
    Bson::Binary(binary) => write_binary(output, binary),
    Bson::RegularExpression(regex) => {
      let literal_safe = !regex.pattern.is_empty()
        && !regex.pattern.contains(['/', '\n', '\r'])
        && !regex.pattern.ends_with('\\');
      if literal_safe {
        let _ = write!(output, "/{}/{}", regex.pattern, regex.options);
      } else {
        output.push_str("BSONRegExp(");
        write_string(output, &regex.pattern);
        output.push_str(", ");
        write_string(output, &regex.options);
        output.push(')');
      }
    }
    Bson::Timestamp(timestamp) => {
      let _ = write!(output, "Timestamp({{ t: {}, i: {} }})", timestamp.time, timestamp.increment);
    }
    Bson::MinKey => output.push_str("MinKey()"),
    Bson::MaxKey => output.push_str("MaxKey()"),
    Bson::JavaScriptCode(code) => {
      output.push_str("Code(");
      write_string(output, code);
      output.push(')');
    }
    Bson::JavaScriptCodeWithScope(code) => {
      output.push_str("Code(");
      write_string(output, &code.code);
      output.push_str(", ");
      write_document(output, &code.scope, Layout::OneLine, depth);
      output.push(')');
    }
    // 早已废弃、mongosh 里也没有构造函数的两种：写成 canonical EJSON，
    // 解析器认得这层包装
    Bson::Symbol(_) | Bson::DbPointer(_) => {
      output.push_str(&value.clone().into_canonical_extjson().to_string());
    }
  }
}

/// 整数值的双精度数带 `.0`，与 Int32 区分开；其余取最短的、读得回原值的写法
fn format_double(value: f64) -> String {
  if value.is_nan() {
    return "NaN".to_string();
  }
  if value.is_infinite() {
    return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
  }
  // Debug 给的就是最短往返写法，整数值自带 `.0`，很大很小的用指数
  format!("{value:?}")
}

fn write_string(output: &mut String, text: &str) {
  output.push('\'');
  for character in text.chars() {
    match character {
      '\'' => output.push_str("\\'"),
      '\\' => output.push_str("\\\\"),
      '\n' => output.push_str("\\n"),
      '\r' => output.push_str("\\r"),
      '\t' => output.push_str("\\t"),
      control if control.is_control() => {
        let _ = write!(output, "\\u{:04x}", u32::from(control));
      }
      other => output.push(other),
    }
  }
  output.push('\'');
}

fn write_binary(output: &mut String, binary: &Binary) {
  if binary.subtype == BinarySubtype::Uuid && binary.bytes.len() == 16 {
    let hex: String = binary.bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let _ = write!(
      output,
      "UUID('{}-{}-{}-{}-{}')",
      &hex[0..8],
      &hex[8..12],
      &hex[12..16],
      &hex[16..20],
      &hex[20..32]
    );
    return;
  }
  let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &binary.bytes);
  let _ = write!(output, "Binary.createFromBase64('{base64}', {})", u8::from(binary.subtype));
}

fn write_key(output: &mut String, key: &str) {
  let plain =
    key.chars().next().is_some_and(is_identifier_start) && key.chars().all(is_identifier_part);
  if plain {
    output.push_str(key);
  } else {
    write_string(output, key);
  }
}

fn write_document(output: &mut String, document: &Document, layout: Layout, depth: usize) {
  if document.is_empty() {
    output.push_str("{}");
    return;
  }
  match layout {
    Layout::OneLine => {
      output.push_str("{ ");
      for (index, (key, value)) in document.iter().enumerate() {
        if index > 0 {
          output.push_str(", ");
        }
        write_key(output, key);
        output.push_str(": ");
        write_value(output, value, layout, depth + 1);
      }
      output.push_str(" }");
    }
    Layout::Indented => {
      output.push_str("{\n");
      for (index, (key, value)) in document.iter().enumerate() {
        indent(output, depth + 1);
        write_key(output, key);
        output.push_str(": ");
        write_value(output, value, layout, depth + 1);
        if index + 1 < document.len() {
          output.push(',');
        }
        output.push('\n');
      }
      indent(output, depth);
      output.push('}');
    }
  }
}

fn write_array(output: &mut String, items: &[Bson], layout: Layout, depth: usize) {
  if items.is_empty() {
    output.push_str("[]");
    return;
  }
  // 标量数组即使在缩进形态下也写一行：一个 `tags` 数组占八行只会让文档没法读
  let all_scalars = items.iter().all(|item| !matches!(item, Bson::Document(_) | Bson::Array(_)));
  if layout == Layout::OneLine || all_scalars {
    output.push_str("[ ");
    for (index, item) in items.iter().enumerate() {
      if index > 0 {
        output.push_str(", ");
      }
      write_value(output, item, layout, depth + 1);
    }
    output.push_str(" ]");
    return;
  }
  output.push_str("[\n");
  for (index, item) in items.iter().enumerate() {
    indent(output, depth + 1);
    write_value(output, item, layout, depth + 1);
    if index + 1 < items.len() {
      output.push(',');
    }
    output.push('\n');
  }
  indent(output, depth);
  output.push(']');
}

fn indent(output: &mut String, depth: usize) {
  for _ in 0..depth {
    output.push_str("  ");
  }
}

/// 网格上用来着色、对齐的类型名。与前端 `MongoValueKind` 对应
pub fn value_kind(value: &Bson) -> &'static str {
  match value {
    Bson::Double(_) => "double",
    Bson::Int32(_) => "int",
    Bson::Int64(_) => "long",
    Bson::Decimal128(_) => "decimal",
    Bson::String(_) => "string",
    Bson::Boolean(_) => "bool",
    Bson::Null | Bson::Undefined => "null",
    Bson::ObjectId(_) => "objectId",
    Bson::DateTime(_) => "date",
    Bson::Document(_) => "document",
    Bson::Array(_) => "array",
    Bson::Binary(_) => "binary",
    _ => "other",
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use mongodb::bson::doc;

  fn round_trip(document: &Document) {
    for layout in [Layout::OneLine, Layout::Indented] {
      let text = format_document(document, layout);
      let parsed = parse_document(&text).unwrap_or_else(|error| panic!("{error} 读不回：{text}"));
      assert_eq!(&parsed, document, "往返后变了：{text}");
    }
  }

  fn every_type() -> Document {
    doc! {
      "_id": ObjectId::parse_str("65a0c0ffee0000000000abcd").unwrap(),
      "int": 30,
      "long": 41_i64,
      "double": 3.0,
      "fraction": 2.5,
      "tiny": 1e-7,
      "huge": 1e300,
      "negativeZero": -0.0,
      "decimal": Decimal128::from_str("12.50").unwrap(),
      "string": "it's \"quoted\"\n\ttab \\ back 中文 😀 \u{1}",
      "bool": true,
      "null": Bson::Null,
      "undefined": Bson::Undefined,
      "date": DateTime::parse_rfc3339_str("2024-01-05T12:30:45.123Z").unwrap(),
      "farDate": DateTime::from_millis(-62_198_755_200_000 - 86_400_000),
      "binary": Binary { subtype: BinarySubtype::Generic, bytes: vec![1, 2, 3] },
      "uuid": Binary { subtype: BinarySubtype::Uuid, bytes: (0..16).collect() },
      "userBinary": Binary { subtype: BinarySubtype::UserDefined(0x80), bytes: vec![0xff] },
      "regex": Regex { pattern: "^al\\.ice[/x]".to_string(), options: "i".to_string() },
      "slashRegex": Regex { pattern: "a/b".to_string(), options: "".to_string() },
      "timestamp": Timestamp { time: 1_700_000_000, increment: 7 },
      "minKey": Bson::MinKey,
      "maxKey": Bson::MaxKey,
      "code": Bson::JavaScriptCode("function () { return 'x'; }".to_string()),
      "codeWithScope": JavaScriptCodeWithScope { code: "x".to_string(), scope: doc! { "x": 1_i64 } },
      "symbol": Bson::Symbol("sym".to_string()),
      "nested": { "address": { "city": "Beijing", "zip": "100000" }, "empty": {} },
      "array": [1, 2_i64, "three", { "four": 4.0 }, [5], []],
      "key with space": 1,
      "dotted.key": 2,
      "$dollar": 3,
      "": 4,
    }
  }

  #[test]
  fn every_bson_type_survives_format_then_parse() {
    round_trip(&every_type());
  }

  #[test]
  fn nan_and_infinities_survive_too() {
    let document = doc! { "inf": f64::INFINITY, "negInf": f64::NEG_INFINITY };
    round_trip(&document);
    // NaN != NaN，单独比
    let parsed = parse_document(&format_document(&doc! { "nan": f64::NAN }, Layout::OneLine));
    assert!(matches!(parsed.map(|d| d.get_f64("nan").map(f64::is_nan)), Ok(Ok(true))));
  }

  /// 反向：mongosh 的写法把整数值的双精度数印成 `3`，读回来是 Int32。
  /// 这里印成 `3.0`——这条钉住它，免得哪天被「和 mongosh 保持一致」改回去
  #[test]
  fn an_integral_double_is_not_printed_like_an_int() {
    assert_eq!(format_value(&Bson::Double(3.0), Layout::OneLine), "3.0");
    assert_eq!(parse_value("3"), Ok(Bson::Int32(3)));
    assert_eq!(parse_value("3.0"), Ok(Bson::Double(3.0)));
    assert_eq!(parse_value("1e16"), Ok(Bson::Double(1e16)));
  }

  #[test]
  fn integers_widen_to_long_instead_of_losing_digits() {
    assert_eq!(parse_value("2147483647"), Ok(Bson::Int32(i32::MAX)));
    assert_eq!(parse_value("2147483648"), Ok(Bson::Int64(2_147_483_648)));
    assert_eq!(parse_value("-9007199254740993"), Ok(Bson::Int64(-9_007_199_254_740_993)));
    assert_eq!(parse_value("1_000"), Ok(Bson::Int32(1000)));
  }

  #[test]
  fn what_people_type_into_a_filter_box_parses() {
    let parsed = parse_document(
      "{ age: { $gt: 30 }, name: /^al/i, 'address.city': \"Beijing\", tags: { $in: ['a', 'b',] }, }",
    );
    assert_eq!(
      parsed,
      Ok(doc! {
        "age": { "$gt": 30 },
        "name": Regex { pattern: "^al".to_string(), options: "i".to_string() },
        "address.city": "Beijing",
        "tags": { "$in": ["a", "b"] },
      })
    );
    // 不加引号的点号键：JS 里不行，这里行
    assert_eq!(parse_document("{ address.city: 'x' }"), Ok(doc! { "address.city": "x" }));
    // 注释
    assert_eq!(
      parse_document("// 活跃用户\n{ active: true /* 只看 */ }"),
      Ok(doc! { "active": true })
    );
  }

  #[test]
  fn an_empty_filter_box_means_everything() {
    assert_eq!(parse_document(""), Ok(Document::new()));
    assert_eq!(parse_document("  \n // 什么都没写\n"), Ok(Document::new()));
  }

  #[test]
  fn constructor_spellings_from_other_tools_are_accepted() {
    let id = ObjectId::parse_str("65a0c0ffee0000000000abcd").unwrap();
    let cases: [(&str, Bson); 12] = [
      ("ObjectId(\"65a0c0ffee0000000000abcd\")", Bson::ObjectId(id)),
      ("{ $oid: '65a0c0ffee0000000000abcd' }", Bson::ObjectId(id)),
      ("NumberLong(41)", Bson::Int64(41)),
      ("NumberLong('9223372036854775807')", Bson::Int64(i64::MAX)),
      ("{ $numberLong: '41' }", Bson::Int64(41)),
      ("NumberInt('7')", Bson::Int32(7)),
      ("NumberDecimal('0.1')", Bson::Decimal128(Decimal128::from_str("0.1").unwrap())),
      (
        "new Date('2024-01-05T12:30:45Z')",
        Bson::DateTime(DateTime::from_millis(1_704_457_845_000)),
      ),
      ("ISODate('2024-01-05')", Bson::DateTime(DateTime::from_millis(1_704_412_800_000))),
      ("ISODate('2024-01-05T12:30:45')", Bson::DateTime(DateTime::from_millis(1_704_457_845_000))),
      (
        "BinData(0, 'AQID')",
        Bson::Binary(Binary { subtype: BinarySubtype::Generic, bytes: vec![1, 2, 3] }),
      ),
      ("Timestamp(1, 2)", Bson::Timestamp(Timestamp { time: 1, increment: 2 })),
    ];
    for (text, expected) in cases {
      assert_eq!(parse_value(text), Ok(expected), "{text}");
    }
    // 查询运算符不是 EJSON 包装，不能被碰
    assert_eq!(parse_value("{ $gt: Long('1') }"), Ok(Bson::Document(doc! { "$gt": 1_i64 })));
  }

  #[test]
  fn regex_flags_are_sorted_and_g_is_dropped() {
    assert_eq!(
      parse_value("/x/smig"),
      Ok(Bson::RegularExpression(Regex { pattern: "x".to_string(), options: "ims".to_string() }))
    );
    assert!(matches!(parse_value("/x/q"), Err(ParseError { code: MONGO_BAD_ARGUMENT, .. })));
  }

  #[test]
  fn errors_point_at_the_line_and_column() {
    let error = parse_document("{\n  age: { $gt 30 }\n}").err();
    assert_eq!(error, Some(ParseError { code: MONGO_SYNTAX, detail: "2:14".to_string() }));

    let error = parse_document("{ name: 'unterminated }").err();
    assert_eq!(error, Some(ParseError { code: MONGO_SYNTAX, detail: "1:9".to_string() }));

    let error = parse_document("{ _id: ObjectID('65a0c0ffee0000000000abcd') }").err();
    assert_eq!(
      error,
      Some(ParseError { code: MONGO_UNKNOWN_FUNCTION, detail: "ObjectID (1:8)".to_string() })
    );

    let error = parse_document("{ _id: ObjectId('xyz') }").err();
    assert_eq!(
      error,
      Some(ParseError { code: MONGO_BAD_ARGUMENT, detail: "ObjectId (1:16)".to_string() })
    );

    let error = parse_document("[1, 2]").err();
    assert_eq!(error, Some(ParseError { code: MONGO_NOT_DOCUMENT, detail: "1:1".to_string() }));

    // 文档后面还有东西
    let error = parse_document("{ a: 1 } { b: 2 }").err();
    assert_eq!(error, Some(ParseError { code: MONGO_SYNTAX, detail: "1:10".to_string() }));
  }

  #[test]
  fn indented_layout_keeps_scalar_arrays_on_one_line() {
    let text =
      format_document(&doc! { "tags": ["a", "b"], "items": [{ "sku": "s1" }] }, Layout::Indented);
    assert_eq!(text, "{\n  tags: [ 'a', 'b' ],\n  items: [\n    {\n      sku: 's1'\n    }\n  ]\n}");
  }

  #[test]
  fn the_one_line_layout_reads_like_mongosh() {
    let text = format_document(
      &doc! {
        "_id": ObjectId::parse_str("65a0c0ffee0000000000abcd").unwrap(),
        "age": 41_i64,
        "tags": ["admin"],
        "at": DateTime::from_millis(1_704_457_845_000),
      },
      Layout::OneLine,
    );
    assert_eq!(
      text,
      "{ _id: ObjectId('65a0c0ffee0000000000abcd'), age: Long('41'), tags: [ 'admin' ], at: ISODate('2024-01-05T12:30:45Z') }"
    );
  }
}
