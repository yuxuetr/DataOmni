//! 改结构语料 `fixtures/ddl-conformance.json` 的读法，两份真库用例共用。
use serde_json::Value as JsonValue;

pub struct Case {
  pub name: String,
  pub table: String,
  pub final_table: String,
  pub fixture: Vec<String>,
  pub statements: Vec<String>,
  /// 建表用例跑完之后不写主键值插一行：写错的自增表现不是建表失败，
  /// 而是建出来了但**插不进行**
  pub insert: Vec<String>,
  pub origin: Vec<Column>,
  pub after: Vec<Column>,
  pub cleanup: Vec<String>,
  /// 改表名单独成句的那种（TiDB 上界面发的就是它）：任何一家都不许拒绝。
  /// 只有 MySQL 系的用例读它，另两份用例文件里是死字段
  #[allow(dead_code)]
  pub rename_apart: bool,
}

/// 目录里一列的期望值。`None` 表示这个方言不报告该字段，不参与比对
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
  pub name: String,
  pub data_type: String,
  pub nullable: bool,
  pub primary_key_ordinal: Option<i64>,
  pub default_value: Option<String>,
  pub generated: bool,
  pub collation: Option<String>,
  pub comment: Option<String>,
  pub extra: Option<String>,
}

fn text(value: &JsonValue, key: &str) -> Option<String> {
  value.get(key).and_then(|found| found.as_str()).map(str::to_string)
}

fn columns(value: &JsonValue, key: &str) -> Vec<Column> {
  value
    .get(key)
    .and_then(|found| found.as_array())
    .map(|entries| {
      entries
        .iter()
        .map(|entry| Column {
          name: text(entry, "name").unwrap_or_default(),
          data_type: text(entry, "dataType").unwrap_or_default(),
          nullable: entry.get("nullable").and_then(|found| found.as_bool()).unwrap_or(false),
          primary_key_ordinal: entry.get("primaryKeyOrdinal").and_then(|found| found.as_i64()),
          default_value: text(entry, "defaultValue"),
          generated: entry.get("generated").and_then(|found| found.as_bool()).unwrap_or(false),
          collation: text(entry, "collation"),
          comment: text(entry, "comment"),
          extra: text(entry, "extra"),
        })
        .collect()
    })
    .unwrap_or_default()
}

fn strings(value: &JsonValue, key: &str) -> Vec<String> {
  value
    .get(key)
    .and_then(|found| found.as_array())
    .map(|entries| entries.iter().filter_map(|entry| entry.as_str().map(str::to_string)).collect())
    .unwrap_or_default()
}

pub fn load(dialect: &str) -> Vec<Case> {
  let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/ddl-conformance.json");
  let source = std::fs::read_to_string(path).expect("读取改结构语料");
  let parsed: JsonValue = serde_json::from_str(&source).expect("解析改结构语料");
  let cases = parsed.get("cases").and_then(|found| found.as_array()).expect("语料里要有 cases");
  cases
    .iter()
    .filter(|case| text(case, "dialect").as_deref() == Some(dialect))
    .map(|case| Case {
      name: text(case, "name").unwrap_or_default(),
      table: text(case, "table").unwrap_or_default(),
      final_table: text(case, "newTableName").unwrap_or_default(),
      fixture: strings(case, "fixture"),
      statements: strings(case, "statements"),
      insert: strings(case, "insert"),
      origin: columns(case, "origin"),
      after: columns(case, "after"),
      cleanup: strings(case, "cleanup"),
      rename_apart: case.get("renameApart").and_then(JsonValue::as_bool).unwrap_or(false),
    })
    .collect()
}
