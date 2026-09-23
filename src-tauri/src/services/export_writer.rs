//! 把查询结果流式写成 CSV / JSON 文件。
//!
//! 整表导出的行数不设上限，所以整个过程不能有任何一步把结果攒在内存里：
//! 行从数据库流出来，逐行格式化，逐行写进文件。前端只出选项和路径。

use crate::services::{
  QueryError, QueryResultBatch, QueryRow, SessionConnection, StreamOptions,
  DEFAULT_QUERY_BATCH_SIZE, NON_QUERY_MESSAGE,
};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

pub const EXPORT_WRITE_FAILED: &str = "DATAOMNI_EXPORT_WRITE_FAILED";
pub const DIRECTORY_MISSING: &str = "DATAOMNI_DIRECTORY_MISSING";
pub const FILE_CREATE_FAILED: &str = "DATAOMNI_FILE_CREATE_FAILED";
pub const FILE_RENAME_FAILED: &str = "DATAOMNI_FILE_RENAME_FAILED";
/// 用户按了取消。不是失败，界面上不该标红
pub const EXPORT_CANCELLED: &str = "DATAOMNI_EXPORT_CANCELLED";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
  Csv,
  Json,
}

/// 导出选项。字段与前端 `ExportOptions` 一一对应——同一份选项既喂对话框里的
/// 预览，也喂这里真正写文件的代码，名字对不上就会让预览说一套、文件是另一套。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
  pub format: ExportFormat,
  pub delimiter: String,
  pub include_header: bool,
  /// NULL 在 CSV 里写成什么。JSON 有真正的 null，不受这个影响。
  pub null_text: String,
  /// UTF-8 BOM。Excel 不认没有 BOM 的 UTF-8 CSV，中文会读成乱码。
  pub byte_order_mark: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
  pub rows_written: u64,
  pub bytes_written: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
  pub rows_written: u64,
  pub bytes_written: u64,
  pub path: String,
}

/// 行分隔用 LF 而不是 RFC 4180 的 CRLF，与前端预览一致。
const LINE_SEPARATOR: &str = "\n";

/// U+FEFF。写成转义而不是字面字符——源码里的 BOM 肉眼不可见，改坏了也看不出来。
const UTF8_BOM: &str = "\u{feff}";

/// 把一份结果写成文件的状态机。
///
/// 泛型在 `W` 上，是为了让测试把字节写进 `Vec<u8>` 逐字节核对。文件路径、
/// 重命名、取消清理都在 [`export_query`] 那一层，这里只管「字节长什么样」。
pub struct ExportWriter<W: Write> {
  inner: W,
  options: ExportOptions,
  /// CSV 表头用原始列名；JSON 用去重后的键
  columns: Vec<String>,
  json_keys: Vec<String>,
  rows_written: u64,
  bytes_written: u64,
  /// CSV 的行分隔符要写在**下一行之前**：`lines.join('\n')` 不留行尾换行，
  /// 而流式写入没有「最后一行」可言，只能靠这个标志跳过第一次。
  wrote_anything: bool,
}

impl<W: Write> ExportWriter<W> {
  pub fn begin(inner: W, columns: Vec<String>, options: ExportOptions) -> Result<Self, QueryError> {
    let json_keys = unique_column_names(&columns);
    let mut writer = Self {
      inner,
      options,
      columns,
      json_keys,
      rows_written: 0,
      bytes_written: 0,
      wrote_anything: false,
    };

    if writer.options.byte_order_mark {
      writer.emit(UTF8_BOM)?;
    }
    match writer.options.format {
      ExportFormat::Csv => {
        if writer.options.include_header {
          let header = writer
            .columns
            .iter()
            .map(|name| csv_escape(name, &writer.options.delimiter))
            .collect::<Vec<_>>()
            .join(&writer.options.delimiter);
          writer.emit(&header)?;
          writer.wrote_anything = true;
        }
      }
      // 空结果要写成 `[]`，与 `JSON.stringify([], null, 2)` 一致。开头的 `[`
      // 留到第一行或收尾时再决定，就不用回头改已经写出去的字节。
      ExportFormat::Json => {}
    }
    Ok(writer)
  }

  pub fn write_row(&mut self, row: &QueryRow) -> Result<(), QueryError> {
    match self.options.format {
      ExportFormat::Csv => {
        let line = self
          .columns
          .iter()
          .map(|name| {
            let value = row.get(name).unwrap_or(&JsonValue::Null);
            csv_escape(&csv_field(value, &self.options.null_text), &self.options.delimiter)
          })
          .collect::<Vec<_>>()
          .join(&self.options.delimiter);
        if self.wrote_anything {
          self.emit(LINE_SEPARATOR)?;
        }
        self.emit(&line)?;
      }
      ExportFormat::Json => {
        let entries = self
          .json_keys
          .iter()
          .enumerate()
          .map(|(index, key)| {
            let source = self.columns.get(index).map(String::as_str).unwrap_or(key);
            (key.as_str(), json_field(row.get(source).unwrap_or(&JsonValue::Null)))
          })
          .collect::<Vec<_>>();
        // 记录在数组里缩进两格，所以它自身就从第 2 列开始渲染
        let rendered = render_object(&entries, 2);
        if self.wrote_anything {
          self.emit(",\n")?;
        } else {
          self.emit("[\n")?;
        }
        self.emit("  ")?;
        self.emit(&rendered)?;
      }
    }
    self.wrote_anything = true;
    self.rows_written += 1;
    Ok(())
  }

  pub fn finish(mut self) -> Result<(u64, u64), QueryError> {
    if self.options.format == ExportFormat::Json {
      if self.rows_written == 0 {
        self.emit("[]")?;
      } else {
        self.emit("\n]")?;
      }
    }
    self.inner.flush().map_err(|error| QueryError::message(error.to_string()))?;
    Ok((self.rows_written, self.bytes_written))
  }

  pub fn progress(&self) -> ExportProgress {
    ExportProgress { rows_written: self.rows_written, bytes_written: self.bytes_written }
  }

  fn emit(&mut self, text: &str) -> Result<(), QueryError> {
    self
      .inner
      .write_all(text.as_bytes())
      .map_err(|error| QueryError::message(format!("{EXPORT_WRITE_FAILED}: {error}")))?;
    self.bytes_written += text.len() as u64;
    Ok(())
  }
}

/// 按 `JSON.stringify(value, null, 2)` 的排版渲染。
///
/// 不用 `serde_json::to_string_pretty`，因为两处对不上：默认的 `Map` 是
/// BTreeMap，会把列按字母重排；而整数值的 f64 它写成 `1.0`，JS 写成 `1`。
/// 任何一处不一致，同一份结果的预览和文件就会长得不一样。
fn render_json(value: &JsonValue, indent: usize) -> String {
  match value {
    JsonValue::Null => "null".to_string(),
    JsonValue::Bool(flag) => flag.to_string(),
    JsonValue::Number(number) => number_text(number),
    JsonValue::String(text) => render_string(text),
    JsonValue::Array(items) => {
      if items.is_empty() {
        return "[]".to_string();
      }
      let inner = items
        .iter()
        .map(|item| format!("{}{}", pad(indent + 2), render_json(item, indent + 2)))
        .collect::<Vec<_>>()
        .join(",\n");
      format!("[\n{inner}\n{}]", pad(indent))
    }
    JsonValue::Object(fields) => {
      let entries =
        fields.iter().map(|(key, value)| (key.as_str(), value.clone())).collect::<Vec<_>>();
      render_object(&entries, indent)
    }
  }
}

/// 对象按给定的顺序渲染，而不是按键排序——导出的列序必须是 SELECT 的列序。
fn render_object(entries: &[(&str, JsonValue)], indent: usize) -> String {
  if entries.is_empty() {
    return "{}".to_string();
  }
  let inner = entries
    .iter()
    .map(|(key, value)| {
      format!("{}{}: {}", pad(indent + 2), render_string(key), render_json(value, indent + 2))
    })
    .collect::<Vec<_>>()
    .join(",\n");
  format!("{{\n{inner}\n{}}}", pad(indent))
}

fn render_string(text: &str) -> String {
  JsonValue::String(text.to_string()).to_string()
}

fn pad(width: usize) -> String {
  " ".repeat(width)
}

/// 一条 SELECT 完全可以返回两列都叫 `id`。JSON 用列名作键，重名会让后一列
/// 静默顶掉前一列——导出少一列而文件看上去完全正常，是最难发现的一种损坏。
pub fn unique_column_names(columns: &[String]) -> Vec<String> {
  let mut taken = std::collections::HashSet::new();
  let mut result = Vec::with_capacity(columns.len());
  for name in columns {
    if taken.insert(name.clone()) {
      result.push(name.clone());
      continue;
    }
    let mut suffix = 2;
    let mut candidate = format!("{name}_{suffix}");
    while !taken.insert(candidate.clone()) {
      suffix += 1;
      candidate = format!("{name}_{suffix}");
    }
    result.push(candidate);
  }
  result
}

pub fn csv_field(value: &JsonValue, null_text: &str) -> String {
  match tagged_parts(value) {
    None => match value {
      JsonValue::Null => null_text.to_string(),
      JsonValue::String(text) => text.clone(),
      JsonValue::Bool(flag) => flag.to_string(),
      JsonValue::Number(number) => number_text(number),
      other => other.to_string(),
    },
    Some(("binary", hex)) => format!("0x{hex}"),
    // 数据库里的 JSON 常带缩进换行。CSV 单元格放得下，但每一行都会撑开引号块，
    // 用表格软件打开后满屏是断行。压成一行更像「一个值」。
    Some(("json", text)) => serde_json::from_str::<JsonValue>(text)
      .map(|parsed| parsed.to_string())
      .unwrap_or_else(|_| text.to_string()),
    Some((_, text)) => text.to_string(),
  }
}

pub fn csv_escape(field: &str, delimiter: &str) -> String {
  let needs_quotes = (!delimiter.is_empty() && field.contains(delimiter))
    || field.contains('"')
    || field.contains('\n')
    || field.contains('\r');

  if needs_quotes {
    format!("\"{}\"", field.replace('"', "\"\""))
  } else {
    field.to_string()
  }
}

pub fn json_field(value: &JsonValue) -> JsonValue {
  match tagged_parts(value) {
    None => value.clone(),
    Some(("binary", hex)) => JsonValue::String(format!("0x{hex}")),
    Some(("json", text)) => serde_json::from_str::<JsonValue>(text)
      .unwrap_or_else(|_| JsonValue::String(text.to_string())),
    // bigint / decimal 写成字符串。JSON 数字在实践中就是 IEEE-754 双精度，
    // 消费方 JSON.parse 一个 20 位整数必然丢位；加引号才能无损往返。
    Some((_, text)) => JsonValue::String(text.to_string()),
  }
}

/// tagged value 的判定要与前端 `isTaggedResultValue` 完全一致：对象、
/// `type` 与 `value` 都是字符串。少一个条件，普通的 JSON 列就会被当成标记值。
fn tagged_parts(value: &JsonValue) -> Option<(&str, &str)> {
  let object = value.as_object()?;
  let value_type = object.get("type")?.as_str()?;
  let inner = object.get("value")?.as_str()?;
  Some((value_type, inner))
}

/// 按 JavaScript `String(number)` 的规则渲染。
///
/// 浮点在两侧的文本形态必须一致，否则对话框里的预览和文件里的内容会差一个
/// 尾巴：Rust 的 `{}` 给整数值的 f64 补 `.0`，而 JS 不补；指数形态的门槛和
/// 正号也不同。
fn number_text(number: &serde_json::Number) -> String {
  let Some(value) = number.as_f64() else {
    return number.to_string();
  };
  if !number.is_f64() {
    // 整数由 serde_json 原样保留，不经过 f64 就不会有精度问题
    return number.to_string();
  }
  if value == 0.0 {
    // JS 的 String(-0) 是 "0"
    return "0".to_string();
  }
  let magnitude = value.abs();
  if magnitude >= 1e21 || magnitude < 1e-6 {
    let text = format!("{value:e}");
    return match text.split_once('e') {
      Some((mantissa, exponent)) if !exponent.starts_with('-') => format!("{mantissa}e+{exponent}"),
      _ => text,
    };
  }
  let text = format!("{value}");
  text.strip_suffix(".0").map(str::to_string).unwrap_or(text)
}

/// 中途失败或被取消时留下的半份文件必须消失。
///
/// 取消是把整个导出 future 丢掉，之后没有任何代码会再碰到它，所以清理只能挂
/// 在 Drop 上。一份写到一半的 CSV 和一份完整的 CSV 在文件管理器里长得一模一样。
struct PartFile {
  path: PathBuf,
  armed: bool,
}

impl Drop for PartFile {
  fn drop(&mut self) {
    if self.armed {
      std::fs::remove_file(&self.path).ok();
    }
  }
}

/// 进度回报的最小间隔。按批次报会在窄表上变成每秒上千条 IPC 消息，
/// 而界面上一秒刷新几次就够了。
const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(120);

pub const EXPORT_CANCELLED_CODE: &str = "EXPORT_CANCELLED";

/// 流式执行 `sql` 并把结果写到 `path`。
///
/// 用的是**另开的一条连接**，不是编辑器那条 Session：一次整表导出可能跑几分钟，
/// 占着 Session 会让 SQL 编辑器在这期间完全按不动。代价是导出看不到 Session 里
/// 未提交的事务，而这对「导出这张表现在的样子」正是想要的语义。
pub async fn export_query<'a>(
  pool: impl Into<crate::services::query_executor::PoolRef<'a>>,
  sql: &str,
  path: &Path,
  options: ExportOptions,
  progress: &mut (dyn FnMut(ExportProgress) + Send),
  cancelled: &mut (dyn FnMut() -> bool + Send),
) -> Result<ExportSummary, QueryError> {
  if let Some(parent) = path.parent() {
    if !parent.as_os_str().is_empty() && !parent.exists() {
      return Err(QueryError::message(format!("{DIRECTORY_MISSING}: {}", parent.display())));
    }
  }

  let mut connection = SessionConnection::acquire(pool).await?;
  // 列名要在第一批数据之前就位——CSV 表头得先写出去。空列表就是数据库在说
  // 这条语句不返回结果集，此时一行都还没有被执行。
  let columns = connection
    .describe_columns(sql)
    .await?
    .into_iter()
    .map(|column| column.name)
    .collect::<Vec<_>>();
  if columns.is_empty() {
    return Err(QueryError::message(NON_QUERY_MESSAGE));
  }

  let part_path = part_path_for(path);
  let mut guard = PartFile { path: part_path.clone(), armed: true };
  let file = std::fs::File::create(&part_path).map_err(|error| {
    QueryError::message(format!("{FILE_CREATE_FAILED}: {} · {error}", part_path.display()))
  })?;
  let mut writer = ExportWriter::begin(BufWriter::new(file), columns, options)?;

  {
    let mut last_report = std::time::Instant::now();
    let writer = &mut writer;
    let mut sink = |batch: QueryResultBatch| -> Result<(), QueryError> {
      // 取消必须在这里问，不能靠 `tokio::select!` 把整个 future 丢掉：SQLite 的
      // 行常常是立刻就绪的，整趟导出可以在**一次 poll 里跑完**，期间运行时
      // 根本没机会轮询取消那一侧——按下取消要等导出自己结束才生效。
      if cancelled() {
        return Err(QueryError::with_code(EXPORT_CANCELLED_CODE, EXPORT_CANCELLED));
      }
      for row in &batch.rows {
        writer.write_row(row)?;
      }
      if last_report.elapsed() >= PROGRESS_INTERVAL {
        last_report = std::time::Instant::now();
        progress(writer.progress());
      }
      Ok(())
    };
    connection
      .execute_streaming(sql, StreamOptions::unlimited_export(DEFAULT_QUERY_BATCH_SIZE), &mut sink)
      .await?;
  }

  let (rows_written, bytes_written) = writer.finish()?;
  std::fs::rename(&part_path, path).map_err(|error| {
    QueryError::message(format!("{FILE_RENAME_FAILED}: {} · {error}", path.display()))
  })?;
  guard.armed = false;

  progress(ExportProgress { rows_written, bytes_written });
  Ok(ExportSummary { rows_written, bytes_written, path: path.to_string_lossy().to_string() })
}

/// 先写 `.part` 再改名，是为了让「文件存在」等于「导出完成」。
fn part_path_for(path: &Path) -> PathBuf {
  let mut name = path.file_name().map(|name| name.to_os_string()).unwrap_or_default();
  name.push(".part");
  path.with_file_name(name)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;
  use tauri_plugin_sql::DbPool;

  /// 前后端共用的语料。路径写死在编译期：运行时去找文件，文件没了测试会
  /// 「跳过」而不是变红，而一道不会红的门等于没有门。
  const CONFORMANCE_CORPUS: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/export-conformance.json"));

  #[derive(Deserialize)]
  struct ConformanceCorpus {
    cases: Vec<ConformanceCase>,
  }

  #[derive(Deserialize)]
  struct ConformanceCase {
    name: String,
    columns: Vec<String>,
    rows: Vec<QueryRow>,
    options: ExportOptions,
    expected: String,
  }

  fn render(columns: Vec<String>, rows: &[QueryRow], options: ExportOptions) -> String {
    let mut buffer = Vec::new();
    {
      let mut writer = ExportWriter::begin(&mut buffer, columns, options).expect("begin");
      for row in rows {
        writer.write_row(row).expect("write row");
      }
      writer.finish().expect("finish");
    }
    String::from_utf8(buffer).expect("utf-8")
  }

  #[test]
  fn matches_the_shared_conformance_corpus() {
    let corpus: ConformanceCorpus =
      serde_json::from_str(CONFORMANCE_CORPUS).expect("parse conformance corpus");
    assert!(corpus.cases.len() >= 16, "语料被删空了就不是门了");

    for case in &corpus.cases {
      let actual = render(case.columns.clone(), &case.rows, case.options.clone());
      assert_eq!(actual, case.expected, "语料 {} 对不上", case.name);
    }
  }

  /// `String(1.0)` 在 JS 里是 `"1"`，`String(-0)` 是 `"0"`。两者都过不了语料文件的
  /// JSON 往返（写出来就成了整数），只能在这里直接钉住。
  #[test]
  fn renders_floats_the_way_javascript_does() {
    let cases: &[(f64, &str)] = &[
      (1.0, "1"),
      (-0.0, "0"),
      (0.0, "0"),
      (1.5, "1.5"),
      (-2.25, "-2.25"),
      (1e21, "1e+21"),
      (1e-7, "1e-7"),
      (1e20, "100000000000000000000"),
      (0.000001, "0.000001"),
    ];
    for (value, expected) in cases {
      let number = serde_json::Number::from_f64(*value).expect("finite");
      assert_eq!(number_text(&number), *expected, "{value} 应渲染成 {expected}");
    }
  }

  #[test]
  fn a_partial_file_never_takes_the_target_name() {
    let dir = std::env::temp_dir().join(format!("dataomni-part-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let target = dir.join("export.csv");

    {
      let guard = PartFile { path: part_path_for(&target), armed: true };
      std::fs::write(&guard.path, "half a file").expect("write part");
      assert!(guard.path.exists());
    }

    assert!(!part_path_for(&target).exists(), "中途退出要把 .part 带走");
    assert!(!target.exists(), "半份内容不该以目标名字留下");
    std::fs::remove_dir_all(&dir).ok();
  }

  #[test]
  fn an_unparseable_json_column_is_written_as_the_original_text() {
    let value = json!({ "type": "json", "value": "{broken" });
    assert_eq!(csv_field(&value, ""), "{broken");
    assert_eq!(json_field(&value), json!("{broken"));
  }

  /// 判定少一个条件，一个普通的对象列就会被当成标记值。
  #[test]
  fn only_a_string_type_and_string_value_counts_as_a_tagged_value() {
    assert_eq!(tagged_parts(&json!({ "type": "bigint", "value": "1" })), Some(("bigint", "1")));
    assert_eq!(tagged_parts(&json!({ "type": "bigint", "value": 1 })), None);
    assert_eq!(tagged_parts(&json!({ "type": 1, "value": "1" })), None);
    assert_eq!(tagged_parts(&json!({ "value": "1" })), None);
    assert_eq!(tagged_parts(&json!("bigint")), None);
  }

  /// 导出要另开一条连接，所以内存库不行——那样每条连接是各自独立的一个库。
  /// 顺带这也让测试跑在真实的文件 IO 上。
  async fn seeded_pool(dir: &Path) -> DbPool {
    let file = dir.join("export.db");
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
      .max_connections(2)
      .connect(&format!("sqlite:{}?mode=rwc", file.display()))
      .await
      .expect("connect to SQLite");
    sqlx::query("CREATE TABLE notes (id INTEGER PRIMARY KEY, label TEXT, size REAL)")
      .execute(&pool)
      .await
      .expect("create table");
    for (id, label, size) in [(1, "first", 1.5), (2, "has,comma", 2.0), (3, "has\"quote", 3.25)] {
      sqlx::query("INSERT INTO notes (id, label, size) VALUES (?, ?, ?)")
        .bind(id)
        .bind(label)
        .bind(size)
        .execute(&pool)
        .await
        .expect("insert");
    }
    DbPool::Sqlite(pool)
  }

  fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dataomni-export-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
  }

  fn csv_options() -> ExportOptions {
    ExportOptions {
      format: ExportFormat::Csv,
      delimiter: ",".to_string(),
      include_header: true,
      null_text: String::new(),
      byte_order_mark: false,
    }
  }

  #[tokio::test]
  async fn streams_every_row_to_the_file_without_a_row_limit() {
    let dir = temp_dir("stream");
    let pool = seeded_pool(&dir).await;
    let target = dir.join("notes.csv");
    let mut reports = Vec::new();

    let summary = export_query(
      &pool,
      "SELECT id, label FROM notes ORDER BY id",
      &target,
      csv_options(),
      &mut |progress| reports.push(progress),
      &mut || false,
    )
    .await
    .expect("export");

    let contents = std::fs::read_to_string(&target).expect("read back");
    assert_eq!(contents, "id,label\n1,first\n2,\"has,comma\"\n3,\"has\"\"quote\"");
    assert_eq!(summary.rows_written, 3);
    assert_eq!(summary.bytes_written, contents.len() as u64);
    // 收尾那一次总要报，否则界面会停在最后一次节流之前的数字上
    assert_eq!(reports.last().map(|report| report.rows_written), Some(3));

    std::fs::remove_dir_all(&dir).ok();
  }

  /// 点一下「导出」不该让一条 DELETE 真把数据删掉。
  #[tokio::test]
  async fn refuses_a_statement_that_returns_no_rows_without_running_it() {
    let dir = temp_dir("nonquery");
    let pool = seeded_pool(&dir).await;
    let target = dir.join("notes.csv");

    let error =
      export_query(&pool, "DELETE FROM notes", &target, csv_options(), &mut |_| {}, &mut || false)
        .await
        .expect_err("should refuse");
    assert_eq!(error.message, NON_QUERY_MESSAGE);
    assert!(!target.exists(), "拒绝时不该留下文件");

    let DbPool::Sqlite(sqlite) = &pool else { panic!("expected SQLite") };
    let remaining: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM notes").fetch_one(sqlite).await.expect("count");
    assert_eq!(remaining, 3, "被拒绝的语句一行也不该执行");

    std::fs::remove_dir_all(&dir).ok();
  }

  /// 一份写到一半的 CSV 和一份完整的 CSV 在文件管理器里长得一模一样。
  #[tokio::test]
  async fn a_failed_export_leaves_no_file_behind() {
    let dir = temp_dir("failure");
    let pool = seeded_pool(&dir).await;
    let target = dir.join("notes.csv");

    let error = export_query(
      &pool,
      "SELECT * FROM no_such_table",
      &target,
      csv_options(),
      &mut |_| {},
      &mut || false,
    )
    .await
    .expect_err("should fail");
    assert!(error.message.contains("no_such_table"), "错误要来自数据库原话: {}", error.message);
    assert!(!target.exists());
    assert!(!part_path_for(&target).exists());

    std::fs::remove_dir_all(&dir).ok();
  }

  /// 按下取消要在导出跑完之前生效。
  ///
  /// 这条测试的第一版用 `tokio::select!` racing 一个 5 毫秒的计时器，结果
  /// 50 万行跑满 2.3 秒也没被取消——SQLite 的行立刻就绪，整趟导出在一次 poll
  /// 里跑完，运行时压根没机会轮询计时器那一侧。取消只能是协作式的。
  #[tokio::test]
  async fn cancelling_stops_the_export_and_removes_the_half_written_file() {
    let dir = temp_dir("cancel");
    let pool = seeded_pool(&dir).await;
    let target = dir.join("notes.csv");
    let many_rows =
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500000) \
       SELECT i AS id, 'row ' || i AS label FROM n";

    // 第一个批次照常写，第二个批次开始喊停——不是一开始就停，那样连
    // `.part` 文件都还没建起来，清理也就无从验起
    let mut batches_seen = 0;
    let mut cancelled = || {
      batches_seen += 1;
      batches_seen > 1
    };
    let started = std::time::Instant::now();

    let error = export_query(&pool, many_rows, &target, csv_options(), &mut |_| {}, &mut cancelled)
      .await
      .expect_err("should be cancelled");

    assert_eq!(error.code.as_deref(), Some(EXPORT_CANCELLED_CODE));
    assert!(started.elapsed() < std::time::Duration::from_secs(1), "取消没有真的打断这趟导出");
    assert!(!target.exists(), "取消后不该出现目标文件");
    assert!(!part_path_for(&target).exists(), "取消后 .part 也要消失");

    std::fs::remove_dir_all(&dir).ok();
  }

  /// 导出的既有行为：一行都没有时仍要写出表头，而不是留一个空文件。
  #[tokio::test]
  async fn an_empty_result_still_gets_its_header() {
    let dir = temp_dir("empty");
    let pool = seeded_pool(&dir).await;
    let target = dir.join("notes.csv");

    export_query(
      &pool,
      "SELECT id, label FROM notes WHERE 0",
      &target,
      csv_options(),
      &mut |_| {},
      &mut || false,
    )
    .await
    .expect("export");
    assert_eq!(std::fs::read_to_string(&target).expect("read back"), "id,label");

    std::fs::remove_dir_all(&dir).ok();
  }

  #[test]
  fn duplicate_column_names_get_a_suffix_that_is_not_already_taken() {
    let columns =
      ["id", "id", "id_2", "id"].iter().map(|name| name.to_string()).collect::<Vec<_>>();
    assert_eq!(unique_column_names(&columns), vec!["id", "id_2", "id_2_2", "id_3"]);
  }
}
