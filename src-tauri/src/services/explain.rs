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

/// 取计划要发的那条语句。
///
/// 一律用结构化格式：文本格式好看，但为了它再发一次 EXPLAIN，在 ANALYZE
/// 下就是把查询跑第二遍。
pub fn explain_statement(
  db_type: &DatabaseType,
  sql: &str,
  analyze: bool,
) -> Result<String, QueryError> {
  if analyze && !supports_analyze(db_type) {
    // 悄悄降级成普通 EXPLAIN 才是最糟的：界面说「真的跑了一遍」，
    // 而给出的是估算值
    return Err(QueryError::message(format!("{EXPLAIN_ANALYZE_UNSUPPORTED}: {db_type:?}")));
  }
  let sql = sql.trim().trim_end_matches(';');
  match db_type {
    DatabaseType::PostgreSQL => Ok(if analyze {
      // BUFFERS 一起要：知道「读了多少块、命中多少」才看得出慢在 I/O 还是 CPU
      format!("EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) {sql}")
    } else {
      format!("EXPLAIN (VERBOSE, FORMAT JSON) {sql}")
    }),
    DatabaseType::MySQL => Ok(format!("EXPLAIN FORMAT=JSON {sql}")),
    DatabaseType::SQLite => Ok(format!("EXPLAIN QUERY PLAN {sql}")),
    other => Err(QueryError::message(format!("{EXPLAIN_UNSUPPORTED}: {other:?}"))),
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
  db_type: &DatabaseType,
  rows: &[Map<String, JsonValue>],
  analyze: bool,
) -> Result<QueryPlan, QueryError> {
  match db_type {
    DatabaseType::PostgreSQL => parse_postgres(rows, analyze),
    DatabaseType::MySQL => parse_mysql(rows),
    DatabaseType::SQLite => Ok(parse_sqlite(rows)),
    other => Err(QueryError::message(format!("{EXPLAIN_UNSUPPORTED}: {other:?}"))),
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
}
