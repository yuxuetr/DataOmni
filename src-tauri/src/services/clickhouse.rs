//! ClickHouse：走 HTTP 的分析库。连接由后端持有，`test_connection` 连上之后把
//! [`ClickHousePool`] 登记在 [`ClickHouseRegistry`] 里，键是不带口令的连接串。
//!
//! 没有用官方的 `clickhouse` crate：它的价值在类型化的行（要为每张表写结构体），而这里
//! 要的是任意语句的原始结果；TLS 它只认 webpki 根证书，自签 CA、只加密不校验、经隧道
//! 按原主机名校验都要另写一套——那套 Elasticsearch 已经有了（`http_endpoint`）。
//! 它唯一省下的是「流到一半的异常」那一段，照着它的做法写在 [`ResultReader`] 里。
//!
//! 实验得来、值得记住的（TODOs 4.2「ClickHouse」，25.8.33 上逐条试过）：
//! - **结果用 `TabSeparatedWithNamesAndTypes`**：值是 ClickHouse 自己的文本写法，逐字节
//!   原样（`\N` 是 NULL，字符串里的 `\N` 写成 `\\N`，不混）。JSON 那一族把 `nan` 写成
//!   `null`、把不是 UTF-8 的字符串换成 U+FFFD。嵌套类型写成 ClickHouse 字面量
//!   （`['a','b']`），本身已经转义过，**不再按 TSV 反转义**。
//! - **有没有结果集看 `X-ClickHouse-Format`**：`INSERT`、`CREATE` 的回答没有这个头、没有
//!   正文，写入行数在 `X-ClickHouse-Summary` 里。不用按关键字猜。
//! - **丢掉请求，服务端照跑**：取消、超时、到了行数上限都要按 `query_id` 发 `KILL QUERY`。
//!   而那条查询跑着的时候会话是锁着的，所以下一条语句先等 KILL 回来（[`PendingKill`]）。
//! - **不带任何服务端设置**：`readonly = 1` 的账号改任何设置都被拒（164），`max_execution_time`
//!   也一样。`default_format`、`session_id`、`query_id` 不算设置，只读账号也收。
//! - **不压缩**：开着 lz4 时，流到一半的异常把之前收到的数据全裹进了消息里。
//! - 一次一条语句（服务端拒绝多条），错误位置是从 1 数的**字节**。
//!
//! 没有事务：表格一次只改一项，按「数一遍 → 执行 → 核对」走（[`ClickHousePool::write_batch`]）；
//! 按参数执行（CSV 导入）不开，见 [`CLICKHOUSE_WRITE_UNSUPPORTED`]。

use crate::models::ConnectionProfile;
use crate::services::http_endpoint::{error_chain, EndpointError, HttpEndpoint};
use crate::services::query_error::{QueryErrorDetails, CONNECTION_LOST, CONNECTION_LOST_CODE};
use crate::services::query_executor::{
  admit_row_bytes, flush_full_batch, flush_remaining_batch, number_duplicate_columns, tagged_value,
  NonQueryHandling, QueryColumnMetadata, QueryExecutionSummary, QueryResultBatch, QueryRow,
  QueryTruncationReason, StreamOptions, NON_QUERY_MESSAGE,
};
use crate::services::write_batch::{
  WriteBatchError, WriteStatement, ROW_COUNT_MISMATCH, ROW_COUNT_MISMATCH_CODE,
};
use crate::services::QueryError;
use reqwest::{Client, Response, Url};
use serde_json::{Map, Value as JsonValue};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinHandle;

/// 连接串以它开头就归这里管，与前端 `CLICKHOUSE_SCHEME` 一致
pub const CLICKHOUSE_SCHEME: &str = "clickhouse://";

/// 用户名或口令不对。冒号后面是服务端那句原话
pub const CLICKHOUSE_AUTH_FAILED: &str = "DATAOMNI_CLICKHOUSE_AUTH_FAILED";
/// 在时限内没连上：地址不通、TLS 对不上、HTTP 连到了 HTTPS 端口。冒号后面是原因
pub const CLICKHOUSE_UNREACHABLE: &str = "DATAOMNI_CLICKHOUSE_UNREACHABLE";
/// 连上的不是 ClickHouse 的 HTTP 接口（原生协议的 9000 端口、别的 HTTP 服务）
pub const CLICKHOUSE_NOT_CLICKHOUSE: &str = "DATAOMNI_CLICKHOUSE_NOT_CLICKHOUSE";
/// CA 证书文件读不了或不是证书。冒号后面带着路径
pub const CLICKHOUSE_TLS_FILE_INVALID: &str = "DATAOMNI_CLICKHOUSE_TLS_FILE_INVALID";
/// CSV 导入：没有事务，做不到「中途失败什么都不留」
pub const CLICKHOUSE_WRITE_UNSUPPORTED: &str = "DATAOMNI_CLICKHOUSE_WRITE_UNSUPPORTED";
/// 执行前数到不止一行和它一模一样（按比得准的列），分不出改哪一行；没有执行。冒号后面是行数
pub const CLICKHOUSE_ROW_AMBIGUOUS: &str = "DATAOMNI_CLICKHOUSE_ROW_AMBIGUOUS";
/// 已经执行了，但事后核对对不上——没有事务，撤不回来。冒号后面是「期望 · 实际」或核对时的错误
pub const CLICKHOUSE_WRITE_UNVERIFIED: &str = "DATAOMNI_CLICKHOUSE_WRITE_UNVERIFIED";
/// 回答的一行和表头对不上。冒号后面是「行号: 字段数/表头的列数」
pub const CLICKHOUSE_MALFORMED_RESULT: &str = "DATAOMNI_CLICKHOUSE_MALFORMED_RESULT";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 池子里的空闲连接留多久。服务端只留 10 秒（`Keep-Alive: timeout=10`，老版本是 3 秒），
/// reqwest 默认留 90 秒：留得比服务端久，就可能在服务端关连接的那一刻拿它去发请求，得到
/// 「connection closed before message completed」，而 POST 不会被自动重试。这是预防：
/// 真库用例里见过这句报错，但当时测试容器正内存不足（后台合并报 241），没法断定是这个原因，
/// 也没能稳定复现。官方 crate 取 2 秒，同一个理由
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(2);
/// KILL 本身也可能卡住（服务端忙）；等不到就不等了，下一条语句自己会报「会话锁着」
const KILL_TIMEOUT: Duration = Duration::from_secs(10);
const RESULT_FORMAT: &str = "TabSeparatedWithNamesAndTypes";
/// 服务端 `max_session_timeout` 的默认值。默认的 60 秒太短：离开一分钟，`SET` 过的设置、
/// 建的临时表就悄悄没了。管理员把上限调小时服务端报 374，照原话给出来
const SESSION_TIMEOUT_SECONDS: &str = "3600";
/// 错误回答最多读这么多
const MAX_ERROR_BYTES: usize = 64 * 1024;
/// 目录查询的回答上限。几千张表的库，列目录也就几 MB
const SELECT_BYTE_LIMIT: usize = 64 * 1024 * 1024;
/// 这几个码是认证失败：516 口令不对，192 没有这个用户，194 要口令而没给
const AUTH_ERROR_CODES: [&str; 3] = ["516", "192", "194"];

pub type ClickHouseRegistry = crate::services::pool_registry::PoolRegistry<ClickHousePool>;

#[derive(Clone)]
pub struct ClickHouseTarget {
  endpoint: HttpEndpoint,
  username: String,
  password: String,
  database: Option<String>,
}

impl ClickHouseTarget {
  /// 隧道端口单独传：HTTPS 要按原来的主机名校验证书（见 `HttpEndpoint::from_profile`）
  pub fn from_profile(profile: &ConnectionProfile, tunnel_port: Option<u16>) -> Self {
    Self {
      endpoint: HttpEndpoint::from_profile(profile, tunnel_port),
      username: profile.username.trim().to_string(),
      password: profile.password.clone(),
      database: profile
        .database
        .as_deref()
        .map(str::trim)
        .filter(|database| !database.is_empty())
        .map(str::to_string),
    }
  }
}

/// 一个连接配置在后端的全部：reqwest 的客户端（它自己管着连接池）、根地址与凭据。
/// HTTP 没有连接状态，会话靠 `session_id`（[`ClickHouseConnection`]）
pub struct ClickHousePool {
  client: Client,
  base: Url,
  username: String,
  password: String,
  database: Option<String>,
}

/// 一次请求要带的东西
#[derive(Clone, Copy)]
struct RequestParams<'a> {
  session_id: Option<&'a str>,
  query_id: &'a str,
  /// 服务端参数，按序号叫 `p1`、`p2`……（语句里写 `{p1:String}`）
  params: &'a [JsonValue],
  /// `ALTER TABLE … UPDATE / DELETE` 默认交给后台就返回；带上 `mutations_sync = 2` 等它
  /// 做完（25.8 上试过）。只在表格写入那条路上用：只读账号改不了设置，而它本来也写不了
  wait_for_mutation: bool,
}

/// 连上并 `SELECT version()`：口令错、端口不对都在这一步报出来
pub async fn connect(target: ClickHouseTarget) -> Result<Arc<ClickHousePool>, String> {
  let pool = Arc::new(ClickHousePool {
    client: target
      .endpoint
      .client(CONNECT_TIMEOUT, Some(POOL_IDLE_TIMEOUT))
      .map_err(endpoint_error)?,
    base: target.endpoint.base_url().map_err(endpoint_error)?,
    username: target.username,
    password: target.password,
    database: target.database,
  });
  let rows = tokio::time::timeout(CONNECT_TIMEOUT, pool.select("SELECT version() AS version", &[]))
    .await
    .map_err(|_| format!("{CLICKHOUSE_UNREACHABLE}: {}ms", CONNECT_TIMEOUT.as_millis()))?
    .map_err(|error| match error.code.as_deref() {
      Some(code) if AUTH_ERROR_CODES.contains(&code) => {
        format!("{CLICKHOUSE_AUTH_FAILED}: {}", error.message)
      }
      Some(CONNECTION_LOST_CODE) => {
        error.message.replacen(CONNECTION_LOST, CLICKHOUSE_UNREACHABLE, 1)
      }
      Some(_) => error.message,
      None => format!("{CLICKHOUSE_NOT_CLICKHOUSE}: {}", error.message),
    })?;
  if rows.is_empty() {
    return Err(CLICKHOUSE_NOT_CLICKHOUSE.to_string());
  }
  Ok(pool)
}

fn endpoint_error(error: EndpointError) -> String {
  match error {
    EndpointError::Unreachable(reason) => format!("{CLICKHOUSE_UNREACHABLE}: {reason}"),
    EndpointError::CertificateFile(reason) => format!("{CLICKHOUSE_TLS_FILE_INVALID}: {reason}"),
  }
}

impl ClickHousePool {
  fn request(&self, sql: &str, request: RequestParams<'_>) -> reqwest::RequestBuilder {
    let mut url = self.base.clone();
    {
      let mut query = url.query_pairs_mut();
      if let Some(database) = &self.database {
        query.append_pair("database", database);
      }
      query.append_pair("default_format", RESULT_FORMAT);
      query.append_pair("query_id", request.query_id);
      if let Some(session_id) = request.session_id {
        query.append_pair("session_id", session_id);
        query.append_pair("session_timeout", SESSION_TIMEOUT_SECONDS);
      }
      for (index, value) in request.params.iter().enumerate() {
        query.append_pair(
          &format!("param_p{}", index + 1),
          &param_text(value, param_type(sql, index + 1)),
        );
      }
      if request.wait_for_mutation {
        query.append_pair("mutations_sync", "2");
      }
    }
    let mut builder = self.client.post(url).body(sql.to_string());
    // 用户名空着就是 `default` 用户，由服务端自己认
    if !self.username.is_empty() {
      builder = builder.header("X-ClickHouse-User", &self.username);
    }
    if !self.password.is_empty() {
      builder = builder.header("X-ClickHouse-Key", &self.password);
    }
    builder
  }

  /// 发出去，拿到状态码不是 200 的就读出错误。
  ///
  /// 查询碰上「connection closed before message completed」重发一次：会话里读完一个大结果
  /// （10 万行）之后，下一个请求拿到的那条池里的连接偶尔已经被服务端关了（实测 40 次里
  /// 2～3 次；不带会话、或者结果很小都是 0 次，响应头里也没有 `Connection: close`，机制没查清）。
  /// 写语句不重发：请求可能已经到了服务端，重发就是写两遍
  async fn send(&self, sql: &str, request: RequestParams<'_>) -> Result<Response, QueryError> {
    let response = match self.request(sql, request).send().await {
      Err(error) if is_stale_connection(&error) && is_query(sql) => {
        self.request(sql, request).send().await.map_err(network_error)?
      }
      other => other.map_err(network_error)?,
    };
    if response.status().is_success() {
      return Ok(response);
    }
    Err(read_error(response, sql).await)
  }

  /// 目录查询：带服务端参数（`{p1:String}`），不在任何会话里，返回**不带类型标签**的值，
  /// 和插件 `select` 的形状一样
  pub async fn select(
    self: &Arc<Self>,
    sql: &str,
    params: &[JsonValue],
  ) -> Result<Vec<QueryRow>, QueryError> {
    let query_id = uuid::Uuid::new_v4().to_string();
    let response = self
      .send(
        sql,
        RequestParams { session_id: None, query_id: &query_id, params, wait_for_mutation: false },
      )
      .await?;
    let mut rows = Vec::new();
    let options = StreamOptions::limited(usize::MAX, SELECT_BYTE_LIMIT, usize::MAX);
    read_result(response, options, &mut |batch| {
      rows.extend(batch.rows);
      Ok(())
    })
    .await?;
    Ok(
      rows
        .into_iter()
        .map(|row| row.into_iter().map(|(k, v)| (k, untagged(v))).collect())
        .collect(),
    )
  }

  /// 表格里的一项改动，按顺序一条条执行。**没有事务**：前端把一项改动展开成
  /// 「执行前数一遍 → 执行 → 执行后核对」三条，这里照 `expect_rows` 逐条核对。
  ///
  /// - 查询比它返回的那个数（`SELECT count() …`），写语句比服务端报的写入行数
  ///   （`X-ClickHouse-Summary`；只有 `INSERT` 报得出，`ALTER … UPDATE` 与 `DELETE` 报 0，
  ///   所以前端不给它们期望值）。
  /// - `ALTER` 带 `mutations_sync = 2`，改完才返回：否则紧跟着的核对读到的是改之前的样子。
  /// - 对不上时分两种说：还没写过（什么都没变，和别家的「没有恰好影响一行」同一个码；
  ///   数到不止一行另给一个码），写过了（撤不回来，[`CLICKHOUSE_WRITE_UNVERIFIED`]）。
  ///
  /// 仍然存在、界面上写明的：数完到执行之间别处写进来一行一模一样的，会一起被改
  pub async fn write_batch(
    self: &Arc<Self>,
    statements: &[WriteStatement],
  ) -> Result<Vec<u64>, WriteBatchError> {
    let mut results = Vec::with_capacity(statements.len());
    let mut written = false;
    for (index, statement) in statements.iter().enumerate() {
      let sql = statement.sql.trim();
      let query = is_query(sql);
      let failed = |error: QueryError| WriteBatchError::at(index, after_write(error, written));
      let query_id = uuid::Uuid::new_v4().to_string();
      let request = RequestParams {
        session_id: None,
        query_id: &query_id,
        params: &statement.params,
        wait_for_mutation: !query
          && crate::services::transaction_state::leading_keywords(sql).0 == "ALTER",
      };
      let response = self.send(sql, request).await.map_err(failed)?;
      let mut rows = Vec::new();
      let options = StreamOptions::limited(usize::MAX, SELECT_BYTE_LIMIT, usize::MAX);
      let (summary, _) = read_result(response, options, &mut |batch| {
        rows.extend(batch.rows);
        Ok(())
      })
      .await
      .map_err(failed)?;
      let count = match summary {
        QueryExecutionSummary::Affected { rows_affected } => rows_affected,
        QueryExecutionSummary::Rows { .. } => first_count(&rows),
      };
      if !query {
        written = true;
      }
      if let Some(expected) = statement.expect_rows {
        if count != expected {
          return Err(WriteBatchError::at(index, count_mismatch(expected, count, written)));
        }
      }
      results.push(count);
    }
    Ok(results)
  }

  /// 停下一条查询。用自己的请求、不带会话：那个会话正被这条查询锁着
  async fn kill(&self, query_id: &str) {
    let kill_id = uuid::Uuid::new_v4().to_string();
    let request = RequestParams {
      session_id: None,
      query_id: &kill_id,
      params: &[JsonValue::String(query_id.to_string())],
      wait_for_mutation: false,
    };
    let sent = self.send("KILL QUERY WHERE query_id = {p1:String} SYNC", request);
    // 停不下来也不是这条语句的错：它已经报过取消或超时了
    let _ = tokio::time::timeout(KILL_TIMEOUT, async {
      if let Ok(response) = sent.await {
        let _ = response.bytes().await;
      }
    })
    .await;
  }

  /// 给一个会话用的连接。它上面的 `SET`、`USE`、临时表都只属于这个会话
  pub fn acquire_for_session(self: &Arc<Self>) -> ClickHouseConnection {
    ClickHouseConnection {
      pool: Arc::clone(self),
      session_id: uuid::Uuid::new_v4().to_string(),
      pending_kill: Arc::new(Mutex::new(None)),
    }
  }
}

/// 还没回来的 KILL。下一条语句先等它：被停的那条还占着会话，不等就是「会话锁着」
type PendingKill = Arc<Mutex<Option<JoinHandle<()>>>>;

/// 一个会话。
///
/// 服务端的会话一次只跑一条语句，和「一个标签一条会话连接」对得上
pub struct ClickHouseConnection {
  pool: Arc<ClickHousePool>,
  session_id: String,
  pending_kill: PendingKill,
}

/// future 被丢掉时（超时、取消）停下服务端那条查询
struct KillOnDrop {
  pool: Arc<ClickHousePool>,
  query_id: String,
  pending: PendingKill,
  finished: bool,
}

impl Drop for KillOnDrop {
  fn drop(&mut self) {
    if self.finished {
      return;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
      return;
    };
    let pool = Arc::clone(&self.pool);
    let query_id = std::mem::take(&mut self.query_id);
    let handle = runtime.spawn(async move { pool.kill(&query_id).await });
    if let Ok(mut pending) = self.pending.lock() {
      *pending = Some(handle);
    }
  }
}

impl ClickHouseConnection {
  /// 上一条被停下的查询真的停了没有。见 [`PendingKill`]
  async fn settle(&self) {
    let pending = self.pending_kill.lock().ok().and_then(|mut pending| pending.take());
    if let Some(handle) = pending {
      let _ = handle.await;
    }
  }

  pub async fn execute_streaming(
    &mut self,
    sql: &str,
    options: StreamOptions,
    sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
  ) -> Result<QueryExecutionSummary, QueryError> {
    let statement = sql.trim();
    if options.non_query == NonQueryHandling::Refuse && !is_query(statement) {
      return Err(QueryError::message(NON_QUERY_MESSAGE));
    }
    self.settle().await;
    let query_id = uuid::Uuid::new_v4().to_string();
    let mut guard = KillOnDrop {
      pool: Arc::clone(&self.pool),
      query_id: query_id.clone(),
      pending: Arc::clone(&self.pending_kill),
      finished: false,
    };
    let request = RequestParams {
      session_id: Some(&self.session_id),
      query_id: &query_id,
      params: &[],
      wait_for_mutation: false,
    };
    let response = match self.pool.send(statement, request).await {
      Ok(response) => response,
      Err(error) => {
        guard.finished = true;
        return Err(error);
      }
    };
    let outcome = read_result(response, options, sink).await;
    guard.finished = true;
    match outcome {
      Ok((summary, ReadEnd::Complete)) => Ok(summary),
      // 到了上限、不再往下读：服务端还在算，停下它，免得白占资源、占着会话
      Ok((summary, ReadEnd::Truncated)) => {
        self.pool.kill(&query_id).await;
        Ok(summary)
      }
      Err(error) => {
        self.pool.kill(&query_id).await;
        Err(error)
      }
    }
  }

  /// 只问「这条语句返回哪些列」，不执行（导出要先写表头）。`DESCRIBE` 一个子查询只做分析；
  /// 末尾换行再收括号，免得语句最后一行是 `--` 注释时把括号注释掉
  pub async fn describe_columns(
    &mut self,
    sql: &str,
  ) -> Result<Vec<QueryColumnMetadata>, QueryError> {
    let statement = sql.trim().trim_end_matches(';');
    if !is_query(statement) {
      return Ok(Vec::new());
    }
    self.settle().await;
    let query_id = uuid::Uuid::new_v4().to_string();
    let describe = format!("DESCRIBE TABLE (\n{statement}\n)");
    let request = RequestParams {
      session_id: Some(&self.session_id),
      query_id: &query_id,
      params: &[],
      wait_for_mutation: false,
    };
    let response = self.pool.send(&describe, request).await?;
    let mut rows = Vec::new();
    let options = StreamOptions::limited(usize::MAX, SELECT_BYTE_LIMIT, usize::MAX);
    read_result(response, options, &mut |batch| {
      rows.extend(batch.rows);
      Ok(())
    })
    .await?;
    let named: Vec<(String, String)> = rows
      .iter()
      .map(|row| {
        let text = |key: &str| row.get(key).and_then(JsonValue::as_str).unwrap_or("").to_string();
        (text("name"), text("type"))
      })
      .collect();
    let names = number_duplicate_columns(named.iter().map(|(name, _)| name.as_str()));
    Ok(
      names
        .into_iter()
        .zip(named)
        .enumerate()
        .map(|(ordinal, (name, (_, type_name)))| column_metadata(ordinal, name, &type_name))
        .collect(),
    )
  }

  /// 一次没有结果集可言的执行，返回写入行数
  pub async fn execute_batch(&mut self, sql: &str) -> Result<u64, QueryError> {
    let summary =
      self.execute_streaming(sql, StreamOptions::limited(1, 1 << 20, 1), &mut |_| Ok(())).await?;
    Ok(match summary {
      QueryExecutionSummary::Affected { rows_affected } => rows_affected,
      QueryExecutionSummary::Rows { .. } => 0,
    })
  }
}

/// 核对查询（`SELECT count() …`）的那一个数
fn first_count(rows: &[QueryRow]) -> u64 {
  let Some(value) = rows.first().and_then(|row| row.values().next()) else {
    return 0;
  };
  match untagged(value.clone()) {
    JsonValue::Number(number) => number.as_u64().unwrap_or(0),
    JsonValue::String(text) => text.parse().unwrap_or(0),
    JsonValue::Bool(flag) => u64::from(flag),
    _ => 0,
  }
}

fn count_mismatch(expected: u64, actual: u64, written: bool) -> QueryError {
  if written {
    return QueryError::message(format!("{CLICKHOUSE_WRITE_UNVERIFIED}: {expected} · {actual}"));
  }
  if actual > expected {
    return QueryError::message(format!("{CLICKHOUSE_ROW_AMBIGUOUS}: {actual}"));
  }
  QueryError::with_code(
    ROW_COUNT_MISMATCH_CODE,
    format!("{ROW_COUNT_MISMATCH}: {expected} · {actual}"),
  )
}

/// 写过之后的任何错误（核对查询自己失败了）都要说「已经执行」：否则用户会以为什么都没变
fn after_write(error: QueryError, written: bool) -> QueryError {
  if !written {
    return error;
  }
  QueryError::message(format!("{CLICKHOUSE_WRITE_UNVERIFIED}: {}", error.message))
}

/// 导出前拒绝非查询时用：这些关键字开头的返回行。不在这里的都当写——导出只是拒跑，
/// 认错了的代价是一句「这不是查询」。`FROM t SELECT …` 是 ClickHouse 把 FROM 写在前面的查询
fn is_query(sql: &str) -> bool {
  let (first, _) = crate::services::transaction_state::leading_keywords(sql);
  matches!(
    first.as_str(),
    "SELECT" | "WITH" | "FROM" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "EXISTS"
  ) || sql.trim_start().starts_with('(')
}

/// 语句里第 `index` 个参数写的类型：`{p1:Nullable(String)}` 里的 `Nullable(String)`
fn param_type(sql: &str, index: usize) -> Option<&str> {
  let marker = format!("{{p{index}:");
  let start = sql.find(&marker)? + marker.len();
  let length = sql[start..].find('}')?;
  Some(&sql[start..start + length])
}

/// 参数值的文本写法。服务端按 TSV 的转义读它：`\\` 是一个反斜杠、`\n` 是换行，原样的换行与制表符
/// 读不进去——字符串要照这个转义。Array / Map / Tuple 读的是字面量（界面上显示的就是它，
/// 里面的 `\'` 已经是字面量的转义），再转一层反而读不进去，原样传
fn param_text(value: &JsonValue, type_name: Option<&str>) -> String {
  match value {
    // 服务端参数的文本写法里 `\N` 是 NULL（参数类型要写成 `Nullable(…)`）
    JsonValue::Null => "\\N".to_string(),
    JsonValue::String(text) if type_name.is_some_and(is_composite_type) => text.clone(),
    JsonValue::String(text) => {
      let mut escaped = String::with_capacity(text.len());
      for character in text.chars() {
        match character {
          '\\' => escaped.push_str("\\\\"),
          '\n' => escaped.push_str("\\n"),
          '\t' => escaped.push_str("\\t"),
          '\r' => escaped.push_str("\\r"),
          '\0' => escaped.push_str("\\0"),
          other => escaped.push(other),
        }
      }
      escaped
    }
    other => other.to_string(),
  }
}

fn is_composite_type(type_name: &str) -> bool {
  let mut inner = type_name.trim();
  while let Some(rest) =
    inner.strip_prefix("Nullable(").or_else(|| inner.strip_prefix("LowCardinality("))
  {
    inner = rest;
  }
  ["Array(", "Map(", "Tuple(", "Nested("].iter().any(|prefix| inner.starts_with(prefix))
}

/// 池里拿到一条服务端已经关掉的连接。hyper 的原话，reqwest 不另给判断方法
fn is_stale_connection(error: &reqwest::Error) -> bool {
  error.is_request() && error_chain(error).contains("connection closed before message completed")
}

fn network_error(error: reqwest::Error) -> QueryError {
  QueryError::with_code(CONNECTION_LOST_CODE, format!("{CONNECTION_LOST}: {}", error_chain(&error)))
}

/// 状态码不是 200：正文是服务端那句 `Code: N. DB::Exception: …`
async fn read_error(mut response: Response, sql: &str) -> QueryError {
  let status = response.status();
  let mut bytes = Vec::new();
  while let Ok(Some(chunk)) = response.chunk().await {
    bytes.extend_from_slice(&chunk);
    if bytes.len() >= MAX_ERROR_BYTES {
      break;
    }
  }
  let text = String::from_utf8_lossy(&bytes);
  if text.contains("Exception") {
    return server_error(&text, Some(sql));
  }
  QueryError::message(format!("{CLICKHOUSE_NOT_CLICKHOUSE}: HTTP {}", status.as_u16()))
}

/// `Code: 62. DB::Exception: Syntax error: failed at position 22 (FROMM): … (SYNTAX_ERROR)
/// (version 25.8.33.6 (official build))` 拆成码、消息与位置。版本那一截不要
fn server_error(text: &str, sql: Option<&str>) -> QueryError {
  let text = text.trim();
  let text = &text[text.rfind("Code: ").unwrap_or(0)..];
  let (code, rest) = match text.strip_prefix("Code: ").and_then(|rest| rest.split_once(". ")) {
    Some((code, rest)) if code.chars().all(|c| c.is_ascii_digit()) => (Some(code), rest),
    _ => (None, text),
  };
  // `DB::Exception:`、`DB::NetException:`……
  let message = match rest.find("Exception: ") {
    Some(at) if rest[..at].starts_with("DB::") => &rest[at + "Exception: ".len()..],
    _ => rest,
  };
  let message = match message.rfind(" (version ") {
    Some(at) => &message[..at],
    None => message,
  };
  let position = sql.and_then(|sql| error_position(message, sql));
  QueryError {
    message: message.to_string(),
    code: code.map(str::to_string),
    details: position.map(|position| {
      Box::new(QueryErrorDetails { position: Some(position), ..Default::default() })
    }),
  }
}

/// 「failed at position 22」是从 1 数的字节；界面要的是从 1 数的字符
fn error_position(message: &str, sql: &str) -> Option<u32> {
  let at = message.find("failed at position ")? + "failed at position ".len();
  let digits: String = message[at..].chars().take_while(char::is_ascii_digit).collect();
  let byte = digits.parse::<usize>().ok()?.checked_sub(1)?;
  let prefix = sql.get(..byte.min(sql.len()))?;
  u32::try_from(prefix.chars().count() + 1).ok()
}

/// 读完了，还是读到上限就停了
#[derive(Debug, PartialEq)]
enum ReadEnd {
  Complete,
  Truncated,
}

/// 把一次回答读成结果集。
///
/// 按行读，**晚一行**再交出去：流到一半的异常写在最后，而且可能紧跟在半行数据后面——
/// 25.11 之前是末尾一行 `Code: N. DB::Exception: …`，之后是由 `X-ClickHouse-Exception-Tag`
/// 标出的一段。晚一行，读到结尾时手里那一行就还没交出去，是异常就不当数据。
/// （官方 crate 只看最后一个数据块的末尾，异常被切在两块之间时认不出。）
async fn read_result(
  mut response: Response,
  options: StreamOptions,
  sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
) -> Result<(QueryExecutionSummary, ReadEnd), QueryError> {
  let headers = response.headers();
  let header =
    |name: &str| headers.get(name).and_then(|value| value.to_str().ok()).map(str::to_string);
  let Some(format) = header("X-ClickHouse-Format") else {
    // 没有结果集：写入行数在摘要里
    let written =
      header("X-ClickHouse-Summary").and_then(|summary| written_rows(&summary)).unwrap_or(0);
    while response.chunk().await.map_err(network_error)?.is_some() {}
    return Ok((QueryExecutionSummary::Affected { rows_affected: written }, ReadEnd::Complete));
  };
  let tag = header("X-ClickHouse-Exception-Tag");
  let mut reader = ResultReader::new(format != RESULT_FORMAT, tag, options);
  let mut end = ReadEnd::Complete;
  'read: loop {
    let chunk = match response.chunk().await {
      Ok(Some(chunk)) => chunk,
      Ok(None) => break,
      // 服务端写完异常就断开，不给分块的结尾（25.8 上见过「unexpected EOF during chunk
      // size line」）：手里已经有那段异常了，报它，不报「连接断了」
      Err(error) => {
        return Err(reader.received_exception().unwrap_or_else(|| network_error(error)))
      }
    };
    reader.buffer.extend_from_slice(&chunk);
    while let Some(line) = reader.next_line() {
      if !reader.push_line(line, sink)? {
        end = ReadEnd::Truncated;
        break 'read;
      }
    }
  }
  if end == ReadEnd::Complete {
    reader.finish(sink)?;
  }
  Ok((reader.summary(), end))
}

fn written_rows(summary: &str) -> Option<u64> {
  let summary: JsonValue = serde_json::from_str(summary).ok()?;
  summary.get("written_rows")?.as_str()?.parse().ok()
}

struct ResultReader {
  buffer: Vec<u8>,
  /// 语句自己写了 `FORMAT JSON` 这类：不按 TSV 解，每行原样一格
  raw: bool,
  tag: Option<String>,
  options: StreamOptions,
  names: Option<Vec<String>>,
  columns: Option<Vec<(String, ColumnKind, String)>>,
  /// 晚一行交出去的那一行
  held: Option<Vec<u8>>,
  /// 25.11 之后的异常段开始了：之后的都是它
  exception: Option<Vec<u8>>,
  rows: Vec<QueryRow>,
  row_count: usize,
  batch_count: usize,
  bytes_read: usize,
  truncation_reason: Option<QueryTruncationReason>,
}

impl ResultReader {
  fn new(raw: bool, tag: Option<String>, options: StreamOptions) -> Self {
    Self {
      buffer: Vec::new(),
      raw,
      tag,
      options,
      names: None,
      columns: None,
      held: None,
      exception: None,
      rows: Vec::with_capacity(options.batch_size.min(1024)),
      row_count: 0,
      batch_count: 0,
      bytes_read: 0,
      truncation_reason: None,
    }
  }

  fn next_line(&mut self) -> Option<Vec<u8>> {
    let end = self.buffer.iter().position(|byte| *byte == b'\n')?;
    let mut line: Vec<u8> = self.buffer.drain(..=end).collect();
    line.pop();
    Some(line)
  }

  /// 返回 false 表示到了上限，不要再读
  fn push_line(
    &mut self,
    line: Vec<u8>,
    sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
  ) -> Result<bool, QueryError> {
    if let Some(exception) = &mut self.exception {
      exception.extend_from_slice(&line);
      exception.push(b'\n');
      return Ok(true);
    }
    // 25.8 也写这一行（后面直接是消息，不带标记）；25.11 起后面是带标记的一段。
    // 前面那一行可能是被打断的半行（以 `\r` 结尾）——反正这一次是错误，一并不要
    if line == b"__exception__\r" {
      self.held = None;
      self.exception = Some(Vec::new());
      return Ok(true);
    }
    if self.raw {
      if self.columns.is_none() {
        self.columns = Some(vec![("result".to_string(), ColumnKind::Text, "String".to_string())]);
      }
    } else if self.columns.is_some() {
      // 表头读完了，这一行是数据
    } else if self.names.is_none() {
      self.names = Some(split_fields(&line).iter().map(|field| lossy(&unescape(field))).collect());
      return Ok(true);
    } else {
      let names = self.names.take().unwrap_or_default();
      let types: Vec<String> =
        split_fields(&line).iter().map(|field| lossy(&unescape(field))).collect();
      let labels = number_duplicate_columns(names.iter().map(String::as_str));
      self.columns = Some(
        labels
          .into_iter()
          .zip(types)
          .map(|(name, type_name)| (name, ColumnKind::of(&type_name), type_name))
          .collect(),
      );
      return Ok(true);
    }
    match self.held.replace(line) {
      Some(previous) => self.admit(previous, sink),
      None => Ok(true),
    }
  }

  fn admit(
    &mut self,
    line: Vec<u8>,
    sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
  ) -> Result<bool, QueryError> {
    if self.row_count >= self.options.row_limit {
      self.truncation_reason = Some(QueryTruncationReason::RowLimit);
      return Ok(false);
    }
    let row = self.decode_row(&line)?;
    if !admit_row_bytes(&row, self.options.byte_limit, &mut self.bytes_read)? {
      self.truncation_reason = Some(QueryTruncationReason::ByteLimit);
      return Ok(false);
    }
    self.rows.push(row);
    self.row_count += 1;
    flush_full_batch(
      &mut self.rows,
      self.options.batch_size,
      &mut self.batch_count,
      self.row_count,
      sink,
    )?;
    Ok(true)
  }

  fn decode_row(&self, line: &[u8]) -> Result<QueryRow, QueryError> {
    let columns = self.columns.as_deref().unwrap_or_default();
    if self.raw {
      return Ok(Map::from_iter([(columns[0].0.clone(), JsonValue::String(lossy(line)))]));
    }
    let fields = split_fields(line);
    if fields.len() != columns.len() {
      return Err(QueryError::message(format!(
        "{CLICKHOUSE_MALFORMED_RESULT}: {}: {}/{}",
        self.row_count + 1,
        fields.len(),
        columns.len()
      )));
    }
    Ok(
      columns
        .iter()
        .zip(fields)
        .map(|((name, kind, _), field)| (name.clone(), decode(field, *kind)))
        .collect(),
    )
  }

  /// 已经收到的异常：`__exception__` 之后的那一段，或者末尾那一行老格式的
  fn received_exception(&self) -> Option<QueryError> {
    if let Some(exception) = &self.exception {
      let mut exception = exception.clone();
      exception.extend_from_slice(&self.buffer);
      return Some(match self.tag.as_deref() {
        Some(tag) => tagged_exception(&exception, tag),
        None => server_error(&String::from_utf8_lossy(&exception), None),
      });
    }
    let mut tail = self.held.clone().unwrap_or_default();
    tail.extend_from_slice(&self.buffer);
    trailing_exception(&tail)
  }

  /// 读到结尾：手里那一行要么是异常，要么是最后一行数据
  fn finish(
    &mut self,
    sink: &mut (dyn FnMut(QueryResultBatch) -> Result<(), QueryError> + Send),
  ) -> Result<(), QueryError> {
    if self.exception.is_some() {
      if let Some(error) = self.received_exception() {
        return Err(error);
      }
    }
    // 没有换行结尾的残段：老格式的异常就是这样接在半行数据后面的
    let rest = std::mem::take(&mut self.buffer);
    let last = match (self.held.take(), rest.is_empty()) {
      (Some(mut held), false) => {
        held.push(b'\n');
        held.extend_from_slice(&rest);
        Some(held)
      }
      (held, true) => held,
      (None, false) => Some(rest),
    };
    if let Some(line) = last {
      if let Some(error) = trailing_exception(&line) {
        return Err(error);
      }
      self.admit(line, sink)?;
    }
    flush_remaining_batch(&mut self.rows, &mut self.batch_count, self.row_count, sink)
  }

  fn summary(&mut self) -> QueryExecutionSummary {
    let (columns, column_metadata) = match self.columns.take() {
      Some(columns) => (
        columns.iter().map(|(name, _, _)| name.clone()).collect(),
        columns
          .iter()
          .enumerate()
          .map(|(ordinal, (name, _, type_name))| column_metadata(ordinal, name.clone(), type_name))
          .collect(),
      ),
      None => (Vec::new(), Vec::new()),
    };
    QueryExecutionSummary::Rows {
      columns,
      column_metadata,
      row_count: self.row_count,
      batch_count: self.batch_count,
      truncated: self.truncation_reason.is_some(),
      truncation_reason: self.truncation_reason,
      row_limit: self.options.row_limit,
      byte_limit: self.options.byte_limit,
      bytes_read: self.bytes_read,
      omitted_result_sets: 0,
    }
  }
}

/// 更早的版本：数据后面直接接一行 `Code: N. DB::Exception: … (version …)`，没有
/// `__exception__` 那一行
fn trailing_exception(line: &[u8]) -> Option<QueryError> {
  let text = String::from_utf8_lossy(line);
  let at = text.rfind("Code: ")?;
  let tail = &text[at..];
  (tail.contains("DB::") && tail.contains("Exception: ") && tail.contains(" (version "))
    .then(|| server_error(tail, None))
}

/// 25.11 起：`__exception__\r\n<tag>\r\n<消息>\n<消息长度> <tag>\r\n__exception__\r\n`。
/// 这里拿到的是第一个 `__exception__` 之后的全部
fn tagged_exception(block: &[u8], tag: &str) -> QueryError {
  let text = String::from_utf8_lossy(block);
  let text = text.strip_prefix(&format!("{tag}\r\n")).unwrap_or(&text);
  let text = text.strip_suffix("__exception__\r\n").unwrap_or(text);
  let message = match text.trim_end().rfind('\n') {
    Some(at) => &text[..at],
    None => text,
  };
  server_error(message, None)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ColumnKind {
  Bool,
  /// 32 位以内：JavaScript 的数放得下
  SmallInteger,
  /// 64 位以上：超出安全整数的带标签、以文本传
  BigInteger,
  Float,
  /// 带着小数位数：ClickHouse 输出时去掉末尾的 0（`Decimal(10, 2)` 的 10.50 写成 `10.5`），
  /// 别家都按列的位数写。补回来不改值，免得同一列里 `10.5` 与 `10.25` 看着像两种精度
  Decimal(Option<usize>),
  Date,
  DateTime,
  Time,
  Text,
  /// 数组、元组、Map、JSON……：值是 ClickHouse 字面量，已经转义过
  Composite,
  /// `Nullable(Nothing)`，即 `SELECT NULL`
  Nothing,
}

impl ColumnKind {
  fn of(type_name: &str) -> Self {
    let base = unwrap_type(type_name);
    let head = base.split('(').next().unwrap_or(base);
    match head {
      "Bool" => Self::Bool,
      "Int8" | "Int16" | "Int32" | "UInt8" | "UInt16" | "UInt32" => Self::SmallInteger,
      "Int64" | "UInt64" | "Int128" | "UInt128" | "Int256" | "UInt256" => Self::BigInteger,
      "Float32" | "Float64" | "BFloat16" => Self::Float,
      "Decimal" | "Decimal32" | "Decimal64" | "Decimal128" | "Decimal256" => {
        Self::Decimal(decimal_scale(base))
      }
      "Date" | "Date32" => Self::Date,
      "DateTime" | "DateTime64" => Self::DateTime,
      "Time" | "Time64" => Self::Time,
      "Array" | "Tuple" | "Map" | "Nested" | "JSON" | "Object" | "Point" | "Ring"
      | "LineString" | "MultiLineString" | "Polygon" | "MultiPolygon" => Self::Composite,
      "Nothing" => Self::Nothing,
      _ => Self::Text,
    }
  }

  fn logical_type(self) -> &'static str {
    match self {
      Self::Bool => "boolean",
      Self::SmallInteger | Self::BigInteger => "integer",
      Self::Float | Self::Decimal(_) => "decimal",
      Self::Date => "date",
      Self::DateTime => "datetime",
      Self::Time => "time",
      Self::Text | Self::Composite | Self::Nothing => "text",
    }
  }
}

/// `Decimal(P, S)` 与 `Decimal64(S)` 里的 S
fn decimal_scale(type_name: &str) -> Option<usize> {
  let arguments = type_name.split_once('(')?.1.strip_suffix(')')?;
  arguments.rsplit(',').next()?.trim().parse().ok()
}

fn pad_scale(text: &str, scale: Option<usize>) -> String {
  let Some(scale) = scale.filter(|scale| *scale > 0) else {
    return text.to_string();
  };
  let decimals = text.split_once('.').map_or(0, |(_, fraction)| fraction.len());
  if decimals >= scale {
    return text.to_string();
  }
  let point = if decimals == 0 { "." } else { "" };
  format!("{text}{point}{}", "0".repeat(scale - decimals))
}

/// 去掉不改变值的外壳：`Nullable(T)`、`LowCardinality(T)`
fn unwrap_type(type_name: &str) -> &str {
  let mut current = type_name.trim();
  loop {
    let inner = ["Nullable(", "LowCardinality("]
      .iter()
      .find_map(|wrapper| current.strip_prefix(wrapper).and_then(|rest| rest.strip_suffix(')')));
    match inner {
      Some(inner) => current = inner.trim(),
      None => return current,
    }
  }
}

fn column_metadata(ordinal: usize, name: String, type_name: &str) -> QueryColumnMetadata {
  let unwrapped = type_name.trim().strip_prefix("LowCardinality(").unwrap_or(type_name.trim());
  QueryColumnMetadata {
    name,
    ordinal,
    database_type: type_name.to_string(),
    logical_type: ColumnKind::of(type_name).logical_type().to_string(),
    nullable: Some(unwrapped.starts_with("Nullable(")),
  }
}

fn split_fields(line: &[u8]) -> Vec<&[u8]> {
  line.split(|byte| *byte == b'\t').collect()
}

/// TSV 的反转义：`\t` `\n` `\\` 这些。别的反斜杠序列原样留着
fn unescape(field: &[u8]) -> Vec<u8> {
  let mut out = Vec::with_capacity(field.len());
  let mut bytes = field.iter();
  while let Some(&byte) = bytes.next() {
    if byte != b'\\' {
      out.push(byte);
      continue;
    }
    match bytes.next() {
      Some(b'b') => out.push(0x08),
      Some(b'f') => out.push(0x0c),
      Some(b'n') => out.push(b'\n'),
      Some(b'r') => out.push(b'\r'),
      Some(b't') => out.push(b'\t'),
      Some(b'0') => out.push(0),
      Some(b'a') => out.push(0x07),
      Some(b'v') => out.push(0x0b),
      Some(&other @ (b'\\' | b'\'' | b'"')) => out.push(other),
      Some(&other) => out.extend_from_slice(&[b'\\', other]),
      None => out.push(b'\\'),
    }
  }
  out
}

fn lossy(bytes: &[u8]) -> String {
  String::from_utf8_lossy(bytes).into_owned()
}

/// JavaScript 数能精确表示的最大整数
const MAX_SAFE_INTEGER: i128 = (1 << 53) - 1;

/// 一个单元格。约定与另外几家相同：超出安全整数的、小数、时间与二进制带类型标签，
/// 以文本传；其余是裸值
fn decode(field: &[u8], kind: ColumnKind) -> JsonValue {
  if field == b"\\N" || kind == ColumnKind::Nothing {
    return JsonValue::Null;
  }
  if kind == ColumnKind::Composite {
    return text_or_binary(field.to_vec());
  }
  let bytes = unescape(field);
  let Ok(text) = std::str::from_utf8(&bytes) else {
    return binary(&bytes);
  };
  match kind {
    ColumnKind::Bool => match text {
      "true" => JsonValue::Bool(true),
      "false" => JsonValue::Bool(false),
      _ => JsonValue::String(text.to_string()),
    },
    ColumnKind::SmallInteger => text
      .parse::<i64>()
      .map(JsonValue::from)
      .unwrap_or_else(|_| JsonValue::String(text.to_string())),
    ColumnKind::BigInteger => match text.parse::<i128>() {
      Ok(value) if value.unsigned_abs() <= MAX_SAFE_INTEGER.unsigned_abs() => {
        JsonValue::from(value as i64)
      }
      _ => tagged_value("bigint", text.to_string()),
    },
    // `nan`、`inf` 原样是文字：JSON 里没有这两个数
    ColumnKind::Float => text
      .parse::<f64>()
      .ok()
      .filter(|value| value.is_finite())
      .and_then(serde_json::Number::from_f64)
      .map(JsonValue::Number)
      .unwrap_or_else(|| JsonValue::String(text.to_string())),
    ColumnKind::Decimal(scale) => tagged_value("decimal", pad_scale(text, scale)),
    ColumnKind::Date => tagged_value("date", text.to_string()),
    ColumnKind::DateTime => tagged_value("datetime", text.to_string()),
    ColumnKind::Time => tagged_value("time", text.to_string()),
    ColumnKind::Text | ColumnKind::Composite | ColumnKind::Nothing => {
      JsonValue::String(text.to_string())
    }
  }
}

fn text_or_binary(bytes: Vec<u8>) -> JsonValue {
  match String::from_utf8(bytes) {
    Ok(text) => JsonValue::String(text),
    Err(error) => binary(error.as_bytes()),
  }
}

fn binary(bytes: &[u8]) -> JsonValue {
  tagged_value("binary", bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// 目录查询给的是裸值（插件的形状）
fn untagged(value: JsonValue) -> JsonValue {
  match value {
    JsonValue::Object(mut map) if map.contains_key("type") => {
      map.remove("value").unwrap_or(JsonValue::Null)
    }
    other => other,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn row(line: &str, types: &[&str]) -> Vec<JsonValue> {
    let kinds: Vec<ColumnKind> = types.iter().map(|type_name| ColumnKind::of(type_name)).collect();
    split_fields(line.as_bytes())
      .into_iter()
      .zip(kinds)
      .map(|(field, kind)| decode(field, kind))
      .collect()
  }

  /// 实验里 25.8 给的原样一行（`cat -vet` 抄下来的）
  #[test]
  fn values_keep_their_precision_and_their_clickhouse_spelling() {
    let values = row(
      "18446744073709551615\t1234567890.123456789\t1.5\tnan\t\\N\t['x\\ty','o\\'k']\t{'k':1}\t2024-01-02\t2024-01-02 03:04:05.123\ttrue\t3\tline\\nbreak\\\\x\t\\\\N",
      &[
        "UInt64",
        "Decimal(38, 9)",
        "Float64",
        "Float64",
        "Nullable(Nothing)",
        "Array(String)",
        "Map(String, UInt8)",
        "Date",
        "DateTime64(3, 'Asia/Shanghai')",
        "Bool",
        "Nullable(UInt8)",
        "String",
        "String",
      ],
    );
    assert_eq!(values[0], tagged_value("bigint", "18446744073709551615".into()));
    assert_eq!(values[1], tagged_value("decimal", "1234567890.123456789".into()));
    assert_eq!(values[2], JsonValue::from(1.5));
    assert_eq!(values[3], JsonValue::from("nan"));
    assert_eq!(values[4], JsonValue::Null);
    // 嵌套值不反转义：`\t` 与 `\'` 是它字面量写法的一部分
    assert_eq!(values[5], JsonValue::from("['x\\ty','o\\'k']"));
    assert_eq!(values[6], JsonValue::from("{'k':1}"));
    assert_eq!(values[7], tagged_value("date", "2024-01-02".into()));
    assert_eq!(values[8], tagged_value("datetime", "2024-01-02 03:04:05.123".into()));
    assert_eq!(values[9], JsonValue::Bool(true));
    assert_eq!(values[10], JsonValue::from(3));
    assert_eq!(values[11], JsonValue::from("line\nbreak\\x"));
    // 字符串 `\N` 写成 `\\N`，不是 NULL
    assert_eq!(values[12], JsonValue::from("\\N"));
  }

  /// 打包版上撞到的：服务端按 TSV 转义读参数，原样传时 `a\\b` 存成 `a\b`、`a\b` 存成退格符，
  /// 换行与制表符直接报 BAD_QUERY_PARAMETER。Array / Map / Tuple 按字面量读，再转义一次反而报错。
  /// 25.8 上逐个核过
  #[test]
  fn string_parameters_are_escaped_the_way_the_server_reads_them() {
    let sql = "ALTER TABLE t UPDATE s = {p1:String} WHERE a = {p2:Array(Nullable(String))} \
      AND n = {p3:Nullable(String)} AND m = {p4:Map(String, UInt8)} AND l = {p5:LowCardinality(Nullable(String))}";
    let text =
      |index: usize, value: &str| param_text(&JsonValue::from(value), param_type(sql, index));
    assert_eq!(text(1, "multi\nline\t\\ \\N\r"), "multi\\nline\\t\\\\ \\\\N\\r");
    assert_eq!(text(2, "['q\\'s',NULL]"), "['q\\'s',NULL]");
    assert_eq!(text(3, "a\\b"), "a\\\\b");
    assert_eq!(text(4, "{'k\\'':1}"), "{'k\\'':1}");
    assert_eq!(text(5, "\n"), "\\n");
    assert_eq!(param_text(&JsonValue::Null, param_type(sql, 3)), "\\N");
    assert_eq!(param_text(&JsonValue::from(7), param_type(sql, 1)), "7");
  }

  /// 打包版上撞到的：Int128 最小值取 `abs()` 溢出回绕成负数，被当成安全整数截成了 0
  #[test]
  fn the_most_negative_integers_stay_whole() {
    let kind = ColumnKind::of("Int128");
    for text in ["-170141183460469231731687303715884105728", "-9007199254740992"] {
      assert_eq!(decode(text.as_bytes(), kind), tagged_value("bigint", text.into()));
    }
    assert_eq!(decode(b"-9007199254740991", kind), JsonValue::from(-9_007_199_254_740_991_i64));
  }

  #[test]
  fn decimals_are_written_with_the_columns_scale() {
    let kind = ColumnKind::of("Decimal(10, 2)");
    assert_eq!(decode(b"10.5", kind), tagged_value("decimal", "10.50".into()));
    assert_eq!(decode(b"-3", kind), tagged_value("decimal", "-3.00".into()));
    assert_eq!(decode(b"10.25", kind), tagged_value("decimal", "10.25".into()));
    assert_eq!(decode(b"7", ColumnKind::of("Decimal(10, 0)")), tagged_value("decimal", "7".into()));
  }

  #[test]
  fn bytes_that_are_not_utf8_come_back_as_binary() {
    let values = row("\u{0}", &["String"]);
    assert_eq!(values[0], JsonValue::from("\u{0}"));
    let kind = ColumnKind::of("String");
    assert_eq!(decode(&[0xff, b'\\', b'0'], kind), tagged_value("binary", "ff00".into()));
  }

  #[test]
  fn wrappers_do_not_change_the_kind() {
    assert_eq!(ColumnKind::of("LowCardinality(Nullable(String))"), ColumnKind::Text);
    assert_eq!(ColumnKind::of("Nullable(Decimal(10, 2))"), ColumnKind::Decimal(Some(2)));
    assert_eq!(ColumnKind::of("Decimal64(4)"), ColumnKind::Decimal(Some(4)));
    assert_eq!(ColumnKind::of("Array(Nullable(Int64))"), ColumnKind::Composite);
    assert_eq!(ColumnKind::of("Int64"), ColumnKind::BigInteger);
    assert_eq!(
      column_metadata(0, "a".into(), "LowCardinality(Nullable(String))").nullable,
      Some(true)
    );
    assert_eq!(column_metadata(0, "a".into(), "Array(Nullable(String))").nullable, Some(false));
  }

  #[test]
  fn server_errors_become_a_code_a_message_and_a_character_position() {
    let sql = "SELECT '日本' AS a FROMM t";
    let error = server_error(
      "Code: 62. DB::Exception: Syntax error: failed at position 22 (FROMM): FROMM t. Expected one of: FROM. (SYNTAX_ERROR) (version 25.8.33.6 (official build))\n",
      Some(sql),
    );
    assert_eq!(error.code.as_deref(), Some("62"));
    assert_eq!(
      error.message,
      "Syntax error: failed at position 22 (FROMM): FROMM t. Expected one of: FROM. (SYNTAX_ERROR)"
    );
    // 字节 22 是字符 18：前面的两个汉字各占三个字节
    assert_eq!(error.position(), Some(18));
    assert_eq!(&sql[21..26], "FROMM");
  }

  fn reader(tag: Option<&str>) -> ResultReader {
    ResultReader::new(false, tag.map(str::to_string), StreamOptions::limited(100, 1 << 20, 10))
  }

  fn feed(reader: &mut ResultReader, text: &[u8]) -> Result<Vec<QueryRow>, QueryError> {
    let mut rows = Vec::new();
    let mut sink = |batch: QueryResultBatch| {
      rows.extend(batch.rows);
      Ok(())
    };
    reader.buffer.extend_from_slice(text);
    while let Some(line) = reader.next_line() {
      reader.push_line(line, &mut sink)?;
    }
    reader.finish(&mut sink)?;
    Ok(rows)
  }

  #[test]
  fn a_complete_answer_yields_every_row() {
    let rows = feed(&mut reader(None), b"n\tv\nUInt8\tString\n1\ta\n2\tb\n").expect("rows");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1]["v"], JsonValue::from("b"));
  }

  /// 实验里的原样：老格式的异常接在最后一行数据之后
  #[test]
  fn an_exception_after_the_data_is_an_error_not_a_row() {
    let body = b"number\tx\nUInt64\tUInt8\n49999\t0\nCode: 395. DB::Exception: boom: while executing 'FUNCTION throwIf'. (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO) (version 25.8.33.6 (official build))\n";
    let error = feed(&mut reader(None), body).expect_err("exception");
    assert_eq!(error.code.as_deref(), Some("395"));
    assert!(error.message.starts_with("boom"), "{}", error.message);
    // 接在半行数据后面也认得出
    let body = b"number\tx\nUInt64\tUInt8\n1\t0\n4999Code: 395. DB::Exception: boom. (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO) (version 25.8.33.6 (official build))\n";
    assert_eq!(feed(&mut reader(None), body).expect_err("exception").code.as_deref(), Some("395"));
  }

  /// 25.8 带会话时的原样：数据之后一行 `__exception__\r`，再是消息，没有标记
  #[test]
  fn an_untagged_exception_marker_is_an_error_too() {
    let body = b"number\tx\nUInt64\tUInt8\n49998\t0\n49999\t0\n__exception__\r\nCode: 395. DB::Exception: boom: while executing 'FUNCTION throwIf'. (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO) (version 25.8.33.6 (official build))\n";
    let error = feed(&mut reader(None), body).expect_err("exception");
    assert_eq!(error.code.as_deref(), Some("395"));
    assert!(error.message.starts_with("boom"), "{}", error.message);
  }

  /// 官方 crate 测试里 25.12 的原样一段
  #[test]
  fn a_tagged_exception_is_an_error_and_the_half_row_before_it_is_dropped() {
    let tag = "rnywyenlaeqynhmu";
    let body = b"n\nUInt64\n1\n2\r\n__exception__\r\nrnywyenlaeqynhmu\r\nCode: 159. DB::Exception: Timeout exceeded: elapsed 126.147987 ms, maximum: 100 ms. (TIMEOUT_EXCEEDED) (version 25.12.1.649 (official build))\n142 rnywyenlaeqynhmu\r\n__exception__\r\n";
    let mut rows = Vec::new();
    let mut reader = reader(Some(tag));
    let mut sink = |batch: QueryResultBatch| {
      rows.extend(batch.rows);
      Ok(())
    };
    reader.buffer.extend_from_slice(body);
    while let Some(line) = reader.next_line() {
      reader.push_line(line, &mut sink).expect("lines");
    }
    let error = reader.finish(&mut sink).expect_err("exception");
    assert_eq!(error.code.as_deref(), Some("159"));
    assert_eq!(
      error.message,
      "Timeout exceeded: elapsed 126.147987 ms, maximum: 100 ms. (TIMEOUT_EXCEEDED)"
    );
    // 收下的只有第一行，被打断的「2\r」不算数据（报错之后这一批本来就不交出去）
    assert_eq!(reader.row_count, 1);
    assert!(rows.is_empty());
  }

  #[test]
  fn the_row_limit_stops_reading_and_counts_as_truncated() {
    let mut reader = ResultReader::new(false, None, StreamOptions::limited(2, 1 << 20, 10));
    let mut sink = |_: QueryResultBatch| Ok(());
    reader.buffer.extend_from_slice(b"n\nUInt8\n1\n2\n3\n4\n");
    let mut stopped = false;
    while let Some(line) = reader.next_line() {
      if !reader.push_line(line, &mut sink).expect("lines") {
        stopped = true;
        break;
      }
    }
    assert!(stopped);
    match reader.summary() {
      QueryExecutionSummary::Rows { row_count, truncated, .. } => {
        assert_eq!(row_count, 2);
        assert!(truncated);
      }
      QueryExecutionSummary::Affected { .. } => panic!("rows expected"),
    }
    // 恰好等于上限不算截断
    let rows = feed(
      &mut ResultReader::new(false, None, StreamOptions::limited(2, 1 << 20, 10)),
      b"n\nUInt8\n1\n2\n",
    )
    .expect("rows");
    assert_eq!(rows.len(), 2);
  }

  #[test]
  fn statements_that_return_rows_are_told_apart_for_export() {
    for sql in [
      "SELECT 1",
      "with x as (select 1) select * from x",
      "SHOW TABLES",
      "(SELECT 1)",
      "EXPLAIN SELECT 1",
      // FROM 写在 SELECT 前面，26.9 上试过
      "FROM system.one SELECT dummy",
    ] {
      assert!(is_query(sql), "{sql}");
    }
    for sql in ["INSERT INTO t VALUES (1)", "ALTER TABLE t DELETE WHERE 1", "OPTIMIZE TABLE t"] {
      assert!(!is_query(sql), "{sql}");
    }
  }
}
