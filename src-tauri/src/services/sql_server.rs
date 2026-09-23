//! SQL Server：插件之外的第四种关系库。
//!
//! 另外三种的连接池归 `tauri-plugin-sql` 管（`DbInstances`，由前端的
//! `Database.load` 打开）。插件的 `DbPool` 只有 sqlx 的三个驱动，而 sqlx 0.7 起
//! 不再带 MSSQL，所以 SQL Server 的连接只能由后端自己持有：`test_connection`
//! 连上之后把池子登记在 [`SqlServerRegistry`] 里，键是不带口令的
//! `sqlserver://user@host:port/db`，其余命令按同一个键取。
//!
//! 与 sqlx 那三家行为不同、值得记住的两处：
//! - **被放弃的查询不会在服务端停下。** tiberius 不发 TDS 的 attention 包，
//!   同一条连接上的下一条要等它跑完。所以超时与取消要**关掉那条连接**，
//!   服务端据此中止；见 [`SqlServerConnection`] 上的说明。
//! - **结果流不报影响行数。** 语句原样发；没有结果集的，在同一条连接上
//!   紧接着另发一批 `SELECT @@ROWCOUNT` 取回来（它跨批保留）。**不**把这一句
//!   拼在用户的语句后面：那样一条没写完的语句报的是「`;` 附近有语法错误」，
//!   指着一段用户根本没写过的文字，而 `CREATE PROCEDURE` 会把它存进过程体。

use crate::models::{ConnectionProfile, TlsMode};
use crate::services::query_error::QueryErrorDetails;
use crate::services::query_error::{CONNECTION_LOST, CONNECTION_LOST_CODE};
use crate::services::query_executor::{
  admit_row_bytes, flush_full_batch, flush_remaining_batch, format_date, format_datetime,
  format_time, tagged_value, NonQueryHandling, QueryColumnMetadata, QueryExecutionSummary,
  QueryResultBatch, QueryRow, QueryTruncationReason, StreamOptions,
};
use crate::services::QueryError;
use futures_util::TryStreamExt;
use serde_json::{Map, Value as JsonValue};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tiberius::{AuthMethod, Client, ColumnData, ColumnType, Config, EncryptionLevel, FromSql};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

pub type SqlServerClient = Client<Compat<TcpStream>>;

/// 列类型的完整写法，`nvarchar(32)`、`decimal(10,2)`、`varchar(max)`。
///
/// `sys.types` 只给名字，长度精度在 `sys.columns` 里，而且 n 系列的
/// `max_length` 是**字节**数，要除以二才是声明的长度。结构页、ER 图、补全
/// 三处都要显示这个，写成宏是为了能 `concat!` 进各自的查询字面量。
/// 引用的别名固定是 `c`（`sys.columns`）与 `ty`（`sys.types`）。
macro_rules! sql_server_type_name {
  () => {
    "CASE
    WHEN ty.name IN ('varchar', 'char', 'varbinary', 'binary')
      THEN ty.name + '(' + CASE WHEN c.max_length = -1 THEN 'max'
        ELSE CAST(c.max_length AS varchar(10)) END + ')'
    WHEN ty.name IN ('nvarchar', 'nchar')
      THEN ty.name + '(' + CASE WHEN c.max_length = -1 THEN 'max'
        ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
    WHEN ty.name IN ('decimal', 'numeric')
      THEN ty.name + '(' + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')'
    WHEN ty.name IN ('datetime2', 'time', 'datetimeoffset')
      THEN ty.name + '(' + CAST(c.scale AS varchar(10)) + ')'
    ELSE ty.name
  END"
  };
}
pub(crate) use sql_server_type_name;

/// 连接串的 scheme。前端据此认出这条连接不归插件管
pub const SQL_SERVER_SCHEME: &str = "sqlserver://";

/// 这一阶段还没做的操作。前端把它译成一句「SQL Server 还不支持……」
pub const SQL_SERVER_UNSUPPORTED: &str = "DATAOMNI_SQL_SERVER_UNSUPPORTED";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// 空闲连接留几条。目录查询是短而零星的，多留没用
const MAX_IDLE: usize = 4;

/// 连上一台 SQL Server 需要知道的全部。
#[derive(Clone)]
pub struct SqlServerTarget {
  host: String,
  port: u16,
  database: Option<String>,
  username: String,
  password: String,
  tls: TlsMode,
  ca_certificate_path: Option<String>,
}

impl SqlServerTarget {
  pub fn from_profile(profile: &ConnectionProfile) -> Self {
    Self {
      host: profile.host.clone(),
      port: profile.port,
      database: profile.database.clone().filter(|database| !database.is_empty()),
      username: profile.username.clone(),
      password: profile.password.clone(),
      tls: profile.effective_tls_mode(),
      ca_certificate_path: profile.ca_certificate_path.clone().filter(|path| !path.is_empty()),
    }
  }

  fn config(&self) -> Config {
    let mut config = Config::new();
    config.host(&self.host);
    config.port(self.port);
    if let Some(database) = &self.database {
      config.database(database);
    }
    config.application_name("DataOmni");
    config.authentication(AuthMethod::sql_server(&self.username, &self.password));
    let (encryption, verify) = tls_settings(self.tls);
    config.encryption(encryption);
    match (&self.ca_certificate_path, verify) {
      (Some(path), true) => config.trust_cert_ca(path),
      (_, true) => {}
      (_, false) => config.trust_cert(),
    }
    config
  }
}

/// 应用的五档 TLS 模式在 SQL Server 上是什么意思：加不加密、校不校验证书。
///
/// SQL Server 装好默认就是自签证书，「优先 / 要求」这两档不校验，和 MySQL、
/// PostgreSQL 那两档的含义一致；要校验就选后两档并给 CA。tiberius 校验证书时
/// 一定连主机名一起校验，所以「校验证书颁发机构」在这里和「校验证书和主机名」
/// 是同一件事——宁可严，不可松。
fn tls_settings(mode: TlsMode) -> (EncryptionLevel, bool) {
  match mode {
    TlsMode::Disabled => (EncryptionLevel::NotSupported, false),
    TlsMode::Preferred => (EncryptionLevel::On, false),
    TlsMode::Required => (EncryptionLevel::Required, false),
    TlsMode::VerifyCa | TlsMode::VerifyFull => (EncryptionLevel::Required, true),
  }
}

pub async fn connect(target: &SqlServerTarget) -> Result<SqlServerClient, QueryError> {
  let config = target.config();
  let attempt = async {
    let tcp = TcpStream::connect(config.get_addr()).await.map_err(connection_lost)?;
    tcp.set_nodelay(true).map_err(connection_lost)?;
    Client::connect(config, tcp.compat_write()).await.map_err(|error| query_error(error, None))
  };
  tokio::time::timeout(CONNECT_TIMEOUT, attempt).await.map_err(|_| {
    QueryError::with_code(
      CONNECTION_LOST_CODE,
      format!("{CONNECTION_LOST}: timed out after {}s", CONNECT_TIMEOUT.as_secs()),
    )
  })?
}

/// 一台服务器的连接：一份连接参数，加几条空闲连接。
pub struct SqlServerPool {
  target: SqlServerTarget,
  idle: Mutex<Vec<SqlServerClient>>,
}

impl SqlServerPool {
  /// `first` 是测试连接时连上的那一条，直接留着用，省一次登录
  pub fn new(target: SqlServerTarget, first: SqlServerClient) -> Arc<Self> {
    Arc::new(Self { target, idle: Mutex::new(vec![first]) })
  }

  /// 给一个会话用的连接：用完**不放回**。
  ///
  /// 会话连接上可能开着事务、建过临时表、改过 `SET` 选项，放回池子就会被下一次
  /// 目录查询接着用——在别人的事务里读目录。
  pub async fn acquire_for_session(self: &Arc<Self>) -> Result<SqlServerConnection, QueryError> {
    Ok(SqlServerConnection {
      client: Some(connect(&self.target).await?),
      target: self.target.clone(),
      pool: None,
    })
  }

  /// 给一次目录查询用的连接：用完放回。
  async fn acquire_reusable(self: &Arc<Self>) -> Result<SqlServerConnection, QueryError> {
    let idle = self.idle.lock().ok().and_then(|mut idle| idle.pop());
    let client = match idle {
      Some(client) => client,
      None => connect(&self.target).await?,
    };
    Ok(SqlServerConnection {
      client: Some(client),
      target: self.target.clone(),
      pool: Some(Arc::clone(self)),
    })
  }
}

/// 一条连接，外加「上一条查询有没有被放弃」的记号。
///
/// 记号就是 `client` 本身：执行期间把它取出来，执行完放回去。执行的 future
/// 被丢掉（超时、取消）时它就回不来了，`client` 留在 `None`——那条连接随
/// future 一起被丢掉，TCP 断开，服务端据此中止还在跑的语句。下一次用的时候
/// 看到 `None` 就重连。
pub struct SqlServerConnection {
  client: Option<SqlServerClient>,
  target: SqlServerTarget,
  /// 目录查询的连接用完放回这里；会话连接是 `None`
  pool: Option<Arc<SqlServerPool>>,
}

impl SqlServerConnection {
  /// 取出客户端开始一次执行；上一次被放弃过就先重连。
  async fn take_client(&mut self) -> Result<SqlServerClient, QueryError> {
    match self.client.take() {
      Some(client) => Ok(client),
      None => connect(&self.target).await,
    }
  }

  pub async fn execute_streaming(
    &mut self,
    sql: &str,
    options: StreamOptions,
    sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
  ) -> Result<QueryExecutionSummary, QueryError> {
    // 导出要求「不返回结果集就别执行」，而这里只有执行之后才知道——先执行再
    // 拒绝等于把一条 DELETE 真的跑了。在有 describe 之前一律不做
    if options.non_query == NonQueryHandling::Refuse {
      return Err(QueryError::message(format!("{SQL_SERVER_UNSUPPORTED}: export")));
    }
    let mut client = self.take_client().await?;
    let result = stream_first_result(&mut client, sql, options, sink).await;
    // 连接本身断了就不放回：下一次用的时候重连
    if !matches!(&result, Err(error) if error.code.as_deref() == Some(CONNECTION_LOST_CODE)) {
      self.client = Some(client);
    }
    result
  }

  /// 一次没有结果集可言的执行（事务控制这类）。
  pub async fn execute_batch(&mut self, sql: &str) -> Result<u64, QueryError> {
    let mut client = self.take_client().await?;
    let result: Result<u64, QueryError> = async {
      let stream = client.simple_query(sql).await.map_err(|error| query_error(error, Some(sql)))?;
      stream.into_results().await.map_err(|error| query_error(error, Some(sql)))?;
      Ok(0)
    }
    .await;
    if !matches!(&result, Err(error) if error.code.as_deref() == Some(CONNECTION_LOST_CODE)) {
      self.client = Some(client);
    }
    result
  }
}

impl Drop for SqlServerConnection {
  fn drop(&mut self) {
    let (Some(pool), Some(client)) = (self.pool.take(), self.client.take()) else {
      return;
    };
    if let Ok(mut idle) = pool.idle.lock() {
      if idle.len() < MAX_IDLE {
        idle.push(client);
      }
    };
  }
}

/// 按连接串登记的 SQL Server 连接池。和插件的 `DbInstances` 是同一个角色。
#[derive(Default)]
pub struct SqlServerRegistry {
  pools: Mutex<HashMap<String, Arc<SqlServerPool>>>,
}

impl SqlServerRegistry {
  pub fn insert(&self, key: String, pool: Arc<SqlServerPool>) {
    if let Ok(mut pools) = self.pools.lock() {
      pools.insert(key, pool);
    }
  }

  pub fn get(&self, key: &str) -> Option<Arc<SqlServerPool>> {
    self.pools.lock().ok().and_then(|pools| pools.get(key).cloned())
  }

  pub fn remove(&self, key: &str) -> bool {
    self.pools.lock().ok().and_then(|mut pools| pools.remove(key)).is_some()
  }
}

impl SqlServerPool {
  pub fn target(&self) -> &SqlServerTarget {
    &self.target
  }

  /// 前端目录查询的那条路：带绑定参数（`@P1`、`@P2`…），返回的是**不带类型标签**
  /// 的值，和插件 `select` 返回的形状一样——目录的消费方按插件的形状写的。
  pub async fn select(
    self: &Arc<Self>,
    sql: &str,
    params: &[JsonValue],
  ) -> Result<Vec<QueryRow>, QueryError> {
    let mut connection = self.acquire_reusable().await?;
    let mut client = connection.take_client().await?;
    let result = select_rows(&mut client, sql, params).await;
    if !matches!(&result, Err(error) if error.code.as_deref() == Some(CONNECTION_LOST_CODE)) {
      connection.client = Some(client);
    }
    result
  }
}

async fn select_rows(
  client: &mut SqlServerClient,
  sql: &str,
  params: &[JsonValue],
) -> Result<Vec<QueryRow>, QueryError> {
  let mut query = tiberius::Query::new(sql);
  for param in params {
    match param {
      JsonValue::Null => query.bind(Option::<String>::None),
      JsonValue::Bool(value) => query.bind(*value),
      JsonValue::Number(number) => match number.as_i64() {
        Some(integer) => query.bind(integer),
        None => query.bind(number.as_f64()),
      },
      JsonValue::String(text) => query.bind(text.clone()),
      other => query.bind(other.to_string()),
    }
  }
  let stream = query.query(client).await.map_err(|error| query_error(error, Some(sql)))?;
  let rows = stream.into_first_result().await.map_err(|error| query_error(error, Some(sql)))?;
  rows
    .into_iter()
    .map(|row| {
      let names = column_names(row.columns());
      let mut values = Map::new();
      for (name, (column, data)) in names.into_iter().zip(row.cells()) {
        values.insert(name, untagged(decode(column.column_type(), data)?));
      }
      Ok(values)
    })
    .collect()
}

/// 插件的解码器返回的是裸值；我们的解码器给精度敏感的类型挂了标签
fn untagged(value: JsonValue) -> JsonValue {
  match value {
    JsonValue::Object(mut map) if map.contains_key("type") => {
      map.remove("value").unwrap_or(JsonValue::Null)
    }
    other => other,
  }
}

async fn stream_first_result(
  client: &mut SqlServerClient,
  sql: &str,
  options: StreamOptions,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
) -> Result<QueryExecutionSummary, QueryError> {
  let mut stream = client.simple_query(sql).await.map_err(|error| query_error(error, Some(sql)))?;

  // 第一个结果集是要给用户看的；之后的结果集读掉不留（和另外三家一样）
  let mut first: Option<(usize, Vec<QueryColumnMetadata>, Vec<String>)> = None;
  let mut rows = Vec::with_capacity(options.batch_size);
  let mut row_count = 0;
  let mut batch_count = 0;
  let mut bytes_read: usize = 0;
  let mut truncation_reason = None;

  while let Some(item) = stream.try_next().await.map_err(|error| query_error(error, Some(sql)))? {
    match item {
      tiberius::QueryItem::Metadata(metadata) => {
        if first.is_some() {
          continue;
        }
        let columns = metadata.columns();
        let names = column_names(columns);
        let column_metadata = columns
          .iter()
          .zip(&names)
          .enumerate()
          .map(|(ordinal, (column, name))| QueryColumnMetadata {
            name: name.clone(),
            ordinal,
            database_type: format!("{:?}", column.column_type()),
            logical_type: logical_type(column.column_type()).to_string(),
            nullable: None,
          })
          .collect();
        first = Some((metadata.result_index(), column_metadata, names));
      }
      tiberius::QueryItem::Row(row) => {
        let Some((index, _, names)) = &first else { continue };
        if row.result_index() != *index {
          continue;
        }
        // 到了上限之后还要把剩下的行读完：不读完这条连接就用不了，
        // 而断开重连会把会话里的事务和临时表一起丢掉
        if truncation_reason.is_some() {
          continue;
        }
        if row_count >= options.row_limit {
          truncation_reason = Some(QueryTruncationReason::RowLimit);
          continue;
        }
        let mut values = Map::new();
        for (name, (column, data)) in names.iter().zip(row.cells()) {
          values.insert(name.clone(), decode(column.column_type(), data)?);
        }
        if !admit_row_bytes(&values, options.byte_limit, &mut bytes_read)? {
          truncation_reason = Some(QueryTruncationReason::ByteLimit);
          continue;
        }
        rows.push(values);
        row_count += 1;
        flush_full_batch(&mut rows, options.batch_size, &mut batch_count, row_count, sink)?;
      }
    }
  }
  drop(stream);

  let Some((_, column_metadata, columns)) = first else {
    return Ok(QueryExecutionSummary::Affected { rows_affected: last_row_count(client).await? });
  };
  flush_remaining_batch(&mut rows, &mut batch_count, row_count, sink)?;
  Ok(QueryExecutionSummary::Rows {
    columns,
    column_metadata,
    row_count,
    batch_count,
    truncated: truncation_reason.is_some(),
    truncation_reason,
    row_limit: options.row_limit,
    byte_limit: options.byte_limit,
    bytes_read,
  })
}

/// 上一条语句影响了几行。必须紧接着在**同一条连接**上问：`@@ROWCOUNT`
/// 属于会话，跨批保留，下一条语句一执行就变了。
async fn last_row_count(client: &mut SqlServerClient) -> Result<u64, QueryError> {
  let row = client
    .simple_query("SELECT CAST(@@ROWCOUNT AS BIGINT)")
    .await
    .map_err(|error| query_error(error, None))?
    .into_row()
    .await
    .map_err(|error| query_error(error, None))?;
  let count = row.and_then(|row| row.get::<i64, _>(0)).unwrap_or(0);
  Ok(u64::try_from(count).unwrap_or(0))
}

/// 列名。SQL Server 的表达式列没有名字（SSMS 显示「(No column name)」），而
/// 结果行按列名做键——两个没名字的列会互相覆盖，所以给它们编上号。
fn column_names(columns: &[tiberius::Column]) -> Vec<String> {
  label_columns(columns.iter().map(|column| column.name()))
}

fn label_columns<'a>(names: impl Iterator<Item = &'a str>) -> Vec<String> {
  let mut unnamed = 0;
  names
    .map(|name| {
      if !name.is_empty() {
        return name.to_string();
      }
      unnamed += 1;
      if unnamed == 1 {
        "(No column name)".to_string()
      } else {
        format!("(No column name) {unnamed}")
      }
    })
    .collect()
}

fn logical_type(column_type: ColumnType) -> &'static str {
  match column_type {
    ColumnType::Bit | ColumnType::Bitn => "boolean",
    ColumnType::Int1
    | ColumnType::Int2
    | ColumnType::Int4
    | ColumnType::Int8
    | ColumnType::Intn => "integer",
    ColumnType::Decimaln
    | ColumnType::Numericn
    | ColumnType::Money
    | ColumnType::Money4
    | ColumnType::Float4
    | ColumnType::Float8
    | ColumnType::Floatn => "decimal",
    ColumnType::Daten => "date",
    ColumnType::Timen => "time",
    ColumnType::Datetime
    | ColumnType::Datetime4
    | ColumnType::Datetimen
    | ColumnType::Datetime2
    | ColumnType::DatetimeOffsetn => "datetime",
    ColumnType::BigVarBin | ColumnType::BigBinary | ColumnType::Image => "binary",
    ColumnType::BigVarChar
    | ColumnType::BigChar
    | ColumnType::NVarchar
    | ColumnType::NChar
    | ColumnType::Text
    | ColumnType::NText
    | ColumnType::Xml
    | ColumnType::Guid => "text",
    _ => "unknown",
  }
}

/// 一个单元格。与其它三家同一套约定：超出 JavaScript 安全整数的、小数、时间
/// 与二进制带类型标签，以文本传；其余是裸值。
fn decode(column_type: ColumnType, data: &ColumnData<'static>) -> Result<JsonValue, QueryError> {
  let value = match data {
    ColumnData::U8(value) => value.map(JsonValue::from),
    ColumnData::I16(value) => value.map(JsonValue::from),
    ColumnData::I32(value) => value.map(JsonValue::from),
    ColumnData::I64(value) => value.map(|value| tagged_value("bigint", value.to_string())),
    // money 在 TDS 里是定点数，tiberius 把它解成 f64。四位小数是它的定义，
    // 照这个标度写出来，不让 1.5 显示成 1.5000000000000002 这类样子
    ColumnData::F64(value) if matches!(column_type, ColumnType::Money | ColumnType::Money4) => {
      value.map(|value| tagged_value("decimal", format!("{value:.4}")))
    }
    ColumnData::F32(value) => value.map(JsonValue::from),
    ColumnData::F64(value) => value.map(JsonValue::from),
    ColumnData::Bit(value) => value.map(JsonValue::from),
    ColumnData::String(value) => value.as_ref().map(|text| JsonValue::from(text.as_ref())),
    // SQL Server 自己把 uniqueidentifier 写成大写
    ColumnData::Guid(value) => {
      value.map(|guid| tagged_value("text", guid.to_string().to_uppercase()))
    }
    ColumnData::Binary(value) => value.as_ref().map(|bytes| {
      tagged_value("binary", bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }),
    ColumnData::Numeric(value) => {
      value.map(|numeric| tagged_value("decimal", format_numeric(numeric.value(), numeric.scale())))
    }
    ColumnData::Xml(value) => value.as_ref().map(|xml| JsonValue::from(xml.to_string())),
    ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
      time::PrimitiveDateTime::from_sql(data)
        .map_err(|error| query_error(error, None))?
        .map(|value| tagged_value("datetime", format_datetime(value)))
    }
    ColumnData::Date(_) => time::Date::from_sql(data)
      .map_err(|error| query_error(error, None))?
      .map(|value| tagged_value("date", format_date(value))),
    ColumnData::Time(_) => time::Time::from_sql(data)
      .map_err(|error| query_error(error, None))?
      .map(|value| tagged_value("time", format_time(value))),
    ColumnData::DateTimeOffset(_) => time::OffsetDateTime::from_sql(data)
      .map_err(|error| query_error(error, None))?
      .map(|value| tagged_value("datetime", format_offset_datetime(value))),
  };
  Ok(value.unwrap_or(JsonValue::Null))
}

/// `datetimeoffset` 照 SQL Server 自己的写法：本地时间加偏移，`+08:00`。
fn format_offset_datetime(value: time::OffsetDateTime) -> String {
  let offset = value.offset();
  let sign = if offset.is_negative() { '-' } else { '+' };
  format!(
    "{} {sign}{:02}:{:02}",
    format_datetime(time::PrimitiveDateTime::new(value.date(), value.time())),
    offset.whole_hours().unsigned_abs(),
    offset.minutes_past_hour().unsigned_abs()
  )
}

/// 定点数的文本：按标度补足小数位，保留符号。
///
/// 不用 tiberius 的 `Display`：它把整数部分与小数部分分开格式化，`-1.5`
/// 写成 `-1.-5`，`-0.5` 丢了负号，标度 0 时多出一个 `.0`。
pub fn format_numeric(value: i128, scale: u8) -> String {
  let digits = value.unsigned_abs().to_string();
  let sign = if value < 0 { "-" } else { "" };
  let scale = usize::from(scale);
  if scale == 0 {
    return format!("{sign}{digits}");
  }
  let padded = format!("{digits:0>width$}", width = scale + 1);
  let (whole, fraction) = padded.split_at(padded.len() - scale);
  format!("{sign}{whole}.{fraction}")
}

fn connection_lost(error: impl std::fmt::Display) -> QueryError {
  QueryError::with_code(CONNECTION_LOST_CODE, format!("{CONNECTION_LOST}: {error}"))
}

/// tiberius 的错误 → 应用的查询错误。
///
/// 服务端错误带错误号、级别和**行号**；错误面板按字符位置标出错处，这里把
/// 行号换成那一行开头的字符位置，至少能跳到那一行。发生在存储过程里的错误
/// 行号是过程体里的，不换。
fn query_error(error: tiberius::error::Error, sql: Option<&str>) -> QueryError {
  match error {
    tiberius::error::Error::Server(token) => {
      let position = match (sql, token.procedure().is_empty()) {
        (Some(sql), true) => line_start_position(sql, token.line()),
        _ => None,
      };
      QueryError {
        message: token.message().to_string(),
        code: Some(token.code().to_string()),
        details: position.map(|position| {
          Box::new(QueryErrorDetails { position: Some(position), ..Default::default() })
        }),
      }
    }
    tiberius::error::Error::Io { .. } => connection_lost(error),
    other => QueryError::message(other.to_string()),
  }
}

/// 第 `line` 行（从 1 起）第一个字符的位置（从 1 起，按字符计）
fn line_start_position(sql: &str, line: u32) -> Option<u32> {
  if line == 0 {
    return None;
  }
  let skipped: usize = sql
    .split('\n')
    .take(usize::try_from(line).ok()? - 1)
    .map(|text| text.chars().count() + 1)
    .sum();
  (skipped < sql.chars().count()).then(|| u32::try_from(skipped + 1).ok()).flatten()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn numerics_keep_their_scale_and_sign() {
    assert_eq!(format_numeric(1050, 2), "10.50");
    assert_eq!(format_numeric(-15, 1), "-1.5");
    assert_eq!(format_numeric(-5, 1), "-0.5");
    assert_eq!(format_numeric(5, 3), "0.005");
    assert_eq!(format_numeric(42, 0), "42");
    assert_eq!(format_numeric(0, 2), "0.00");
    assert_eq!(format_numeric(i128::MAX, 0), i128::MAX.to_string());
  }

  #[test]
  fn a_server_error_line_becomes_the_position_of_that_line() {
    let sql = "SELECT 1\nFROM nowhere\nWHERE x";
    assert_eq!(line_start_position(sql, 1), Some(1));
    assert_eq!(line_start_position(sql, 2), Some(10));
    assert_eq!(line_start_position(sql, 3), Some(23));
    // 行号超出语句本身（报错来自别处）就不标
    assert_eq!(line_start_position(sql, 4), None);
    assert_eq!(line_start_position(sql, 0), None);
  }

  #[test]
  fn unnamed_columns_get_distinct_names() {
    // 两个没名字的列用同一个键，后一个会把前一个覆盖掉
    assert_eq!(
      label_columns(["", "a", ""].into_iter()),
      ["(No column name)", "a", "(No column name) 2"]
    );
  }

  #[test]
  fn tls_modes_map_to_encryption_and_verification() {
    assert_eq!(tls_settings(TlsMode::Disabled), (EncryptionLevel::NotSupported, false));
    assert_eq!(tls_settings(TlsMode::Preferred), (EncryptionLevel::On, false));
    assert_eq!(tls_settings(TlsMode::Required), (EncryptionLevel::Required, false));
    assert_eq!(tls_settings(TlsMode::VerifyFull), (EncryptionLevel::Required, true));
  }
}
