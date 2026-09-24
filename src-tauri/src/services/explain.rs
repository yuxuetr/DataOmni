//! 执行计划：三种方言各自的 EXPLAIN，解析成同一棵树。
//!
//! 解析放在 Rust 而不是前端，理由和目录查询一样——这三种返回的形状只有拿
//! 真库跑一遍才知道对不对。PostgreSQL 的 `Plans` 嵌套、MySQL 那个**用键名
//! 表示操作**的不规则对象、SQLite 的 `parent` 指针，照着文档猜写出来的解析
//! 器能跑通、画出来的树是错的，而错的树看上去和对的一样。
//!
//! **只发一次 EXPLAIN。** 不再额外取一份 `FORMAT TEXT` / `FORMAT=TREE`：
//! 带 ANALYZE 时那等于把查询再跑一遍。「文本」那一页给的是数据库返回的原文，
//! 「树形」那一页是这里解析出来的结构。

use crate::models::DatabaseType;
use crate::services::query_error::QueryError;
use serde::Serialize;
use serde_json::{Map, Value as JsonValue};

/// 数据里带的都是数据库类型名
pub const EXPLAIN_UNSUPPORTED: &str = "DATAOMNI_EXPLAIN_UNSUPPORTED";
pub const EXPLAIN_ANALYZE_UNSUPPORTED: &str = "DATAOMNI_EXPLAIN_ANALYZE_UNSUPPORTED";
/// 查询跑了，但计划是空的。当成错误而不是一棵空树——空树会让人以为计划就是空的
pub const EXPLAIN_EMPTY: &str = "DATAOMNI_EXPLAIN_EMPTY";
pub const EXPLAIN_NOT_JSON: &str = "DATAOMNI_EXPLAIN_NOT_JSON";
/// SQL Server 的计划解析不了。数据是解析器的原话
pub const EXPLAIN_NOT_XML: &str = "DATAOMNI_EXPLAIN_NOT_XML";

/// 计划树上的一个节点。
///
/// 字段是三家的**交集**，其余一律原样进 `detail`——把 MySQL 的
/// `rows_examined_per_scan` 硬塞进某个通用字段，读的人会以为那是它的语义。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanNode {
  /// 这一步在做什么
  pub operation: String,
  /// 动的是哪张表 / 哪个索引
  pub target: Option<String>,
  /// 优化器估的行数
  pub estimated_rows: Option<f64>,
  /// 真实行数。只有 ANALYZE 才有——没有它就是 `None`，不是 0
  pub actual_rows: Option<f64>,
  pub cost: Option<f64>,
  /// 真实耗时，毫秒。同样只有 ANALYZE 才有
  pub actual_ms: Option<f64>,
  /// 其余字段，按数据库给的名字原样带上
  pub detail: Vec<PlanDetail>,
  pub children: Vec<PlanNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDetail {
  pub key: String,
  pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPlan {
  /// 顶层节点。SQLite 的 `EXPLAIN QUERY PLAN` 可能给出并列的多棵树
  pub roots: Vec<PlanNode>,
  /// 这次是不是真的把语句跑了
  pub analyzed: bool,
  pub planning_ms: Option<f64>,
  pub execution_ms: Option<f64>,
  /// 数据库返回的原文，给「文本」那一页
  pub raw: String,
}

impl PlanNode {
  fn new(operation: impl Into<String>) -> Self {
    Self {
      operation: operation.into(),
      target: None,
      estimated_rows: None,
      actual_rows: None,
      cost: None,
      actual_ms: None,
      detail: Vec::new(),
      children: Vec::new(),
    }
  }
}

/// 这个方言支不支持「真的跑一遍」的执行计划。
///
/// - SQLite 没有：`EXPLAIN QUERY PLAN` 只给计划，裸 `EXPLAIN` 给的是 VDBE
///   字节码，不是同一回事。
/// - MySQL **当前版本不做**：它的 `EXPLAIN ANALYZE` 只出 TREE 那种缩进文本，
///   给不出 JSON，要再写一个按缩进认层级的解析器。路线图这一条要的是
///   「支持 MySQL EXPLAIN」，没要 ANALYZE。重估条件：这条断言——哪天真的
///   支持了它会红，逼着回来改掉理由。
///
/// 界面据此把开关禁掉，而不是给一个按了会报错的按钮。
pub fn supports_analyze(db_type: &DatabaseType) -> bool {
  matches!(db_type, DatabaseType::PostgreSQL)
}

/// 发哪一种 EXPLAIN、按哪一种形状解析。
///
/// 比连接类型细一层：TiDB 与 CockroachDB 说 MySQL / PostgreSQL 的线协议，
/// EXPLAIN 却各说各的——TiDB 不认 `FORMAT=JSON`，有自己的 `tidb_json`；
/// CockroachDB 没有 JSON 格式，给的是一棵文本树。
///
/// 分辨靠连上之后读 `VERSION()`（[`SERVER_VERSION_QUERY`]），不看连接表单上
/// 记的入口：那一格只供显示，从 MySQL 入口连 TiDB 的人同样该拿到计划。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanDialect {
  PostgreSql,
  CockroachDb,
  MySql,
  TiDb,
  Sqlite,
  SqlServer,
  Oracle,
  /// 没有 EXPLAIN 的类型；带着类型名，报错时说得出是谁
  Unsupported(String),
}

/// 分辨服务端要发的那一句。MySQL 与 PostgreSQL 两边都认
pub const SERVER_VERSION_QUERY: &str = "SELECT VERSION()";

impl From<&DatabaseType> for PlanDialect {
  fn from(db_type: &DatabaseType) -> Self {
    match db_type {
      DatabaseType::PostgreSQL => Self::PostgreSql,
      DatabaseType::MySQL => Self::MySql,
      DatabaseType::SQLite => Self::Sqlite,
      DatabaseType::SqlServer => Self::SqlServer,
      DatabaseType::Oracle => Self::Oracle,
      other => Self::Unsupported(format!("{other:?}")),
    }
  }
}

impl PlanDialect {
  /// 这个类型要不要先读一次 `VERSION()` 才分得清
  pub fn needs_server_version(db_type: &DatabaseType) -> bool {
    matches!(db_type, DatabaseType::MySQL | DatabaseType::PostgreSQL)
  }

  /// `VERSION()` 的原话：TiDB 是 `8.0.11-TiDB-v8.5.3`，CockroachDB 是
  /// `CockroachDB CCL v25.2.x ...`
  pub fn detect(db_type: &DatabaseType, server_version: &str) -> Self {
    match Self::from(db_type) {
      Self::MySql if server_version.contains("TiDB") => Self::TiDb,
      Self::PostgreSql if server_version.contains("CockroachDB") => Self::CockroachDb,
      other => other,
    }
  }

  fn supports_analyze(&self) -> bool {
    matches!(self, Self::PostgreSql | Self::CockroachDb)
  }

  fn label(&self) -> &str {
    match self {
      Self::PostgreSql => "PostgreSQL",
      Self::CockroachDb => "CockroachDB",
      Self::MySql => "MySQL",
      Self::TiDb => "TiDB",
      Self::Sqlite => "SQLite",
      Self::SqlServer => "SqlServer",
      Self::Oracle => "Oracle",
      Self::Unsupported(name) => name,
    }
  }
}

/// 取计划要发的那条语句。
///
/// 一律用结构化格式：文本格式好看，但为了它再发一次 EXPLAIN，在 ANALYZE
/// 下就是把查询跑第二遍。
pub fn explain_statement(
  dialect: impl Into<PlanDialect>,
  sql: &str,
  analyze: bool,
) -> Result<String, QueryError> {
  let dialect = dialect.into();
  if analyze && !dialect.supports_analyze() {
    // 悄悄降级成普通 EXPLAIN 才是最糟的：界面说「真的跑了一遍」，
    // 而给出的是估算值
    return Err(QueryError::message(format!("{EXPLAIN_ANALYZE_UNSUPPORTED}: {}", dialect.label())));
  }
  let sql = sql.trim().trim_end_matches(';');
  match dialect {
    PlanDialect::PostgreSql => Ok(if analyze {
      // BUFFERS 一起要：知道「读了多少块、命中多少」才看得出慢在 I/O 还是 CPU
      format!("EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) {sql}")
    } else {
      format!("EXPLAIN (VERBOSE, FORMAT JSON) {sql}")
    }),
    // 文本树是它唯一的格式；VERBOSE 多给列与过滤条件
    PlanDialect::CockroachDb => Ok(if analyze {
      format!("EXPLAIN ANALYZE (VERBOSE) {sql}")
    } else {
      format!("EXPLAIN (VERBOSE) {sql}")
    }),
    PlanDialect::MySql => Ok(format!("EXPLAIN FORMAT=JSON {sql}")),
    PlanDialect::TiDb => Ok(format!("EXPLAIN FORMAT='tidb_json' {sql}")),
    PlanDialect::Sqlite => Ok(format!("EXPLAIN QUERY PLAN {sql}")),
    // 没有 EXPLAIN：语句原样，由执行那一侧用 `SET SHOWPLAN_XML` 包住
    // （见 `StreamOptions::explain_plan`）
    PlanDialect::SqlServer => Ok(sql.to_string()),
    // 同样原样：`EXPLAIN PLAN` 要写进 PLAN_TABLE 再读出来、再撤掉，是执行那一侧的
    // 几步（见 `oracle::explain_plan`）
    PlanDialect::Oracle => Ok(sql.to_string()),
    PlanDialect::Unsupported(name) => {
      Err(QueryError::message(format!("{EXPLAIN_UNSUPPORTED}: {name}")))
    }
  }
}

fn number(value: Option<&JsonValue>) -> Option<f64> {
  match value? {
    JsonValue::Number(number) => number.as_f64(),
    // MySQL 把代价放在字符串里：`"query_cost": "12.34"`
    JsonValue::String(text) => text.parse().ok(),
    _ => None,
  }
}

fn scalar_text(value: &JsonValue) -> Option<String> {
  match value {
    JsonValue::Null => None,
    JsonValue::Bool(flag) => Some(flag.to_string()),
    JsonValue::Number(number) => Some(number.to_string()),
    JsonValue::String(text) => Some(text.clone()),
    // 字符串数组（PG 的 Sort Key、Output）够常见，值得读得出来
    JsonValue::Array(items) if items.iter().all(|item| item.is_string()) => {
      Some(items.iter().filter_map(|item| item.as_str()).collect::<Vec<_>>().join(", "))
    }
    _ => None,
  }
}

/// 结果集里那一格的文本。
///
/// 三家把计划放在不同类型的列里，而我们的解码器又会把 JSON 列包成
/// `{type:"json", value:"…"}`。这里一律还原成原始文本再去解析。
fn cell_text(value: &JsonValue) -> String {
  match value {
    JsonValue::String(text) => text.clone(),
    JsonValue::Object(map) => match (map.get("type"), map.get("value")) {
      (Some(JsonValue::String(_)), Some(JsonValue::String(text))) => text.clone(),
      _ => value.to_string(),
    },
    other => other.to_string(),
  }
}

/// 一行结果里第一个非空的格子。EXPLAIN 的列名三家各不相同
/// （PostgreSQL 是 `QUERY PLAN`，MySQL 是 `EXPLAIN`），按位置取更稳。
fn first_cell(row: &Map<String, JsonValue>) -> Option<String> {
  row.values().find(|value| !value.is_null()).map(cell_text)
}

/// 把整棵计划解析出来。`rows` 是 EXPLAIN 自己的结果集。
pub fn parse_plan(
  dialect: impl Into<PlanDialect>,
  rows: &[Map<String, JsonValue>],
  analyze: bool,
) -> Result<QueryPlan, QueryError> {
  match dialect.into() {
    PlanDialect::PostgreSql => parse_postgres(rows, analyze),
    PlanDialect::CockroachDb => parse_cockroach(rows, analyze),
    PlanDialect::MySql => parse_mysql(rows),
    PlanDialect::TiDb => parse_tidb(rows),
    PlanDialect::Sqlite => Ok(parse_sqlite(rows)),
    PlanDialect::SqlServer => parse_sql_server(rows),
    PlanDialect::Oracle => parse_oracle(rows),
    PlanDialect::Unsupported(name) => {
      Err(QueryError::message(format!("{EXPLAIN_UNSUPPORTED}: {name}")))
    }
  }
}

fn parse_json_payload(rows: &[Map<String, JsonValue>]) -> Result<(JsonValue, String), QueryError> {
  // MySQL 的 JSON 计划偶尔跨多行返回，拼起来再解析
  let text: String = rows.iter().filter_map(first_cell).collect::<Vec<_>>().join("");
  if text.trim().is_empty() {
    return Err(QueryError::message(EXPLAIN_EMPTY));
  }
  let parsed: JsonValue = serde_json::from_str(&text)
    .map_err(|error| QueryError::message(format!("{EXPLAIN_NOT_JSON}: {error}")))?;
  let pretty = serde_json::to_string_pretty(&parsed).unwrap_or(text);
  Ok((parsed, pretty))
}

/// PostgreSQL：顶层是数组，每个元素有一个 `Plan`，子节点在 `Plans` 里。
fn parse_postgres(rows: &[Map<String, JsonValue>], analyze: bool) -> Result<QueryPlan, QueryError> {
  let (parsed, raw) = parse_json_payload(rows)?;
  let entries = parsed.as_array().cloned().unwrap_or_else(|| vec![parsed.clone()]);

  let mut roots = Vec::new();
  let mut planning_ms = None;
  let mut execution_ms = None;
  for entry in &entries {
    let Some(object) = entry.as_object() else { continue };
    planning_ms = planning_ms.or_else(|| number(object.get("Planning Time")));
    execution_ms = execution_ms.or_else(|| number(object.get("Execution Time")));
    if let Some(plan) = object.get("Plan").and_then(JsonValue::as_object) {
      roots.push(postgres_node(plan));
    }
  }

  Ok(QueryPlan { roots, analyzed: analyze, planning_ms, execution_ms, raw })
}

/// 这些键已经有专门的字段，不再重复进 detail
const POSTGRES_PROMOTED: &[&str] = &[
  "Node Type",
  "Plans",
  "Plan Rows",
  "Actual Rows",
  "Total Cost",
  "Actual Total Time",
  "Relation Name",
];

fn postgres_node(plan: &Map<String, JsonValue>) -> PlanNode {
  let mut node =
    PlanNode::new(plan.get("Node Type").and_then(JsonValue::as_str).unwrap_or("Unknown"));
  // 依次退让：扫表给表名，扫索引给索引名，CTE 与函数各有自己的名字。
  // 都没有就留空——给一个猜出来的名字比留空糟
  node.target = ["Relation Name", "Index Name", "CTE Name", "Function Name"]
    .iter()
    .find_map(|key| plan.get(*key).and_then(JsonValue::as_str))
    .map(str::to_string);
  node.estimated_rows = number(plan.get("Plan Rows"));
  node.actual_rows = number(plan.get("Actual Rows"));
  node.cost = number(plan.get("Total Cost"));
  node.actual_ms = number(plan.get("Actual Total Time"));

  for (key, value) in plan {
    if POSTGRES_PROMOTED.contains(&key.as_str()) {
      continue;
    }
    if let Some(text) = scalar_text(value) {
      node.detail.push(PlanDetail { key: key.clone(), value: text });
    }
  }

  node.children = plan
    .get("Plans")
    .and_then(JsonValue::as_array)
    .map(|plans| plans.iter().filter_map(JsonValue::as_object).map(postgres_node).collect())
    .unwrap_or_default();
  node
}

/// MySQL：**用键名表示操作**的不规则嵌套对象。
///
/// 不枚举它的词汇表（`ordering_operation`、`grouping_operation`、
/// `duplicates_removal`、`materialized_from_subquery`…）：那份清单每个大版本
/// 都在长，漏一个就整棵子树不见。改成通用规则——**嵌套的对象/数组一律是
/// 子节点，标量是细节**。
///
/// 曾经想把「只装标量的对象」（`cost_info` 那种）压进父节点的细节里，少一层
/// 噪声。单测当场证明那条规则会吃掉节点：一个字段恰好全是标量的 `table`
/// 也满足它，于是那张表从树上消失了，而剩下的树看起来完全正常。
/// 宁可多一个 `cost_info` 叶子，也不要一条会静默丢节点的规则。
fn parse_mysql(rows: &[Map<String, JsonValue>]) -> Result<QueryPlan, QueryError> {
  let (parsed, raw) = parse_json_payload(rows)?;
  let roots = match parsed.as_object() {
    Some(object) => object.iter().filter_map(|(key, value)| mysql_node(key, value)).collect(),
    None => Vec::new(),
  };
  Ok(QueryPlan { roots, analyzed: false, planning_ms: None, execution_ms: None, raw })
}

fn mysql_node(key: &str, value: &JsonValue) -> Option<PlanNode> {
  match value {
    JsonValue::Object(map) => {
      let mut node = PlanNode::new(key);
      node.target = map.get("table_name").and_then(JsonValue::as_str).map(str::to_string);
      node.estimated_rows = number(map.get("rows_produced_per_join"))
        .or_else(|| number(map.get("rows_examined_per_scan")));
      node.cost = map.get("cost_info").and_then(JsonValue::as_object).and_then(|cost| {
        number(cost.get("prefix_cost")).or_else(|| number(cost.get("query_cost")))
      });

      for (child_key, child) in map {
        if child_key == "table_name" {
          continue;
        }
        if let Some(text) = scalar_text(child) {
          node.detail.push(PlanDetail { key: child_key.clone(), value: text });
          continue;
        }
        if let Some(found) = mysql_node(child_key, child) {
          node.children.push(found);
        }
      }
      Some(node)
    }
    JsonValue::Array(items) => {
      let children: Vec<PlanNode> = items
        .iter()
        .filter_map(|item| match item.as_object() {
          // `nested_loop` 的每个元素是 `{"table": {...}}` 这样的单键包装，
          // 用里面那个键当名字，外面那层不该在树上占一行
          Some(map) if map.len() == 1 => {
            map.iter().next().and_then(|(inner, value)| mysql_node(inner, value))
          }
          _ => mysql_node(key, item),
        })
        .collect();
      if children.is_empty() {
        return None;
      }
      let mut node = PlanNode::new(key);
      node.children = children;
      Some(node)
    }
    _ => None,
  }
}

/// TiDB 的 `tidb_json`：顶层是数组，子节点在 `subOperators` 里。
fn parse_tidb(rows: &[Map<String, JsonValue>]) -> Result<QueryPlan, QueryError> {
  let (parsed, raw) = parse_json_payload(rows)?;
  let roots: Vec<PlanNode> = parsed
    .as_array()
    .map(|operators| operators.iter().map(tidb_node).collect())
    .unwrap_or_default();
  if roots.is_empty() {
    return Err(QueryError::message(EXPLAIN_EMPTY));
  }
  Ok(QueryPlan { roots, analyzed: false, planning_ms: None, execution_ms: None, raw })
}

fn tidb_node(operator: &JsonValue) -> PlanNode {
  let text = |key: &str| operator.get(key).and_then(scalar_text).filter(|value| !value.is_empty());
  let id = text("id").unwrap_or_else(|| "?".to_string());
  let mut node = PlanNode::new(tidb_operation(&id));
  node.target = text("accessObject");
  node.estimated_rows = number(operator.get("estRows"));
  // 标签照 TiDB 自己普通 EXPLAIN 的列名写，读过它文档的人认得
  for (key, label) in [("taskType", "task"), ("operatorInfo", "operator info"), ("id", "id")] {
    if let Some(value) = text(key) {
      node.detail.push(PlanDetail { key: label.to_string(), value });
    }
  }
  node.children = operator
    .get("subOperators")
    .and_then(JsonValue::as_array)
    .map(|children| children.iter().map(tidb_node).collect())
    .unwrap_or_default();
  node
}

/// `HashJoin_27` → `HashJoin`，`IndexReader_32(Build)` → `IndexReader (Build)`。
///
/// 编号只是优化器内部的序号，树上一眼要看的是算子与它在连接里的角色；
/// 完整的 id 仍在 detail 里。
fn tidb_operation(id: &str) -> String {
  let (name, role) = match id.split_once('(') {
    Some((name, role)) => (name, Some(role.trim_end_matches(')'))),
    None => (id, None),
  };
  let base = match name.rsplit_once('_') {
    Some((base, number)) if !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) => {
      base
    }
    _ => name,
  };
  match role {
    Some(role) => format!("{base} ({role})"),
    None => base.to_string(),
  }
}

/// CockroachDB：一行一行的文本树。
///
/// ```text
/// planning time: 2ms            ← 只有 ANALYZE 才有的头部
/// • group (streaming)           ← `•` 所在的列就是深度
/// │ estimated row count: 1      ← 属于上面最近的那个节点
/// └── • scan
///       table: plan_a@idx_code
///
/// index recommendations: 1      ← 顶格、不带 `•`：树结束了
/// ```
///
/// 深度按 `•` 的字符位置算，不按字节：前面的 `│ ├ └ ─` 都是多字节字符。
fn parse_cockroach(
  rows: &[Map<String, JsonValue>],
  analyze: bool,
) -> Result<QueryPlan, QueryError> {
  let lines: Vec<String> = rows.iter().filter_map(first_cell).collect();
  let mut plan = QueryPlan {
    roots: Vec::new(),
    analyzed: analyze,
    planning_ms: None,
    execution_ms: None,
    raw: lines.join("\n"),
  };
  let mut stack: Vec<(usize, PlanNode)> = Vec::new();
  let mut started = false;

  for line in &lines {
    if let Some(depth) = line.chars().position(|c| c == '•') {
      let operation = line.split_once('•').map(|(_, rest)| rest.trim()).unwrap_or_default();
      close_deeper(&mut stack, &mut plan.roots, depth);
      stack.push((depth, PlanNode::new(operation)));
      started = true;
      continue;
    }
    let content = line.trim_start_matches([' ', '│', '├', '└', '─']);
    let Some((key, value)) = content.split_once(": ") else {
      continue;
    };
    let indented = content.len() != line.len();
    match stack.last_mut() {
      Some((_, node)) if indented => apply_cockroach_attribute(node, key, value.trim()),
      // 顶格的一行出现在树之后：树结束了，下面是索引建议之类，只留在原文里
      _ if started => close_deeper(&mut stack, &mut plan.roots, 0),
      _ => match key {
        "planning time" => plan.planning_ms = duration_ms(value),
        "execution time" => plan.execution_ms = duration_ms(value),
        _ => {}
      },
    }
  }
  close_deeper(&mut stack, &mut plan.roots, 0);

  if plan.roots.is_empty() {
    return Err(QueryError::message(EXPLAIN_EMPTY));
  }
  Ok(plan)
}

/// 把栈里深度 ≥ `depth` 的节点收起来，挂到各自的父节点上（栈底的挂成根）
fn close_deeper(stack: &mut Vec<(usize, PlanNode)>, roots: &mut Vec<PlanNode>, depth: usize) {
  while stack.last().is_some_and(|(top, _)| *top >= depth) {
    let Some((_, node)) = stack.pop() else { break };
    match stack.last_mut() {
      Some((_, parent)) => parent.children.push(node),
      None => roots.push(node),
    }
  }
}

fn apply_cockroach_attribute(node: &mut PlanNode, key: &str, value: &str) {
  match key {
    "estimated row count" => node.estimated_rows = leading_number(value),
    "actual row count" => node.actual_rows = leading_number(value),
    "execution time" => node.actual_ms = duration_ms(value),
    "table" => node.target = Some(value.to_string()),
    _ => node.detail.push(PlanDetail { key: key.to_string(), value: value.to_string() }),
  }
}

/// `1,000 (missing stats)` → 1000
fn leading_number(value: &str) -> Option<f64> {
  value.split_whitespace().next()?.replace(',', "").parse().ok()
}

/// `432µs` / `4ms` / `1.5s` → 毫秒
fn duration_ms(value: &str) -> Option<f64> {
  let value = value.trim();
  let split = value.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
  let (number, unit) = value.split_at(split);
  let number: f64 = number.parse().ok()?;
  let scale = match unit.trim() {
    "ns" => 1e-6,
    "µs" | "us" => 1e-3,
    "ms" => 1.0,
    "s" => 1e3,
    _ => return None,
  };
  Some(number * scale)
}

/// SQLite：扁平的行，靠 `parent` 指回另一行的 `id` 组成树。
///
/// 认不到父亲的行当成根，不丢掉：`id` 是 VDBE 地址，不保证连续，
/// 静默丢一行等于让计划少一步而没人知道。
fn parse_sqlite(rows: &[Map<String, JsonValue>]) -> QueryPlan {
  let entries: Vec<(i64, i64, String)> = rows
    .iter()
    .map(|row| {
      (
        number(row.get("id")).unwrap_or_default() as i64,
        number(row.get("parent")).unwrap_or_default() as i64,
        row.get("detail").map(cell_text).unwrap_or_default(),
      )
    })
    .collect();

  let known: Vec<i64> = entries.iter().map(|(id, ..)| *id).collect();
  let mut nodes: Vec<PlanNode> = entries
    .iter()
    .map(|(_, _, detail)| {
      let mut node = PlanNode::new(detail.clone());
      // SQLite 把表名写在文本里（`SCAN c USING …`），不另给一列。
      // 硬从文本里抠一个表名出来就是在猜，所以 target 留空
      node.target = None;
      node
    })
    .collect();

  // 从后往前接：子节点先接好，再整个挂到父亲上
  let mut roots = Vec::new();
  for index in (0..nodes.len()).rev() {
    let (_, parent, _) = entries[index];
    let node = nodes.remove(index);
    match known.iter().position(|id| *id == parent).filter(|position| *position < index) {
      Some(position) => nodes[position].children.insert(0, node),
      None => roots.insert(0, node),
    }
  }

  let raw = entries.iter().map(|(_, _, detail)| detail.clone()).collect::<Vec<_>>().join("\n");
  QueryPlan { roots, analyzed: false, planning_ms: None, execution_ms: None, raw }
}

/// SQL Server：一批一份 `ShowPlanXML`，每条语句一个 `QueryPlan`，里面是嵌套的
/// `RelOp`。
///
/// 子节点**不是** `RelOp` 的直接子元素：中间隔着一层运算符自己的元素
/// （`RelOp/NestedLoops/RelOp`、`RelOp/Hash/RelOp`），而谓词、列清单里也有
/// 深浅不一的嵌套。所以往下走的规矩是「遇到下一个 `RelOp` 就停」——它是
/// 子节点，它下面的东西归它。只认直接子元素的写法会得到一棵只有根的树。
fn parse_sql_server(rows: &[Map<String, JsonValue>]) -> Result<QueryPlan, QueryError> {
  let texts: Vec<String> = rows.iter().filter_map(first_cell).collect();
  if texts.iter().all(|text| text.trim().is_empty()) {
    return Err(QueryError::message(EXPLAIN_EMPTY));
  }

  let mut roots = Vec::new();
  for text in &texts {
    let document = roxmltree::Document::parse(text)
      .map_err(|error| QueryError::message(format!("{EXPLAIN_NOT_XML}: {error}")))?;
    // `SET`、`DECLARE` 这类语句也有 StmtSimple，但没有 QueryPlan
    for plan in document.descendants().filter(|node| is_element(node, "QueryPlan")) {
      roots.extend(plan.children().filter(|node| is_element(node, "RelOp")).map(sql_server_node));
    }
  }
  if roots.is_empty() {
    return Err(QueryError::message(EXPLAIN_EMPTY));
  }

  Ok(QueryPlan {
    roots,
    analyzed: false,
    planning_ms: None,
    execution_ms: None,
    // 一行到底的 XML 没法读；每个标签起一行。标签之间的空白在 XML 里不算内容，
    // 换行之后仍是同一份计划，另存成 .sqlplan 照样能在 SSMS 里打开
    raw: texts.join("\n").replace("><", ">\n<"),
  })
}

/// Oracle：`PLAN_TABLE` 的每一步带 `id` 与 `parent_id`，`DBMS_XPLAN` 的原文另给。
/// 两样由执行那一侧装进一格 JSON（`{"steps": [...], "text": "..."}`）。
///
/// 操作名是 `OPERATION` 与 `OPTIONS` 连起来（`TABLE ACCESS` + `FULL`）：`DBMS_XPLAN`
/// 就这么写，Oracle 用户认得的也是这个写法。
fn parse_oracle(rows: &[Map<String, JsonValue>]) -> Result<QueryPlan, QueryError> {
  let (payload, _) = parse_json_payload(rows)?;
  let steps = payload.get("steps").and_then(JsonValue::as_array).cloned().unwrap_or_default();
  if steps.is_empty() {
    return Err(QueryError::message(EXPLAIN_EMPTY));
  }
  let id_of = |step: &JsonValue, key: &str| number(step.get(key)).map(|value| value as i64);

  let mut nodes: Vec<(i64, Option<i64>, PlanNode)> = steps
    .iter()
    .filter_map(|step| Some((id_of(step, "id")?, id_of(step, "parent_id"), oracle_node(step))))
    .collect();
  // 从最深的一步往上挂：先把子节点挂好，父节点再被挂到它的父节点上时带着整棵子树。
  // `id` 按执行计划的先序排，子节点的 id 总比父节点大
  nodes.sort_by_key(|(id, _, _)| *id);
  let mut roots = Vec::new();
  while let Some((_, parent, node)) = nodes.pop() {
    match parent.and_then(|parent| nodes.iter_mut().find(|(id, _, _)| *id == parent)) {
      Some((_, _, parent)) => parent.children.insert(0, node),
      None => roots.insert(0, node),
    }
  }

  Ok(QueryPlan {
    roots,
    analyzed: false,
    planning_ms: None,
    execution_ms: None,
    raw: payload.get("text").and_then(JsonValue::as_str).unwrap_or_default().to_string(),
  })
}

fn oracle_node(step: &JsonValue) -> PlanNode {
  let text = |key: &str| step.get(key).and_then(scalar_text).filter(|value| !value.is_empty());
  let operation = match (text("operation"), text("options")) {
    (Some(operation), Some(options)) => format!("{operation} {options}"),
    (Some(operation), None) => operation,
    _ => "?".to_string(),
  };
  let mut node = PlanNode::new(operation);
  node.target = match (text("object_owner"), text("object_name")) {
    (Some(owner), Some(name)) => Some(format!("{owner}.{name}")),
    (None, Some(name)) => Some(name),
    _ => None,
  };
  node.estimated_rows = number(step.get("cardinality"));
  node.cost = number(step.get("cost"));
  for (key, label) in [
    ("access_predicates", "Access"),
    ("filter_predicates", "Filter"),
    ("object_type", "Object type"),
    ("bytes", "Bytes"),
    ("cpu_cost", "CPU cost"),
    ("io_cost", "IO cost"),
    ("time", "Time (s)"),
    ("projection", "Projection"),
  ] {
    if let Some(value) = text(key) {
      node.detail.push(PlanDetail { key: label.to_string(), value });
    }
  }
  node
}

/// 按本地名比，不管命名空间：整份计划都在 showplan 的命名空间里
fn is_element(node: &roxmltree::Node<'_, '_>, name: &str) -> bool {
  node.is_element() && node.tag_name().name() == name
}

fn sql_server_node(relop: roxmltree::Node<'_, '_>) -> PlanNode {
  let attribute = |name: &str| relop.attribute(name);
  let physical = attribute("PhysicalOp").unwrap_or("?");
  let mut node = PlanNode::new(physical);
  node.estimated_rows = attribute("EstimateRows").and_then(|value| value.parse().ok());
  node.cost = attribute("EstimatedTotalSubtreeCost").and_then(|value| value.parse().ok());

  let mut owned = OwnedElements::default();
  collect_owned(relop, &mut owned);
  node.children = owned.children.into_iter().map(sql_server_node).collect();

  if let Some(object) = owned.object {
    let part = |name: &str| object.attribute(name).map(|value| value.trim_matches(['[', ']']));
    node.target = match (part("Schema"), part("Table")) {
      (Some(schema), Some(table)) => Some(format!("{schema}.{table}")),
      (None, Some(table)) => Some(table.to_string()),
      _ => None,
    };
    if let Some(index) = part("Index") {
      node.detail.push(PlanDetail { key: "Index".to_string(), value: index.to_string() });
    }
  }
  if let Some(logical) = attribute("LogicalOp").filter(|logical| *logical != physical) {
    node.detail.push(PlanDetail { key: "LogicalOp".to_string(), value: logical.to_string() });
  }
  for (key, text) in owned.predicates {
    node.detail.push(PlanDetail { key, value: text });
  }
  for key in ["EstimateIO", "EstimateCPU", "AvgRowSize", "EstimatedExecutionMode", "Parallel"] {
    if let Some(value) = attribute(key) {
      node.detail.push(PlanDetail { key: key.to_string(), value: value.to_string() });
    }
  }
  node
}

/// 索引查找的范围，`id GT (1)`。它没有现成的文本：列在 `RangeColumns`，
/// 比较方式在 `ScanType`，值在 `RangeExpressions`，要自己拼
fn seek_ranges(seek: roxmltree::Node<'_, '_>) -> String {
  seek
    .descendants()
    .filter(|node| matches!(node.tag_name().name(), "Prefix" | "StartRange" | "EndRange"))
    .map(|range| {
      let columns = range
        .descendants()
        .filter(|node| {
          is_element(node, "ColumnReference")
            && node.parent().is_some_and(|parent| is_element(&parent, "RangeColumns"))
        })
        .filter_map(|column| column.attribute("Column"))
        .collect::<Vec<_>>()
        .join(", ");
      let values = range
        .descendants()
        .filter(|node| is_element(node, "ScalarOperator"))
        .filter_map(|value| value.attribute("ScalarString"))
        .collect::<Vec<_>>()
        .join(", ");
      format!("{columns} {} {values}", range.attribute("ScanType").unwrap_or("="))
    })
    .collect::<Vec<_>>()
    .join(" AND ")
}

/// 一个 `RelOp` 自己名下的东西：到下一个 `RelOp` 为止
#[derive(Default)]
struct OwnedElements<'a, 'input> {
  children: Vec<roxmltree::Node<'a, 'input>>,
  object: Option<roxmltree::Node<'a, 'input>>,
  /// 谓词的元素名（`Predicate`、`SeekPredicates`…）与服务端写好的那段文本
  predicates: Vec<(String, String)>,
}

fn collect_owned<'a, 'input>(
  node: roxmltree::Node<'a, 'input>,
  owned: &mut OwnedElements<'a, 'input>,
) {
  for child in node.children().filter(roxmltree::Node::is_element) {
    let name = child.tag_name().name();
    if name == "RelOp" {
      owned.children.push(child);
      continue;
    }
    if name == "Object" && owned.object.is_none() {
      owned.object = Some(child);
    }
    if name == "SeekPredicates" {
      owned.predicates.push((name.to_string(), seek_ranges(child)));
      continue;
    }
    if matches!(name, "Predicate" | "ProbeResidual" | "Residual") {
      // 谓词的可读文本在它下面第一个带 ScalarString 的元素上
      let text = child.descendants().find_map(|element| element.attribute("ScalarString"));
      if let Some(text) = text {
        owned.predicates.push((name.to_string(), text.to_string()));
        continue;
      }
    }
    collect_owned(child, owned);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn row(pairs: &[(&str, JsonValue)]) -> Map<String, JsonValue> {
    pairs.iter().map(|(key, value)| ((*key).to_string(), value.clone())).collect()
  }

  fn json_row(text: &str) -> Vec<Map<String, JsonValue>> {
    vec![row(&[("QUERY PLAN", JsonValue::String(text.to_string()))])]
  }

  /// 原样取自 PostgreSQL 16 的 `EXPLAIN (ANALYZE, FORMAT JSON)`
  const POSTGRES_ANALYZED: &str = r#"[
    {
      "Plan": {
        "Node Type": "Limit",
        "Startup Cost": 0.0, "Total Cost": 0.1, "Plan Rows": 3, "Plan Width": 4,
        "Actual Startup Time": 0.027, "Actual Total Time": 0.029,
        "Actual Rows": 3, "Actual Loops": 1,
        "Plans": [
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "Outer",
            "Relation Name": "plan_probe", "Alias": "p",
            "Startup Cost": 0.0, "Total Cost": 9.25, "Plan Rows": 285, "Plan Width": 4,
            "Actual Startup Time": 0.025, "Actual Total Time": 0.026,
            "Actual Rows": 3, "Actual Loops": 1,
            "Filter": "(n > 2)", "Rows Removed by Filter": 2
          }
        ]
      },
      "Planning Time": 0.123,
      "Triggers": [],
      "Execution Time": 0.051
    }
  ]"#;

  #[test]
  fn postgres_plan_keeps_the_nesting_and_both_row_counts() {
    let plan =
      parse_plan(&DatabaseType::PostgreSQL, &json_row(POSTGRES_ANALYZED), true).expect("parse");
    assert_eq!(plan.planning_ms, Some(0.123));
    assert_eq!(plan.execution_ms, Some(0.051));
    assert_eq!(plan.roots.len(), 1);

    let limit = &plan.roots[0];
    assert_eq!(limit.operation, "Limit");
    assert_eq!(limit.children.len(), 1);

    let scan = &limit.children[0];
    assert_eq!(scan.operation, "Seq Scan");
    assert_eq!(scan.target.as_deref(), Some("plan_probe"));
    // 估算和实际必须分得开：把 285 显示成实际行数，整张图的意义就反了
    assert_eq!(scan.estimated_rows, Some(285.0));
    assert_eq!(scan.actual_rows, Some(3.0));
    assert_eq!(scan.cost, Some(9.25));
    assert_eq!(scan.actual_ms, Some(0.026));
    assert!(
      scan.detail.iter().any(|item| item.key == "Filter" && item.value == "(n > 2)"),
      "其余字段要原样带上: {:?}",
      scan.detail
    );
  }

  /// 没 ANALYZE 时不能凭空造出实际行数——那正是「计划对不对」要靠的对比
  #[test]
  fn a_plain_postgres_plan_has_no_actual_numbers() {
    let text =
      r#"[{"Plan":{"Node Type":"Seq Scan","Relation Name":"t","Plan Rows":7,"Total Cost":1.5}}]"#;
    let plan = parse_plan(&DatabaseType::PostgreSQL, &json_row(text), false).expect("parse");
    let node = &plan.roots[0];
    assert_eq!(node.estimated_rows, Some(7.0));
    assert_eq!(node.actual_rows, None);
    assert_eq!(node.actual_ms, None);
    assert!(!plan.analyzed);
  }

  /// 原样取自 MySQL 8.4 的 `EXPLAIN FORMAT=JSON`
  const MYSQL_PLAN: &str = r#"{
    "query_block": {
      "select_id": 1,
      "cost_info": { "query_cost": "43.58" },
      "ordering_operation": {
        "using_filesort": true,
        "grouping_operation": {
          "using_temporary_table": true,
          "nested_loop": [
            {
              "table": {
                "table_name": "p",
                "access_type": "ALL",
                "rows_examined_per_scan": 200,
                "rows_produced_per_join": 66,
                "filtered": "33.33",
                "cost_info": { "read_cost": "13.58", "prefix_cost": "20.25" },
                "attached_condition": "(`db`.`p`.`n` > 2)"
              }
            },
            {
              "table": {
                "table_name": "c",
                "access_type": "ref",
                "key": "parent",
                "rows_examined_per_scan": 1,
                "rows_produced_per_join": 66,
                "cost_info": { "read_cost": "16.66", "prefix_cost": "43.58" }
              }
            }
          ]
        }
      }
    }
  }"#;

  #[test]
  fn mysql_plan_nests_by_key_name_and_keeps_both_tables() {
    let plan = parse_plan(&DatabaseType::MySQL, &json_row(MYSQL_PLAN), false).expect("parse");
    assert_eq!(plan.roots.len(), 1);
    let block = &plan.roots[0];
    assert_eq!(block.operation, "query_block");
    // cost_info 作为叶子节点出现，不做「压进细节」的特殊处理——那条规则
    // 会连带吃掉字段恰好全是标量的 table 节点
    let names: Vec<&str> = block.children.iter().map(|child| child.operation.as_str()).collect();
    assert!(names.contains(&"cost_info"), "{names:?}");

    let ordering = block
      .children
      .iter()
      .find(|child| child.operation == "ordering_operation")
      .expect("ordering_operation");
    assert_eq!(ordering.operation, "ordering_operation");
    let grouping = &ordering.children[0];
    assert_eq!(grouping.operation, "grouping_operation");
    let loop_node = &grouping.children[0];
    assert_eq!(loop_node.operation, "nested_loop");

    // `nested_loop` 的元素是 `{"table": {...}}` 单键包装，外面那层不该占一行
    let tables: Vec<&str> =
      loop_node.children.iter().map(|child| child.target.as_deref().unwrap_or_default()).collect();
    assert_eq!(tables, vec!["p", "c"], "两张表都要在，且顺序是连接顺序");
    assert_eq!(loop_node.children[0].operation, "table");
    assert_eq!(loop_node.children[0].estimated_rows, Some(66.0));
    assert_eq!(loop_node.children[0].cost, Some(20.25));
  }

  /// 不认识的容器键也要长出子树来。
  ///
  /// MySQL 的词汇表每个大版本都在长，枚举它就等于给未来留一个静默丢子树的坑。
  #[test]
  fn mysql_keeps_containers_it_has_never_heard_of() {
    let text = r#"{"query_block":{"some_future_operation":{"table":{"table_name":"t"}}}}"#;
    let plan = parse_plan(&DatabaseType::MySQL, &json_row(text), false).expect("parse");
    let future = &plan.roots[0].children[0];
    assert_eq!(future.operation, "some_future_operation");
    assert_eq!(future.children[0].target.as_deref(), Some("t"));
  }

  #[test]
  fn sqlite_rows_become_a_tree_through_the_parent_pointers() {
    let rows = vec![
      row(&[
        ("id", JsonValue::from(9)),
        ("parent", JsonValue::from(0)),
        ("detail", JsonValue::String("SCAN c USING COVERING INDEX ix".into())),
      ]),
      row(&[
        ("id", JsonValue::from(11)),
        ("parent", JsonValue::from(9)),
        ("detail", JsonValue::String("SEARCH p USING INTEGER PRIMARY KEY".into())),
      ]),
      row(&[
        ("id", JsonValue::from(16)),
        ("parent", JsonValue::from(0)),
        ("detail", JsonValue::String("USE TEMP B-TREE FOR GROUP BY".into())),
      ]),
    ];
    let plan = parse_plan(&DatabaseType::SQLite, &rows, false).expect("parse");
    assert_eq!(plan.roots.len(), 2);
    assert_eq!(plan.roots[0].operation, "SCAN c USING COVERING INDEX ix");
    assert_eq!(plan.roots[0].children.len(), 1);
    assert_eq!(plan.roots[1].operation, "USE TEMP B-TREE FOR GROUP BY");
  }

  /// `id` 是 VDBE 地址，不保证连续。认不到父亲的行当成根，不能丢掉——
  /// 静默少一步，而没有任何地方会说这是为什么。
  #[test]
  fn sqlite_keeps_a_row_whose_parent_is_missing() {
    let rows = vec![row(&[
      ("id", JsonValue::from(4)),
      ("parent", JsonValue::from(999)),
      ("detail", JsonValue::String("SCAN t".into())),
    ])];
    let plan = parse_plan(&DatabaseType::SQLite, &rows, false).expect("parse");
    assert_eq!(plan.roots.len(), 1);
    assert_eq!(plan.roots[0].operation, "SCAN t");
  }

  /// 解码器会把 JSON 列包成 `{type:"json", value:"…"}`，拆不开就整棵树都没了
  #[test]
  fn unwraps_the_tagged_json_column_our_own_decoder_produces() {
    let tagged = row(&[(
      "QUERY PLAN",
      JsonValue::Object(Map::from_iter([
        ("type".to_string(), JsonValue::String("json".into())),
        ("value".to_string(), JsonValue::String(r#"[{"Plan":{"Node Type":"Result"}}]"#.into())),
      ])),
    )]);
    let plan = parse_plan(&DatabaseType::PostgreSQL, &[tagged], false).expect("parse");
    assert_eq!(plan.roots[0].operation, "Result");
  }

  #[test]
  fn an_empty_result_is_an_error_not_an_empty_tree() {
    // 空树在界面上和「这条语句不走任何步骤」长得一样
    assert!(parse_plan(&DatabaseType::PostgreSQL, &[], false).is_err());
  }

  /// 「不做」的重估条件，写成可执行的。
  #[test]
  fn only_postgres_can_really_run_the_plan() {
    // SQLite 的裸 EXPLAIN 给的是 VDBE 字节码；MySQL 的 EXPLAIN ANALYZE
    // 只出缩进文本，要再写一个解析器，而路线图这一条没要它
    assert!(supports_analyze(&DatabaseType::PostgreSQL));
    assert!(!supports_analyze(&DatabaseType::SQLite));
    assert!(!supports_analyze(&DatabaseType::MySQL));
  }

  #[test]
  fn asking_to_analyze_where_it_is_unsupported_is_an_error_not_a_silent_downgrade() {
    // 降级成普通 EXPLAIN，界面会说「真的跑了一遍」而给的是估算值
    for db_type in [DatabaseType::MySQL, DatabaseType::SQLite] {
      assert!(explain_statement(&db_type, "SELECT 1", true).is_err(), "{db_type:?}");
    }
  }

  #[test]
  fn strips_the_trailing_semicolon_before_wrapping() {
    // `EXPLAIN SELECT 1;` 在 MySQL 上没问题，但拼在 `EXPLAIN (…) …` 后面的
    // 分号会让 PostgreSQL 报语法错误
    let sql = explain_statement(&DatabaseType::PostgreSQL, "SELECT 1;  ", false).expect("pg");
    assert!(sql.ends_with("SELECT 1"), "{sql}");
  }

  #[test]
  fn analyze_changes_the_statement() {
    let plain = explain_statement(&DatabaseType::PostgreSQL, "SELECT 1", false).expect("plain");
    let analyzed = explain_statement(&DatabaseType::PostgreSQL, "SELECT 1", true).expect("ok");
    assert!(!plain.contains("ANALYZE"), "{plain}");
    assert!(analyzed.contains("ANALYZE"), "{analyzed}");
  }

  #[test]
  fn unsupported_databases_say_so_instead_of_returning_broken_sql() {
    assert!(explain_statement(&DatabaseType::MongoDB, "SELECT 1", false).is_err());
  }

  /// 真库上取回来的一份计划（`fixtures/sqlserver-showplan.xml`，两表连接加排序）
  #[test]
  fn sql_server_plans_nest_through_the_operator_elements() {
    let xml = include_str!("../../../fixtures/sqlserver-showplan.xml");
    let plan = parse_plan(&DatabaseType::SqlServer, &json_row(xml), false).expect("parses");

    assert!(!plan.analyzed);
    assert_eq!(plan.roots.len(), 1);
    let join = &plan.roots[0];
    assert_eq!(join.operation, "Nested Loops");
    assert_eq!(join.estimated_rows, Some(1.0));
    assert!(join.cost.is_some_and(|cost| cost > 0.0));
    assert!(join.detail.iter().any(|d| d.key == "LogicalOp" && d.value == "Inner Join"));

    // 子节点隔着 NestedLoops 那一层；只认直接子元素会得到一棵只有根的树
    let operations: Vec<&str> = join.children.iter().map(|c| c.operation.as_str()).collect();
    assert_eq!(operations, ["Index Scan", "Clustered Index Seek"]);
    let seek = &join.children[1];
    assert_eq!(seek.target.as_deref(), Some("dataomni_meta.child"));
    assert!(seek.detail.iter().any(|d| d.key == "Index" && d.value == "pk_child"));
    let range = seek.detail.iter().find(|d| d.key == "SeekPredicates").expect("seek range");
    assert_eq!(range.value, "id GT (1)");
    // 下一层的对象不能被算到上一层头上
    assert_eq!(join.target, None);
    assert!(plan.raw.lines().count() > 10, "原文要一行一个标签");
  }

  /// 真库上取回来的一份（`fixtures/oracle-plan.json`，分组加排序），由 `oracle_smoke` 写出
  #[test]
  fn oracle_plans_hang_steps_under_their_parent_ids() {
    let rows: Vec<Map<String, JsonValue>> =
      serde_json::from_str(include_str!("../../../fixtures/oracle-plan.json")).expect("fixture");
    let plan = parse_plan(&DatabaseType::Oracle, &rows, false).expect("parses");

    assert_eq!(plan.roots.len(), 1);
    let root = &plan.roots[0];
    assert_eq!(root.operation, "SELECT STATEMENT");
    assert_eq!(root.cost, Some(4.0));
    let sort = &root.children[0];
    assert_eq!(sort.operation, "SORT GROUP BY", "操作名是 OPERATION 与 OPTIONS 连起来");
    let scan = &sort.children[0];
    assert_eq!(scan.operation, "TABLE ACCESS FULL");
    assert_eq!(scan.target.as_deref(), Some("DATAOMNI.OM_WRITE"));
    assert_eq!(scan.estimated_rows, Some(1.0));
    assert!(scan.detail.iter().any(|d| d.key == "Filter" && d.value == "\"ID\">1"));
    assert!(plan.raw.starts_with("Plan hash value"), "{}", plan.raw);
  }

  #[test]
  fn oracle_siblings_keep_the_plan_order() {
    use serde_json::json;
    let step = |id: i64, parent: Option<i64>, operation: &str| json!({ "id": id, "parent_id": parent, "operation": operation, "options": null });
    let payload = json!({
      "steps": [
        step(0, None, "SELECT STATEMENT"),
        step(1, Some(0), "HASH JOIN"),
        step(2, Some(1), "BUILD"),
        step(3, Some(2), "BUILD SCAN"),
        step(4, Some(1), "PROBE"),
      ],
      "text": ""
    });
    let plan =
      parse_plan(&DatabaseType::Oracle, &json_row(&payload.to_string()), false).expect("parses");
    let join = &plan.roots[0].children[0];
    let children: Vec<&str> = join.children.iter().map(|c| c.operation.as_str()).collect();
    assert_eq!(children, ["BUILD", "PROBE"], "连接的两侧不能颠倒");
    assert_eq!(join.children[0].children[0].operation, "BUILD SCAN");
  }

  #[test]
  fn an_oracle_plan_without_steps_is_empty_not_a_blank_tree() {
    let error = parse_plan(&DatabaseType::Oracle, &json_row(r#"{"steps":[],"text":""}"#), false)
      .expect_err("empty");
    assert_eq!(error.message, EXPLAIN_EMPTY);
  }

  #[test]
  fn a_sql_server_plan_that_is_not_xml_is_named() {
    let error = parse_plan(&DatabaseType::SqlServer, &json_row("<ShowPlanXML"), false)
      .expect_err("broken xml");
    assert!(error.message.starts_with(EXPLAIN_NOT_XML), "{}", error.message);
  }

  /// TiDB 8.5 的 `EXPLAIN FORMAT='tidb_json'`，原样取自真库（`fixtures/tidb-plan.json`）
  const TIDB_PLAN: &str = include_str!("../../../fixtures/tidb-plan.json");

  fn find<'a>(node: &'a PlanNode, operation: &str) -> Option<&'a PlanNode> {
    if node.operation == operation {
      return Some(node);
    }
    node.children.iter().find_map(|child| find(child, operation))
  }

  #[test]
  fn tidb_plan_nests_by_sub_operators_and_keeps_the_join_roles() {
    let rows = vec![row(&[("TiDB_JSON", JsonValue::String(TIDB_PLAN.to_string()))])];
    let plan = parse_plan(PlanDialect::TiDb, &rows, false).expect("parse");
    assert_eq!(plan.roots.len(), 1);
    assert_eq!(plan.roots[0].operation, "Sort");

    let join = find(&plan.roots[0], "HashJoin").expect("HashJoin 在树上");
    let sides: Vec<&str> = join.children.iter().map(|child| child.operation.as_str()).collect();
    assert_eq!(sides, vec!["IndexReader (Build)", "TableReader (Probe)"]);

    let scan = find(&plan.roots[0], "IndexRangeScan").expect("索引扫描");
    assert_eq!(scan.target.as_deref(), Some("table:a, index:idx_code(code)"));
    assert_eq!(scan.estimated_rows, Some(10.0));
    // 去掉的编号还在 detail 里
    assert!(scan
      .detail
      .iter()
      .any(|entry| entry.key == "id" && entry.value == "IndexRangeScan_31"));
  }

  #[test]
  fn tidb_operation_drops_the_optimizer_serial_but_not_a_real_suffix() {
    assert_eq!(tidb_operation("HashJoin_27"), "HashJoin");
    assert_eq!(tidb_operation("TableReader_30(Probe)"), "TableReader (Probe)");
    assert_eq!(tidb_operation("Point_Get_1"), "Point_Get");
    assert_eq!(tidb_operation("Projection"), "Projection");
  }

  fn cockroach_rows(key: &str) -> Vec<Map<String, JsonValue>> {
    let fixture: JsonValue =
      serde_json::from_str(include_str!("../../../fixtures/cockroach-plan.json")).expect("fixture");
    fixture[key]
      .as_array()
      .expect("lines")
      .iter()
      .map(|line| row(&[("info", line.clone())]))
      .collect()
  }

  #[test]
  fn cockroach_text_tree_nests_by_the_bullet_column() {
    let plan =
      parse_plan(PlanDialect::CockroachDb, &cockroach_rows("plain"), false).expect("parse");
    assert_eq!(plan.roots.len(), 1, "{:?}", plan.roots);
    let root = &plan.roots[0];
    assert_eq!(root.operation, "group (streaming)");
    assert_eq!(root.estimated_rows, Some(1.0));

    let join = find(root, "hash join (inner)").expect("连接");
    let scans: Vec<(&str, Option<f64>)> = join
      .children
      .iter()
      .map(|child| (child.target.as_deref().unwrap_or(""), child.estimated_rows))
      .collect();
    // `├──` 与 `└──` 下的两个 scan 是兄弟，不是一个挂在另一个下面
    assert_eq!(scans, vec![("plan_a@idx_code", Some(1.0)), ("plan_b@plan_b_pkey", Some(2.0))]);
    assert!(join.children.iter().all(|child| child.children.is_empty()));
    assert!(root.actual_rows.is_none(), "没 ANALYZE 就不该有实际行数");
    assert!(plan.raw.starts_with("distribution: local"), "原文一行不少");
  }

  #[test]
  fn cockroach_stops_the_tree_at_the_first_flush_left_line() {
    // 缺索引时树后面跟着索引建议，取自统计信息还没收齐时的真实输出
    let lines = [
      "• scan",
      "  estimated row count: 1,000 (missing stats)",
      "  table: plan_b@plan_b_pkey",
      "",
      "index recommendations: 1",
      "1. type: index creation",
      "   SQL command: CREATE INDEX ON plan_b (a_id) STORING (amount);",
    ];
    let rows: Vec<_> =
      lines.iter().map(|line| row(&[("info", JsonValue::String(line.to_string()))])).collect();
    let plan = parse_plan(PlanDialect::CockroachDb, &rows, false).expect("parse");
    let scan = &plan.roots[0];
    // 千分位的逗号要认
    assert_eq!(scan.estimated_rows, Some(1000.0));
    assert!(
      scan.detail.iter().all(|entry| !entry.value.contains("CREATE INDEX")),
      "索引建议不是这个节点的属性: {:?}",
      scan.detail
    );
  }

  #[test]
  fn cockroach_analyze_gives_actual_rows_and_both_times() {
    let plan =
      parse_plan(PlanDialect::CockroachDb, &cockroach_rows("analyze"), true).expect("parse");
    assert!(plan.analyzed);
    assert_eq!(plan.planning_ms, Some(2.0));
    assert_eq!(plan.execution_ms, Some(7.0));
    let root = &plan.roots[0];
    // 节点里的 execution time 是这一步的耗时，不是头部那个
    assert_eq!(root.actual_ms, Some(0.099));
    let join = find(root, "hash join (inner)").expect("连接");
    let actual: Vec<Option<f64>> = join.children.iter().map(|child| child.actual_rows).collect();
    assert_eq!(actual, vec![Some(1.0), Some(2.0)]);
  }

  #[test]
  fn the_server_version_decides_the_dialect_not_the_connection_type_alone() {
    let mysql = DatabaseType::MySQL;
    let postgres = DatabaseType::PostgreSQL;
    assert_eq!(PlanDialect::detect(&mysql, "8.0.11-TiDB-v8.5.3"), PlanDialect::TiDb);
    assert_eq!(PlanDialect::detect(&mysql, "8.4.2"), PlanDialect::MySql);
    assert_eq!(PlanDialect::detect(&mysql, "11.4.3-MariaDB"), PlanDialect::MySql);
    assert_eq!(
      PlanDialect::detect(&postgres, "CockroachDB CCL v25.2.1 (x86_64-pc-linux-gnu)"),
      PlanDialect::CockroachDb
    );
    assert_eq!(PlanDialect::detect(&postgres, "PostgreSQL 16.4"), PlanDialect::PostgreSql);
    // 同一句版本串落在别的类型上不改变什么
    assert_eq!(PlanDialect::detect(&DatabaseType::SQLite, "TiDB"), PlanDialect::Sqlite);
  }

  #[test]
  fn tidb_and_cockroach_get_their_own_explain_and_only_cockroach_can_analyze() {
    assert_eq!(
      explain_statement(PlanDialect::TiDb, "SELECT 1;", false).expect("tidb"),
      "EXPLAIN FORMAT='tidb_json' SELECT 1"
    );
    assert!(explain_statement(PlanDialect::TiDb, "SELECT 1", true).is_err());
    assert_eq!(
      explain_statement(PlanDialect::CockroachDb, "SELECT 1", true).expect("crdb"),
      "EXPLAIN ANALYZE (VERBOSE) SELECT 1"
    );
  }
}
