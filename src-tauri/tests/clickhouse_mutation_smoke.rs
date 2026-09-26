//! ClickHouse 的真库用例里最重的一条，单独一个文件：cargo 按文件依次跑，同一个文件里的
//! 用例并行。它往测试库写 2000 万行、再重写整块数据，和别的用例挤在一起时，那些用例里的
//! 计时断言与连接超时会时红时绿（试过）。
//!
//! 删表一律 `SYNC`：ClickHouse 默认过 8 分钟才真的删文件，跑几轮就能把 cu 的数据盘写满
//!（这一条每次写约 550 MB，撞上过一次 100%）。
//!
//! 环境变量与 `clickhouse_smoke.rs` 相同，没设就跳过。

use dataomni_lib::models::ConnectionProfile;
use dataomni_lib::services::clickhouse::{self, ClickHousePool, ClickHouseTarget};
use dataomni_lib::services::{execute_write_batch, PoolRef, SessionConnection, WriteStatement};
use serde_json::{json, Value as JsonValue};
use std::sync::Arc;

const URL_ENV: &str = "DATAOMNI_CLICKHOUSE_TEST_URL";
const REQUIRE_ENV: &str = "DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS";

async fn pool() -> Option<Arc<ClickHousePool>> {
  let url = match std::env::var(URL_ENV) {
    Ok(url) if !url.is_empty() => url,
    _ if std::env::var(REQUIRE_ENV).as_deref() == Ok("1") => {
      panic!("{URL_ENV} must be set when {REQUIRE_ENV}=1")
    }
    _ => return None,
  };
  let (scheme, rest) = url.split_once("://").expect("scheme://");
  let (credentials, address) = rest.rsplit_once('@').expect("user:password@host:port");
  let (username, password) = credentials.split_once(':').expect("user:password");
  let (host, port) = address.trim_end_matches('/').rsplit_once(':').expect("host:port");
  let tls = if scheme == "https" { "preferred" } else { "disabled" };
  let profile: ConnectionProfile = serde_json::from_value(json!({
    "name": "clickhouse-mutation-smoke",
    "db_type": "clickhouse",
    "host": host,
    "port": port.parse::<u16>().expect("port"),
    "database": "dataomni_smoke",
    "username": username,
    "password": password,
    "ssl": tls != "disabled",
    "tls_mode": tls,
    "options": {},
    "tags": []
  }))
  .expect("profile");
  let mut bootstrap = profile.clone();
  bootstrap.database = None;
  let admin =
    clickhouse::connect(ClickHouseTarget::from_profile(&bootstrap, None)).await.expect("connect");
  admin.select("CREATE DATABASE IF NOT EXISTS dataomni_smoke", &[]).await.expect("database");
  Some(clickhouse::connect(ClickHouseTarget::from_profile(&profile, None)).await.expect("connect"))
}

async fn run(connection: &mut SessionConnection, sql: &str) {
  connection.execute(sql, 10).await.unwrap_or_else(|error| panic!("{sql}: {error:?}"));
}

fn write(sql: &str, params: Vec<JsonValue>, expect_rows: Option<u64>) -> WriteStatement {
  WriteStatement { sql: sql.to_string(), params, expect_rows }
}

/// `ALTER … UPDATE` 默认交给后台就返回。一大块数据上（2000 万行，改一行要重写整块，
/// 实测 4 秒多）紧跟着的核对会读到改之前的值——所以要等它做完（`mutations_sync = 2`）。
/// 小表上改动快到下一个请求之前就做完了，证明不了这一条（试过）
#[tokio::test]
async fn clickhouse_grid_updates_wait_for_the_mutation() {
  let Some(pool) = pool().await else { return };
  let mut connection =
    SessionConnection::acquire(PoolRef::ClickHouse(&pool)).await.expect("session");
  for sql in [
    "DROP TABLE IF EXISTS smoke_grid_big SYNC",
    "CREATE TABLE smoke_grid_big (id UInt64, v String) ENGINE = MergeTree ORDER BY id",
    "INSERT INTO smoke_grid_big SELECT number, toString(number) FROM numbers(20000000)",
    "OPTIMIZE TABLE smoke_grid_big FINAL",
  ] {
    run(&mut connection, sql).await;
  }
  let row = "id = {p1:UInt64} AND v = {p2:String}";
  let result = execute_write_batch(
    PoolRef::ClickHouse(&pool),
    &[
      write(
        &format!("SELECT count() FROM smoke_grid_big WHERE {row}"),
        vec![json!(5), json!("5")],
        Some(1),
      ),
      write(
        &format!("ALTER TABLE smoke_grid_big UPDATE v = {{p3:String}} WHERE {row}"),
        vec![json!(5), json!("5"), json!("x")],
        None,
      ),
      write(
        &format!("SELECT toUInt64(count() >= 1) FROM smoke_grid_big WHERE {row}"),
        vec![json!(5), json!("x")],
        Some(1),
      ),
    ],
  )
  .await;
  run(&mut connection, "DROP TABLE smoke_grid_big SYNC").await;
  result.expect("the check right after the mutation sees the new value");
}
