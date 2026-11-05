//! 结构比对的往返验收（`scripts/schema-diff-verify.sh`）用的是应用里**同一份**目录查询：
//! 设了 `DATAOMNI_DUMP_CATALOG_QUERIES=<文件>` 时把各方言的 ER 图查询与单表结构查询写成 JSON，
//! 没设时什么也不做。查询只住在 Rust 这边（见 `catalogQueries.ts` 开头），脚本另抄一份就验不到真东西了

use dataomni_lib::models::DatabaseType;
use dataomni_lib::services::{er_diagram_queries, schema_metadata_queries};

#[test]
fn dump_catalog_queries() {
  let Ok(path) = std::env::var("DATAOMNI_DUMP_CATALOG_QUERIES") else {
    return;
  };
  let mut dialects = serde_json::Map::new();
  for (name, db_type) in [
    ("postgresql", DatabaseType::PostgreSQL),
    ("mysql", DatabaseType::MySQL),
    ("sqlite", DatabaseType::SQLite),
    ("sqlserver", DatabaseType::SqlServer),
  ] {
    dialects.insert(
      name.to_string(),
      serde_json::json!({
        "er": er_diagram_queries(&db_type),
        "metadata": schema_metadata_queries(&db_type),
      }),
    );
  }
  let text = serde_json::to_string_pretty(&dialects).expect("queries serialize");
  std::fs::write(&path, text).expect("write the dumped queries");
}
