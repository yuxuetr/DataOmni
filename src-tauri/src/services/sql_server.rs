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
//! - **结果流不报影响行数。** 语句原样发；之后在同一条连接上另发一批，
//!   问 `@@ROWCOUNT`（它跨批保留）与事务深度。**不**把这一句拼在用户的语句
//!   后面：那样一条没写完的语句报的是「`;` 附近有语法错误」，指着一段用户
//!   根本没写过的文字，而 `CREATE PROCEDURE` 会把它存进过程体。
//! - **事务状态问服务端，不从语句推。** 一条类型转换错误（245）会把整个事务
//!   回滚掉，而语句本身只是 `SELECT`；按语句推，状态栏会一直说「事务中」，
//!   关掉自动提交时后面的写入也不会再被放进事务。

use crate::models::{ConnectionProfile, TlsMode};
use crate::services::query_error::QueryErrorDetails;
use crate::services::query_error::{CONNECTION_LOST, CONNECTION_LOST_CODE};
use crate::services::query_executor::{
  admit_row_bytes, flush_full_batch, flush_remaining_batch, format_date, format_datetime,
  format_time, tagged_value, NonQueryHandling, QueryColumnMetadata, QueryExecutionSummary,
  QueryResultBatch, QueryRow, QueryTruncationReason, StreamOptions,
};
use crate::services::transaction_state::{TransactionState, TransactionStatus};
use crate::services::write_batch::{
  WriteBatchError, WriteStatement, ROW_COUNT_MISMATCH, ROW_COUNT_MISMATCH_CODE,
  UNSUPPORTED_PARAMETER_TYPE,
};
use crate::services::QueryError;
use futures_util::{FutureExt, TryStreamExt};
use serde_json::{Map, Value as JsonValue};
use std::future::Future;
use std::panic::AssertUnwindSafe;
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

/// tiberius 在它没实现的地方直接 panic：`sql_variant` 与 CLR 类型（geography、
/// hierarchyid）的列元数据是 `todo!()`，服务端要求的加密级别对不上时也是
/// `panic!`。没接住的话那一次调用永远不回来，界面一直转着「执行中」。
/// 冒号后面是 panic 的原话。
pub const SQL_SERVER_DRIVER_FAILURE: &str = "DATAOMNI_SQL_SERVER_DRIVER_FAILURE";
/// 驱动失败之后这条连接的协议状态不可知，和断线一样不再复用
const DRIVER_FAILURE_CODE: &str = "SQL_SERVER_DRIVER_FAILURE";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// 空闲连接留几条。目录查询是短而零星的，多留没用
const MAX_IDLE: usize = 4;

/// 池子里的连接等锁最多等多久。
///
/// SQL Server 默认的读已提交是**加锁读**，不是另外两家那样的多版本读：编辑器
/// 里开着一个改过某张表的事务，表数据页、目录查询与网格的提交在这张表上会
/// 一直等下去，界面停在「加载中」。等满了报 1222，至少说得出是在等锁。
const POOL_LOCK_TIMEOUT: &str = "SET LOCK_TIMEOUT 5000";

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
  let attempt = guarded(async {
    let tcp = TcpStream::connect(config.get_addr()).await.map_err(connection_lost)?;
    tcp.set_nodelay(true).map_err(connection_lost)?;
    Client::connect(config, tcp.compat_write()).await.map_err(|error| query_error(error, None))
  });
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
  pub async fn new(
    target: SqlServerTarget,
    mut first: SqlServerClient,
  ) -> Result<Arc<Self>, QueryError> {
    run_simple(&mut first, POOL_LOCK_TIMEOUT).await?;
    Ok(Arc::new(Self { target, idle: Mutex::new(vec![first]) }))
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
      transaction: TransactionState::default(),
    })
  }

  /// 给一次目录查询用的连接：用完放回。
  async fn acquire_reusable(self: &Arc<Self>) -> Result<SqlServerConnection, QueryError> {
    let idle = self.idle.lock().ok().and_then(|mut idle| idle.pop());
    let client = match idle {
      Some(client) => client,
      None => {
        let mut client = connect(&self.target).await?;
        run_simple(&mut client, POOL_LOCK_TIMEOUT).await?;
        client
      }
    };
    Ok(SqlServerConnection {
      client: Some(client),
      target: self.target.clone(),
      pool: Some(Arc::clone(self)),
      transaction: TransactionState::default(),
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
  /// 上一条语句之后服务端报的事务状态
  transaction: TransactionState,
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
    // 导出要求「不返回结果集就别执行」，而执行之后才知道就晚了——那条 DELETE
    // 已经删了。先描述一遍（只编译不执行），0 列就不执行
    if options.non_query == NonQueryHandling::Refuse && self.describe_columns(sql).await?.is_empty()
    {
      crate::services::query_executor::refuse_non_query(options.non_query)?;
    }
    // 和 MySQL 同一个理由：会话连接换了库，对象树与表数据还在原来那个库上读
    crate::services::query_executor::refuse_use_statement(sql)?;
    if options.explain_plan {
      return self.show_plan(sql, options, sink).await;
    }
    let mut client = self.take_client().await?;
    let outcome = guarded(stream_first_result(&mut client, sql, options, sink)).await;
    self
      .finish(client, outcome, |summary, rows_affected| match summary {
        QueryExecutionSummary::Affected { .. } => QueryExecutionSummary::Affected { rows_affected },
        rows => rows,
      })
      .await
  }

  /// 一次没有结果集可言的执行（事务控制这类）。
  pub async fn execute_batch(&mut self, sql: &str) -> Result<u64, QueryError> {
    let mut client = self.take_client().await?;
    let outcome = guarded(async {
      let stream = client.simple_query(sql).await.map_err(|error| query_error(error, Some(sql)))?;
      stream.into_results().await.map_err(|error| query_error(error, Some(sql)))?;
      Ok(0)
    })
    .await;
    self.finish(client, outcome, |_, rows_affected| rows_affected).await
  }

  /// 一条带参数的语句，返回影响行数（CSV 导入走这里）。值一律按 nvarchar 绑，
  /// 由服务端转成列的类型——和另外三家一样，CSV 给的本来就只有文本与空。
  pub async fn execute_with_params(
    &mut self,
    sql: &str,
    params: &[Option<String>],
  ) -> Result<u64, QueryError> {
    let mut client = self.take_client().await?;
    let outcome = guarded(async {
      let mut query = tiberius::Query::new(sql);
      for param in params {
        query.bind(param.clone());
      }
      let stream = query.query(&mut client).await.map_err(|error| query_error(error, Some(sql)))?;
      stream.into_results().await.map_err(|error| query_error(error, Some(sql)))?;
      Ok(0)
    })
    .await;
    self.finish(client, outcome, |_, rows_affected| rows_affected).await
  }

  /// 这条会话连接上的一次带参数的查询，返回不带类型标签的行
  pub async fn select(
    &mut self,
    sql: &str,
    params: &[JsonValue],
  ) -> Result<Vec<QueryRow>, QueryError> {
    let mut client = self.take_client().await?;
    let outcome = guarded(select_rows(&mut client, sql, params)).await;
    self.finish(client, outcome, |rows, _| rows).await
  }

  /// 只问「这条语句返回哪些列」，不执行。
  ///
  /// `sp_describe_first_result_set` 只编译：一条 `DELETE` 在这里报 0 列，一行
  /// 也不会删。导出据此在执行之前就拒绝不返回结果集的语句。
  pub async fn describe_columns(
    &mut self,
    sql: &str,
  ) -> Result<Vec<QueryColumnMetadata>, QueryError> {
    // 表值函数的形式把「描述不了」（语法错误、引用了不存在的表）放在
    // `error_number` / `error_message` 两列里返回，而不是报错——不看这两列，
    // 一条写错的语句会被当成「不返回结果集」
    let rows = self
      .select(
        "SELECT name, system_type_name, error_number, error_message
         FROM sys.dm_exec_describe_first_result_set(@P1, NULL, 0)
         WHERE is_hidden = 0 OR error_number IS NOT NULL ORDER BY column_ordinal",
        &[JsonValue::from(sql)],
      )
      .await?;
    if let Some(row) = rows.iter().find(|row| !row["error_number"].is_null()) {
      return Err(QueryError {
        message: row["error_message"].as_str().unwrap_or_default().to_string(),
        code: Some(row["error_number"].to_string()),
        details: None,
      });
    }
    let names = label_columns(
      rows.iter().map(|row| row.get("name").and_then(JsonValue::as_str).unwrap_or("")),
    );
    Ok(
      names
        .into_iter()
        .zip(&rows)
        .enumerate()
        .map(|(ordinal, (name, row))| {
          let declared = row.get("system_type_name").and_then(JsonValue::as_str).unwrap_or("");
          QueryColumnMetadata {
            name,
            ordinal,
            database_type: declared.to_string(),
            // 导出只用列名；逻辑类型要到真的取回一行时才从 TDS 的类型上定
            logical_type: "unknown".to_string(),
            nullable: None,
          }
        })
        .collect(),
    )
  }

  /// 一次执行之后：问服务端这条语句留下了什么，再决定连接留不留。
  ///
  /// 失败了也要问——失败的那一条可能已经把整个事务回滚了。连接断了、驱动
  /// 半路失败了就不问也不留：连接随 `client` 一起丢掉，服务端据此回滚，
  /// 事务状态也就回到了空闲。
  async fn finish<T>(
    &mut self,
    mut client: SqlServerClient,
    outcome: Result<T, QueryError>,
    with_row_count: impl FnOnce(T, u64) -> T,
  ) -> Result<T, QueryError> {
    let started_at = std::mem::take(&mut self.transaction).started_at;
    if !keeps_connection(&outcome) {
      return outcome;
    }
    let after = match guarded(after_statement(&mut client)).await {
      Ok(after) => after,
      // 语句本身的错优先：那是用户要看的
      Err(error) => return outcome.and(Err(error)),
    };
    self.client = Some(client);
    self.transaction = after.transaction(started_at);
    outcome.map(|value| with_row_count(value, after.row_count))
  }

  /// 只编译不执行，取估算的执行计划。
  ///
  /// `SET SHOWPLAN_XML` 必须独占一批。打开期间这条连接上的**任何**语句都只
  /// 返回计划不执行——包括 [`Self::finish`] 那一句 `@@ROWCOUNT`，所以这里不问，
  /// 事务状态也不变（计划不碰数据）。关不掉就把连接丢掉：留着它，后面每一条
  /// 语句都「成功」地什么也没做。
  async fn show_plan(
    &mut self,
    sql: &str,
    options: StreamOptions,
    sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
  ) -> Result<QueryExecutionSummary, QueryError> {
    let mut client = self.take_client().await?;
    if let Err(error) = run_simple(&mut client, "SET SHOWPLAN_XML ON").await {
      if !breaks_connection(&error) {
        self.client = Some(client);
      }
      return Err(error);
    }
    let outcome = guarded(stream_first_result(&mut client, sql, options, sink)).await;
    // 连接断了、或者关不掉：`client` 不放回，随之丢掉
    if !keeps_connection(&outcome) {
      return outcome;
    }
    run_simple(&mut client, "SET SHOWPLAN_XML OFF").await?;
    self.client = Some(client);
    outcome
  }

  /// 服务端上一次报的事务状态。
  ///
  /// 连接被放弃过（超时、取消）就是空闲：那条连接已经关了，服务端回滚了它上面
  /// 的事务。
  pub fn transaction(&self) -> TransactionState {
    match self.client {
      Some(_) => self.transaction.clone(),
      None => TransactionState::default(),
    }
  }
}

/// 一条语句之后，会话里留下的东西
struct AfterStatement {
  row_count: u64,
  /// `@@TRANCOUNT`：嵌套的 `BEGIN TRANSACTION` 各加一层，`COMMIT` 减一层，
  /// `ROLLBACK` 一次清零。
  ///
  /// 不问 `XACT_STATE()`：「开着但只能回滚」的事务活不过一批——批结束时服务端
  /// 自己把它回滚掉（3998），而这里问的时候总是在下一批。
  depth: i32,
}

impl AfterStatement {
  fn transaction(&self, started_at: Option<String>) -> TransactionState {
    if self.depth <= 0 {
      return TransactionState::default();
    }
    TransactionState {
      status: TransactionStatus::Active,
      // 还是同一个事务就沿用开始时间，否则状态栏上的计时每条语句都归零
      started_at: started_at.or_else(|| Some(chrono::Utc::now().to_rfc3339())),
    }
  }
}

async fn after_statement(client: &mut SqlServerClient) -> Result<AfterStatement, QueryError> {
  // `@@ROWCOUNT` 必须是这一批里第一个被求值的：任何一条语句都会改掉它
  let row = client
    .simple_query("SELECT CAST(@@ROWCOUNT AS BIGINT), CAST(@@TRANCOUNT AS INT)")
    .await
    .map_err(|error| query_error(error, None))?
    .into_row()
    .await
    .map_err(|error| query_error(error, None))?;
  // `try_get` 而不是 `get`：后者在类型对不上时 panic
  let (count, depth) = match &row {
    Some(row) => (int_cell::<i64>(row, 0)?, int_cell::<i32>(row, 1)?),
    None => (0, 0),
  };
  Ok(AfterStatement { row_count: u64::try_from(count).unwrap_or(0), depth })
}

/// 一格整数；空值当 0
fn int_cell<T>(row: &tiberius::Row, index: usize) -> Result<T, QueryError>
where
  T: for<'a> FromSql<'a> + Default,
{
  row
    .try_get::<T, _>(index)
    .map(Option::unwrap_or_default)
    .map_err(|error| query_error(error, None))
}

/// 这条语句是不是在开、关事务——关掉自动提交时，这种语句前面不补
/// `BEGIN TRANSACTION`。
///
/// 不能照另外三家只看第一个词：T-SQL 里 `BEGIN` 还开语句块（`BEGIN TRY`、
/// `BEGIN … END`），把 `BEGIN TRY DELETE …` 当成开事务，那条 DELETE 就在
/// 「自动提交已关闭」之下自动提交了。
pub fn controls_transaction(sql: &str) -> bool {
  let (first, second) = crate::services::transaction_state::leading_keywords(sql);
  match first.as_str() {
    "BEGIN" => matches!(second.as_str(), "TRAN" | "TRANSACTION" | "DISTRIBUTED"),
    "COMMIT" | "ROLLBACK" => true,
    _ => false,
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

/// 按连接串登记的 SQL Server 连接池
pub type SqlServerRegistry = crate::services::pool_registry::PoolRegistry<SqlServerPool>;

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
    let result = guarded(select_rows(&mut client, sql, params)).await;
    if keeps_connection(&result) {
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
  bind_params(&mut query, params)?;
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

/// 绑定参数。只认标量，理由同 `write_batch` 的 `bind_params!`：数组和对象走到
/// 这里说明两边漂开了，绑成一段 JSON 文本会悄悄存进去一串像数据的字符。
fn bind_params(query: &mut tiberius::Query<'_>, params: &[JsonValue]) -> Result<(), QueryError> {
  for param in params {
    match param {
      JsonValue::Null => query.bind(Option::<String>::None),
      JsonValue::Bool(value) => query.bind(*value),
      JsonValue::Number(number) => match number.as_i64() {
        Some(integer) => query.bind(integer),
        None => query.bind(number.as_f64()),
      },
      JsonValue::String(text) => query.bind(text.clone()),
      other => return Err(QueryError::message(format!("{UNSUPPORTED_PARAMETER_TYPE}: {other}"))),
    }
  }
  Ok(())
}

async fn run_simple(client: &mut SqlServerClient, sql: &str) -> Result<(), QueryError> {
  guarded(async {
    let stream = client.simple_query(sql).await.map_err(|error| query_error(error, Some(sql)))?;
    stream.into_results().await.map_err(|error| query_error(error, Some(sql)))?;
    Ok(())
  })
  .await
}

impl SqlServerPool {
  /// 一批写入，在一个事务里，要么全成要么全不成。约定与 sqlx 那三家的
  /// `write_batch::execute_write_batch` 相同。
  ///
  /// 影响行数用同一批里紧跟的 `SELECT @@ROWCOUNT` 取，不用驱动报的 DONE 计数：
  /// 表上的触发器每写一次都会多报一个计数（一条 UPDATE 触发三行审计插入，
  /// 驱动报的是 1 和 3），「必须恰好改一行」的核对就永远不过，那张表一行也
  /// 改不了。`@@ROWCOUNT` 只算这条语句自己。
  ///
  /// 这里拼接没有问题：语句是网格生成的，不是用户在编辑器里写的原文。
  pub async fn write_batch(
    self: &Arc<Self>,
    statements: &[WriteStatement],
  ) -> Result<Vec<u64>, WriteBatchError> {
    if statements.is_empty() {
      return Ok(Vec::new());
    }
    let mut connection =
      self.acquire_reusable().await.map_err(|error| WriteBatchError::at(0, error))?;
    let mut client =
      connection.take_client().await.map_err(|error| WriteBatchError::at(0, error))?;

    let mut index = 0;
    let outcome = guarded(write_in_transaction(&mut client, statements, &mut index)).await;
    // 连接要回到池子里给目录查询用，上面不能留着事务。失败时回滚不掉
    // （连接断了），这条连接就不要了——服务端会在断开时回滚
    let reusable = match &outcome {
      Ok(_) => true,
      Err(error) => {
        !breaks_connection(error)
          && run_simple(&mut client, "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION").await.is_ok()
      }
    };
    if reusable {
      connection.client = Some(client);
    }
    outcome.map_err(|error| WriteBatchError::at(index, error))
  }
}

/// `index` 记着做到了第几条，出错时由调用方标在那一条上；提交失败标在
/// `statements.len()`，和 sqlx 那边一样
async fn write_in_transaction(
  client: &mut SqlServerClient,
  statements: &[WriteStatement],
  index: &mut usize,
) -> Result<Vec<u64>, QueryError> {
  run_simple(client, "BEGIN TRANSACTION").await?;
  let mut affected = Vec::with_capacity(statements.len());
  for (position, statement) in statements.iter().enumerate() {
    *index = position;
    let sql = format!("{};\nSELECT CAST(@@ROWCOUNT AS BIGINT)", statement.sql);
    let mut query = tiberius::Query::new(sql.as_str());
    bind_params(&mut query, &statement.params)?;
    let results = query
      .query(client)
      .await
      .map_err(|error| query_error(error, Some(&statement.sql)))?
      .into_results()
      .await
      .map_err(|error| query_error(error, Some(&statement.sql)))?;
    // 触发器也可能返回结果集，行数在最后一个里
    let rows = results
      .last()
      .and_then(|set| set.first())
      .map(|row| int_cell::<i64>(row, 0))
      .transpose()?
      .and_then(|count| u64::try_from(count).ok())
      .unwrap_or(0);
    if let Some(expected) = statement.expect_rows {
      if rows != expected {
        return Err(QueryError::with_code(
          ROW_COUNT_MISMATCH_CODE,
          format!("{ROW_COUNT_MISMATCH}: {expected} · {rows}"),
        ));
      }
    }
    affected.push(rows);
  }
  *index = statements.len();
  run_simple(client, "COMMIT TRANSACTION").await?;
  Ok(affected)
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
            database_type: type_name(column.column_type()).to_string(),
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

  // 影响行数由调用方随后问 `@@ROWCOUNT` 填上，见 `SqlServerConnection::finish`
  let Some((_, column_metadata, columns)) = first else {
    return Ok(QueryExecutionSummary::Affected { rows_affected: 0 });
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

/// 结果列头上显示的类型名，照 SQL Server 自己的叫法。
///
/// TDS 只给到类型族：`intn` 可能是 tinyint 到 bigint 里的任何一种、`nvarchar`
/// 不带长度。比 tiberius 的内部名（`Intn`、`Decimaln`）好读，但精确的声明
/// 类型要看结构页。
fn type_name(column_type: ColumnType) -> &'static str {
  match column_type {
    ColumnType::Null => "null",
    ColumnType::Bit | ColumnType::Bitn => "bit",
    ColumnType::Int1 => "tinyint",
    ColumnType::Int2 => "smallint",
    ColumnType::Int4 | ColumnType::Intn => "int",
    ColumnType::Int8 => "bigint",
    ColumnType::Float4 => "real",
    ColumnType::Float8 | ColumnType::Floatn => "float",
    ColumnType::Money | ColumnType::Money4 => "money",
    ColumnType::Decimaln => "decimal",
    ColumnType::Numericn => "numeric",
    ColumnType::Datetime | ColumnType::Datetimen => "datetime",
    ColumnType::Datetime4 => "smalldatetime",
    ColumnType::Daten => "date",
    ColumnType::Timen => "time",
    ColumnType::Datetime2 => "datetime2",
    ColumnType::DatetimeOffsetn => "datetimeoffset",
    ColumnType::Guid => "uniqueidentifier",
    ColumnType::BigVarBin => "varbinary",
    ColumnType::BigBinary => "binary",
    ColumnType::Image => "image",
    ColumnType::BigVarChar => "varchar",
    ColumnType::BigChar => "char",
    ColumnType::NVarchar => "nvarchar",
    ColumnType::NChar => "nchar",
    ColumnType::Text => "text",
    ColumnType::NText => "ntext",
    ColumnType::Xml => "xml",
    ColumnType::Udt => "udt",
    ColumnType::SSVariant => "sql_variant",
  }
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
    // 老的 datetime 以 1/300 秒为刻度，照原样换算是 `.003333`：SQL Server 从
    // 字符串转 datetime 最多收三位小数，这个值写回去或拿去比较会报 241。
    // 按毫秒写（SSMS 也这么显示），转回去落在同一个刻度上
    ColumnData::DateTime(_) => time::PrimitiveDateTime::from_sql(data)
      .map_err(|error| query_error(error, None))?
      .map(|value| tagged_value("datetime", format_datetime(round_to_millisecond(value)))),
    ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
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

/// 刻度最大是 299/300 秒，四舍五入到 997 毫秒，不会进位到下一秒
fn round_to_millisecond(value: time::PrimitiveDateTime) -> time::PrimitiveDateTime {
  let millis = (value.nanosecond() + 500_000) / 1_000_000;
  value.replace_nanosecond(millis.min(999) * 1_000_000).unwrap_or(value)
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

/// 把驱动里的 panic 变成一条查询错误。
///
/// `AssertUnwindSafe` 成立的前提：panic 之后被借用的那条连接一律丢掉
/// （见 [`keeps_connection`]），不会有人再看到它半路停下的状态。
async fn guarded<T>(future: impl Future<Output = Result<T, QueryError>>) -> Result<T, QueryError> {
  match AssertUnwindSafe(future).catch_unwind().await {
    Ok(result) => result,
    Err(payload) => {
      let reason = payload
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| payload.downcast_ref::<&str>().copied())
        .unwrap_or("unknown");
      Err(QueryError::with_code(
        DRIVER_FAILURE_CODE,
        format!("{SQL_SERVER_DRIVER_FAILURE}: {reason}"),
      ))
    }
  }
}

/// 这次执行之后连接还能不能接着用：服务端报的错可以，断线与驱动失败不行
fn keeps_connection<T>(result: &Result<T, QueryError>) -> bool {
  !matches!(result, Err(error) if breaks_connection(error))
}

fn breaks_connection(error: &QueryError) -> bool {
  matches!(error.code.as_deref(), Some(CONNECTION_LOST_CODE | DRIVER_FAILURE_CODE))
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
