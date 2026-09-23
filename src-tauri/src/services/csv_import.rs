//! 把一个 CSV 文件写进一张表。
//!
//! 三件事决定了这个模块的形状：
//!
//! - **文件可能很大。** 行一行一行地读、一批一批地写，整个过程中内存里只有
//!   当前这一批。所以预览与导入是两趟：预览只读前几十行，导入从头再读一遍。
//! - **值一律当文本绑定，不拼进 SQL。** CSV 里的一个单引号足以把语句改写成
//!   别的意思。类型转换交给数据库：MySQL 与 SQLite 自己会转，PostgreSQL 不会，
//!   所以那边的每个占位符都套一层到目标类型的显式转换。
//! - **一行坏掉不该毁掉一整批。** 多行 INSERT 出错时数据库只说「这条语句失败」，
//!   不会说是哪一行；所以出错的那一批要退回保存点，再逐行重放一遍，
//!   代价只在真的含坏行的批次上付。
//! - **SQL Server 的类型转换错误不止毁掉一批。** `'abc'` 转 int（245）、坏日期
//!   （241）会让服务端把**整个事务**回滚，保存点跟着没了，后面的语句落在自动
//!   提交里。所以那边每一批先用 `TRY_CONVERT` 查一遍哪些值转不过去（它不报错），
//!   坏行当场记下、不进 INSERT；剩下那些错误（主键冲突、非空、截断）只终止
//!   语句本身，照常退回保存点。万一还是有错误带走了事务，就停下来说清楚，
//!   不在一个已经没有了的事务里接着写。

use crate::services::query_error::QueryError;
use crate::services::query_executor::SessionConnection;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// 分隔符不是一个字符。数据里带的是用户填的那一串
pub const CSV_DELIMITER_INVALID: &str = "DATAOMNI_CSV_DELIMITER_INVALID";
pub const CSV_PARSE_FAILED: &str = "DATAOMNI_CSV_PARSE_FAILED";
/// 一列都没映射到目标表——导进去什么都不会写
pub const CSV_NO_COLUMN_MAPPED: &str = "DATAOMNI_CSV_NO_COLUMN_MAPPED";
/// 列类型名不合法。数据是 `列名 · 填的类型`
pub const CSV_COLUMN_TYPE_INVALID: &str = "DATAOMNI_CSV_COLUMN_TYPE_INVALID";
/// 这个值转不成目标列的类型（SQL Server 在插入之前查出来的）。数据是
/// `列名 · 类型 · 值`
pub const CSV_VALUE_NOT_CONVERTIBLE: &str = "DATAOMNI_CSV_VALUE_NOT_CONVERTIBLE";
/// 服务端把导入的事务整个回滚了。数据是那条错误的原话
pub const CSV_TRANSACTION_LOST: &str = "DATAOMNI_CSV_TRANSACTION_LOST";
/// 这一行字段数不够。数据是 `实际字段数 · 要取第几个 · 映射到哪一列`
pub const CSV_ROW_TOO_SHORT: &str = "DATAOMNI_CSV_ROW_TOO_SHORT";
pub const FILE_OPEN_FAILED: &str = "DATAOMNI_FILE_OPEN_FAILED";
pub const FILE_READ_FAILED: &str = "DATAOMNI_FILE_READ_FAILED";

/// 预览读多少行。够看清映射对不对，又不至于为了看一眼而读完整个文件。
pub const PREVIEW_ROWS: usize = 50;

/// 最多记下多少条错误行。
///
/// 一个列错位的文件可以让每一行都失败；把几十万条错误原样带回界面，
/// 界面会先于数据库倒下。超过之后只计数。
pub const MAX_RECORDED_ERRORS: usize = 100;

/// 一条语句里最多放多少个占位符。
///
/// 三家都有上限：PostgreSQL 是 65535，MySQL 的 `?` 也是 65535，SQLite 较新的
/// 版本是 32766。取最小的那个，再按列数换算成「一条语句能放几行」。
const MAX_BIND_PARAMS: usize = 32766;

/// SQL Server 的两道上限：一次调用最多 2100 个参数，一个 `VALUES` 最多 1000 行
const SQL_SERVER_MAX_PARAMS: usize = 2100;
const SQL_SERVER_MAX_VALUES_ROWS: usize = 1000;

/// 进度回报的最小间隔，与导出同一个理由：按批报会变成每秒上千条 IPC 消息。
const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(120);

/// 暂停时的轮询间隔。暂停是人按出来的，百毫秒的反应延迟看不出来。
const PAUSE_POLL: std::time::Duration = std::time::Duration::from_millis(100);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvOptions {
  /// 单个字符。多字节分隔符不支持——csv 的记录边界判定就是按字节做的。
  pub delimiter: String,
  pub has_header: bool,
  /// 哪个字符串算 NULL。
  ///
  /// 空串表示「空字段就是 NULL」。CSV 本身分不开「空字符串」和「没有值」，
  /// 所以这件事只能由人来指定，不能猜——猜错的那一侧会在 NOT NULL 列上报错，
  /// 或者在唯一索引里变成另一个键。
  pub null_text: String,
}

impl CsvOptions {
  fn delimiter_byte(&self) -> Result<u8, QueryError> {
    let bytes = self.delimiter.as_bytes();
    match bytes {
      [single] => Ok(*single),
      _ => Err(QueryError::message(format!("{CSV_DELIMITER_INVALID}: {:?}", self.delimiter))),
    }
  }

  fn to_value(&self, field: &str) -> Option<String> {
    if field == self.null_text {
      None
    } else {
      Some(field.to_string())
    }
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RaggedRow {
  pub line: u64,
  pub fields: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreview {
  /// 实际用的分隔符。没指定时这里是嗅探出来的那个。
  pub delimiter: String,
  pub headers: Vec<String>,
  pub rows: Vec<Vec<String>>,
  pub total_bytes: u64,
  /// 文件还有更多行没读
  pub more: bool,
  /// 字段数与表头对不上的行。选错分隔符时这一项会立刻铺满。
  pub ragged: Vec<RaggedRow>,
}

/// 猜分隔符。
///
/// 判据是**字段数整齐**而不是「哪个字符出现得多」：一段中文里逗号可以比分号多，
/// 但用它切出来的行每行列数都不一样。逐个候选试切前几行，取「每行列数一致
/// 且多于一列」的那个；都不满足就回落到逗号，让预览把问题摆给人看。
pub fn sniff_delimiter(sample: &[u8]) -> u8 {
  const CANDIDATES: [u8; 4] = *b",;\t|";
  let mut best: Option<(u8, usize)> = None;

  for candidate in CANDIDATES {
    let mut reader = csv::ReaderBuilder::new()
      .delimiter(candidate)
      .has_headers(false)
      .flexible(true)
      .from_reader(sample);

    let mut counts = Vec::new();
    for record in reader.records().take(5) {
      match record {
        Ok(record) => counts.push(record.len()),
        // 读不下去就是这个候选切不动这个文件，直接判它出局
        Err(_) => {
          counts.clear();
          break;
        }
      }
    }

    // 采样是按字节截断的：不以换行结尾就说明最后一条记录是半行，列数天然
    // 对不上。整份读完的小文件没有这个问题，那时每一行都算数
    if !sample.ends_with(b"\n") && counts.len() > 1 {
      counts.pop();
    }

    let fields = counts.first().copied().unwrap_or(0);
    let consistent = fields > 1 && counts.iter().all(|count| *count == fields);
    if consistent && best.map(|(_, best_fields)| fields > best_fields).unwrap_or(true) {
      best = Some((candidate, fields));
    }
  }

  best.map(|(delimiter, _)| delimiter).unwrap_or(b',')
}

/// 读文件开头，给出表头与前几行。
///
/// `delimiter` 为 `None` 时先嗅探。表头那一行不在 `rows` 里——它是列名，
/// 不是数据；`has_header` 为假时列名是 `1`、`2`…，那是 CSV 里的序号，
/// 不是目标表的列名。
pub fn preview_csv(
  path: &Path,
  delimiter: Option<u8>,
  has_header: bool,
  max_rows: usize,
) -> Result<CsvPreview, QueryError> {
  let total_bytes = std::fs::metadata(path)
    .map_err(|error| {
      QueryError::message(format!("{FILE_READ_FAILED}: {} · {error}", path.display()))
    })?
    .len();

  let delimiter = match delimiter {
    Some(delimiter) => delimiter,
    None => {
      // 只读开头这一段来嗅探：几百 MB 的文件不该为了猜一个字符整份读进内存
      let sample = read_head(path, 64 * 1024)?;
      sniff_delimiter(&sample)
    }
  };

  let mut reader = csv::ReaderBuilder::new()
    .delimiter(delimiter)
    .has_headers(has_header)
    .flexible(true)
    .from_path(path)
    .map_err(|error| {
      QueryError::message(format!("{FILE_OPEN_FAILED}: {} · {error}", path.display()))
    })?;

  let headers = if has_header {
    reader.headers().map_err(csv_error)?.iter().map(|field| field.to_string()).collect::<Vec<_>>()
  } else {
    Vec::new()
  };

  let mut rows = Vec::new();
  let mut ragged = Vec::new();
  let mut more = false;
  for record in reader.records() {
    let record = record.map_err(csv_error)?;
    if rows.len() >= max_rows {
      more = true;
      break;
    }
    let fields = record.len();
    if !headers.is_empty() && fields != headers.len() {
      ragged.push(RaggedRow {
        line: record.position().map(|position| position.line()).unwrap_or(0),
        fields,
      });
    }
    rows.push(record.iter().map(|field| field.to_string()).collect::<Vec<_>>());
  }

  // 没有表头行时列名就是序号，宽度取样本里最宽的一行
  let headers = if headers.is_empty() {
    let width = rows.iter().map(|row| row.len()).max().unwrap_or(0);
    (1..=width).map(|index| index.to_string()).collect()
  } else {
    headers
  };

  Ok(CsvPreview {
    delimiter: (delimiter as char).to_string(),
    headers,
    rows,
    total_bytes,
    more,
    ragged,
  })
}

fn read_head(path: &Path, limit: usize) -> Result<Vec<u8>, QueryError> {
  use std::io::Read;
  let file = std::fs::File::open(path).map_err(|error| {
    QueryError::message(format!("{FILE_OPEN_FAILED}: {} · {error}", path.display()))
  })?;
  let mut head = Vec::new();
  std::io::BufReader::new(file).take(limit as u64).read_to_end(&mut head).map_err(|error| {
    QueryError::message(format!("{FILE_READ_FAILED}: {} · {error}", path.display()))
  })?;
  Ok(head)
}

fn csv_error(error: csv::Error) -> QueryError {
  QueryError::message(format!("{CSV_PARSE_FAILED}: {error}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransactionStrategy {
  /// 整个文件一个事务：要么整份进去，要么一行都没有。
  SingleTransaction,
  /// 每批一个事务：出错时前面提交过的批次留在库里。
  PerBatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorPolicy {
  /// 第一条错就停。
  Abort,
  /// 跳过错误行接着导，最后把它们列出来。
  Skip,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportColumn {
  /// CSV 里的第几列，从 0 起。
  pub source: usize,
  pub target: String,
  /// 目标列的声明类型，例如 `character varying(32)`。
  ///
  /// PostgreSQL 用它：那边把文本绑进 integer 列会直接报类型错，所以占位符
  /// 要写成 `$1::text::integer`。SQL Server 用它在插入前查哪些值转不过去。
  /// MySQL 与 SQLite 自己会转。
  pub target_type: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
  pub path: String,
  pub schema: Option<String>,
  pub table: String,
  pub csv: CsvOptions,
  pub columns: Vec<ImportColumn>,
  pub batch_size: usize,
  pub strategy: TransactionStrategy,
  pub on_error: ErrorPolicy,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
  pub rows_read: u64,
  pub rows_inserted: u64,
  pub rows_failed: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRowError {
  /// 文件里的行号。报「第 3 批第 7 行」等于让人自己去算。
  pub line: u64,
  pub message: String,
  /// 这一行的原始字段，照原样带回来——要改的是文件，不是数据库
  pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
  pub rows_read: u64,
  pub rows_inserted: u64,
  pub rows_failed: u64,
  pub errors: Vec<ImportRowError>,
  /// 错误行多到没有全记下来
  pub errors_truncated: bool,
  /// 这次导入有没有被整个退回去。
  ///
  /// 单事务失败或取消 = 一行都没进去；分批提交 = 前面的批次留在库里，
  /// 这个值是假，`rows_inserted` 才是真正进去的行数。
  pub rolled_back: bool,
  pub cancelled: bool,
}

/// 生成 SQL 时用的方言。
///
/// 由**连接本身**决定，不看请求里的类型字段：后者对不上时生成的是一条
/// 能发出去、到了数据库才炸的语句，而错误信息完全不指向真正的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dialect {
  Sqlite,
  MySql,
  Postgres,
  SqlServer,
}

impl Dialect {
  fn of(connection: &SessionConnection) -> Self {
    match connection {
      SessionConnection::Sqlite(_) => Self::Sqlite,
      SessionConnection::MySql(_) => Self::MySql,
      SessionConnection::Postgres(_) => Self::Postgres,
      SessionConnection::SqlServer(_) => Self::SqlServer,
      SessionConnection::Oracle(_) => {
        unreachable!("import_csv refuses Oracle before it picks a dialect")
      }
    }
  }

  fn quote(&self, identifier: &str) -> String {
    if *self == Self::SqlServer {
      return format!("[{}]", identifier.replace(']', "]]"));
    }
    let quote = if *self == Self::MySql { '`' } else { '"' };
    let escaped = identifier.replace(quote, &format!("{quote}{quote}"));
    format!("{quote}{escaped}{quote}")
  }

  /// T-SQL 里单独的 `BEGIN` 是语句块
  fn begin(&self) -> &'static str {
    if *self == Self::SqlServer {
      "BEGIN TRANSACTION"
    } else {
      "BEGIN"
    }
  }

  fn savepoint(&self, name: &str) -> String {
    if *self == Self::SqlServer {
      format!("SAVE TRANSACTION {name}")
    } else {
      format!("SAVEPOINT {name}")
    }
  }

  fn rollback_to(&self, name: &str) -> String {
    if *self == Self::SqlServer {
      format!("ROLLBACK TRANSACTION {name}")
    } else {
      format!("ROLLBACK TO SAVEPOINT {name}")
    }
  }

  /// SQL Server 没有释放保存点这回事，保存点随事务结束
  fn release(&self, name: &str) -> Option<String> {
    (*self != Self::SqlServer).then(|| format!("RELEASE SAVEPOINT {name}"))
  }

  /// 一条语句放几行：受占位符上限约束，SQL Server 另有 `VALUES` 的行数上限
  fn rows_per_statement(&self, batch_size: usize, columns: usize) -> usize {
    if columns == 0 {
      return 0;
    }
    let (params, rows) = match self {
      Self::SqlServer => (SQL_SERVER_MAX_PARAMS, SQL_SERVER_MAX_VALUES_ROWS),
      _ => (MAX_BIND_PARAMS, usize::MAX),
    };
    batch_size.clamp(1, (params / columns).clamp(1, rows))
  }
}

async fn savepoint(connection: &mut SessionConnection, name: &str) -> Result<(), QueryError> {
  let sql = Dialect::of(connection).savepoint(name);
  connection.execute_unprepared(&sql).await.map(|_| ())
}

async fn rollback_to(connection: &mut SessionConnection, name: &str) -> Result<(), QueryError> {
  let sql = Dialect::of(connection).rollback_to(name);
  connection.execute_unprepared(&sql).await.map(|_| ())
}

async fn release(connection: &mut SessionConnection, name: &str) -> Result<(), QueryError> {
  match Dialect::of(connection).release(name) {
    Some(sql) => connection.execute_unprepared(&sql).await.map(|_| ()),
    None => Ok(()),
  }
}

/// 一条语句失败之后，事务还在不在。
///
/// 只有 SQL Server 报得出（每条语句之后问 `@@TRANCOUNT`）；另外三家的语句
/// 错误不会结束事务，PostgreSQL 的「废止」由退回保存点解除。不在了就停下：
/// 接着往下写会落在自动提交里，而界面仍会说「单事务，出错全部回滚」。
fn ensure_transaction(
  connection: &SessionConnection,
  error: &QueryError,
) -> Result<(), QueryError> {
  match connection.observed_transaction() {
    Some(state) if !state.in_transaction() => {
      Err(QueryError::message(format!("{CSV_TRANSACTION_LOST}: {}", error.message)))
    }
    _ => Ok(()),
  }
}

/// 不用查转换的类型：文本进文本不会转换失败（太长是截断，只终止语句）
fn converts_without_failing(target_type: &str) -> bool {
  let token = target_type.split(['(', ' ']).next().unwrap_or("").to_ascii_lowercase();
  matches!(token.as_str(), "char" | "varchar" | "nchar" | "nvarchar" | "text" | "ntext" | "sysname")
}

/// SQL Server：这一批里哪些值转不成目标类型。返回 `(第几行, 第几列)`，每行只报
/// 第一个转不过去的列。`None` 表示这张表的映射里没有需要查的列。
///
/// 用 `TRY_CONVERT`：转不过去给 NULL，而不是像 INSERT 那样报 245 把事务带走。
/// 参数和 INSERT 是同一份，排列也一样，所以不会超过参数上限。
fn conversion_check(columns: &[ImportColumn], rows: usize) -> Result<Option<String>, QueryError> {
  let checked: Vec<(usize, &ImportColumn)> = columns
    .iter()
    .enumerate()
    .filter(|(_, column)| !converts_without_failing(&column.target_type))
    .collect();
  if checked.is_empty() {
    return Ok(None);
  }
  for (_, column) in &checked {
    if !valid_type_name(&column.target_type) {
      return Err(QueryError::message(format!(
        "{CSV_COLUMN_TYPE_INVALID}: {} · {}",
        column.target, column.target_type
      )));
    }
  }
  let width = columns.len();
  let tuples = (0..rows)
    .map(|row| {
      let values =
        (0..width).map(|column| format!("@P{}", row * width + column + 1)).collect::<Vec<_>>();
      format!("({row}, {})", values.join(", "))
    })
    .collect::<Vec<_>>()
    .join(", ");
  let aliases = (0..width).map(|column| format!("c{column}")).collect::<Vec<_>>().join(", ");
  let fails = |index: usize, column: &ImportColumn| {
    format!("(v.c{index} IS NOT NULL AND TRY_CONVERT({}, v.c{index}) IS NULL)", column.target_type)
  };
  let first_bad = checked
    .iter()
    .map(|(index, column)| format!("WHEN {} THEN {index}", fails(*index, column)))
    .collect::<Vec<_>>()
    .join(" ");
  let any_bad =
    checked.iter().map(|(index, column)| fails(*index, column)).collect::<Vec<_>>().join(" OR ");
  Ok(Some(format!(
    "SELECT v.i AS row_index, CASE {first_bad} END AS column_index \
     FROM (VALUES {tuples}) AS v(i, {aliases}) WHERE {any_bad} ORDER BY v.i"
  )))
}

/// 目标类型里允许出现的字符。
///
/// 这个字符串会被拼进 SQL——它来自界面，而界面上的列类型来自目录，但「来自
/// 目录」不是可以省掉校验的理由：一个改过的请求就能从这里写进任意 SQL。
/// 放行的是真实类型名里会出现的那些：`character varying(32)`、`numeric(10,2)`、
/// `text[]`、`public.my_enum`。
fn valid_type_name(name: &str) -> bool {
  !name.is_empty()
    && name.len() <= 128
    && name.chars().all(|c| {
      c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '(' | ')' | ',' | '[' | ']' | '.')
    })
}

/// 一条多行 INSERT。返回语句本身与它能放下的行数。
fn build_insert(
  dialect: Dialect,
  schema: Option<&str>,
  table: &str,
  columns: &[ImportColumn],
  rows: usize,
) -> Result<String, QueryError> {
  let qualified = match schema {
    Some(schema) if !schema.is_empty() => {
      format!("{}.{}", dialect.quote(schema), dialect.quote(table))
    }
    _ => dialect.quote(table),
  };
  let names =
    columns.iter().map(|column| dialect.quote(&column.target)).collect::<Vec<_>>().join(", ");

  let mut tuples = Vec::with_capacity(rows);
  let mut next = 1usize;
  for _ in 0..rows {
    let mut placeholders = Vec::with_capacity(columns.len());
    for column in columns {
      match dialect {
        Dialect::Postgres => {
          if !valid_type_name(&column.target_type) {
            return Err(QueryError::message(format!(
              "{CSV_COLUMN_TYPE_INVALID}: {} · {}",
              column.target, column.target_type
            )));
          }
          // 先钉成 text 再转到目标类型：只写 `$1::integer` 的话 PostgreSQL 会把
          // 参数本身推断成 integer，而我们绑进去的是一串文本
          placeholders.push(format!("${next}::text::{}", column.target_type));
        }
        Dialect::SqlServer => placeholders.push(format!("@P{next}")),
        _ => placeholders.push("?".to_string()),
      }
      next += 1;
    }
    tuples.push(format!("({})", placeholders.join(", ")));
  }

  Ok(format!("INSERT INTO {qualified} ({names}) VALUES {}", tuples.join(", ")))
}

/// 从一条 CSV 记录里取出要绑定的值。
///
/// 字段不够是**这一行坏了**，不是「缺的当 NULL」：短一格通常意味着这一行
/// 的所有值都往前挪了一位，当 NULL 补上会把错位的数据静静写进库里。
fn row_params(
  record: &csv::StringRecord,
  columns: &[ImportColumn],
  options: &CsvOptions,
) -> Result<Vec<Option<String>>, String> {
  let mut params = Vec::with_capacity(columns.len());
  for column in columns {
    match record.get(column.source) {
      Some(field) => params.push(options.to_value(field)),
      None => {
        return Err(format!(
          "{CSV_ROW_TOO_SHORT}: {} · {} · {}",
          record.len(),
          column.source + 1,
          column.target
        ))
      }
    }
  }
  Ok(params)
}

struct Batch {
  records: Vec<csv::StringRecord>,
  lines: Vec<u64>,
  params: Vec<Option<String>>,
}

/// 把一个 CSV 文件导入一张表。
///
/// 用的是另开的一条连接，与导出同一个理由：一次导入可能跑几分钟，占着编辑器
/// 那条 Session 会让 SQL 编辑器在这期间完全按不动。
pub async fn import_csv<'a>(
  pool: impl Into<crate::services::query_executor::PoolRef<'a>>,
  request: &ImportRequest,
  progress: &mut (dyn FnMut(ImportProgress) + Send),
  cancelled: &mut (dyn FnMut() -> bool + Send),
  paused: &mut (dyn FnMut() -> bool + Send),
) -> Result<ImportSummary, QueryError> {
  if request.columns.is_empty() {
    return Err(QueryError::message(CSV_NO_COLUMN_MAPPED));
  }

  let delimiter = request.csv.delimiter_byte()?;
  let path = std::path::PathBuf::from(&request.path);
  let mut reader = csv::ReaderBuilder::new()
    .delimiter(delimiter)
    .has_headers(request.csv.has_header)
    .flexible(true)
    .from_path(&path)
    .map_err(|error| {
      QueryError::message(format!("{FILE_OPEN_FAILED}: {} · {error}", path.display()))
    })?;

  let mut connection = SessionConnection::acquire(pool).await?;
  if matches!(connection, SessionConnection::Oracle(_)) {
    return Err(crate::services::oracle::unsupported("import"));
  }
  let dialect = Dialect::of(&connection);
  let per_statement = dialect.rows_per_statement(request.batch_size, request.columns.len());
  let batch_sql = build_insert(
    dialect,
    request.schema.as_deref(),
    &request.table,
    &request.columns,
    per_statement,
  )?;
  let single_sql =
    build_insert(dialect, request.schema.as_deref(), &request.table, &request.columns, 1)?;

  let mut state = ImportState {
    rows_read: 0,
    rows_inserted: 0,
    rows_failed: 0,
    errors: Vec::new(),
    errors_truncated: false,
  };
  let mut last_report = std::time::Instant::now();
  let single = request.strategy == TransactionStrategy::SingleTransaction;

  if single {
    connection.execute_unprepared(dialect.begin()).await?;
  }

  let mut batch = Batch {
    records: Vec::with_capacity(per_statement),
    lines: Vec::with_capacity(per_statement),
    params: Vec::with_capacity(per_statement * request.columns.len()),
  };
  let mut aborted = false;
  let mut was_cancelled = false;

  'reading: for record in reader.records() {
    let record = match record {
      Ok(record) => record,
      // 读不下去了（引号没闭合、不是 UTF-8）。两种错误策略在这里是同一个
      // 结果：`on_error` 说的是「数据库拒收的行」怎么办，而这是**文件读不下去**，
      // 后面的行号全都对不上，跳过它继续读只会把错误堆成一片
      Err(error) => {
        state.fail(0, csv_error(error).to_string(), Vec::new());
        aborted = true;
        break 'reading;
      }
    };

    let line = record.position().map(|position| position.line()).unwrap_or(0);
    state.rows_read += 1;

    match row_params(&record, &request.columns, &request.csv) {
      Ok(params) => {
        batch.params.extend(params);
        batch.lines.push(line);
        batch.records.push(record);
      }
      Err(message) => {
        state.fail(line, message, record.iter().map(|field| field.to_string()).collect());
        if request.on_error == ErrorPolicy::Abort {
          aborted = true;
          break 'reading;
        }
      }
    }

    if batch.records.len() < per_statement {
      continue;
    }

    match flush(
      &mut connection,
      request,
      &batch_sql,
      &single_sql,
      per_statement,
      &mut batch,
      &mut state,
    )
    .await?
    {
      Flushed::Ok => {}
      Flushed::Aborted => {
        aborted = true;
        break 'reading;
      }
    }

    if cancelled() {
      was_cancelled = true;
      break 'reading;
    }
    while paused() {
      if cancelled() {
        was_cancelled = true;
        break 'reading;
      }
      tokio::time::sleep(PAUSE_POLL).await;
    }
    if last_report.elapsed() >= PROGRESS_INTERVAL {
      last_report = std::time::Instant::now();
      progress(state.progress());
    }
  }

  if !aborted && !was_cancelled && !batch.records.is_empty() {
    if let Flushed::Aborted = flush(
      &mut connection,
      request,
      &batch_sql,
      &single_sql,
      per_statement,
      &mut batch,
      &mut state,
    )
    .await?
    {
      aborted = true;
    }
  }

  // 单事务下「出错」与「取消」都意味着一行都不该留下；分批提交时前面的批次
  // 已经在库里了，回滚只能撤掉当前这一批
  let rolled_back = single && (aborted || was_cancelled);
  if single {
    if rolled_back {
      connection.execute_unprepared("ROLLBACK").await?;
      state.rows_inserted = 0;
    } else {
      connection.execute_unprepared("COMMIT").await?;
    }
  }

  let summary = ImportSummary {
    rows_read: state.rows_read,
    rows_inserted: state.rows_inserted,
    rows_failed: state.rows_failed,
    errors: state.errors,
    errors_truncated: state.errors_truncated,
    rolled_back,
    cancelled: was_cancelled,
  };
  progress(ImportProgress {
    rows_read: summary.rows_read,
    rows_inserted: summary.rows_inserted,
    rows_failed: summary.rows_failed,
  });
  Ok(summary)
}

struct ImportState {
  rows_read: u64,
  rows_inserted: u64,
  rows_failed: u64,
  errors: Vec<ImportRowError>,
  errors_truncated: bool,
}

impl ImportState {
  fn fail(&mut self, line: u64, message: String, values: Vec<String>) {
    self.rows_failed += 1;
    if self.errors.len() < MAX_RECORDED_ERRORS {
      self.errors.push(ImportRowError { line, message, values });
    } else {
      self.errors_truncated = true;
    }
  }

  fn progress(&self) -> ImportProgress {
    ImportProgress {
      rows_read: self.rows_read,
      rows_inserted: self.rows_inserted,
      rows_failed: self.rows_failed,
    }
  }
}

enum Flushed {
  Ok,
  Aborted,
}

/// 写出一批，必要时逐行重放。
///
/// 保存点是这里的关键：多行 INSERT 失败时数据库只说「这条语句失败」，
/// 不说是哪一行。退回保存点之后逐行再发一遍，坏的那几行自己会暴露出来，
/// 而这份代价只在真的含坏行的批次上付。
///
/// PostgreSQL 还额外需要它：一条语句报错之后整个事务就废了，不退回保存点
/// 连接下来的好行都发不出去。
async fn flush(
  connection: &mut SessionConnection,
  request: &ImportRequest,
  batch_sql: &str,
  single_sql: &str,
  per_statement: usize,
  batch: &mut Batch,
  state: &mut ImportState,
) -> Result<Flushed, QueryError> {
  let dialect = Dialect::of(connection);
  if dialect == Dialect::SqlServer
    && !drop_unconvertible_rows(connection, request, batch, state).await?
  {
    batch.records.clear();
    batch.lines.clear();
    batch.params.clear();
    return Ok(Flushed::Aborted);
  }
  let rows = batch.records.len();
  if rows == 0 {
    return Ok(Flushed::Ok);
  }
  let per_batch = request.strategy == TransactionStrategy::PerBatch;
  if per_batch {
    connection.execute_unprepared(dialect.begin()).await?;
  }

  savepoint(connection, "dataomni_import").await?;
  // 最后一批通常不满，占位符数量对不上整批那条语句，得按实际行数重拼一条
  let tail_sql;
  let sql = if rows == per_statement {
    batch_sql
  } else {
    tail_sql =
      build_insert(dialect, request.schema.as_deref(), &request.table, &request.columns, rows)?;
    &tail_sql
  };

  let outcome = connection.execute_with_params(sql, &batch.params).await;
  let mut aborted = false;

  match outcome {
    Ok(_) => {
      release(connection, "dataomni_import").await?;
      state.rows_inserted += rows as u64;
    }
    Err(batch_error) => {
      ensure_transaction(connection, &batch_error)?;
      rollback_to(connection, "dataomni_import").await?;
      if request.on_error == ErrorPolicy::Abort {
        // 整批一起失败时报不出是哪一行，所以停下来之前也要逐行找一遍——
        // 「第 12000 行的日期格式不对」和「这一批失败了」是两种可用性
        let culprit = find_culprit(connection, single_sql, request, batch, state).await?;
        if !culprit {
          state.fail(
            batch.lines.first().copied().unwrap_or(0),
            batch_error.to_string(),
            Vec::new(),
          );
        }
        aborted = true;
      } else {
        replay(connection, single_sql, request, batch, state).await?;
      }
      release(connection, "dataomni_import").await?;
    }
  }

  if per_batch {
    connection.execute_unprepared(if aborted { "ROLLBACK" } else { "COMMIT" }).await?;
  }

  batch.records.clear();
  batch.lines.clear();
  batch.params.clear();

  Ok(if aborted { Flushed::Aborted } else { Flushed::Ok })
}

/// SQL Server：先把转不过去的行挑出来记成失败，不让它们进 INSERT。
///
/// 返回 false 表示按「出错即中止」该停了——此时这一批一行都没写。
async fn drop_unconvertible_rows(
  connection: &mut SessionConnection,
  request: &ImportRequest,
  batch: &mut Batch,
  state: &mut ImportState,
) -> Result<bool, QueryError> {
  let SessionConnection::SqlServer(sql_server) = connection else {
    return Ok(true);
  };
  let rows = batch.records.len();
  let Some(check) = conversion_check(&request.columns, rows)? else {
    return Ok(true);
  };
  let params: Vec<serde_json::Value> = batch
    .params
    .iter()
    .map(|value| value.clone().map_or(serde_json::Value::Null, Into::into))
    .collect();
  let bad = sql_server.select(&check, &params).await?;
  if bad.is_empty() {
    return Ok(true);
  }

  let width = request.columns.len();
  let mut rejected = vec![false; rows];
  for found in &bad {
    let (Some(row), Some(column)) = (found["row_index"].as_u64(), found["column_index"].as_u64())
    else {
      continue;
    };
    let (row, column) = (row as usize, column as usize);
    let (Some(record), Some(target)) = (batch.records.get(row), request.columns.get(column)) else {
      continue;
    };
    let value = batch.params.get(row * width + column).cloned().flatten().unwrap_or_default();
    state.fail(
      batch.lines.get(row).copied().unwrap_or(0),
      format!("{CSV_VALUE_NOT_CONVERTIBLE}: {} · {} · {value}", target.target, target.target_type),
      record.iter().map(|field| field.to_string()).collect(),
    );
    rejected[row] = true;
    if request.on_error == ErrorPolicy::Abort {
      return Ok(false);
    }
  }

  let mut kept = Batch {
    records: Vec::with_capacity(rows),
    lines: Vec::with_capacity(rows),
    params: Vec::with_capacity(batch.params.len()),
  };
  for (row, reject) in rejected.into_iter().enumerate() {
    if reject {
      continue;
    }
    kept.records.push(batch.records[row].clone());
    kept.lines.push(batch.lines[row]);
    kept.params.extend_from_slice(&batch.params[row * width..(row + 1) * width]);
  }
  *batch = kept;
  Ok(true)
}

/// 逐行重放，坏行记下来，好行留在库里。
async fn replay(
  connection: &mut SessionConnection,
  single_sql: &str,
  request: &ImportRequest,
  batch: &Batch,
  state: &mut ImportState,
) -> Result<(), QueryError> {
  let width = request.columns.len();
  for (index, record) in batch.records.iter().enumerate() {
    let params = &batch.params[index * width..(index + 1) * width];
    savepoint(connection, "dataomni_row").await?;
    match connection.execute_with_params(single_sql, params).await {
      Ok(_) => {
        release(connection, "dataomni_row").await?;
        state.rows_inserted += 1;
      }
      Err(error) => {
        ensure_transaction(connection, &error)?;
        rollback_to(connection, "dataomni_row").await?;
        release(connection, "dataomni_row").await?;
        state.fail(
          batch.lines.get(index).copied().unwrap_or(0),
          error.to_string(),
          record.iter().map(|field| field.to_string()).collect(),
        );
      }
    }
  }
  Ok(())
}

/// 只为了找出是哪一行错了，找到就停——好行不留下，因为这是要中止的那条路。
async fn find_culprit(
  connection: &mut SessionConnection,
  single_sql: &str,
  request: &ImportRequest,
  batch: &Batch,
  state: &mut ImportState,
) -> Result<bool, QueryError> {
  let width = request.columns.len();
  for (index, record) in batch.records.iter().enumerate() {
    let params = &batch.params[index * width..(index + 1) * width];
    savepoint(connection, "dataomni_probe").await?;
    let outcome = connection.execute_with_params(single_sql, params).await;
    if let Err(error) = &outcome {
      ensure_transaction(connection, error)?;
    }
    rollback_to(connection, "dataomni_probe").await?;
    release(connection, "dataomni_probe").await?;
    if let Err(error) = outcome {
      state.fail(
        batch.lines.get(index).copied().unwrap_or(0),
        error.to_string(),
        record.iter().map(|field| field.to_string()).collect(),
      );
      return Ok(true);
    }
  }
  Ok(false)
}

#[cfg(test)]
mod tests {
  use super::*;
  use sqlx::sqlite::SqlitePoolOptions;
  use sqlx::{Row, Sqlite};
  use tauri_plugin_sql::DbPool;

  #[test]
  fn the_delimiter_is_the_one_that_cuts_even_rows() {
    // 逗号比分号多，但用逗号切出来每行列数都不一样
    let sample = b"name;city\n\xe5\xbc\xa0,\xe4\xb8\x89;\xe5\x8c\x97\xe4\xba\xac\nbob;NY\n";
    assert_eq!(sniff_delimiter(sample), b';');
  }

  #[test]
  fn the_usual_delimiters_are_all_recognised() {
    assert_eq!(sniff_delimiter(b"a,b,c\n1,2,3\n"), b',');
    assert_eq!(sniff_delimiter(b"a\tb\tc\n1\t2\t3\n"), b'\t');
    assert_eq!(sniff_delimiter(b"a|b|c\n1|2|3\n"), b'|');
  }

  #[test]
  fn a_single_column_file_falls_back_to_comma() {
    // 一列的文件里没有分隔符可言；回落到逗号，让预览把「只有一列」摆出来
    assert_eq!(sniff_delimiter(b"name\nalice\nbob\n"), b',');
  }

  #[test]
  fn a_truncated_last_line_does_not_decide_the_delimiter() {
    // 采样按字节截断，最后一行几乎总是半截；它参与判断就会把正确的候选判出局。
    // 用制表符来验：回落值是逗号，所以拿逗号做这条断言无论对错都会绿
    assert_eq!(sniff_delimiter(b"a\tb\tc\n1\t2\t3\n4\t5"), b'\t');
  }

  #[test]
  fn a_complete_short_file_keeps_every_line_in_the_vote() {
    // 以换行结尾说明没被截断，这时丢掉最后一行等于放过真正的参差
    assert_eq!(sniff_delimiter(b"a\tb\n1\t2\n"), b'\t');
  }

  #[test]
  fn a_statement_never_exceeds_the_bind_limit() {
    // 超了之后数据库拒绝的是整条语句，报的错和 CSV 一点关系都没有
    assert_eq!(Dialect::MySql.rows_per_statement(1000, 3), 1000);
    assert_eq!(Dialect::MySql.rows_per_statement(1000, 200), MAX_BIND_PARAMS / 200);
    // 列多到一行就撑满时也得能发出去一行
    assert_eq!(Dialect::MySql.rows_per_statement(1000, 40_000), 1);
    // SQL Server：2100 个参数，一个 VALUES 最多 1000 行
    assert_eq!(Dialect::SqlServer.rows_per_statement(5000, 1), 1000);
    assert_eq!(Dialect::SqlServer.rows_per_statement(1000, 3), 700);
    assert_eq!(Dialect::SqlServer.rows_per_statement(1000, 3000), 1);
  }

  #[test]
  fn sql_server_checks_conversions_only_where_they_can_fail() {
    let columns = vec![
      ImportColumn { source: 0, target: "id".into(), target_type: "int".into() },
      ImportColumn { source: 1, target: "name".into(), target_type: "nvarchar(32)".into() },
      ImportColumn { source: 2, target: "at".into(), target_type: "datetime2(3)".into() },
    ];
    let sql = conversion_check(&columns, 2).expect("builds").expect("has checked columns");
    assert!(sql.contains("VALUES (0, @P1, @P2, @P3), (1, @P4, @P5, @P6)"), "{sql}");
    assert!(sql.contains("TRY_CONVERT(int, v.c0)"), "{sql}");
    assert!(sql.contains("TRY_CONVERT(datetime2(3), v.c2)"), "{sql}");
    assert!(!sql.contains("v.c1)"), "文本列不用查: {sql}");

    let text_only =
      vec![ImportColumn { source: 0, target: "n".into(), target_type: "varchar(max)".into() }];
    assert_eq!(conversion_check(&text_only, 3).expect("builds"), None);

    let injected = vec![ImportColumn {
      source: 0,
      target: "x".into(),
      target_type: "int); DROP TABLE t; --".into(),
    }];
    assert!(conversion_check(&injected, 1).is_err(), "类型名会拼进语句，要校验");
  }

  #[test]
  fn only_real_type_names_go_into_the_statement() {
    assert!(valid_type_name("integer"));
    assert!(valid_type_name("character varying(32)"));
    assert!(valid_type_name("numeric(10,2)"));
    assert!(valid_type_name("text[]"));
    assert!(valid_type_name("public.my_enum"));
    // 这个字段会被拼进 SQL，所以它是一处注入面，不是一处显示文本
    assert!(!valid_type_name("integer; DROP TABLE t --"));
    assert!(!valid_type_name("text'"));
    assert!(!valid_type_name(""));
  }

  fn columns() -> Vec<ImportColumn> {
    vec![
      ImportColumn { source: 0, target: "id".into(), target_type: "integer".into() },
      ImportColumn { source: 1, target: "name".into(), target_type: "text".into() },
    ]
  }

  #[test]
  fn postgres_pins_every_value_to_text_before_casting() {
    // 只写 $1::integer 的话 PostgreSQL 会把参数本身推断成 integer，
    // 而绑进去的是一串文本
    let sql = build_insert(Dialect::Postgres, Some("public"), "t", &columns(), 2).expect("builds");
    assert_eq!(
      sql,
      r#"INSERT INTO "public"."t" ("id", "name") VALUES ($1::text::integer, $2::text::text), ($3::text::integer, $4::text::text)"#
    );
  }

  #[test]
  fn mysql_and_sqlite_let_the_database_convert() {
    let sql = build_insert(Dialect::MySql, None, "t", &columns(), 2).expect("builds");
    assert_eq!(sql, "INSERT INTO `t` (`id`, `name`) VALUES (?, ?), (?, ?)");
    let sql = build_insert(Dialect::Sqlite, None, "t", &columns(), 1).expect("builds");
    assert_eq!(sql, r#"INSERT INTO "t" ("id", "name") VALUES (?, ?)"#);
  }

  #[test]
  fn a_quote_in_a_table_name_cannot_end_the_quoting() {
    let sql = build_insert(
      Dialect::Postgres,
      None,
      r#"we"ird"#,
      &[ImportColumn { source: 0, target: "a".into(), target_type: "text".into() }],
      1,
    )
    .expect("builds");
    assert!(sql.starts_with(r#"INSERT INTO "we""ird""#), "{sql}");
  }

  fn write_csv(name: &str, contents: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("dataomni-csv-{name}.csv"));
    std::fs::write(&path, contents).expect("write fixture");
    path
  }

  #[test]
  fn the_preview_keeps_quoted_commas_and_newlines_in_one_field() {
    let path = write_csv("quoted", "id,note\n1,\"a,b\"\n2,\"line1\nline2\"\n");
    let preview = preview_csv(&path, None, true, 10).expect("preview");
    assert_eq!(preview.delimiter, ",");
    assert_eq!(preview.headers, vec!["id", "note"]);
    assert_eq!(preview.rows, vec![vec!["1", "a,b"], vec!["2", "line1\nline2"]]);
    assert!(preview.ragged.is_empty());
    assert!(!preview.more);
  }

  #[test]
  fn the_preview_points_at_rows_whose_field_count_is_off() {
    // 选错分隔符时这一项会立刻铺满，那正是要给人看的信号
    let path = write_csv("ragged", "id,name\n1,a\n2,a,b\n3\n");
    let preview = preview_csv(&path, Some(b','), true, 10).expect("preview");
    assert_eq!(preview.ragged.iter().map(|row| row.fields).collect::<Vec<_>>(), vec![3, 1]);
  }

  #[test]
  fn without_a_header_the_columns_are_numbered_and_no_row_is_eaten() {
    let path = write_csv("noheader", "1,a\n2,b\n");
    let preview = preview_csv(&path, Some(b','), false, 10).expect("preview");
    assert_eq!(preview.headers, vec!["1", "2"]);
    assert_eq!(preview.rows.len(), 2);
  }

  async fn sqlite_pool() -> DbPool {
    let pool = SqlitePoolOptions::new()
      .max_connections(1)
      .connect("sqlite::memory:")
      .await
      .expect("connect to SQLite");
    sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
      .execute(&pool)
      .await
      .expect("create table");
    DbPool::Sqlite(pool)
  }

  async fn rows_in(pool: &DbPool) -> Vec<(i64, String)> {
    let DbPool::Sqlite(pool) = pool else {
      unreachable!("测试只用 SQLite 池");
    };
    let pool: &sqlx::Pool<Sqlite> = pool;
    sqlx::query("SELECT id, name FROM t ORDER BY id")
      .fetch_all(pool)
      .await
      .expect("select")
      .iter()
      .map(|row| (row.get::<i64, _>("id"), row.get::<String, _>("name")))
      .collect()
  }

  fn request(path: &std::path::Path, batch_size: usize) -> ImportRequest {
    ImportRequest {
      path: path.to_string_lossy().to_string(),
      schema: None,
      table: "t".into(),
      csv: CsvOptions { delimiter: ",".into(), has_header: true, null_text: String::new() },
      columns: columns(),
      batch_size,
      strategy: TransactionStrategy::SingleTransaction,
      on_error: ErrorPolicy::Abort,
    }
  }

  async fn run(pool: &DbPool, request: &ImportRequest) -> ImportSummary {
    let mut progress = |_| {};
    let mut cancelled = || false;
    let mut paused = || false;
    import_csv(pool, request, &mut progress, &mut cancelled, &mut paused)
      .await
      .expect("import runs")
  }

  #[tokio::test]
  async fn a_clean_file_lands_row_for_row() {
    let pool = sqlite_pool().await;
    let path = write_csv("clean", "id,name\n1,alice\n2,bob\n3,carol\n");
    // 批量大小故意小于行数：最后一批不满，要重拼一条语句
    let summary = run(&pool, &request(&path, 2)).await;
    assert_eq!(summary.rows_inserted, 3);
    assert_eq!(summary.rows_failed, 0);
    assert_eq!(
      rows_in(&pool).await,
      vec![(1, "alice".into()), (2, "bob".into()), (3, "carol".into())]
    );
  }

  #[tokio::test]
  async fn a_bad_row_is_named_by_its_line_not_by_its_batch() {
    // 多行 INSERT 失败时数据库只说「这条语句失败」；退回保存点逐行重放才知道是哪一行
    let pool = sqlite_pool().await;
    let path = write_csv("skip", "id,name\n1,alice\n2,\n3,carol\n");
    let mut request = request(&path, 10);
    request.on_error = ErrorPolicy::Skip;
    let summary = run(&pool, &request).await;

    assert_eq!(summary.rows_inserted, 2);
    assert_eq!(summary.rows_failed, 1);
    assert_eq!(summary.errors.len(), 1);
    assert_eq!(summary.errors[0].line, 3);
    assert_eq!(summary.errors[0].values, vec!["2", ""]);
    assert_eq!(rows_in(&pool).await, vec![(1, "alice".into()), (3, "carol".into())]);
  }

  #[tokio::test]
  async fn one_bad_row_takes_the_whole_single_transaction_down() {
    let pool = sqlite_pool().await;
    let path = write_csv("abort", "id,name\n1,alice\n2,\n3,carol\n");
    let summary = run(&pool, &request(&path, 10)).await;

    assert!(summary.rolled_back);
    assert_eq!(summary.rows_inserted, 0);
    // 停下来之前也要说清是哪一行——「这一批失败了」帮不上任何忙
    assert_eq!(summary.errors[0].line, 3);
    assert!(rows_in(&pool).await.is_empty());
  }

  #[tokio::test]
  async fn per_batch_keeps_what_it_already_committed() {
    let pool = sqlite_pool().await;
    let path = write_csv("perbatch", "id,name\n1,alice\n2,bob\n3,\n4,dave\n");
    let mut request = request(&path, 2);
    request.strategy = TransactionStrategy::PerBatch;
    let summary = run(&pool, &request).await;

    assert!(!summary.rolled_back);
    assert_eq!(summary.rows_inserted, 2);
    assert_eq!(rows_in(&pool).await, vec![(1, "alice".into()), (2, "bob".into())]);
  }

  #[tokio::test]
  async fn a_short_row_is_a_broken_row_not_a_row_of_nulls() {
    // 少一格通常意味着这一行的值全都往前挪了一位；补 NULL 会把错位的数据静静写进库里
    let pool = sqlite_pool().await;
    let path = write_csv("short", "id,name\n1,alice\n2\n");
    let mut request = request(&path, 10);
    request.on_error = ErrorPolicy::Skip;
    let summary = run(&pool, &request).await;

    assert_eq!(summary.rows_failed, 1);
    assert!(summary.errors[0].message.starts_with(CSV_ROW_TOO_SHORT), "{:?}", summary.errors[0]);
    // 数据里要带上「实际有几个字段」，否则看不出差在哪
    assert!(summary.errors[0].message.contains(": 1 ·"), "{:?}", summary.errors[0]);
    assert_eq!(rows_in(&pool).await, vec![(1, "alice".into())]);
  }

  #[tokio::test]
  async fn null_text_decides_between_null_and_the_empty_string() {
    let pool = sqlite_pool().await;
    let path = write_csv("nulltext", "id,name\n1,\\N\n2,\n");
    let mut request = request(&path, 10);
    // NULL 写成 \N 时，空字段就是空字符串——而 name 是 NOT NULL，空串进得去
    request.csv.null_text = "\\N".into();
    request.on_error = ErrorPolicy::Skip;
    let summary = run(&pool, &request).await;

    assert_eq!(summary.rows_inserted, 1);
    assert_eq!(summary.rows_failed, 1);
    assert_eq!(rows_in(&pool).await, vec![(2, String::new())]);
  }

  #[tokio::test]
  async fn cancelling_rolls_a_single_transaction_all_the_way_back() {
    let pool = sqlite_pool().await;
    let path = write_csv("cancel", "id,name\n1,a\n2,b\n3,c\n4,d\n");
    let mut fired = false;
    let mut progress = |_| {};
    // 第一批写完之后按下取消
    let mut cancelled = || {
      let first = !fired;
      fired = true;
      !first
    };
    let mut paused = || false;
    let summary = import_csv(&pool, &request(&path, 2), &mut progress, &mut cancelled, &mut paused)
      .await
      .expect("import runs");

    assert!(summary.cancelled);
    assert!(summary.rolled_back);
    assert_eq!(summary.rows_inserted, 0);
    assert!(rows_in(&pool).await.is_empty());
  }
}
