//! 嵌入式库的备份：SQLite 用 `VACUUM INTO`，DuckDB 用 `EXPORT DATABASE`。
//!
//! **不自己实现 dump**（rfcs/ai-design-and-export.md §4）：导得出、恢复不回去的备份比没有更危险。
//! 这两家的官方做法都在库里、不用外部工具——SQLite 得到一份一致的库文件（直接打开就是恢复），
//! DuckDB 得到一个目录（`IMPORT DATABASE` 恢复），格式用 Parquet：类型原样保留，CSV 做不到。
//!
//! PostgreSQL 用它自己的 `pg_dump`（custom 格式，`pg_restore` 恢复），MySQL / MariaDB 用 `mysqldump`
//! （SQL 文本，`mysql` 恢复），MongoDB 用 `mongodump`（gzip 的归档，`mongorestore` 恢复）：
//! 找得到才给，找不到就说装什么。
//! 密码只经 `PGPASSWORD` / `MYSQL_PWD` / 标准输入传，不进命令行（命令行在 `ps` 里谁都看得见）。

use crate::models::{ConnectionProfile, DatabaseType, TlsMode};
use crate::services::query_executor::PoolRef;
use crate::services::{QueryError, SessionConnection};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const BACKUP_UNSUPPORTED: &str = "DATAOMNI_BACKUP_UNSUPPORTED";
/// DuckDB 的备份是个目录；目标已经存在时不去覆盖，免得和一份旧备份的文件混在一起
pub const BACKUP_TARGET_EXISTS: &str = "DATAOMNI_BACKUP_TARGET_EXISTS";
pub const BACKUP_FAILED: &str = "DATAOMNI_BACKUP_FAILED";
/// DuckDB 导出的建表语句自己重放不回去（数据是 DuckDB 的报错）。备份不留：恢复不回去的备份比没有更危险
pub const BACKUP_NOT_RESTORABLE: &str = "DATAOMNI_BACKUP_NOT_RESTORABLE";
/// 找不到外部工具。数据是工具名
pub const BACKUP_TOOL_MISSING: &str = "DATAOMNI_BACKUP_TOOL_MISSING";
/// 外部工具跑了但失败了。数据是它 stderr 的末尾（版本不配、权限不够都在这里说）
pub const BACKUP_TOOL_FAILED: &str = "DATAOMNI_BACKUP_TOOL_FAILED";
/// CockroachDB 走 PostgreSQL 协议，但 pg_dump 对它不管用；它有自己的 `BACKUP` 语句
pub const BACKUP_COCKROACH: &str = "DATAOMNI_BACKUP_COCKROACH";
/// TiDB 走 MySQL 协议，但 mysqldump 的 `--single-transaction` 在它上面失败
/// （`ROLLBACK TO SAVEPOINT` 报 1305）；它有自己的 Dumpling
pub const BACKUP_TIDB: &str = "DATAOMNI_BACKUP_TIDB";
/// mysqldump 只备份一个库，连接上没填库名就不知道备份哪个
pub const BACKUP_NO_DATABASE: &str = "DATAOMNI_BACKUP_NO_DATABASE";

/// 备份的形态，前端据此说「文件」还是「目录」、怎么恢复
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackupKind {
  SqliteFile,
  DuckdbDirectory,
  PostgresDump,
  MysqlDump,
  MongoArchive,
}

/// 先写到旁边的 `.part`，写完再改名：和导出一样，让「目标存在」等于「备份完整」。
/// 中途失败时 `.part` 留着也不会被当成备份，下一次开始前清掉
pub async fn backup_embedded<'a>(
  pool: impl Into<PoolRef<'a>>,
  target: &Path,
) -> Result<BackupKind, QueryError> {
  let pool = pool.into();
  let part = part_path(target);
  // VACUUM INTO / EXPORT DATABASE 不收绑定参数，路径只能写成字面量；单引号写两遍是两家共同的规则
  let (kind, statement) = match pool {
    PoolRef::Sqlx(tauri_plugin_sql::DbPool::Sqlite(_)) => {
      (BackupKind::SqliteFile, format!("VACUUM INTO {}", quote_literal(&part)))
    }
    PoolRef::DuckDb(_) => (
      BackupKind::DuckdbDirectory,
      format!("EXPORT DATABASE {} (FORMAT PARQUET)", quote_literal(&part)),
    ),
    _ => return Err(QueryError::message(BACKUP_UNSUPPORTED)),
  };
  if kind == BackupKind::DuckdbDirectory && target.exists() {
    return Err(QueryError::message(format!("{BACKUP_TARGET_EXISTS}: {}", target.display())));
  }
  remove_path(&part);

  let mut connection = SessionConnection::acquire(pool).await?;
  if let Err(error) = connection.execute_unprepared(&statement).await {
    remove_path(&part);
    return Err(error);
  }
  if kind == BackupKind::DuckdbDirectory {
    if let Err(error) = replay_duckdb_schema(&part) {
      remove_path(&part);
      return Err(error);
    }
  }
  // 文件的改名会顶掉同名的旧文件（保存对话框已经问过要不要替换）；目录走到这里时目标一定不存在
  std::fs::rename(&part, target).map_err(|error| {
    remove_path(&part);
    QueryError::message(format!("{BACKUP_FAILED}: {} · {error}", target.display()))
  })?;
  Ok(kind)
}

/// 用服务端自己的工具备份：PostgreSQL 走 `pg_dump`，MySQL / MariaDB 走 `mysqldump`，MongoDB 走 `mongodump`。
/// `profile` 是已经补上凭据的那一份（`ConnectionService::resolve_for_connection`），
/// `tunnel_port` 是活着的 SSH 隧道的本地端口。
///
/// `mongo_database` 是 MongoDB 要备份的库：它的表单上「数据库」那格是认证库，不是备份对象。
/// 不备份整个部署——那要读 `admin.system.users`，只有某几个库权限的普通账号（包括 X.509 的）
/// 一开始就失败（8.0 上实测：`not authorized on admin to execute command { count: "system.users" }`）
pub async fn backup_with_tool(
  profile: &ConnectionProfile,
  tunnel_port: Option<u16>,
  target: &Path,
  mongo_database: Option<&str>,
) -> Result<BackupKind, QueryError> {
  let server = profile.options.get("server").map(String::as_str);
  let part = part_path(target);
  // 只有 mongodump 从标准输入读密码；另两个不许等输入（没有终端时等于卡死）
  let mut stdin: Option<String> = None;
  let (kind, program, mut command) = match profile.db_type {
    DatabaseType::PostgreSQL => {
      if server == Some("cockroachdb") {
        return Err(QueryError::message(BACKUP_COCKROACH));
      }
      let program = require_tool(&["pg_dump"])?;
      let command = pg_dump_command(&program, profile, tunnel_port, &part);
      (BackupKind::PostgresDump, program, command)
    }
    DatabaseType::MySQL => {
      if server == Some("tidb") {
        return Err(QueryError::message(BACKUP_TIDB));
      }
      let database = profile
        .database
        .as_deref()
        .filter(|database| !database.is_empty())
        .ok_or_else(|| QueryError::message(BACKUP_NO_DATABASE))?;
      // MariaDB 11 的客户端只装 mariadb-dump；装了 mysqldump 名字的，也可能是 MariaDB 的那一份
      let program = require_tool(&["mysqldump", "mariadb-dump"])?;
      let flavor = mysqldump_flavor(&program).await?;
      let command = mysqldump_command(&program, flavor, profile, database, tunnel_port, &part);
      (BackupKind::MysqlDump, program, command)
    }
    DatabaseType::MongoDB => {
      let database = mongo_database
        .filter(|database| !database.is_empty())
        .ok_or_else(|| QueryError::message(BACKUP_NO_DATABASE))?;
      let program = require_tool(&["mongodump"])?;
      let command = mongodump_command(&program, profile, database, tunnel_port, &part);
      if !profile.mongo_x509() && !profile.mongo_username().is_empty() {
        stdin = Some(format!("{}\n", profile.password));
      }
      (BackupKind::MongoArchive, program, command)
    }
    _ => return Err(QueryError::message(BACKUP_UNSUPPORTED)),
  };
  remove_path(&part);
  command.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
  command.stdout(Stdio::piped()).stderr(Stdio::piped());
  // 工具是个阻塞的子进程，放到阻塞线程池里等，不占着异步运行时
  let output = tokio::task::spawn_blocking(move || {
    let mut child = command.spawn()?;
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
      // 写完就关上：工具读到换行就开始连，不关它也不会再等
      pipe.write_all(text.as_bytes())?;
    }
    child.wait_with_output()
  })
  .await
  .map_err(|error| QueryError::message(format!("{BACKUP_FAILED}: {error}")))?
  .map_err(|error| {
    QueryError::message(format!("{BACKUP_FAILED}: {} · {error}", program.display()))
  })?;
  if !output.status.success() {
    remove_path(&part);
    return Err(QueryError::message(format!(
      "{BACKUP_TOOL_FAILED}: {}",
      stderr_tail(&output.stderr)
    )));
  }
  std::fs::rename(&part, target).map_err(|error| {
    remove_path(&part);
    QueryError::message(format!("{BACKUP_FAILED}: {} · {error}", target.display()))
  })?;
  Ok(kind)
}

/// 工具自己的话（版本不配、权限不够都在这里）。两家的报错都以工具名开头，前端原样显示
fn stderr_tail(stderr: &[u8]) -> String {
  let stderr = String::from_utf8_lossy(stderr);
  stderr.trim().chars().rev().take(800).collect::<Vec<_>>().into_iter().rev().collect()
}

fn require_tool(names: &[&str]) -> Result<PathBuf, QueryError> {
  names
    .iter()
    .find_map(|name| find_tool(name))
    .ok_or_else(|| QueryError::message(format!("{BACKUP_TOOL_MISSING}: {}", names[0])))
}

/// 拼 `pg_dump` 的调用。单独拿出来是为了测：参数里不许出现密码，TLS 与隧道要落到对的环境变量上
pub(crate) fn pg_dump_command(
  program: &Path,
  profile: &ConnectionProfile,
  tunnel_port: Option<u16>,
  output: &Path,
) -> Command {
  let mut command = Command::new(program);
  command
    .arg("--format=custom")
    .arg("--no-password")
    .arg(format!("--file={}", output.display()))
    .arg(format!("--host={}", profile.host))
    .arg(format!("--username={}", profile.username))
    .arg(format!("--dbname={}", profile.database.clone().unwrap_or_else(|| "postgres".into())));
  // 有隧道时连本地转发端口，但 TLS 按原主机名校验：libpq 用 hostaddr 连、用 host 验证书，
  // verify-full 经隧道照样成立
  match tunnel_port {
    Some(port) => {
      command.arg(format!("--port={port}")).env("PGHOSTADDR", "127.0.0.1");
    }
    None => {
      command.arg(format!("--port={}", profile.port)).env_remove("PGHOSTADDR");
    }
  }
  let ssl_mode = match profile.effective_tls_mode() {
    TlsMode::Disabled => "disable",
    TlsMode::Preferred => "prefer",
    TlsMode::Required => "require",
    TlsMode::VerifyCa => "verify-ca",
    TlsMode::VerifyFull => "verify-full",
  };
  command.env("PGPASSWORD", &profile.password).env("PGSSLMODE", ssl_mode);
  for (variable, value) in [
    ("PGSSLROOTCERT", &profile.ca_certificate_path),
    ("PGSSLCERT", &profile.client_certificate_path),
    ("PGSSLKEY", &profile.client_key_path),
  ] {
    match value.as_deref().filter(|path| !path.is_empty()) {
      Some(path) => command.env(variable, path),
      // shell 里设过的同名变量不该混进来：界面上没配证书，就是没有证书
      None => command.env_remove(variable),
    };
  }
  command
}

/// mysqldump 有两家：Oracle MySQL 的，和 MariaDB 的（Debian 系的默认客户端、Homebrew 的 mariadb）。
/// 两家的 TLS 参数不通用，认错了就是「unknown option」
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DumpFlavor {
  Oracle,
  MariaDb,
}

/// `--version` 的原话：`mysqldump  Ver 9.4.0 for macos …` 与 `mariadb-dump from 11.4.13-MariaDB …`
/// （更早的 MariaDB 是 `mysqldump  Ver 10.19 Distrib 10.6.18-MariaDB …`）
pub(crate) fn dump_flavor_of(version: &str) -> DumpFlavor {
  if version.contains("MariaDB") {
    DumpFlavor::MariaDb
  } else {
    DumpFlavor::Oracle
  }
}

async fn mysqldump_flavor(program: &Path) -> Result<DumpFlavor, QueryError> {
  let mut command = Command::new(program);
  command.arg("--version");
  let output = tokio::task::spawn_blocking(move || command.output())
    .await
    .map_err(|error| QueryError::message(format!("{BACKUP_FAILED}: {error}")))?
    .map_err(|error| {
      QueryError::message(format!("{BACKUP_FAILED}: {} · {error}", program.display()))
    })?;
  Ok(dump_flavor_of(&String::from_utf8_lossy(&output.stdout)))
}

/// 拼 `mysqldump` 的调用，理由同 `pg_dump_command`。
///
/// 一致性靠 `--single-transaction`（InnoDB 的一致性快照，不锁表）；`--no-tablespaces` 让没有 PROCESS
/// 权限的普通账号也备份得了；`--hex-blob` 让二进制列在 SQL 文本里原样回得来。
/// 不带 `--events`：它要 EVENT 权限，普通账号会整个失败
pub(crate) fn mysqldump_command(
  program: &Path,
  flavor: DumpFlavor,
  profile: &ConnectionProfile,
  database: &str,
  tunnel_port: Option<u16>,
  output: &Path,
) -> Command {
  let mut command = Command::new(program);
  // 必须是第一个参数：不读 ~/.my.cnf，界面上配的是什么就是什么
  command.arg("--no-defaults");
  let (host, port) = match tunnel_port {
    Some(port) => ("127.0.0.1", port),
    None => (profile.host.as_str(), profile.port),
  };
  command
    .arg(format!("--result-file={}", output.display()))
    .arg(format!("--host={host}"))
    .arg(format!("--port={port}"))
    // 主机写 localhost 时客户端默认走 unix socket，而应用自己的连接走的是 TCP
    .arg("--protocol=TCP")
    .arg(format!("--user={}", profile.username))
    .arg("--single-transaction")
    .arg("--no-tablespaces")
    .arg("--routines")
    .arg("--triggers")
    .arg("--hex-blob")
    .arg("--default-character-set=utf8mb4");
  let tls = profile.effective_tls_mode();
  match flavor {
    DumpFlavor::Oracle => {
      let mode = match tls {
        TlsMode::Disabled => "DISABLED",
        TlsMode::Preferred => "PREFERRED",
        TlsMode::Required => "REQUIRED",
        TlsMode::VerifyCa => "VERIFY_CA",
        TlsMode::VerifyFull => "VERIFY_IDENTITY",
      };
      // 备份要能灌进另一台服务器：带上 GTID_PURGED 在开了 GTID 的目标上会直接报错
      command.arg("--set-gtid-purged=OFF").arg(format!("--ssl-mode={mode}"));
    }
    // MariaDB 的客户端只有「加密（连不上 TLS 就退回明文）」和「加密并验证证书」两档——
    // 11.4 上对着不带 TLS 的服务端试过，`--ssl` 照样连上了。所以「要求 TLS」只能落到验证证书：
    // 宁可连不上，也不悄悄走明文
    DumpFlavor::MariaDb => match tls {
      TlsMode::Disabled => {
        command.arg("--skip-ssl");
      }
      TlsMode::Preferred => {
        command.arg("--ssl").arg("--skip-ssl-verify-server-cert");
      }
      TlsMode::Required | TlsMode::VerifyCa | TlsMode::VerifyFull => {
        command.arg("--ssl-verify-server-cert");
      }
    },
  }
  if tls != TlsMode::Disabled {
    for (option, value) in [
      ("--ssl-ca", &profile.ca_certificate_path),
      ("--ssl-cert", &profile.client_certificate_path),
      ("--ssl-key", &profile.client_key_path),
    ] {
      if let Some(path) = value.as_deref().filter(|path| !path.is_empty()) {
        command.arg(format!("{option}={path}"));
      }
    }
  }
  command.arg(database).env("MYSQL_PWD", &profile.password);
  command
}

/// 拼 `mongodump` 的调用：一个库（`--db`），写成一个 gzip 的归档。
///
/// 连接串里不放凭据：用户名单给，密码由调用方从标准输入喂（它不是终端时 mongodump 读一行）。
/// 其余照 `services::mongodb::MongoTarget` 的规矩——直连一台、SRV 交给工具解析、
/// X.509 的认证库是 `$external`、TLS 档位的意思和应用自己的连接一样
pub(crate) fn mongodump_command(
  program: &Path,
  profile: &ConnectionProfile,
  database: &str,
  tunnel_port: Option<u16>,
  output: &Path,
) -> Command {
  let encode = |value: &str| urlencoding::encode(value).into_owned();
  let mut parameters: Vec<String> = Vec::new();
  let mut uri = if profile.mongo_srv() {
    format!("mongodb+srv://{}/", profile.host)
  } else {
    let (host, port) = match tunnel_port {
      Some(port) => ("127.0.0.1", port),
      None => (profile.host.as_str(), profile.port),
    };
    parameters.push("directConnection=true".into());
    format!("mongodb://{host}:{port}/")
  };
  let auth_source = profile.database.as_deref().filter(|database| !database.is_empty());
  let username = profile.mongo_username();
  if profile.mongo_x509() {
    parameters.push("authMechanism=MONGODB-X509".into());
    parameters.push(format!("authSource={}", encode("$external")));
  } else if !username.is_empty() {
    // SRV 没填认证库时不写：TXT 记录里的 authSource（Atlas 写在那里）要能生效
    match (auth_source, profile.mongo_srv()) {
      (Some(source), _) => parameters.push(format!("authSource={}", encode(source))),
      (None, false) => parameters.push("authSource=admin".into()),
      (None, true) => {}
    }
  }
  let tls = profile.effective_tls_mode();
  match tls {
    TlsMode::Disabled => parameters.push("tls=false".into()),
    // 与应用自己的连接一致：MongoDB 没有「能加密就加密」这一档，Preferred 当 Required，只加密不校验
    TlsMode::Preferred | TlsMode::Required => {
      parameters.push("tls=true".into());
      parameters.push("tlsInsecure=true".into());
    }
    TlsMode::VerifyCa | TlsMode::VerifyFull => parameters.push("tls=true".into()),
  }
  if tls != TlsMode::Disabled {
    for (option, value) in [
      ("tlsCAFile", &profile.ca_certificate_path),
      ("tlsCertificateKeyFile", &profile.client_certificate_path),
    ] {
      if let Some(path) = value.as_deref().filter(|path| !path.is_empty()) {
        parameters.push(format!("{option}={}", encode(path)));
      }
    }
  }
  uri.push('?');
  uri.push_str(&parameters.join("&"));

  let mut command = Command::new(program);
  command
    .arg(format!("--uri={uri}"))
    .arg(format!("--db={database}"))
    .arg(format!("--archive={}", output.display()))
    .arg("--gzip");
  if !profile.mongo_x509() && !username.is_empty() {
    command.arg(format!("--username={username}"));
  }
  command
}

/// 在 PATH 和各家常见的安装位置里找工具。从访达启动的应用拿到的 PATH 只有系统那几个目录，
/// Homebrew（`/opt/homebrew/bin`，以及 keg-only 的 libpq、mysql-client）、Postgres.app 都不在里面——
/// 只看 PATH 等于说「没装」
pub fn find_tool(name: &str) -> Option<PathBuf> {
  let from_path = std::env::var_os("PATH")
    .map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
    .unwrap_or_default();
  let known = [
    "/opt/homebrew/bin",
    "/opt/homebrew/opt/libpq/bin",
    "/opt/homebrew/opt/mysql-client/bin",
    "/usr/local/bin",
    "/usr/local/opt/libpq/bin",
    "/usr/local/opt/mysql-client/bin",
    // MySQL 官方 macOS 安装包的位置
    "/usr/local/mysql/bin",
    "/Applications/Postgres.app/Contents/Versions/latest/bin",
    "/usr/bin",
  ]
  .into_iter()
  .map(PathBuf::from);
  from_path.into_iter().chain(known).map(|dir| dir.join(name)).find(|candidate| candidate.is_file())
}

/// 在一个空的内存库里重放 EXPORT 写出的 `schema.sql`。DuckDB 1.5 的 EXPORT 把 ENUM 取值里的
/// 撇号原样写进 `CREATE TYPE`，那份备份 `IMPORT DATABASE` 时才报语法错误。
/// 只重放建表语句、不读数据，开销与库的大小无关
fn replay_duckdb_schema(directory: &Path) -> Result<(), QueryError> {
  let schema = std::fs::read_to_string(directory.join("schema.sql")).map_err(|error| {
    QueryError::message(format!("{BACKUP_FAILED}: {} · {error}", directory.display()))
  })?;
  duckdb::Connection::open_in_memory()
    .and_then(|connection| connection.execute_batch(&schema))
    .map_err(|error| QueryError::message(format!("{BACKUP_NOT_RESTORABLE}: {error}")))
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

  fn pg_profile() -> ConnectionProfile {
    ConnectionProfile {
      db_type: crate::models::DatabaseType::PostgreSQL,
      host: "db.example.com".into(),
      port: 5433,
      database: Some("shop".into()),
      username: "app".into(),
      password: "s3cret pa'ss".into(),
      ..ConnectionProfile::default()
    }
  }

  fn args(command: &Command) -> Vec<String> {
    command.get_args().map(|arg| arg.to_string_lossy().to_string()).collect()
  }

  fn env(command: &Command, name: &str) -> Option<Option<String>> {
    command
      .get_envs()
      .find(|(key, _)| *key == name)
      .map(|(_, value)| value.map(|value| value.to_string_lossy().to_string()))
  }

  /// 命令行在 `ps` 里谁都看得见：密码只能走环境变量
  #[test]
  fn pg_dump_gets_the_password_only_through_the_environment() {
    let command = pg_dump_command(
      Path::new("/x/pg_dump"),
      &pg_profile(),
      None,
      Path::new("/tmp/out.dump.part"),
    );
    let arguments = args(&command);
    assert!(arguments.iter().all(|arg| !arg.contains("s3cret")), "{arguments:?}");
    assert_eq!(env(&command, "PGPASSWORD"), Some(Some("s3cret pa'ss".into())));
    assert!(arguments.contains(&"--no-password".to_string()), "没密码时不许停下来等人输入");
    assert!(arguments.contains(&"--host=db.example.com".to_string()));
    assert!(arguments.contains(&"--port=5433".to_string()));
    assert!(arguments.contains(&"--dbname=shop".to_string()));
    assert_eq!(env(&command, "PGSSLMODE"), Some(Some("disable".into())));
    // 界面上没配证书，shell 里遗留的同名变量也不能混进来
    assert_eq!(env(&command, "PGSSLROOTCERT"), Some(None));
  }

  /// 经隧道时连本地端口，证书仍按原主机名校验
  #[test]
  fn through_a_tunnel_pg_dump_connects_locally_but_verifies_the_real_host() {
    let profile = ConnectionProfile {
      tls_mode: Some(TlsMode::VerifyFull),
      ca_certificate_path: Some("/certs/ca.pem".into()),
      ..pg_profile()
    };
    let command =
      pg_dump_command(Path::new("/x/pg_dump"), &profile, Some(40123), Path::new("/tmp/o"));
    let arguments = args(&command);
    assert!(arguments.contains(&"--port=40123".to_string()), "{arguments:?}");
    assert!(arguments.contains(&"--host=db.example.com".to_string()));
    assert_eq!(env(&command, "PGHOSTADDR"), Some(Some("127.0.0.1".into())));
    assert_eq!(env(&command, "PGSSLMODE"), Some(Some("verify-full".into())));
    assert_eq!(env(&command, "PGSSLROOTCERT"), Some(Some("/certs/ca.pem".into())));
  }

  fn mysql_profile() -> ConnectionProfile {
    ConnectionProfile {
      db_type: DatabaseType::MySQL,
      host: "localhost".into(),
      port: 3307,
      database: Some("shop".into()),
      username: "app".into(),
      password: "s3cret pa'ss".into(),
      tls_mode: Some(TlsMode::Required),
      ca_certificate_path: Some("/certs/ca.pem".into()),
      ..ConnectionProfile::default()
    }
  }

  #[test]
  fn the_two_mysqldump_flavors_are_told_apart_by_their_version_line() {
    assert_eq!(
      dump_flavor_of("mysqldump  Ver 26.7.0 for macos27.0 on arm64 (Homebrew)\n"),
      DumpFlavor::Oracle
    );
    assert_eq!(
      dump_flavor_of(
        "mariadb-dump from 11.4.13-MariaDB, client 10.19 for debian-linux-gnu (x86_64)"
      ),
      DumpFlavor::MariaDb
    );
    assert_eq!(
      dump_flavor_of("mysqldump  Ver 10.19 Distrib 10.6.18-MariaDB, for debian-linux-gnu (x86_64)"),
      DumpFlavor::MariaDb
    );
  }

  /// 密码只走环境变量；`--no-defaults` 必须是第一个参数（mysqldump 只在第一位认它）；
  /// localhost 也要走 TCP
  #[test]
  fn mysqldump_gets_the_password_only_through_the_environment() {
    let command = mysqldump_command(
      Path::new("/x/mysqldump"),
      DumpFlavor::Oracle,
      &mysql_profile(),
      "shop",
      None,
      Path::new("/tmp/out.sql.part"),
    );
    let arguments = args(&command);
    assert!(arguments.iter().all(|arg| !arg.contains("s3cret")), "{arguments:?}");
    assert_eq!(env(&command, "MYSQL_PWD"), Some(Some("s3cret pa'ss".into())));
    assert_eq!(arguments.first().map(String::as_str), Some("--no-defaults"));
    assert_eq!(arguments.last().map(String::as_str), Some("shop"));
    for expected in [
      "--host=localhost",
      "--port=3307",
      "--protocol=TCP",
      "--user=app",
      "--single-transaction",
      "--ssl-mode=REQUIRED",
      "--ssl-ca=/certs/ca.pem",
      "--set-gtid-purged=OFF",
      "--result-file=/tmp/out.sql.part",
    ] {
      assert!(arguments.contains(&expected.to_string()), "{expected} 不在 {arguments:?}");
    }
  }

  /// MariaDB 的客户端没有 `--ssl-mode` 也没有 `--set-gtid-purged`；「要求 TLS」落到验证证书，
  /// 因为它的 `--ssl` 连不上 TLS 时会退回明文
  #[test]
  fn the_mariadb_client_gets_its_own_tls_options() {
    let arguments = |tls: TlsMode, tunnel: Option<u16>| {
      let profile = ConnectionProfile { tls_mode: Some(tls), ..mysql_profile() };
      args(&mysqldump_command(
        Path::new("/x/mariadb-dump"),
        DumpFlavor::MariaDb,
        &profile,
        "shop",
        tunnel,
        Path::new("/tmp/o"),
      ))
    };
    let required = arguments(TlsMode::Required, None);
    assert!(
      required.iter().all(|arg| !arg.starts_with("--ssl-mode") && !arg.starts_with("--set-gtid")),
      "{required:?}"
    );
    assert!(required.contains(&"--ssl-verify-server-cert".to_string()), "{required:?}");
    assert!(!required.contains(&"--ssl".to_string()), "{required:?}");
    let preferred = arguments(TlsMode::Preferred, None);
    assert!(
      preferred.contains(&"--ssl".to_string())
        && preferred.contains(&"--skip-ssl-verify-server-cert".to_string())
    );
    let disabled = arguments(TlsMode::Disabled, Some(40123));
    assert!(disabled.contains(&"--skip-ssl".to_string()), "{disabled:?}");
    assert!(
      disabled.iter().all(|arg| !arg.starts_with("--ssl-ca")),
      "关了 TLS 就不带证书：{disabled:?}"
    );
    assert!(
      disabled.contains(&"--host=127.0.0.1".to_string())
        && disabled.contains(&"--port=40123".to_string())
    );
  }

  #[tokio::test]
  async fn tidb_and_a_profile_without_a_database_are_refused_before_looking_for_the_tool() {
    let mut profile = mysql_profile();
    profile.options.insert("server".into(), "tidb".into());
    let error =
      backup_with_tool(&profile, None, Path::new("/tmp/never"), None).await.expect_err("tidb");
    assert_eq!(error.message, BACKUP_TIDB);
    let profile = ConnectionProfile { database: Some(String::new()), ..mysql_profile() };
    let error =
      backup_with_tool(&profile, None, Path::new("/tmp/never"), None).await.expect_err("no db");
    assert_eq!(error.message, BACKUP_NO_DATABASE);
    // MongoDB 的表单上那格是认证库，不能拿来当备份对象：没说备份哪个库就拒绝
    let error = backup_with_tool(&mongo_profile(), None, Path::new("/tmp/never"), Some(""))
      .await
      .expect_err("mongo without a database");
    assert_eq!(error.message, BACKUP_NO_DATABASE);
  }

  fn mongo_profile() -> ConnectionProfile {
    ConnectionProfile {
      db_type: DatabaseType::MongoDB,
      host: "mongo.example.com".into(),
      port: 27018,
      database: Some(String::new()),
      username: "app".into(),
      password: "s3cret pa'ss".into(),
      tls_mode: Some(TlsMode::Disabled),
      ..ConnectionProfile::default()
    }
  }

  fn uri_of(command: &Command) -> String {
    args(command)
      .into_iter()
      .find_map(|arg| arg.strip_prefix("--uri=").map(str::to_string))
      .expect("--uri")
  }

  /// 密码既不在参数里也不在连接串里（由标准输入喂）；直连一台，认证库默认 admin
  #[test]
  fn mongodump_keeps_the_password_out_of_the_command_line() {
    let command = mongodump_command(
      Path::new("/x/mongodump"),
      &mongo_profile(),
      "shop",
      None,
      Path::new("/tmp/o.part"),
    );
    let arguments = args(&command);
    assert!(arguments.iter().all(|arg| !arg.contains("s3cret")), "{arguments:?}");
    assert!(command
      .get_envs()
      .all(|(_, value)| value.is_none_or(|value| !value.to_string_lossy().contains("s3cret"))));
    assert_eq!(
      uri_of(&command),
      "mongodb://mongo.example.com:27018/?directConnection=true&authSource=admin&tls=false"
    );
    for expected in ["--username=app", "--db=shop", "--archive=/tmp/o.part", "--gzip"] {
      assert!(arguments.contains(&expected.to_string()), "{expected} 不在 {arguments:?}");
    }
  }

  /// X.509：不带用户名，认证库是 `$external`，证书路径按 URI 编码；经隧道连本地端口
  #[test]
  fn an_x509_mongodump_presents_the_certificate_instead_of_a_user() {
    let mut profile = ConnectionProfile {
      tls_mode: Some(TlsMode::VerifyFull),
      ca_certificate_path: Some("/certs/my ca.pem".into()),
      client_certificate_path: Some("/certs/client.pem".into()),
      ..mongo_profile()
    };
    profile
      .options
      .insert(crate::models::MONGO_AUTH_MECHANISM_OPTION.into(), crate::models::MONGO_X509.into());
    let command = mongodump_command(
      Path::new("/x/mongodump"),
      &profile,
      "shop",
      Some(40123),
      Path::new("/tmp/o"),
    );
    assert!(
      args(&command).iter().all(|arg| !arg.starts_with("--username")),
      "{:?}",
      args(&command)
    );
    assert_eq!(
      uri_of(&command),
      "mongodb://127.0.0.1:40123/?directConnection=true&authMechanism=MONGODB-X509&authSource=%24external\
       &tls=true&tlsCAFile=%2Fcerts%2Fmy%20ca.pem&tlsCertificateKeyFile=%2Fcerts%2Fclient.pem"
    );
  }

  /// SRV 交给工具解析；没填认证库时不写，TXT 里的 authSource 才生效。Required 只加密不校验
  #[test]
  fn an_srv_mongodump_leaves_the_auth_source_to_the_txt_record() {
    let mut profile = ConnectionProfile { tls_mode: Some(TlsMode::Required), ..mongo_profile() };
    profile.host = "cluster0.example.net".into();
    profile.options.insert(crate::models::MONGO_SRV_OPTION.into(), "true".into());
    let command =
      mongodump_command(Path::new("/x/mongodump"), &profile, "shop", None, Path::new("/tmp/o"));
    assert_eq!(uri_of(&command), "mongodb+srv://cluster0.example.net/?tls=true&tlsInsecure=true");
  }

  #[tokio::test]
  async fn cockroachdb_is_refused_with_its_own_advice() {
    let mut profile = pg_profile();
    profile.options.insert("server".into(), "cockroachdb".into());
    let error =
      backup_with_tool(&profile, None, Path::new("/tmp/never"), None).await.expect_err("refuse");
    assert_eq!(error.message, BACKUP_COCKROACH);
  }

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

  /// DuckDB 1.5 的 EXPORT DATABASE 把 ENUM 取值里的撇号原样写进 `CREATE TYPE`：
  /// 备份写成了，`IMPORT DATABASE` 却报语法错误——要恢复的时候才发现备份没用
  #[tokio::test]
  async fn a_duckdb_backup_that_would_not_import_back_is_not_kept() {
    let dir = temp_dir("duckdb-enum");
    let file = dir.join("source.duckdb");
    let pool = crate::services::duckdb::open(&file.to_string_lossy()).await.expect("open duckdb");
    let mut connection =
      SessionConnection::acquire(PoolRef::DuckDb(&pool)).await.expect("connection");
    connection
      .execute_unprepared("CREATE TYPE mood AS ENUM ('it''s', 'b'); CREATE TABLE t (m mood);")
      .await
      .expect("seed");
    drop(connection);

    let target = dir.join("backup");
    let error = backup_embedded(PoolRef::DuckDb(&pool), &target).await.expect_err("not restorable");
    assert!(error.message.starts_with(BACKUP_NOT_RESTORABLE), "{}", error.message);
    assert!(!target.exists() && !part_path(&target).exists());
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
