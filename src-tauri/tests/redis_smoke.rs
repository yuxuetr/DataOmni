//! Redis 的真库用例。
//!
//! 默认静默跳过；要跑就在 shell 里设
//! `DATAOMNI_REDIS_TEST_URL=redis://user:password@host:port`（`default` 用户也写出来，
//! **不要写进任何文件**），并设 `DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS=1` 让缺了
//! 连接串的时候报错而不是跳过。另设 `DATAOMNI_REDIS_READER_URL`（同样的写法，一个只有
//! `+@read` 的 ACL 用户）时多验一条「只读用户也能浏览」。
//!
//! TLS 那一条另设 `DATAOMNI_REDIS_TLS_TEST_URL`（一台只开 TLS 端口的服务端）与
//! `DATAOMNI_REDIS_TLS_TEST_CA`（签它证书的 CA 文件路径；证书上写着 127.0.0.1）。
//!
//! 用例各占一个库号（9–14），开头 `FLUSHDB` 清掉残留——那几个库号只给这里用。

use dataomni_lib::models::ConnectionProfile;
use dataomni_lib::models::TlsMode;
use dataomni_lib::services::redis::{
  self as store, RedisReply, RedisTarget, RedisValue, ScanRequest, ValueRequest, REDIS_AUTH_FAILED,
  REDIS_AUTH_REQUIRED, REDIS_COMMAND_CONNECTION_STATE, REDIS_KEY_GONE, REDIS_TLS_FILE_INVALID,
  REDIS_UNREACHABLE,
};
use serde_json::json;
use std::collections::HashSet;
use std::time::{Duration, Instant};

const URL_ENV: &str = "DATAOMNI_REDIS_TEST_URL";
const REQUIRE_ENV: &str = "DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS";
const TIMEOUT: Duration = Duration::from_secs(10);

fn profile_from_url(url: &str, database: i64) -> ConnectionProfile {
  let rest = url.strip_prefix("redis://").expect("redis:// URL");
  let (credentials, address) = rest.rsplit_once('@').expect("user:password@host");
  let (username, password) = credentials.split_once(':').expect("user:password");
  let address = address.trim_end_matches('/');
  let (host, port) = address.rsplit_once(':').expect("host:port");
  serde_json::from_value(json!({
    "name": "redis-smoke",
    "db_type": "redis",
    "host": host,
    "port": port.parse::<u16>().expect("port"),
    "database": database.to_string(),
    "username": username,
    "password": password,
    "ssl": false,
    "tls_mode": "disabled",
    "options": {},
    "tags": []
  }))
  .expect("profile")
}

fn profile(database: i64) -> Option<ConnectionProfile> {
  match std::env::var(URL_ENV) {
    Ok(url) if !url.is_empty() => Some(profile_from_url(&url, database)),
    _ if std::env::var(REQUIRE_ENV).as_deref() == Ok("1") => {
      panic!("{URL_ENV} must be set when {REQUIRE_ENV}=1")
    }
    _ => None,
  }
}

/// 这个库号上的一条普通连接，给用例自己造数据用；先清空
async fn seed_connection(profile: &ConnectionProfile) -> redis::aio::MultiplexedConnection {
  let url = format!(
    "redis://{}:{}@{}:{}/{}",
    profile.username,
    urlencoding::encode(&profile.password),
    profile.host,
    profile.port,
    profile.database.as_deref().unwrap_or("0")
  );
  let client = redis::Client::open(url).expect("seed client");
  let config = redis::AsyncConnectionConfig::new()
    .set_connection_timeout(Some(TIMEOUT))
    .set_response_timeout(None);
  let mut connection =
    client.get_multiplexed_async_connection_with_config(&config).await.expect("seed connect");
  redis::cmd("FLUSHDB").query_async::<()>(&mut connection).await.expect("flushdb");
  connection
}

async fn pool(profile: &ConnectionProfile) -> store::RedisPool {
  store::connect(RedisTarget::from_profile(profile).expect("target")).await.expect("connect")
}

fn read(database: i64, key: &[u8], position: Option<String>, page: u64) -> ValueRequest {
  ValueRequest { database, key: key.to_vec(), position, page, timeout: TIMEOUT }
}

#[tokio::test]
async fn a_wrong_or_missing_password_is_named_and_a_closed_port_is_unreachable() {
  let Some(mut profile) = profile(0) else { return };
  let real = profile.password.clone();
  profile.password.push_str("-wrong");
  let error = store::connect(RedisTarget::from_profile(&profile).expect("target"))
    .await
    .err()
    .unwrap_or_default();
  assert!(error.starts_with(REDIS_AUTH_FAILED), "{error}");

  profile.username.clear();
  profile.password.clear();
  let error = store::connect(RedisTarget::from_profile(&profile).expect("target"))
    .await
    .err()
    .unwrap_or_default();
  assert!(error.starts_with(REDIS_AUTH_REQUIRED), "{error}");

  profile.password = real;
  profile.host = "127.0.0.1".to_string();
  profile.port = 1;
  let started = Instant::now();
  let error = store::connect(RedisTarget::from_profile(&profile).expect("target"))
    .await
    .err()
    .unwrap_or_default();
  assert!(error.starts_with(REDIS_UNREACHABLE), "{error}");
  assert!(started.elapsed() < Duration::from_secs(15), "{:?}", started.elapsed());
}

/// 有键的库都列出来，配置里那个库哪怕是空的也在
#[tokio::test]
async fn the_keyspaces_with_keys_and_the_configured_one_are_listed() {
  let Some(profile) = profile(13) else { return };
  let mut seed =
    seed_connection(&profile_from_url(&std::env::var(URL_ENV).unwrap_or_default(), 12)).await;
  redis::cmd("SET").arg("smoke:there").arg(1).query_async::<()>(&mut seed).await.expect("seed");
  seed_connection(&profile).await;
  let pool = pool(&profile).await;
  let entries = store::list_keyspaces(&pool).await.expect("keyspaces");
  let names: Vec<_> = entries.iter().map(|entry| entry.object_name.as_str()).collect();
  assert!(names.contains(&"db12"), "{names:?}");
  assert!(names.contains(&"db13"), "空的配置库也要在：{names:?}");
  assert_eq!(
    entries.iter().find(|entry| entry.object_name == "db12").map(|entry| entry.keys),
    Some(1)
  );
}

/// 按游标翻完整个库：每个键恰好出现一次，一个不少。类型过滤与剩余时间也对
#[tokio::test]
async fn scanning_page_by_page_sees_every_key_exactly_once() {
  let Some(profile) = profile(9) else { return };
  let mut seed = seed_connection(&profile).await;
  let mut pipe = redis::pipe();
  for n in 0..250 {
    pipe.cmd("SET").arg(format!("smoke:scan:{n}")).arg(n).ignore();
  }
  pipe.cmd("HSET").arg("smoke:hash").arg("f").arg("v").ignore();
  pipe.cmd("SET").arg("other").arg(1).ignore();
  pipe.cmd("PEXPIRE").arg("smoke:scan:0").arg(600_000).ignore();
  pipe.query_async::<()>(&mut seed).await.expect("seed");
  let pool = pool(&profile).await;

  let mut seen = Vec::new();
  let mut cursor = "0".to_string();
  loop {
    let page = store::scan(
      &pool,
      ScanRequest {
        database: 9,
        pattern: "smoke:*".into(),
        cursor,
        kind: None,
        page: 40,
        timeout: TIMEOUT,
      },
    )
    .await
    .expect("scan");
    seen.extend(page.keys);
    match page.cursor {
      Some(next) => cursor = next,
      None => break,
    }
  }
  let names: HashSet<_> = seen.iter().map(|row| row.key.text.clone()).collect();
  assert_eq!(seen.len(), 251, "有重复或有漏：{}", seen.len());
  assert_eq!(names.len(), 251);
  assert!(!names.contains("other"));
  let hash = seen.iter().find(|row| row.key.text == "smoke:hash").expect("hash row");
  assert_eq!((hash.kind.as_str(), hash.ttl_ms), ("hash", -1));
  let expiring = seen.iter().find(|row| row.key.text == "smoke:scan:0").expect("ttl row");
  assert!(expiring.ttl_ms > 590_000 && expiring.ttl_ms <= 600_000, "{}", expiring.ttl_ms);

  let only_hashes = store::scan(
    &pool,
    ScanRequest {
      database: 9,
      pattern: "*".into(),
      cursor: "0".into(),
      kind: Some("hash".into()),
      page: 200,
      timeout: TIMEOUT,
    },
  )
  .await
  .expect("typed scan");
  assert!(only_hashes.keys.iter().all(|row| row.kind == "hash"), "{:?}", only_hashes.keys);
}

/// 每种类型翻页都不重不漏；集合类的总数是服务端的，不是这一页的
#[tokio::test]
async fn every_type_pages_through_its_value() {
  let Some(profile) = profile(10) else { return };
  let mut seed = seed_connection(&profile).await;
  let mut pipe = redis::pipe();
  for n in 0..300 {
    pipe.cmd("HSET").arg("h").arg(format!("f{n}")).arg(n).ignore();
    pipe.cmd("SADD").arg("s").arg(format!("m{n}")).ignore();
  }
  for n in 0..45 {
    pipe.cmd("RPUSH").arg("l").arg(n).ignore();
    pipe.cmd("ZADD").arg("z").arg(n).arg(format!("z{n}")).ignore();
  }
  for n in 0..25 {
    pipe.cmd("XADD").arg("x").arg(format!("1-{}", n + 1)).arg("n").arg(n).ignore();
  }
  pipe.query_async::<()>(&mut seed).await.expect("seed");
  let pool = pool(&profile).await;

  // 散列与集合：`*SCAN` 可能重复返回同一个元素（规范里允许），这里只要求不漏
  let mut fields = HashSet::new();
  let mut position = None;
  loop {
    let RedisValue::Hash { length, entries, next } =
      store::read_value(&pool, read(10, b"h", position, 50)).await.expect("hash")
    else {
      panic!("不是散列")
    };
    assert_eq!(length, 300);
    fields.extend(entries.into_iter().map(|(field, _)| field.text));
    match next {
      Some(next) => position = Some(next),
      None => break,
    }
  }
  assert_eq!(fields.len(), 300);

  let mut members = HashSet::new();
  let mut position = None;
  loop {
    let RedisValue::Set { members: page, next, .. } =
      store::read_value(&pool, read(10, b"s", position, 50)).await.expect("set")
    else {
      panic!("不是集合")
    };
    members.extend(page.into_iter().map(|member| member.text));
    match next {
      Some(next) => position = Some(next),
      None => break,
    }
  }
  assert_eq!(members.len(), 300);

  // 列表与有序集合按下标翻：次序就是服务端的次序
  let mut items = Vec::new();
  let mut position = None;
  loop {
    let RedisValue::List { length, items: page, next, .. } =
      store::read_value(&pool, read(10, b"l", position, 20)).await.expect("list")
    else {
      panic!("不是列表")
    };
    assert_eq!(length, 45);
    items.extend(page.into_iter().map(|item| item.text));
    match next {
      Some(next) => position = Some(next),
      None => break,
    }
  }
  assert_eq!(items, (0..45).map(|n| n.to_string()).collect::<Vec<_>>());

  let RedisValue::Zset { entries, next, .. } =
    store::read_value(&pool, read(10, b"z", Some("40".into()), 20)).await.expect("zset")
  else {
    panic!("不是有序集合")
  };
  assert_eq!(
    entries.first().map(|(member, score)| (member.text.as_str(), score.as_str())),
    Some(("z40", "40"))
  );
  assert_eq!((entries.len(), next), (5, None));

  // 流：接着上一页最后一条往后读，不含它自己
  let mut ids = Vec::new();
  let mut position = None;
  loop {
    let RedisValue::Stream { length, entries, next } =
      store::read_value(&pool, read(10, b"x", position, 10)).await.expect("stream")
    else {
      panic!("不是流")
    };
    assert_eq!(length, 25);
    ids.extend(entries.into_iter().map(|entry| entry.id));
    match next {
      Some(next) => position = Some(next),
      None => break,
    }
  }
  assert_eq!(ids, (1..=25).map(|n| format!("1-{n}")).collect::<Vec<_>>());
}

/// 二进制的键拿 base64 定位、二进制的值标出来；大字符串只带前 512 KiB；没了的键说没了
#[tokio::test]
async fn binary_keys_large_strings_and_missing_keys() {
  let Some(profile) = profile(11) else { return };
  let mut seed = seed_connection(&profile).await;
  let binary_key = vec![b'b', 0xff, 0x00, b'k'];
  redis::cmd("SET")
    .arg(&binary_key)
    .arg(vec![0x89u8, b'P', b'N', b'G'])
    .query_async::<()>(&mut seed)
    .await
    .expect("seed");
  redis::cmd("SET")
    .arg("big")
    .arg("中".repeat(200_000))
    .query_async::<()>(&mut seed)
    .await
    .expect("seed");
  let pool = pool(&profile).await;

  let page = store::scan(
    &pool,
    ScanRequest {
      database: 11,
      pattern: "b*".into(),
      cursor: "0".into(),
      kind: None,
      page: 10,
      timeout: TIMEOUT,
    },
  )
  .await
  .expect("scan");
  let row = page.keys.iter().find(|row| row.key.binary).expect("binary key row");
  assert_eq!(row.key.text, "b\\xff\\x00k");
  let key = store::decode_key(&row.key.raw).expect("decode");
  let RedisValue::String { value, truncated, .. } =
    store::read_value(&pool, read(11, &key, None, 10)).await.expect("binary value")
  else {
    panic!("不是字符串")
  };
  assert!(value.binary && !truncated, "{value:?}");

  let RedisValue::String { size, value, truncated } =
    store::read_value(&pool, read(11, b"big", None, 10)).await.expect("big value")
  else {
    panic!("不是字符串")
  };
  assert_eq!(size, 600_000);
  assert!(truncated && !value.binary, "截在字符中间也还是文字");
  assert!(value.text.len() <= 512 * 1024 && value.text.len() > 500_000, "{}", value.text.len());

  let error =
    store::read_value(&pool, read(11, b"no-such-key", None, 10)).await.err().unwrap_or_default();
  assert_eq!(error, REDIS_KEY_GONE);
}

/// 只有 `+@read`（外加 `INFO`、`SCAN`）的 ACL 用户：浏览要用到的命令都不越权
#[tokio::test]
async fn a_read_only_acl_user_can_browse() {
  let Some(reader) = std::env::var("DATAOMNI_REDIS_READER_URL").ok().filter(|url| !url.is_empty())
  else {
    return;
  };
  let Some(profile) = profile(14) else { return };
  let mut seed = seed_connection(&profile).await;
  redis::cmd("HSET").arg("h").arg("f").arg("v").query_async::<()>(&mut seed).await.expect("seed");
  let pool = pool(&profile_from_url(&reader, 14)).await;
  store::list_keyspaces(&pool).await.expect("keyspaces as reader");
  let page = store::scan(
    &pool,
    ScanRequest {
      database: 14,
      pattern: "*".into(),
      cursor: "0".into(),
      kind: None,
      page: 10,
      timeout: TIMEOUT,
    },
  )
  .await
  .expect("scan as reader");
  assert_eq!(page.keys.len(), 1);
  store::read_value(&pool, read(14, b"h", None, 10)).await.expect("read as reader");
}

/// TLS 四档：带 CA 完整校验连得上；只加密不校验不要 CA 也连得上；完整校验而不给 CA
/// （证书是自签的 CA 签的）连不上；明文去敲 TLS 端口连不上。CA 文件读不了时说是哪个文件
#[tokio::test]
async fn tls_is_verified_against_the_given_ca_and_only_skipped_when_asked() {
  let Some(url) = std::env::var("DATAOMNI_REDIS_TLS_TEST_URL").ok().filter(|url| !url.is_empty())
  else {
    return;
  };
  let Some(ca) = std::env::var("DATAOMNI_REDIS_TLS_TEST_CA").ok() else { return };
  let attempt = |mode: TlsMode, ca: Option<&str>| {
    let mut profile = profile_from_url(&url, 0);
    profile.ssl = mode != TlsMode::Disabled;
    profile.tls_mode = Some(mode);
    profile.ca_certificate_path = ca.map(str::to_string);
    async move { store::connect(RedisTarget::from_profile(&profile).expect("target")).await.map(|_| ()) }
  };
  assert_eq!(attempt(TlsMode::VerifyFull, Some(&ca)).await, Ok(()));
  assert_eq!(attempt(TlsMode::Required, None).await, Ok(()));
  let untrusted = attempt(TlsMode::VerifyFull, None).await;
  assert!(untrusted.is_err(), "不给 CA 就不该信一张自签 CA 签的证书");
  assert!(attempt(TlsMode::Disabled, None).await.is_err());
  let missing =
    attempt(TlsMode::VerifyFull, Some("/nonexistent/ca.pem")).await.err().unwrap_or_default();
  assert!(
    missing.starts_with(REDIS_TLS_FILE_INVALID) && missing.contains("/nonexistent/ca.pem"),
    "{missing}"
  );
}

/// 命令行：参数按字节原样发（二进制也行）；服务端的错误回答是一条正常的回答；命令落在
/// 指定的库号上；会改共用连接状态的命令被拒，而拒绝之后连接照常能用
#[tokio::test]
async fn the_command_line_runs_in_its_database_and_keeps_errors_as_replies() {
  let Some(profile) = profile(12) else { return };
  let mut seed = seed_connection(&profile).await;
  let pool = pool(&profile).await;
  let run = |arguments: Vec<&[u8]>| {
    store::execute(&pool, 12, arguments.into_iter().map(<[u8]>::to_vec).collect(), TIMEOUT)
  };

  assert_eq!(
    run(vec![b"SET", b"bin\xff", &[0xff, 0x00]]).await,
    Ok(RedisReply::Status { value: "OK".into() })
  );
  let Ok(RedisReply::Bulk { value }) = run(vec![b"GET", b"bin\xff"]).await else { panic!("GET") };
  assert_eq!(store::decode_key(&value.raw), Ok(vec![0xff, 0x00]));
  let stored: Vec<u8> =
    redis::cmd("GET").arg(&b"bin\xff"[..]).query_async(&mut seed).await.expect("seed GET");
  assert_eq!(stored, vec![0xff, 0x00], "落在库 12 上");

  let Ok(RedisReply::Error { message }) = run(vec![b"INCR", b"bin\xff"]).await else {
    panic!("INCR")
  };
  assert!(message.contains("not an integer"), "{message}");
  assert_eq!(run(vec![b"GET", b"missing"]).await, Ok(RedisReply::Nil));
  run(vec![b"RPUSH", b"l", b"a", b"b"]).await.expect("rpush");
  let Ok(RedisReply::Array { items }) = run(vec![b"LRANGE", b"l", b"0", b"-1"]).await else {
    panic!("LRANGE")
  };
  assert_eq!(items.len(), 2);

  let refused = run(vec![b"select", b"0"]).await.err().unwrap_or_default();
  assert!(
    refused.starts_with(REDIS_COMMAND_CONNECTION_STATE) && refused.contains("SELECT"),
    "{refused}"
  );
  assert_eq!(
    run(vec![b"EXISTS", b"l"]).await,
    Ok(RedisReply::Integer { value: 1 }),
    "拒绝之后还在库 12"
  );
}
