//! 嵌入式库的备份：SQLite 用 `VACUUM INTO`，DuckDB 用 `EXPORT DATABASE`。
//!
//! **不自己实现 dump**（rfcs/ai-design-and-export.md §4）：导得出、恢复不回去的备份比没有更危险。
//! 这两家的官方做法都在库里、不用外部工具——SQLite 得到一份一致的库文件（直接打开就是恢复），
//! DuckDB 得到一个目录（`IMPORT DATABASE` 恢复），格式用 Parquet：类型原样保留，CSV 做不到。
//! 网络库的 `mysqldump` / `pg_dump` 要另外找工具、传密码，不在这里。

use crate::services::query_executor::PoolRef;
use crate::services::{QueryError, SessionConnection};
use std::path::{Path, PathBuf};

pub const BACKUP_UNSUPPORTED: &str = "DATAOMNI_BACKUP_UNSUPPORTED";
/// DuckDB 的备份是个目录；目标已经存在时不去覆盖，免得和一份旧备份的文件混在一起
pub const BACKUP_TARGET_EXISTS: &str = "DATAOMNI_BACKUP_TARGET_EXISTS";
pub const BACKUP_FAILED: &str = "DATAOMNI_BACKUP_FAILED";

/// 备份的形态，前端据此说「文件」还是「目录」、怎么恢复
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackupKind {
  SqliteFile,
  DuckdbDirectory,
}

/// 先写到旁边的 `.part`，写完再改名：和导出一样，让「目标存在」等于「备份完整」。
/// 中途失败时 `.part` 留着也不会被当成备份，下一次开始前清掉
pub async fn backup_embedded<'a>(
  pool: impl Into<PoolRef<'a>>,
  target: &Path,
) -> Result<BackupKind, QueryError> {
  let pool = pool.into();
  let kind = match pool {
    PoolRef::Sqlx(tauri_plugin_sql::DbPool::Sqlite(_)) => BackupKind::SqliteFile,
    PoolRef::DuckDb(_) => BackupKind::DuckdbDirectory,
    _ => return Err(QueryError::message(BACKUP_UNSUPPORTED)),
  };
  if kind == BackupKind::DuckdbDirectory && target.exists() {
    return Err(QueryError::message(format!("{BACKUP_TARGET_EXISTS}: {}", target.display())));
  }

  let part = part_path(target);
  remove_path(&part);
  let statement = match kind {
    // VACUUM INTO 不收绑定参数，路径只能写成字面量；单引号写两遍是两家共同的规则
    BackupKind::SqliteFile => format!("VACUUM INTO {}", quote_literal(&part)),
    BackupKind::DuckdbDirectory => {
      format!("EXPORT DATABASE {} (FORMAT PARQUET)", quote_literal(&part))
    }
  };

  let mut connection = SessionConnection::acquire(pool).await?;
  if let Err(error) = connection.execute_unprepared(&statement).await {
    remove_path(&part);
    return Err(error);
  }
  // 文件的改名会顶掉同名的旧文件（保存对话框已经问过要不要替换）；目录走到这里时目标一定不存在
  std::fs::rename(&part, target).map_err(|error| {
    remove_path(&part);
    QueryError::message(format!("{BACKUP_FAILED}: {} · {error}", target.display()))
  })?;
  Ok(kind)
}

fn part_path(target: &Path) -> PathBuf {
  let mut name = target.file_name().map(|name| name.to_os_string()).unwrap_or_default();
  name.push(".part");
  target.with_file_name(name)
}

fn remove_path(path: &Path) {
  if path.is_dir() {
    std::fs::remove_dir_all(path).ok();
  } else {
    std::fs::remove_file(path).ok();
  }
}

fn quote_literal(path: &Path) -> String {
  format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

#[cfg(test)]
mod tests {
  use super::*;
  use tauri_plugin_sql::DbPool;

  fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dataomni-backup-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
  }

  /// 目录名里带撇号：路径是拼进 SQL 的，转义错了语句就坏了
  #[tokio::test]
  async fn a_sqlite_backup_opens_as_the_same_database() {
    let dir = temp_dir("sqlite'quote");
    let source = dir.join("source.db");
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
      .connect(&format!("sqlite:{}?mode=rwc", source.display()))
      .await
      .expect("open");
    for sql in [
      "CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT, data BLOB)",
      "INSERT INTO t VALUES (1, 'O''Brien', X'00ff'), (2, '中文', NULL)",
    ] {
      sqlx::query(sql).execute(&pool).await.expect("seed");
    }
    let pool = DbPool::Sqlite(pool);
    let target = dir.join("backup.db");
    std::fs::write(&target, "an older backup").expect("stale target");

    assert_eq!(backup_embedded(&pool, &target).await.expect("backup"), BackupKind::SqliteFile);
    assert!(!part_path(&target).exists(), ".part 要改名成目标");

    let restored = sqlx::sqlite::SqlitePoolOptions::new()
      .connect(&format!("sqlite:{}?mode=ro", target.display()))
      .await
      .expect("open backup");
    let rows: Vec<(i64, String, Option<Vec<u8>>)> =
      sqlx::query_as("SELECT id, label, data FROM t ORDER BY id")
        .fetch_all(&restored)
        .await
        .expect("read");
    assert_eq!(rows, vec![(1, "O'Brien".into(), Some(vec![0, 255])), (2, "中文".into(), None)]);
    std::fs::remove_dir_all(&dir).ok();
  }

  #[tokio::test]
  async fn a_duckdb_backup_imports_back_and_refuses_an_existing_target() {
    let dir = temp_dir("duckdb");
    let file = dir.join("source.duckdb");
    let pool = crate::services::duckdb::open(&file.to_string_lossy()).await.expect("open duckdb");
    let mut connection =
      SessionConnection::acquire(PoolRef::DuckDb(&pool)).await.expect("connection");
    connection
      .execute_unprepared(
        "CREATE TABLE t (id BIGINT PRIMARY KEY, amount DECIMAL(10,2), happened TIMESTAMP); \
         INSERT INTO t VALUES (1, 1.10, TIMESTAMP '2024-01-02 03:04:05'), (2, NULL, NULL);",
      )
      .await
      .expect("seed");
    drop(connection);

    let target = dir.join("backup");
    assert_eq!(
      backup_embedded(PoolRef::DuckDb(&pool), &target).await.expect("backup"),
      BackupKind::DuckdbDirectory
    );
    assert!(target.join("schema.sql").exists() && target.join("load.sql").exists());

    let restored = crate::services::duckdb::open(&dir.join("restored.duckdb").to_string_lossy())
      .await
      .expect("open restored");
    let mut connection =
      SessionConnection::acquire(PoolRef::DuckDb(&restored)).await.expect("connection");
    connection
      .execute_unprepared(&format!("IMPORT DATABASE {}", quote_literal(&target)))
      .await
      .expect("import");
    let result = connection
      .execute("SELECT id, CAST(amount AS VARCHAR) AS amount, CAST(happened AS VARCHAR) AS happened FROM t ORDER BY id", 10)
      .await
      .expect("read");
    let crate::services::QueryExecutionResult::Rows { rows, .. } = result else {
      panic!("expected rows");
    };
    let text = serde_json::to_string(&rows).expect("rows");
    assert!(text.contains("1.10") && text.contains("2024-01-02 03:04:05"), "{text}");
    assert_eq!(rows.len(), 2);

    let error =
      backup_embedded(PoolRef::DuckDb(&pool), &target).await.expect_err("existing target");
    assert!(error.message.starts_with(BACKUP_TARGET_EXISTS), "{}", error.message);
    std::fs::remove_dir_all(&dir).ok();
  }
}
