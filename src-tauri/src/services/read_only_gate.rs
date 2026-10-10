//! 命令行给 Agent 只放行读语句（`rfcs/agent-cli.md` §5.2）。
//!
//! 数据库自己的只读事务挡不全：MySQL、Oracle 在只读事务里照样执行 DDL，SQLite 只读打开后
//! `ATTACH` 能写出新文件，而一次发多条语句时 `COMMIT` 能把只读事务提前结束（实验见 §3.1）。
//! 所以这里是**白名单**：开头必须是读的关键字，全文不许出现写的关键字和有副作用的函数，
//! 只许一条语句。
//!
//! 难的是「全文」——引号和注释里的内容不算，而各家对引号和注释的规矩不一样：
//! PostgreSQL 只在 `E''` 里认反斜杠，MySQL 处处认；MySQL 的 `--` 后面要有空白；
//! 只有部分库认 `#` 注释、嵌套注释、美元引号、反引号、方括号、Oracle 的 `q''`。
//! 按某一家的规矩扫，另一家可能把这边当成字符串的内容当成代码执行。
//! 所以**每一种规矩的组合都扫一遍，任何一种看出问题就拒绝**：只要数据库真实的规矩
//! 是其中一种，它看得见的东西这里就看得见。代价是偶尔误拒，比如 `# don't` 在不认
//! `#` 的规矩下是一个没闭合的字符串。一条语句扫三百多遍也只是微秒级。

use std::fmt;

/// 为什么拒绝。写给 Agent 看：说清楚是哪一类问题，好让它换个写法或者停下
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
  Empty,
  Unterminated,
  MultipleStatements,
  /// MySQL 会执行 `/*! … */` 里的内容
  ExecutableComment,
  NotARead(String),
  WriteKeyword(String),
  SideEffectFunction(String),
}

impl fmt::Display for Refusal {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Empty => write!(f, "the statement is empty"),
      Self::Unterminated => write!(f, "a quote or comment is not closed"),
      Self::MultipleStatements => write!(f, "only one statement per call is allowed"),
      Self::ExecutableComment => write!(f, "executable comments (/*! ... */) are not allowed"),
      Self::NotARead(word) => {
        write!(f, "only read statements are allowed; this one starts with {word}")
      }
      Self::WriteKeyword(word) => write!(f, "{word} is not allowed in a read-only statement"),
      Self::SideEffectFunction(name) => {
        write!(f, "{name}() has side effects and is not allowed")
      }
    }
  }
}

/// 读语句的开头。`TABLE` 是 PostgreSQL 与 MySQL 8 的 `TABLE t`；`FROM`、`SUMMARIZE`、
/// `PIVOT`、`UNPIVOT` 是 DuckDB 的；`EXISTS` 是 ClickHouse 的 `EXISTS TABLE t`。
/// 不收 `PRAGMA`：SQLite 的 PRAGMA 有一半是写
const READ_STARTS: &[&str] = &[
  "SELECT",
  "WITH",
  "SHOW",
  "DESCRIBE",
  "DESC",
  "EXPLAIN",
  "VALUES",
  "TABLE",
  "FROM",
  "SUMMARIZE",
  "PIVOT",
  "UNPIVOT",
  "EXISTS",
];

/// 这几种开头只读元数据，后面出现的 `CREATE`（`SHOW CREATE TABLE`）不是动作
const METADATA_STARTS: &[&str] = &["SHOW", "DESCRIBE", "DESC"];

/// 出现在读语句**里面**就能写或者加锁的词：改数据的 CTE、`SELECT INTO`、`FOR UPDATE`、
/// `EXPLAIN ANALYZE`（真的执行）。其余的写语句在开头就被白名单挡住了，这里也列上，
/// 防的是开头判断以外的漏洞
const WRITE_WORDS: &[&str] = &[
  "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "INTO", "ANALYZE", "ANALYSE", "DROP", "CREATE",
  "ALTER", "TRUNCATE", "RENAME", "GRANT", "REVOKE", "ATTACH", "DETACH", "VACUUM", "COPY", "CALL",
  "EXEC", "EXECUTE", "PREPARE", "LOCK", "PRAGMA", "INSTALL", "LOAD", "COMMIT", "ROLLBACK",
];

/// 只读事务挡不住、或者能读写本机文件与网络的函数。尽力而为——自定义函数什么都能做，
/// 真正的边界是只读账号（§5.2）
const SIDE_EFFECT_FUNCTIONS: &[&str] = &[
  // PostgreSQL
  "PG_TERMINATE_BACKEND",
  "PG_CANCEL_BACKEND",
  "PG_RELOAD_CONF",
  "PG_ROTATE_LOGFILE",
  "PG_READ_FILE",
  "PG_READ_BINARY_FILE",
  "PG_LS_DIR",
  "PG_STAT_FILE",
  "PG_NOTIFY",
  "SET_CONFIG",
  "NEXTVAL",
  "SETVAL",
  "LO_IMPORT",
  "LO_EXPORT",
  "DBLINK",
  "DBLINK_EXEC",
  "QUERY_TO_XML",
  "QUERY_TO_XMLSCHEMA",
  "QUERY_TO_XML_AND_XMLSCHEMA",
  // MySQL
  "GET_LOCK",
  "RELEASE_LOCK",
  "RELEASE_ALL_LOCKS",
  "LOAD_FILE",
  // DuckDB（外部访问另外关掉了，这里是第二层）
  "READ_TEXT",
  "READ_BLOB",
  "READ_CSV",
  "READ_CSV_AUTO",
  "READ_PARQUET",
  "READ_JSON",
  "READ_JSON_AUTO",
  "GLOB",
  // ClickHouse 的表函数（`readonly=1` 也挡，这里是第二层）
  "URL",
  "FILE",
  "S3",
  "S3CLUSTER",
  "REMOTE",
  "REMOTESECURE",
  "HDFS",
  "EXECUTABLE",
  // SQLite
  "LOAD_EXTENSION",
  "READFILE",
  "WRITEFILE",
];

/// 前缀匹配：`pg_advisory_lock`、`pg_advisory_xact_lock_shared` 之类有一整族
const SIDE_EFFECT_PREFIXES: &[&str] = &["PG_ADVISORY"];

pub fn check(sql: &str) -> Result<(), Refusal> {
  every_lexing().try_for_each(|lexing| check_tokens(&lex(sql, lexing)?))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Backslash {
  Never,
  Always,
  /// PostgreSQL（`standard_conforming_strings = on`）：只在 `E''` 里转义
  EPrefixedOnly,
}

#[derive(Debug, Clone, Copy)]
struct Lexing {
  backslash: Backslash,
  hash_comments: bool,
  nested_comments: bool,
  dollar_quotes: bool,
  backtick_quotes: bool,
  bracket_quotes: bool,
  q_quotes: bool,
  /// MySQL 的 `--` 后面要有空白才是注释，`1 --1` 是减负一
  dash_needs_space: bool,
}

fn every_lexing() -> impl Iterator<Item = Lexing> {
  [Backslash::Never, Backslash::Always, Backslash::EPrefixedOnly].into_iter().flat_map(
    |backslash| {
      (0..128u8).map(move |bits| Lexing {
        backslash,
        hash_comments: bits & 1 != 0,
        nested_comments: bits & 2 != 0,
        dollar_quotes: bits & 4 != 0,
        backtick_quotes: bits & 8 != 0,
        bracket_quotes: bits & 16 != 0,
        q_quotes: bits & 32 != 0,
        dash_needs_space: bits & 64 != 0,
      })
    },
  )
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
  /// 关键字或不带引号的标识符，ASCII 部分转成大写
  Word(String),
  /// 带引号的标识符（`"x"`、`` `x` ``、`[x]`）的内容，大写。函数名可以带引号
  Quoted(String),
  Literal,
  Semicolon,
  Punct(char),
}

fn is_word_start(c: char) -> bool {
  c.is_alphabetic() || c == '_' || !c.is_ascii()
}

fn is_word_char(c: char) -> bool {
  c.is_alphanumeric() || c == '_' || c == '$' || !c.is_ascii()
}

fn lex(sql: &str, lexing: Lexing) -> Result<Vec<Token>, Refusal> {
  let chars: Vec<char> = sql.chars().collect();
  let mut tokens = Vec::new();
  let mut i = 0;
  while i < chars.len() {
    let c = chars[i];
    let next = chars.get(i + 1).copied();
    if c.is_whitespace() {
      i += 1;
    } else if c == '-' && next == Some('-') {
      let after = chars.get(i + 2).copied();
      if lexing.dash_needs_space && after.is_some_and(|after| !after.is_whitespace()) {
        tokens.push(Token::Punct('-'));
        i += 1;
      } else {
        i = skip_line(&chars, i);
      }
    } else if c == '#' && lexing.hash_comments {
      i = skip_line(&chars, i);
    } else if c == '/' && next == Some('*') {
      i = skip_block_comment(&chars, i, lexing.nested_comments)?;
    } else if c == '\'' {
      let escapes = lexing.backslash == Backslash::Always;
      i = skip_quoted(&chars, i, '\'', escapes)?;
      tokens.push(Token::Literal);
    } else if c == '"' {
      let escapes = lexing.backslash == Backslash::Always;
      let (end, content) = read_quoted(&chars, i, '"', '"', escapes)?;
      tokens.push(Token::Quoted(content));
      i = end;
    } else if c == '`' && lexing.backtick_quotes {
      let (end, content) = read_quoted(&chars, i, '`', '`', false)?;
      tokens.push(Token::Quoted(content));
      i = end;
    } else if c == '[' && lexing.bracket_quotes {
      let (end, content) = read_quoted(&chars, i, '[', ']', false)?;
      tokens.push(Token::Quoted(content));
      i = end;
    } else if c == '$' && lexing.dollar_quotes {
      match dollar_tag(&chars, i) {
        Some(tag) => {
          i = skip_dollar_quoted(&chars, i, &tag)?;
          tokens.push(Token::Literal);
        }
        None => {
          tokens.push(Token::Punct('$'));
          i += 1;
        }
      }
    } else if c.is_ascii_digit() {
      while chars.get(i).is_some_and(|c| c.is_alphanumeric() || *c == '.' || *c == '_') {
        i += 1;
      }
      tokens.push(Token::Literal);
    } else if is_word_start(c) {
      let start = i;
      while chars.get(i).is_some_and(|c| is_word_char(*c)) {
        i += 1;
      }
      let word: String = chars[start..i].iter().collect::<String>().to_ascii_uppercase();
      // 字符串前缀：E'' 按 PostgreSQL 的规矩转义，q'' / nq'' 是 Oracle 的引号。
      // 其余前缀（N''、X''、B''）就是普通字符串，下一轮按普通字符串扫
      if chars.get(i) == Some(&'\'') {
        if word == "E" && lexing.backslash == Backslash::EPrefixedOnly {
          i = skip_quoted(&chars, i, '\'', true)?;
          tokens.push(Token::Literal);
          continue;
        }
        if (word == "Q" || word == "NQ") && lexing.q_quotes {
          i = skip_q_quoted(&chars, i)?;
          tokens.push(Token::Literal);
          continue;
        }
      }
      tokens.push(Token::Word(word));
    } else if c == ';' {
      tokens.push(Token::Semicolon);
      i += 1;
    } else {
      tokens.push(Token::Punct(c));
      i += 1;
    }
  }
  Ok(tokens)
}

fn skip_line(chars: &[char], from: usize) -> usize {
  chars[from..].iter().position(|c| *c == '\n').map_or(chars.len(), |offset| from + offset + 1)
}

fn skip_block_comment(chars: &[char], from: usize, nested: bool) -> Result<usize, Refusal> {
  // `/*!` 是 MySQL 的可执行注释，`/*M!` 是 MariaDB 的。不管哪种规矩都拒绝
  let body = &chars[from + 2..];
  if body.first() == Some(&'!') || body.starts_with(&['M', '!']) {
    return Err(Refusal::ExecutableComment);
  }
  let mut depth = 1;
  let mut i = from + 2;
  while i < chars.len() {
    if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
      depth -= 1;
      i += 2;
      if depth == 0 {
        return Ok(i);
      }
    } else if nested && chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
      depth += 1;
      i += 2;
    } else {
      i += 1;
    }
  }
  Err(Refusal::Unterminated)
}

/// 从开引号扫到闭引号之后。成对的引号是转义；`escapes` 时反斜杠转义下一个字符
fn skip_quoted(chars: &[char], from: usize, quote: char, escapes: bool) -> Result<usize, Refusal> {
  read_quoted(chars, from, quote, quote, escapes).map(|(end, _)| end)
}

fn read_quoted(
  chars: &[char],
  from: usize,
  open: char,
  close: char,
  escapes: bool,
) -> Result<(usize, String), Refusal> {
  debug_assert_eq!(chars[from], open);
  let mut content = String::new();
  let mut i = from + 1;
  while i < chars.len() {
    let c = chars[i];
    if escapes && c == '\\' {
      if let Some(escaped) = chars.get(i + 1) {
        content.push(*escaped);
      }
      i += 2;
    } else if c == close {
      if chars.get(i + 1) == Some(&close) {
        content.push(close);
        i += 2;
      } else {
        return Ok((i + 1, content.to_ascii_uppercase()));
      }
    } else {
      content.push(c);
      i += 1;
    }
  }
  Err(Refusal::Unterminated)
}

/// `$tag$` 的 tag（可以为空）。`$1` 这类参数不是引号
fn dollar_tag(chars: &[char], from: usize) -> Option<String> {
  let mut i = from + 1;
  let mut tag = String::new();
  while let Some(c) = chars.get(i) {
    if *c == '$' {
      return Some(tag);
    }
    let allowed = if tag.is_empty() { is_word_start(*c) } else { is_word_char(*c) && *c != '$' };
    if !allowed {
      return None;
    }
    tag.push(*c);
    i += 1;
  }
  None
}

fn skip_dollar_quoted(chars: &[char], from: usize, tag: &str) -> Result<usize, Refusal> {
  let delimiter: Vec<char> = format!("${tag}$").chars().collect();
  let body_start = from + delimiter.len();
  (body_start..chars.len())
    .find(|i| chars[*i..].starts_with(&delimiter))
    .map(|i| i + delimiter.len())
    .ok_or(Refusal::Unterminated)
}

/// Oracle 的 `q'X…X'`：括号类的定界符用配对的那一半收尾
fn skip_q_quoted(chars: &[char], quote: usize) -> Result<usize, Refusal> {
  let opening = *chars.get(quote + 1).ok_or(Refusal::Unterminated)?;
  let closing = match opening {
    '[' => ']',
    '(' => ')',
    '{' => '}',
    '<' => '>',
    other => other,
  };
  (quote + 2..chars.len())
    .find(|i| chars[*i] == closing && chars.get(i + 1) == Some(&'\''))
    .map(|i| i + 2)
    .ok_or(Refusal::Unterminated)
}

fn check_tokens(tokens: &[Token]) -> Result<(), Refusal> {
  let statement = match tokens.iter().rposition(|token| *token != Token::Semicolon) {
    Some(last) => &tokens[..=last],
    None => return Err(Refusal::Empty),
  };
  if statement.contains(&Token::Semicolon) {
    return Err(Refusal::MultipleStatements);
  }

  // `(SELECT 1) UNION (SELECT 2)`：动词在括号里
  let first = statement.iter().find(|token| **token != Token::Punct('('));
  let first = match first {
    Some(Token::Word(word)) => word.as_str(),
    _ => return Err(Refusal::NotARead("something other than a keyword".to_string())),
  };
  if !READ_STARTS.contains(&first) {
    return Err(Refusal::NotARead(first.to_string()));
  }

  if !METADATA_STARTS.contains(&first) {
    if let Some(word) = statement.iter().find_map(|token| match token {
      Token::Word(word) if WRITE_WORDS.contains(&word.as_str()) => Some(word),
      _ => None,
    }) {
      return Err(Refusal::WriteKeyword(word.clone()));
    }
  }

  statement.windows(2).try_for_each(|pair| match pair {
    [Token::Word(name) | Token::Quoted(name), Token::Punct('(')] if is_side_effect(name) => {
      Err(Refusal::SideEffectFunction(name.to_ascii_lowercase()))
    }
    _ => Ok(()),
  })
}

fn is_side_effect(name: &str) -> bool {
  SIDE_EFFECT_FUNCTIONS.contains(&name)
    || SIDE_EFFECT_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde::Deserialize;

  /// 前后端共用的语料，路径写死在编译期：文件没了要编译不过，而不是跳过
  const CORPUS: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/agent-read-only.json"));

  #[derive(Deserialize)]
  struct Corpus {
    allow: Vec<Case>,
    deny: Vec<Case>,
  }

  #[derive(Deserialize)]
  struct Case {
    sql: String,
  }

  fn corpus() -> Corpus {
    serde_json::from_str(CORPUS).expect("语料是合法的 JSON")
  }

  #[test]
  fn allows_every_read_in_the_shared_corpus() {
    let corpus = corpus();
    assert!(corpus.allow.len() >= 20, "语料不能被删空");
    let wrongly_refused: Vec<_> = corpus
      .allow
      .iter()
      .filter_map(|case| check(&case.sql).err().map(|refusal| (case.sql.clone(), refusal)))
      .collect();
    assert!(wrongly_refused.is_empty(), "{wrongly_refused:#?}");
  }

  /// 已知的代价：不认反引号的规矩下，`` `delete` `` 就是关键字 DELETE。宁可误拒——
  /// 换个别名或者用双引号就能过，而放过去的那一次可能就是真的 DELETE
  #[test]
  fn a_backticked_write_keyword_is_refused_on_purpose() {
    assert_eq!(check("SELECT `delete` FROM t"), Err(Refusal::WriteKeyword("DELETE".to_string())));
    assert_eq!(check("SELECT `order` FROM t"), Ok(()));
  }

  #[test]
  fn refusals_say_what_was_wrong() {
    assert_eq!(check("DROP TABLE t"), Err(Refusal::NotARead("DROP".to_string())));
    assert_eq!(check("SELECT 1; SELECT 2"), Err(Refusal::MultipleStatements));
    assert_eq!(
      check("SELECT pg_terminate_backend(1)"),
      Err(Refusal::SideEffectFunction("pg_terminate_backend".to_string()))
    );
    assert_eq!(check("  ;  "), Err(Refusal::Empty));
  }

  #[test]
  fn refuses_every_write_and_escape_in_the_shared_corpus() {
    let corpus = corpus();
    assert!(corpus.deny.len() >= 40, "语料不能被删空");
    let wrongly_allowed: Vec<_> =
      corpus.deny.iter().filter(|case| check(&case.sql).is_ok()).map(|case| &case.sql).collect();
    assert!(wrongly_allowed.is_empty(), "{wrongly_allowed:#?}");
  }
}
