//! Neo4j：第三种非关系型库。
//!
//! 连接由后端持有，与 MongoDB、Redis 同一个办法：`test_connection` 连上之后把 [`Neo4jPool`]
//! 登记在 [`Neo4jRegistry`] 里，键是不带口令的 `bolt://user@host:port/库`。
//!
//! 和前两家不同、值得记住的：
//! - **驱动是同步的**（`neo4j` crate，Bolt 5，见 TODOs 4.3 为什么不用 neo4rs）。每次调用放进
//!   `spawn_blocking`；时限交给服务端的事务超时——到点服务端自己停，本机只多等一个网络来回。
//! - **结果的值是图**：节点、关系、路径、时间、空间点……往前端送带 `kind` 的 [`CypherValue`]，
//!   怎么写成 Cypher 字面量由前端决定（`utils/cypherValue.ts`）。
//! - **属性是无序的**（驱动给的是 `HashMap`）：按名字排好再送，同一个节点每次看都是同一个次序。

use crate::models::{ConnectionProfile, TlsMode};
use crate::services::pool_registry::PoolRegistry;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use neo4j::address::Address;
use neo4j::driver::auth::AuthToken;
use neo4j::driver::{ConnectionConfig, Driver, DriverConfig, Record};
use neo4j::session::SessionConfig;
use neo4j::summary::{Summary, SummaryQueryType};
use neo4j::transaction::TransactionTimeout;
use neo4j::value::graph::{Node, RelationshipDirection, UnboundRelationship};
use neo4j::{Neo4jError, ValueReceive};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// 与前端 `NEO4J_SCHEME` 一致：连接串以它开头就归这里管
pub const NEO4J_SCHEME: &str = "bolt://";

/// 用户名或口令不对（`Neo.ClientError.Security.Unauthorized`）
pub const NEO4J_AUTH_FAILED: &str = "DATAOMNI_NEO4J_AUTH_FAILED";
/// 在时限内没连上：地址不通、TLS 对不上、服务没起
pub const NEO4J_UNREACHABLE: &str = "DATAOMNI_NEO4J_UNREACHABLE";
/// 没有这个库（`Neo.ClientError.Database.DatabaseNotFound`）。冒号后面是库名那句原话
pub const NEO4J_DATABASE_NOT_FOUND: &str = "DATAOMNI_NEO4J_DATABASE_NOT_FOUND";
/// 服务端报错，冒号后面是 `Neo4j 的状态码: 原话`（原话里带着行列与出错那一行）
pub const NEO4J_SERVER_ERROR: &str = "DATAOMNI_NEO4J_SERVER_ERROR";
/// 超过了查询时限（服务端按事务超时停下，或本机等不到回答）
pub const NEO4J_TIMEOUT: &str = "DATAOMNI_NEO4J_TIMEOUT";
/// CA 证书文件读不了或不是证书。冒号后面带着路径
pub const NEO4J_TLS_FILE_INVALID: &str = "DATAOMNI_NEO4J_TLS_FILE_INVALID";
/// 连接串对应的连接不在（断开之后还有请求过来）
pub const NEO4J_NOT_CONNECTED: &str = "DATAOMNI_DB_SESSION_NOT_CONNECTED";

/// 连上的等待上限。和前端建立会话的 15 秒错开，让这里先报出原因
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 服务端按事务超时停下之后，回答还要走一个网络来回；本机多等这么久再放弃
const TIMEOUT_GRACE: Duration = Duration::from_secs(5);

/// 连接在池子里空闲超过这么久，拿出来用之前先确认它还活着。经隧道或 NAT 时空闲的
/// 连接会被悄悄丢掉（MySQL 那边实测 3～6 分钟，TODOs「发布里程碑」），不先确认的话
/// 第一条查询要等到超时才报断线
const IDLE_BEFORE_LIVENESS_CHECK: Duration = Duration::from_secs(30);

pub type Neo4jRegistry = PoolRegistry<Neo4jPool>;

#[derive(Clone)]
pub struct Neo4jTarget {
  host: String,
  port: u16,
  username: String,
  password: String,
  /// 表单上「库」那一格；空着就是这个用户的主库（服务端决定）
  database: Option<String>,
  tls: TlsMode,
  ca_certificate_path: Option<String>,
}

impl Neo4jTarget {
  pub fn from_profile(profile: &ConnectionProfile) -> Self {
    Self {
      host: profile.host.clone(),
      port: profile.port,
      username: profile.username.clone(),
      password: profile.password.clone(),
      database: profile
        .database
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string),
      tls: profile.effective_tls_mode(),
      ca_certificate_path: profile.ca_certificate_path.clone().filter(|path| !path.is_empty()),
    }
  }

  fn driver(&self) -> Result<Driver, String> {
    // 总是直连：路由（`neo4j://`）要按服务端给的成员地址去连，经隧道或 NAT 时那些地址
    // 从这台机器上连不到。集群这一版不做，见 TODOs 4.3
    let address =
      ConnectionConfig::new(Address::from((self.host.as_str(), self.port))).with_routing(false);
    // `Preferred` / `Required` 只加密不校验，与另外几家一致；`VerifyCa` 按完整校验
    // （rustls 没有只放过主机名的开关），往严里走
    let connection = match (self.tls, &self.ca_certificate_path) {
      (TlsMode::Disabled, _) => address,
      (TlsMode::Preferred | TlsMode::Required, _) => {
        address.with_encryption_trust_any_certificate()
      }
      (_, Some(path)) => {
        // 驱动读不了文件时只说「invalid certificate」、不说是哪一个；先查一遍，报出路径
        std::fs::File::open(path)
          .map_err(|error| format!("{NEO4J_TLS_FILE_INVALID}: {path}: {error}"))?;
        address
          .with_encryption_trust_custom_cas(&[path])
          .map_err(|error| format!("{NEO4J_TLS_FILE_INVALID}: {path}: {}", error.message))?
      }
      (_, None) => address
        .with_encryption_trust_default_cas()
        .map_err(|error| format!("{NEO4J_TLS_FILE_INVALID}: {}", error.message))?,
    };
    // 服务端关着认证时（`dbms.security.auth_enabled=false`）用户名空着
    let auth = if self.username.is_empty() {
      AuthToken::new_none_auth()
    } else {
      AuthToken::new_basic_auth(&self.username, &self.password)
    };
    let config = DriverConfig::new()
      .with_auth(Arc::new(auth))
      .with_connection_timeout(CONNECT_TIMEOUT)
      .with_connection_acquisition_timeout(CONNECT_TIMEOUT)
      .with_idle_time_before_connection_test(IDLE_BEFORE_LIVENESS_CHECK);
    Ok(Driver::new(connection, config))
  }
}

/// 一个连接配置在后端的全部：驱动（它自己管着连接池）加配置里的库
pub struct Neo4jPool {
  driver: Driver,
  database: Option<String>,
}

impl Neo4jPool {
  fn session(&self, database: Option<&str>) -> neo4j::session::Session<'_> {
    let mut config = SessionConfig::new();
    if let Some(database) = database.or(self.database.as_deref()) {
      config = config.with_database(Arc::new(database.to_string()));
    }
    self.driver.session(config)
  }
}

/// 同步的活放进阻塞线程池，外面套一层时限
async fn blocking<T: Send + 'static>(
  timeout: Duration,
  work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
  match tokio::time::timeout(timeout, tokio::task::spawn_blocking(work)).await {
    Ok(Ok(result)) => result,
    Ok(Err(join)) => Err(format!("{NEO4J_SERVER_ERROR}: {join}")),
    Err(_) => Err(format!("{NEO4J_TIMEOUT}: {}ms", timeout.as_millis())),
  }
}

/// 连上并在配置的库里跑一条 `RETURN 1`：口令错、库不存在都在这一步报出来——
/// 只做握手的话，库名写错要等展开对象树时才知道
pub async fn connect(target: Neo4jTarget) -> Result<Neo4jPool, String> {
  blocking(CONNECT_TIMEOUT + Duration::from_secs(2), move || {
    let pool = Neo4jPool { driver: target.driver()?, database: target.database.clone() };
    pool.session(None).auto_commit("RETURN 1").run().map_err(describe_connect_error)?;
    Ok(pool)
  })
  .await
}

/// 对象树的一行，形状与关系库的对象目录一致：`object_schema` 是库名，
/// 下面是标签（`label`）与关系类型（`relationship-type`）
#[derive(Debug, Serialize, PartialEq)]
pub struct Neo4jObject {
  pub object_schema: String,
  pub object_name: String,
  pub object_kind: &'static str,
  pub object_id: String,
}

/// 能看到的库（`SHOW DATABASES` 只列这个用户有权限的），每个库的标签与关系类型。
/// 没有权限列库时退回配置里的库（或主库）
pub async fn list_objects(
  pool: Arc<Neo4jPool>,
  timeout: Duration,
) -> Result<Vec<Neo4jObject>, String> {
  blocking(timeout + TIMEOUT_GRACE, move || {
    let databases = match single_column(
      &pool,
      Some("system"),
      "SHOW DATABASES YIELD name, currentStatus \
       WHERE currentStatus = 'online' AND name <> 'system' RETURN name ORDER BY name",
      timeout,
    ) {
      Ok(names) => names,
      Err(_) => vec![current_database(&pool, timeout)?],
    };
    let mut objects = Vec::new();
    for database in databases {
      for (kind, query) in [
        ("label", "CALL db.labels() YIELD label RETURN label ORDER BY label"),
        (
          "relationship-type",
          "CALL db.relationshipTypes() YIELD relationshipType \
           RETURN relationshipType ORDER BY relationshipType",
        ),
      ] {
        for name in single_column(&pool, Some(&database), query, timeout)? {
          objects.push(Neo4jObject {
            object_id: format!("{database}:{kind}:{name}"),
            object_schema: database.clone(),
            object_name: name,
            object_kind: kind,
          });
        }
      }
    }
    Ok(objects)
  })
  .await
}

/// 配置里的库，没配就问服务端这个用户的主库叫什么
fn current_database(pool: &Neo4jPool, timeout: Duration) -> Result<String, String> {
  if let Some(database) = &pool.database {
    return Ok(database.clone());
  }
  let mut names = single_column(pool, None, "CALL db.info() YIELD name RETURN name", timeout)?;
  names.pop().ok_or_else(|| format!("{NEO4J_SERVER_ERROR}: db.info() returned no rows"))
}

/// 一列字符串的查询（库名、标签名）
// `with_receiver` 的闭包必须返回驱动自己的 `Result<_, Neo4jError>`，这个错误类型大不大由不得我们
#[allow(clippy::result_large_err)]
fn single_column(
  pool: &Neo4jPool,
  database: Option<&str>,
  query: &str,
  timeout: Duration,
) -> Result<Vec<String>, String> {
  let mut session = pool.session(database);
  let rows = session
    .auto_commit(query)
    .with_transaction_timeout(transaction_timeout(timeout)?)
    .with_receiver(|stream| stream.collect::<Result<Vec<Record>, Neo4jError>>())
    .run()
    .map_err(describe_error)?;
  Ok(
    rows
      .into_iter()
      .filter_map(|record| record.into_values().next())
      .filter_map(|value| match value {
        ValueReceive::String(text) => Some(text),
        _ => None,
      })
      .collect(),
  )
}

fn transaction_timeout(timeout: Duration) -> Result<TransactionTimeout, String> {
  i64::try_from(timeout.as_millis())
    .ok()
    .and_then(TransactionTimeout::from_millis)
    .ok_or_else(|| format!("{NEO4J_TIMEOUT}: {}ms", timeout.as_millis()))
}

pub struct CypherRequest {
  /// 空着就用连接配置里的库（再空就是主库）。查询里的 `USE` 子句照样生效
  pub database: Option<String>,
  pub query: String,
  pub limit: usize,
  pub timeout: Duration,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CypherResult {
  pub columns: Vec<String>,
  pub rows: Vec<Vec<CypherValue>>,
  /// 行数到了上限，后面的没读（服务端那边丢弃了，写入照样全部生效）
  pub truncated: bool,
  pub summary: CypherSummary,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CypherSummary {
  /// `r` 读、`w` 写、`rw` 读写、`s` 改 schema，与服务端的写法一致
  pub query_type: Option<&'static str>,
  /// 实际跑在哪个库上（`USE` 子句会改它）
  pub database: Option<String>,
  /// 只列不为零的计数：建了几个节点、设了几个属性……
  pub counters: Vec<(&'static str, i64)>,
  pub notifications: Vec<CypherNotification>,
  pub available_after_ms: Option<u128>,
  pub consumed_after_ms: Option<u128>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CypherNotification {
  pub code: String,
  pub title: String,
  pub description: String,
  pub severity: String,
}

/// 跑一条 Cypher。行读到上限就停，其余的交给 `consume` 让服务端丢掉——不会整份拉回来
// `with_receiver` 的闭包必须返回驱动自己的 `Result<_, Neo4jError>`，这个错误类型大不大由不得我们
#[allow(clippy::result_large_err)]
pub async fn run(pool: Arc<Neo4jPool>, request: CypherRequest) -> Result<CypherResult, String> {
  let timeout = request.timeout;
  blocking(timeout + TIMEOUT_GRACE, move || {
    let mut session = pool.session(request.database.as_deref());
    let limit = request.limit;
    session
      .auto_commit(&request.query)
      .with_transaction_timeout(transaction_timeout(timeout)?)
      .with_receiver(|stream| {
        let columns = stream.keys().iter().map(|key| key.to_string()).collect();
        let mut rows = Vec::new();
        let mut truncated = false;
        for record in stream.by_ref() {
          if rows.len() == limit {
            truncated = true;
            break;
          }
          rows.push(record?.into_values().map(CypherValue::from).collect());
        }
        let summary = stream.consume()?;
        Ok(CypherResult { columns, rows, truncated, summary: summarize(summary) })
      })
      .run()
      .map_err(describe_error)
  })
  .await
}

/// 不执行、只问服务端这条是读还是写（`EXPLAIN`）。拿来决定要不要先确认——比按关键字猜可靠：
/// `CALL` 一个过程可能写，字符串里出现 `DELETE` 却不写
// `with_receiver` 的闭包必须返回驱动自己的 `Result<_, Neo4jError>`，这个错误类型大不大由不得我们
#[allow(clippy::result_large_err)]
pub async fn query_type(
  pool: Arc<Neo4jPool>,
  database: Option<String>,
  query: String,
  timeout: Duration,
) -> Result<Option<&'static str>, String> {
  blocking(timeout + TIMEOUT_GRACE, move || {
    let mut session = pool.session(database.as_deref());
    let explain = format!("EXPLAIN {query}");
    let summary = session
      .auto_commit(&explain)
      .with_transaction_timeout(transaction_timeout(timeout)?)
      .with_receiver(|stream| stream.consume())
      .run()
      .map_err(describe_error)?;
    Ok(summary.and_then(|summary| summary.query_type.and_then(query_type_code)))
  })
  .await
}

/// 驱动的枚举标着 `non_exhaustive`：认不出的新种类当作「不知道」，由调用方按最严的处理
fn query_type_code(query_type: SummaryQueryType) -> Option<&'static str> {
  match query_type {
    SummaryQueryType::Read => Some("r"),
    SummaryQueryType::Write => Some("w"),
    SummaryQueryType::ReadWrite => Some("rw"),
    SummaryQueryType::Schema => Some("s"),
    _ => None,
  }
}

fn summarize(summary: Option<Summary>) -> CypherSummary {
  let Some(summary) = summary else { return CypherSummary::default() };
  let counters = &summary.counters;
  let counters = [
    ("nodesCreated", counters.nodes_created),
    ("nodesDeleted", counters.nodes_deleted),
    ("relationshipsCreated", counters.relationships_created),
    ("relationshipsDeleted", counters.relationships_deleted),
    ("propertiesSet", counters.properties_set),
    ("labelsAdded", counters.labels_added),
    ("labelsRemoved", counters.labels_removed),
    ("indexesAdded", counters.indexes_added),
    ("indexesRemoved", counters.indexes_removed),
    ("constraintsAdded", counters.constraints_added),
    ("constraintsRemoved", counters.constraints_removed),
    ("systemUpdates", counters.system_updates),
  ]
  .into_iter()
  .filter(|(_, count)| *count != 0)
  .collect();
  CypherSummary {
    query_type: summary.query_type.and_then(query_type_code),
    database: summary.database,
    counters,
    notifications: summary
      .notifications
      .into_iter()
      .map(|notification| CypherNotification {
        code: notification.code,
        title: notification.title,
        description: notification.description,
        severity: notification.raw_severity,
      })
      .collect(),
    available_after_ms: summary.result_available_after.map(|elapsed| elapsed.as_millis()),
    consumed_after_ms: summary.result_consumed_after.map(|elapsed| elapsed.as_millis()),
  }
}

/// 一个值。容器与图元素原样保留结构，时间与空间给出 Cypher 的构造写法——
/// 前端拼字面量时不必再懂时区与纳秒
#[derive(Debug, Serialize, PartialEq)]
// `rename_all` 只改变体名（`kind` 的值），变体里的字段要另用 `rename_all_fields`
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CypherValue {
  Null,
  Boolean {
    value: bool,
  },
  /// 按字符串送：Cypher 的整数是 64 位，JavaScript 的数到 2⁵³ 就不准了
  Integer {
    value: String,
  },
  /// 按字符串送：`NaN` 与无穷大在 JSON 里写不出来
  Float {
    value: String,
  },
  String {
    value: String,
  },
  /// base64
  Bytes {
    value: String,
  },
  List {
    items: Vec<CypherValue>,
  },
  Map {
    entries: Vec<(String, CypherValue)>,
  },
  Node {
    element_id: String,
    labels: Vec<String>,
    properties: Vec<(String, CypherValue)>,
  },
  Relationship {
    element_id: String,
    #[serde(rename = "type")]
    relationship_type: String,
    start_element_id: String,
    end_element_id: String,
    properties: Vec<(String, CypherValue)>,
  },
  /// 路径：起点，然后一段一段（关系、方向、下一个节点）
  Path {
    start: Box<CypherValue>,
    segments: Vec<PathSegment>,
  },
  /// `point({x: 1, y: 2})` 这类构造写法
  Point {
    value: String,
  },
  /// `date('2024-01-02')` 这类构造写法
  Temporal {
    value: String,
  },
  /// 驱动认不出来的值，带着它说的原因
  Unsupported {
    reason: String,
  },
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PathSegment {
  pub relationship: CypherValue,
  /// 关系的方向是否与路径走的方向一致
  pub forward: bool,
  pub node: CypherValue,
}

impl From<ValueReceive> for CypherValue {
  fn from(value: ValueReceive) -> Self {
    match value {
      ValueReceive::Null => CypherValue::Null,
      ValueReceive::Boolean(value) => CypherValue::Boolean { value },
      ValueReceive::Integer(value) => CypherValue::Integer { value: value.to_string() },
      ValueReceive::Float(value) => CypherValue::Float { value: float_text(value) },
      ValueReceive::Bytes(bytes) => CypherValue::Bytes { value: BASE64.encode(bytes) },
      ValueReceive::String(value) => CypherValue::String { value },
      ValueReceive::List(items) => {
        CypherValue::List { items: items.into_iter().map(CypherValue::from).collect() }
      }
      ValueReceive::Map(entries) => CypherValue::Map { entries: sorted(entries) },
      ValueReceive::Node(node) => node_value(node),
      ValueReceive::Relationship(relationship) => CypherValue::Relationship {
        element_id: relationship.element_id,
        relationship_type: relationship.type_,
        start_element_id: relationship.start_node_element_id,
        end_element_id: relationship.end_node_element_id,
        properties: sorted(relationship.properties),
      },
      ValueReceive::Path(path) => {
        let (start, hops) = path.traverse();
        let mut previous = start.element_id.clone();
        let segments = hops
          .into_iter()
          .map(|(direction, relationship, node)| {
            let forward = matches!(direction, RelationshipDirection::To);
            let segment = PathSegment {
              relationship: bound(relationship, &previous, &node.element_id, forward),
              forward,
              node: node_value(node.clone()),
            };
            previous = node.element_id.clone();
            segment
          })
          .collect();
        CypherValue::Path { start: Box::new(node_value(start.clone())), segments }
      }
      ValueReceive::Cartesian2D(point) => CypherValue::Point {
        value: format!(
          "point({{x: {}, y: {}, srid: {}}})",
          float_text(point.x()),
          float_text(point.y()),
          point.srid()
        ),
      },
      ValueReceive::Cartesian3D(point) => CypherValue::Point {
        value: format!(
          "point({{x: {}, y: {}, z: {}, srid: {}}})",
          float_text(point.x()),
          float_text(point.y()),
          float_text(point.z()),
          point.srid()
        ),
      },
      ValueReceive::WGS84_2D(point) => CypherValue::Point {
        value: format!(
          "point({{longitude: {}, latitude: {}, srid: {}}})",
          float_text(point.longitude()),
          float_text(point.latitude()),
          point.srid()
        ),
      },
      ValueReceive::WGS84_3D(point) => CypherValue::Point {
        value: format!(
          "point({{longitude: {}, latitude: {}, height: {}, srid: {}}})",
          float_text(point.longitude()),
          float_text(point.latitude()),
          float_text(point.altitude()),
          point.srid()
        ),
      },
      ValueReceive::Duration(duration) => CypherValue::Temporal {
        value: format!(
          "duration('{}')",
          duration_text(
            duration.months(),
            duration.days(),
            duration.seconds(),
            duration.nanoseconds()
          )
        ),
      },
      ValueReceive::LocalTime(time) => {
        CypherValue::Temporal { value: format!("localtime('{}')", time.format("%H:%M:%S%.f")) }
      }
      ValueReceive::Time(time) => CypherValue::Temporal {
        value: format!("time('{}{}')", time.time.format("%H:%M:%S%.f"), time.offset),
      },
      ValueReceive::Date(date) => {
        CypherValue::Temporal { value: format!("date('{}')", date.format("%Y-%m-%d")) }
      }
      ValueReceive::LocalDateTime(moment) => CypherValue::Temporal {
        value: format!("localdatetime('{}')", moment.format("%Y-%m-%dT%H:%M:%S%.f")),
      },
      ValueReceive::DateTime(moment) => CypherValue::Temporal {
        value: format!(
          "datetime('{}[{}]')",
          moment.format("%Y-%m-%dT%H:%M:%S%.f%:z"),
          moment.timezone()
        ),
      },
      ValueReceive::DateTimeFixed(moment) => CypherValue::Temporal {
        value: format!("datetime('{}')", moment.format("%Y-%m-%dT%H:%M:%S%.f%:z")),
      },
      ValueReceive::BrokenValue(broken) => {
        CypherValue::Unsupported { reason: broken.reason().to_string() }
      }
      // 驱动的枚举标着 `non_exhaustive`：新版本多出来的种类先照实说认不出
      other => CypherValue::Unsupported { reason: format!("{other:?}") },
    }
  }
}

fn node_value(node: Node) -> CypherValue {
  CypherValue::Node {
    element_id: node.element_id,
    labels: node.labels,
    properties: sorted(node.properties),
  }
}

/// 路径里的关系没有起止节点（Bolt 省掉了），按走的方向补上
fn bound(
  relationship: &UnboundRelationship,
  previous: &str,
  next: &str,
  forward: bool,
) -> CypherValue {
  let (start, end) = if forward { (previous, next) } else { (next, previous) };
  CypherValue::Relationship {
    element_id: relationship.element_id.clone(),
    relationship_type: relationship.type_.clone(),
    start_element_id: start.to_string(),
    end_element_id: end.to_string(),
    properties: sorted(relationship.properties.clone()),
  }
}

fn sorted(entries: HashMap<String, ValueReceive>) -> Vec<(String, CypherValue)> {
  let mut entries: Vec<_> =
    entries.into_iter().map(|(key, value)| (key, CypherValue::from(value))).collect();
  entries.sort_by(|left, right| left.0.cmp(&right.0));
  entries
}

/// Cypher 的写法：整数值的浮点数带 `.0`、大的写成 `1e20`（不然读回来是整数，大的还越界），
/// `NaN`、`Infinity`
fn float_text(value: f64) -> String {
  if value.is_nan() {
    "NaN".to_string()
  } else if value.is_infinite() {
    if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string()
  } else if value.fract() != 0.0 {
    value.to_string()
  } else if value.abs() < 1e16 {
    format!("{value:.1}")
  } else {
    format!("{value:e}")
  }
}

/// ISO 8601 的时长，与 Neo4j 自己的写法一样把月拆成年、秒拆成时分：`P1Y2M3DT4H5M6.5S`
fn duration_text(months: i64, days: i64, seconds: i64, nanoseconds: i32) -> String {
  let mut text = String::from("P");
  for (amount, unit) in [(months / 12, 'Y'), (months % 12, 'M'), (days, 'D')] {
    if amount != 0 {
      text.push_str(&format!("{amount}{unit}"));
    }
  }
  let (hours, minutes, whole) = (seconds / 3600, seconds % 3600 / 60, seconds % 60);
  let mut time = String::new();
  for (amount, unit) in [(hours, 'H'), (minutes, 'M')] {
    if amount != 0 {
      time.push_str(&format!("{amount}{unit}"));
    }
  }
  if whole != 0 || nanoseconds != 0 {
    let fraction = format!("{:09}", nanoseconds.unsigned_abs());
    let fraction = fraction.trim_end_matches('0');
    let sign = if whole == 0 && nanoseconds < 0 { "-" } else { "" };
    if fraction.is_empty() {
      time.push_str(&format!("{sign}{whole}S"));
    } else {
      time.push_str(&format!("{sign}{whole}.{fraction}S"));
    }
  }
  if !time.is_empty() {
    text.push('T');
    text.push_str(&time);
  }
  if text == "P" {
    "PT0S".to_string()
  } else {
    text
  }
}

/// 连接阶段：网络层的一律是「连不上」，认证与服务端的照常分
fn describe_connect_error(error: Neo4jError) -> String {
  match error {
    Neo4jError::Disconnect { .. } | Neo4jError::Timeout { .. } => {
      format!("{NEO4J_UNREACHABLE}: {error}")
    }
    other => describe_error(other),
  }
}

/// 驱动的错误 → 带码的一句话。认不出的原样给，比翻错强
pub fn describe_error(error: Neo4jError) -> String {
  match error {
    Neo4jError::ServerError { error, .. } => describe_server_error(&error.code, &error.message),
    Neo4jError::Disconnect { .. } => format!("{NEO4J_UNREACHABLE}: {error}"),
    Neo4jError::Timeout { message, .. } => format!("{NEO4J_TIMEOUT}: {message}"),
    other => other.to_string(),
  }
}

fn describe_server_error(code: &str, message: &str) -> String {
  match code {
    "Neo.ClientError.Security.Unauthorized"
    | "Neo.ClientError.Security.AuthenticationRateLimit" => {
      format!("{NEO4J_AUTH_FAILED}: {message}")
    }
    "Neo.ClientError.Database.DatabaseNotFound" => format!("{NEO4J_DATABASE_NOT_FOUND}: {message}"),
    // `TransactionTimedOut` 与 5.x 起的 `TransactionTimedOutClientConfiguration`
    _ if code.starts_with("Neo.ClientError.Transaction.TransactionTimedOut") => {
      format!("{NEO4J_TIMEOUT}: {message}")
    }
    _ => format!("{NEO4J_SERVER_ERROR}: {code}: {message}"),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn floats_read_back_as_floats() {
    assert_eq!(float_text(3.0), "3.0");
    assert_eq!(float_text(-0.5), "-0.5");
    assert_eq!(float_text(0.1), "0.1");
    assert_eq!(float_text(f64::NAN), "NaN");
    assert_eq!(float_text(f64::NEG_INFINITY), "-Infinity");
    assert_eq!(float_text(1e20), "1e20");
    assert_eq!(float_text(-1.5e17), "-1.5e17");
  }

  #[test]
  fn durations_are_written_the_way_neo4j_writes_them() {
    assert_eq!(duration_text(14, 3, 3600 * 4 + 5 * 60 + 6, 500_000_000), "P1Y2M3DT4H5M6.5S");
    assert_eq!(duration_text(0, 0, 0, 0), "PT0S");
    assert_eq!(duration_text(0, 1, 0, 0), "P1D");
    assert_eq!(duration_text(0, 0, 0, 1), "PT0.000000001S");
    assert_eq!(duration_text(0, -1, 0, 0), "P-1D");
  }

  #[test]
  fn integers_travel_as_text_and_maps_are_sorted() {
    let map = ValueReceive::Map(HashMap::from([
      ("b".to_string(), ValueReceive::Integer(i64::MAX)),
      ("a".to_string(), ValueReceive::Null),
    ]));
    assert_eq!(
      CypherValue::from(map),
      CypherValue::Map {
        entries: vec![
          ("a".to_string(), CypherValue::Null),
          ("b".to_string(), CypherValue::Integer { value: "9223372036854775807".to_string() }),
        ]
      }
    );
  }

  #[test]
  fn values_serialize_with_their_kind() {
    let value = CypherValue::List {
      items: vec![
        CypherValue::Boolean { value: true },
        CypherValue::Float { value: "NaN".to_string() },
      ],
    };
    assert_eq!(
      serde_json::to_value(&value).unwrap_or_default(),
      serde_json::json!({
        "kind": "list",
        "items": [{ "kind": "boolean", "value": true }, { "kind": "float", "value": "NaN" }]
      })
    );
  }

  /// 前端按 `elementId`、`startElementId` 读：变体里的字段也得是 camelCase
  #[test]
  fn graph_values_serialize_with_camel_case_fields() {
    let relationship = CypherValue::Relationship {
      element_id: "5:x:0".to_string(),
      relationship_type: "KNOWS".to_string(),
      start_element_id: "4:x:0".to_string(),
      end_element_id: "4:x:1".to_string(),
      properties: vec![],
    };
    assert_eq!(
      serde_json::to_value(&relationship).unwrap_or_default(),
      serde_json::json!({
        "kind": "relationship",
        "elementId": "5:x:0",
        "type": "KNOWS",
        "startElementId": "4:x:0",
        "endElementId": "4:x:1",
        "properties": []
      })
    );
    let node = CypherValue::Node {
      element_id: "4:x:0".to_string(),
      labels: vec!["A".to_string()],
      properties: vec![],
    };
    assert_eq!(
      serde_json::to_value(&node).unwrap_or_default(),
      serde_json::json!({ "kind": "node", "elementId": "4:x:0", "labels": ["A"], "properties": [] })
    );
  }

  #[test]
  fn server_errors_get_our_codes() {
    assert!(describe_server_error("Neo.ClientError.Security.Unauthorized", "x")
      .starts_with(NEO4J_AUTH_FAILED));
    assert!(describe_server_error("Neo.ClientError.Database.DatabaseNotFound", "x")
      .starts_with(NEO4J_DATABASE_NOT_FOUND));
    assert!(describe_server_error(
      "Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration",
      "x"
    )
    .starts_with(NEO4J_TIMEOUT));
    assert_eq!(
      describe_server_error("Neo.ClientError.Statement.SyntaxError", "Invalid input"),
      format!("{NEO4J_SERVER_ERROR}: Neo.ClientError.Statement.SyntaxError: Invalid input")
    );
  }
}
