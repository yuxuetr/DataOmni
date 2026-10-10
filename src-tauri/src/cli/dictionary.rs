//! `dictionary`：整库的数据字典，Markdown。
//!
//! 与界面导出的英文版（`src/utils/dataDictionary.ts`）逐字相同，由 `fixtures/dictionary-conformance.json`
//! 钉住。目录行的解析同 `erLayout.ts` 的 `toErTables` / `toErLinks`：来源是 ER 图那两段整库查询
//! （`services::er_diagram`），所以同样没有列注释、默认值、索引与唯一约束，开头照实写一句

use crate::models::{ConnectionProfile, DatabaseType};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Column {
  name: String,
  data_type: String,
  is_primary_key: bool,
  is_nullable: bool,
}

#[derive(Deserialize)]
pub(super) struct Table {
  /// PostgreSQL 这类才有；同名不同 schema 的是两张表
  schema: Option<String>,
  name: String,
  columns: Vec<Column>,
}

#[derive(Deserialize)]
pub(super) struct End {
  table: String,
  column: String,
}

#[derive(Deserialize)]
pub(super) struct Link {
  from: End,
  to: End,
}

impl Table {
  fn key(&self) -> String {
    qualify(self.schema.as_deref().unwrap_or(""), &self.name)
  }
}

/// 列的行按表归拢，表按第一次出现的次序，表内的列按 `ordinal`
pub(super) fn tables_from_rows(rows: &[Value]) -> Vec<Table> {
  let mut tables: Vec<(Table, Vec<f64>)> = Vec::new();
  let mut index: HashMap<String, usize> = HashMap::new();
  for row in rows {
    let name = text(&row["table_name"]);
    let column = text(&row["column_name"]);
    if name.is_empty() || column.is_empty() {
      continue;
    }
    let schema = Some(text(&row["table_schema"])).filter(|schema| !schema.is_empty());
    let key = qualify(schema.as_deref().unwrap_or(""), &name);
    let position = *index.entry(key).or_insert_with(|| {
      tables.push((Table { schema, name, columns: Vec::new() }, Vec::new()));
      tables.len() - 1
    });
    let (table, ordinals) = &mut tables[position];
    table.columns.push(Column {
      name: column,
      data_type: text(&row["data_type"]),
      is_primary_key: flag(&row["is_primary_key"]),
      is_nullable: flag(&row["is_nullable"]),
    });
    ordinals.push(number(&row["ordinal"]));
  }
  tables
    .into_iter()
    .map(|(mut table, ordinals)| {
      let mut columns: Vec<(f64, Column)> = ordinals.into_iter().zip(table.columns).collect();
      columns.sort_by(|left, right| left.0.total_cmp(&right.0));
      table.columns = columns.into_iter().map(|(_, column)| column).collect();
      table
    })
    .collect()
}

/// 两头缺列名的外键丢掉：SQLite 父表没有主键时连不到具体的列，那条外键本来不成立
pub(super) fn links_from_rows(rows: &[Value]) -> Vec<Link> {
  rows
    .iter()
    .filter_map(|row| {
      let from = End {
        table: qualify(&text(&row["table_schema"]), &text(&row["table_name"])),
        column: text(&row["column_name"]),
      };
      let to = End {
        table: qualify(&text(&row["referenced_schema"]), &text(&row["referenced_table"])),
        column: text(&row["referenced_column"]),
      };
      let complete =
        [&from.table, &from.column, &to.table, &to.column].iter().all(|part| !part.is_empty());
      complete.then_some(Link { from, to })
    })
    .collect()
}

pub(super) fn render(
  title: &str,
  dialect: &str,
  date: &str,
  tables: &[Table],
  links: &[Link],
) -> String {
  let mut out = vec![
    format!("# {title}"),
    String::new(),
    format!(
      "{dialect} · tables: {} · foreign-key links: {} · exported from DataOmni on {date}",
      tables.len(),
      links.len()
    ),
    String::new(),
    "> From the database catalog: columns, types, nullability, primary and foreign keys. \
     Column comments, defaults, indexes and unique constraints are not included."
      .to_string(),
  ];
  for table in tables {
    let key = table.key();
    out.extend([String::new(), format!("## {key}"), String::new()]);
    out.push("| Column | Type | Nullable | PK | References |".to_string());
    out.push("| --- | --- | --- | --- | --- |".to_string());
    // SQLite 的 rowid 别名：唯一的主键列、类型恰好写作 INTEGER。目录对它报可空，而它存不进 NULL。
    // 别的主键照目录写（同 `dataDictionary.ts`）
    let keys: Vec<usize> =
      (0..table.columns.len()).filter(|&at| table.columns[at].is_primary_key).collect();
    let rowid_alias = match keys.as_slice() {
      [only] if table.columns[*only].data_type.trim().eq_ignore_ascii_case("INTEGER") => {
        Some(*only)
      }
      _ => None,
    };
    for (at, column) in table.columns.iter().enumerate() {
      let targets: Vec<String> = links
        .iter()
        .filter(|link| link.from.table == key && link.from.column == column.name)
        .map(|link| format!("`{}.{}`", cell(&link.to.table), cell(&link.to.column)))
        .collect();
      let nullable = column.is_nullable && rowid_alias != Some(at);
      out.push(format!(
        "| `{}` | {} | {} | {} | {} |",
        cell(&column.name),
        cell(&column.data_type),
        if nullable { "yes" } else { "no" },
        if column.is_primary_key { "✓" } else { "" },
        targets.join(", ")
      ));
    }
    let referenced_by: Vec<String> = links
      .iter()
      .filter(|link| link.to.table == key)
      .map(|link| format!("`{}.{}`", cell(&link.from.table), cell(&link.from.column)))
      .collect();
    if !referenced_by.is_empty() {
      out.extend([String::new(), format!("Referenced by: {}", referenced_by.join(", "))]);
    }
  }
  out.join("\n") + "\n"
}

/// 字典开头写的库名，同界面的 `serverLabel`：经快捷入口建的写服务端的名字（记录与类型对不上就不认）
pub(super) fn dialect(profile: &ConnectionProfile) -> &'static str {
  let preset = profile.options.get("server").map(String::as_str);
  match (&profile.db_type, preset) {
    (DatabaseType::MySQL, Some("mariadb")) => "MariaDB",
    (DatabaseType::MySQL, Some("tidb")) => "TiDB",
    (DatabaseType::PostgreSQL, Some("cockroachdb")) => "CockroachDB",
    (DatabaseType::MySQL, _) => "MySQL",
    (DatabaseType::PostgreSQL, _) => "PostgreSQL",
    (DatabaseType::SQLite, _) => "SQLite",
    (DatabaseType::SqlServer, _) => "SQL Server",
    (DatabaseType::Oracle, _) => "Oracle",
    (DatabaseType::MongoDB, _) => "MongoDB",
    (DatabaseType::Redis, _) => "Redis",
    (DatabaseType::Neo4j, _) => "Neo4j",
    (DatabaseType::DuckDB, _) => "DuckDB",
    (DatabaseType::ClickHouse, _) => "ClickHouse",
    (DatabaseType::Elasticsearch, _) => "Elasticsearch",
  }
}

fn qualify(schema: &str, name: &str) -> String {
  match (schema, name) {
    (_, "") => String::new(),
    ("", name) => name.to_string(),
    (schema, name) => format!("{schema}.{name}"),
  }
}

/// 表格单元格里的竖线会切断这一行；换行会把表格整个断开
fn cell(text: &str) -> String {
  text.replace('|', "\\|").replace("\r\n", " ").replace('\n', " ")
}

fn text(value: &Value) -> String {
  match value {
    Value::String(text) => text.clone(),
    Value::Null => String::new(),
    other => other.to_string(),
  }
}

/// 同 `erLayout.ts` 的 `bool`：MySQL 与 SQLite 给 1 / 0，PostgreSQL 给真布尔
fn flag(value: &Value) -> bool {
  match value {
    Value::Bool(flag) => *flag,
    Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
    Value::String(text) => text == "1" || text == "true",
    _ => false,
  }
}

/// 同 `Number(row.ordinal) || 0`
fn number(value: &Value) -> f64 {
  let parsed = match value {
    Value::Number(number) => number.as_f64(),
    Value::String(text) => text.trim().parse::<f64>().ok(),
    _ => None,
  };
  parsed.filter(|number| number.is_finite()).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  const CORPUS: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/dictionary-conformance.json"));

  #[derive(Deserialize)]
  struct Corpus {
    cases: Vec<Case>,
  }

  #[derive(Deserialize)]
  struct Case {
    why: String,
    title: String,
    dialect: String,
    date: String,
    tables: Vec<Table>,
    links: Vec<Link>,
    expected: String,
  }

  #[test]
  fn renders_the_same_text_as_the_gui() {
    let corpus: Corpus = match serde_json::from_str(CORPUS) {
      Ok(corpus) => corpus,
      Err(error) => panic!("{error}"),
    };
    assert!(corpus.cases.len() >= 3);
    for case in corpus.cases {
      let text = render(&case.title, &case.dialect, &case.date, &case.tables, &case.links);
      assert_eq!(text, case.expected, "{}", case.why);
    }
  }

  #[test]
  fn catalog_rows_are_grouped_by_table_and_ordered_by_ordinal() {
    let rows = vec![
      json!({ "table_schema": "app", "table_name": "t", "column_name": "b", "data_type": "int", "ordinal": 2, "is_primary_key": 0, "is_nullable": 1 }),
      json!({ "table_schema": "", "table_name": "u", "column_name": "id", "data_type": "int", "ordinal": "1", "is_primary_key": "1", "is_nullable": false }),
      json!({ "table_schema": "app", "table_name": "t", "column_name": "a", "data_type": "int", "ordinal": 1, "is_primary_key": true, "is_nullable": 0 }),
      json!({ "table_schema": "app", "table_name": "t", "column_name": null }),
    ];
    let tables = tables_from_rows(&rows);
    let shape: Vec<(String, Vec<&str>)> = tables
      .iter()
      .map(|table| (table.key(), table.columns.iter().map(|column| column.name.as_str()).collect()))
      .collect();
    assert_eq!(shape, vec![("app.t".to_string(), vec!["a", "b"]), ("u".to_string(), vec!["id"])]);
    assert!(tables[0].columns[0].is_primary_key && !tables[0].columns[0].is_nullable);
    assert!(tables[0].columns[1].is_nullable && tables[1].columns[0].is_primary_key);

    let links = links_from_rows(&[
      json!({ "table_name": "t", "column_name": "u_id", "referenced_table": "u", "referenced_column": "id" }),
      json!({ "table_name": "t", "column_name": "x", "referenced_table": "u", "referenced_column": null }),
    ]);
    assert_eq!(links.len(), 1);
    assert_eq!((links[0].from.table.as_str(), links[0].to.column.as_str()), ("t", "id"));
  }
}
