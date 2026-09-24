//! 对象级结构操作语料 `fixtures/object-ddl-conformance.json` 的读法，三份真库用例共用。
use serde_json::Value as JsonValue;

pub struct Case {
  pub name: String,
  /// 语句里写死的 schema（建 schema 的用例没有）。冒烟用例先核对连上的正是它，不去替换语句
  pub schema: Option<String>,
  pub fixture: Vec<String>,
  pub statement: String,
  /// 只返回一个整数的查询
  pub check: String,
  pub expect: i64,
  pub cleanup: Vec<String>,
}

fn text(value: &JsonValue, key: &str) -> Option<String> {
  value.get(key).and_then(|found| found.as_str()).map(str::to_string)
}

fn strings(value: &JsonValue, key: &str) -> Vec<String> {
  value
    .get(key)
    .and_then(|found| found.as_array())
    .map(|entries| entries.iter().filter_map(|entry| entry.as_str().map(str::to_string)).collect())
    .unwrap_or_default()
}

pub fn load(dialect: &str) -> Vec<Case> {
  let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/object-ddl-conformance.json");
  let source = std::fs::read_to_string(path).expect("读取对象结构语料");
  let parsed: JsonValue = serde_json::from_str(&source).expect("解析对象结构语料");
  let cases = parsed.get("cases").and_then(|found| found.as_array()).expect("语料里要有 cases");
  let loaded: Vec<Case> = cases
    .iter()
    .filter(|case| text(case, "dialect").as_deref() == Some(dialect))
    .map(|case| Case {
      name: text(case, "name").unwrap_or_default(),
      schema: case.get("request").and_then(|request| text(request, "schema")),
      fixture: strings(case, "fixture"),
      statement: text(case, "statement").unwrap_or_default(),
      check: text(case, "check").unwrap_or_default(),
      expect: case.get("expect").and_then(JsonValue::as_i64).expect("expect 是整数"),
      cleanup: strings(case, "cleanup"),
    })
    .collect();
  assert!(!loaded.is_empty(), "语料里要有 {dialect} 的用例");
  loaded
}
