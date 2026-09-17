use sqlx::{mysql::MySqlPoolOptions, postgres::PgPoolOptions, sqlite::SqlitePoolOptions};

const REQUIRE_NETWORK_DATABASES_ENV: &str = "DATAOMNI_REQUIRE_NETWORK_DATABASE_TESTS";
const MYSQL_URL_ENV: &str = "DATAOMNI_MYSQL_TEST_URL";
const POSTGRES_URL_ENV: &str = "DATAOMNI_POSTGRES_TEST_URL";

#[tokio::test]
async fn sqlite_supports_basic_read_write() {
  let pool = SqlitePoolOptions::new()
    .max_connections(1)
    .connect("sqlite::memory:")
    .await
    .expect("connect to in-memory SQLite");

  sqlx::query("CREATE TABLE smoke_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
    .execute(&pool)
    .await
    .expect("create SQLite smoke table");
  sqlx::query("INSERT INTO smoke_test (value) VALUES (?)")
    .bind("ready")
    .execute(&pool)
    .await
    .expect("insert SQLite smoke row");

  let value: String = sqlx::query_scalar("SELECT value FROM smoke_test WHERE id = 1")
    .fetch_one(&pool)
    .await
    .expect("read SQLite smoke row");

  assert_eq!(value, "ready");
}

#[tokio::test]
async fn postgres_supports_basic_read_write() {
  let Some(url) = network_database_url(POSTGRES_URL_ENV) else {
    return;
  };
  let pool = PgPoolOptions::new()
    .max_connections(1)
    .connect(&url)
    .await
    .expect("connect to PostgreSQL smoke database");

  sqlx::query("CREATE TEMP TABLE smoke_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
    .execute(&pool)
    .await
    .expect("create PostgreSQL smoke table");
  sqlx::query("INSERT INTO smoke_test (id, value) VALUES ($1, $2)")
    .bind(1_i32)
    .bind("ready")
    .execute(&pool)
    .await
    .expect("insert PostgreSQL smoke row");

  let value: String = sqlx::query_scalar("SELECT value FROM smoke_test WHERE id = $1")
    .bind(1_i32)
    .fetch_one(&pool)
    .await
    .expect("read PostgreSQL smoke row");

  assert_eq!(value, "ready");
}

#[tokio::test]
async fn mysql_supports_basic_read_write() {
  let Some(url) = network_database_url(MYSQL_URL_ENV) else {
    return;
  };
  let pool = MySqlPoolOptions::new()
    .max_connections(1)
    .connect(&url)
    .await
    .expect("connect to MySQL smoke database");

  sqlx::query("CREATE TEMPORARY TABLE smoke_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
    .execute(&pool)
    .await
    .expect("create MySQL smoke table");
  sqlx::query("INSERT INTO smoke_test (id, value) VALUES (?, ?)")
    .bind(1_i32)
    .bind("ready")
    .execute(&pool)
    .await
    .expect("insert MySQL smoke row");

  let value: String = sqlx::query_scalar("SELECT value FROM smoke_test WHERE id = ?")
    .bind(1_i32)
    .fetch_one(&pool)
    .await
    .expect("read MySQL smoke row");

  assert_eq!(value, "ready");
}

fn network_database_url(variable: &str) -> Option<String> {
  match std::env::var(variable) {
    Ok(url) if !url.is_empty() => Some(url),
    _ if network_databases_required() => {
      panic!("{variable} must be set when {REQUIRE_NETWORK_DATABASES_ENV}=1")
    }
    _ => {
      eprintln!("skipping network database smoke test because {variable} is not set");
      None
    }
  }
}

fn network_databases_required() -> bool {
  std::env::var(REQUIRE_NETWORK_DATABASES_ENV).as_deref() == Ok("1")
}
