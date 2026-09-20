use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use urlencoding::encode;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
  /// 保存后由后端生成。新建连接表单在保存之前要先「测试连接」，那时还没有 id，
  /// 所以这三个字段必须有默认值——否则草稿配置根本反序列化不了。
  #[serde(default)]
  pub id: String,
  pub name: String,
  pub db_type: DatabaseType,
  pub host: String,
  pub port: u16,
  pub database: Option<String>,
  pub username: String,
  #[serde(default)]
  pub password: String,
  pub ssl: bool,
  #[serde(default)]
  pub tls_mode: Option<TlsMode>,
  #[serde(default)]
  pub ca_certificate_path: Option<String>,
  #[serde(default)]
  pub client_certificate_path: Option<String>,
  #[serde(default)]
  pub client_key_path: Option<String>,
  #[serde(default = "default_save_password")]
  pub save_password: bool,
  pub options: HashMap<String, String>,
  pub tags: Vec<String>,
  #[serde(default)]
  pub environment: ConnectionEnvironment,
  #[serde(default)]
  pub credential_ref: Option<String>,
  #[serde(default)]
  pub created_at: String,
  #[serde(default)]
  pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionEnvironment {
  #[default]
  Development,
  Testing,
  Staging,
  Production,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum TlsMode {
  Disabled,
  Preferred,
  Required,
  VerifyCa,
  VerifyFull,
}

fn default_save_password() -> bool {
  true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DatabaseType {
  // 关系型数据库
  #[serde(rename = "mysql")]
  MySQL,
  #[serde(rename = "postgresql")]
  PostgreSQL,
  #[serde(rename = "sqlite")]
  SQLite,

  // 非关系型数据库
  #[serde(rename = "mongodb")]
  MongoDB,
  #[serde(rename = "redis")]
  Redis,
  #[serde(rename = "neo4j")]
  Neo4j,

  // 分析平台
  #[serde(rename = "duckdb")]
  DuckDB,
  #[serde(rename = "clickhouse")]
  ClickHouse,
  #[serde(rename = "elasticsearch")]
  Elasticsearch,
}

impl DatabaseType {
  pub fn get_default_port(&self) -> u16 {
    match self {
      DatabaseType::MySQL => 3306,
      DatabaseType::PostgreSQL => 5432,
      DatabaseType::SQLite => 0, // SQLite 不需要端口
      DatabaseType::MongoDB => 27017,
      DatabaseType::Redis => 6379,
      DatabaseType::Neo4j => 7687,      // Neo4j Bolt 端口
      DatabaseType::DuckDB => 0,        // DuckDB 不需要端口
      DatabaseType::ClickHouse => 9000, // ClickHouse 默认端口
      DatabaseType::Elasticsearch => 9200,
    }
  }

  pub fn to_connection_string(&self, config: &ConnectionProfile) -> String {
    match self {
      DatabaseType::MySQL => {
        let base_url = format!(
          "mysql://{}:{}@{}:{}/{}",
          encode(&config.username),
          encode(&config.password),
          config.host,
          config.port,
          config.database.as_ref().unwrap_or(&"mysql".to_string())
        );

        let mut params = Vec::new();

        params.push(format!(
          "ssl-mode={}",
          match config.effective_tls_mode() {
            TlsMode::Disabled => "DISABLED",
            TlsMode::Preferred => "PREFERRED",
            TlsMode::Required => "REQUIRED",
            TlsMode::VerifyCa => "VERIFY_CA",
            TlsMode::VerifyFull => "VERIFY_IDENTITY",
          }
        ));
        if config.effective_tls_mode() != TlsMode::Disabled {
          push_parameter(&mut params, "ssl-ca", config.ca_certificate_path.as_deref());
          push_parameter(&mut params, "ssl-cert", config.client_certificate_path.as_deref());
          push_parameter(&mut params, "ssl-key", config.client_key_path.as_deref());
        }

        // Add connection timeout and other stability parameters
        params.push("connectTimeout=30000".to_string());
        params.push("acquireTimeout=30000".to_string());

        if !params.is_empty() {
          format!("{}?{}", base_url, params.join("&"))
        } else {
          base_url
        }
      }
      DatabaseType::PostgreSQL => {
        let base_url = format!(
          "postgres://{}:{}@{}:{}/{}",
          encode(&config.username),
          encode(&config.password),
          config.host,
          config.port,
          config.database.as_ref().unwrap_or(&"postgres".to_string())
        );

        let mut params = Vec::new();

        params.push(format!(
          "sslmode={}",
          match config.effective_tls_mode() {
            TlsMode::Disabled => "disable",
            TlsMode::Preferred => "prefer",
            TlsMode::Required => "require",
            TlsMode::VerifyCa => "verify-ca",
            TlsMode::VerifyFull => "verify-full",
          }
        ));
        if config.effective_tls_mode() != TlsMode::Disabled {
          push_parameter(&mut params, "sslrootcert", config.ca_certificate_path.as_deref());
          push_parameter(&mut params, "sslcert", config.client_certificate_path.as_deref());
          push_parameter(&mut params, "sslkey", config.client_key_path.as_deref());
        }

        // Add connection timeout
        params.push("connect_timeout=30".to_string());

        if !params.is_empty() {
          format!("{}?{}", base_url, params.join("&"))
        } else {
          base_url
        }
      }
      DatabaseType::SQLite => {
        format!("sqlite:{}", config.database.as_ref().unwrap_or(&":memory:".to_string()))
      }
      DatabaseType::MongoDB => {
        if !config.username.is_empty() && !config.password.is_empty() {
          format!(
            "mongodb://{}:{}@{}:{}/{}",
            encode(&config.username),
            encode(&config.password),
            config.host,
            config.port,
            config.database.as_ref().unwrap_or(&"admin".to_string())
          )
        } else {
          format!(
            "mongodb://{}:{}/{}",
            config.host,
            config.port,
            config.database.as_ref().unwrap_or(&"admin".to_string())
          )
        }
      }
      DatabaseType::Redis => {
        if !config.username.is_empty() && !config.password.is_empty() {
          format!(
            "redis://{}:{}@{}:{}/{}",
            encode(&config.username),
            encode(&config.password),
            config.host,
            config.port,
            config.database.as_ref().unwrap_or(&"0".to_string())
          )
        } else {
          format!(
            "redis://{}:{}/{}",
            config.host,
            config.port,
            config.database.as_ref().unwrap_or(&"0".to_string())
          )
        }
      }
      DatabaseType::Neo4j => {
        format!(
          "bolt://{}:{}@{}:{}/{}",
          encode(&config.username),
          encode(&config.password),
          config.host,
          config.port,
          config.database.as_ref().unwrap_or(&"neo4j".to_string())
        )
      }
      DatabaseType::DuckDB => {
        format!("duckdb:{}", config.database.as_ref().unwrap_or(&":memory:".to_string()))
      }
      DatabaseType::ClickHouse => {
        format!(
          "clickhouse://{}:{}@{}:{}/{}",
          encode(&config.username),
          encode(&config.password),
          config.host,
          config.port,
          config.database.as_ref().unwrap_or(&"default".to_string())
        )
      }
      DatabaseType::Elasticsearch => {
        let scheme =
          if config.effective_tls_mode() == TlsMode::Disabled { "http" } else { "https" };

        if !config.username.is_empty() && !config.password.is_empty() {
          format!(
            "{}://{}:{}@{}:{}",
            scheme,
            encode(&config.username),
            encode(&config.password),
            config.host,
            config.port
          )
        } else {
          format!("{}://{}:{}", scheme, config.host, config.port)
        }
      }
    }
  }
}

impl ConnectionProfile {
  pub fn effective_tls_mode(&self) -> TlsMode {
    self.tls_mode.unwrap_or(if self.ssl { TlsMode::Required } else { TlsMode::Disabled })
  }
}

fn push_parameter(parameters: &mut Vec<String>, name: &str, value: Option<&str>) {
  if let Some(value) = value.filter(|value| !value.is_empty()) {
    parameters.push(format!("{name}={}", encode(value)));
  }
}

impl Default for ConnectionProfile {
  fn default() -> Self {
    Self {
      id: uuid::Uuid::new_v4().to_string(),
      name: "新连接".to_string(),
      db_type: DatabaseType::SQLite,
      host: "localhost".to_string(),
      port: 0,
      database: None,
      username: "".to_string(),
      password: "".to_string(),
      ssl: false,
      tls_mode: Some(TlsMode::Disabled),
      ca_certificate_path: None,
      client_certificate_path: None,
      client_key_path: None,
      save_password: true,
      options: HashMap::new(),
      tags: Vec::new(),
      environment: ConnectionEnvironment::Development,
      credential_ref: None,
      created_at: chrono::Utc::now().to_rfc3339(),
      updated_at: chrono::Utc::now().to_rfc3339(),
    }
  }
}

#[cfg(test)]
mod tests {
  #[test]
  fn draft_connection_without_id_deserializes() {
    // 新建连接表单送来的草稿：还没保存，所以没有 id / created_at / updated_at。
    // 这三个字段当初没有 serde 默认值，于是「测试连接」在保存之前必然失败，
    // 而失败原因在前端又被换成了一句没有信息量的话。
    let draft = r#"{
      "name": "T1",
      "db_type": "mysql",
      "host": "154.44.16.42",
      "port": 3306,
      "database": "mysql",
      "username": "root",
      "password": "secret",
      "ssl": false,
      "tls_mode": "disabled",
      "ca_certificate_path": "",
      "client_certificate_path": "",
      "client_key_path": "",
      "save_password": true,
      "options": {},
      "tags": [],
      "environment": "development"
    }"#;

    let parsed = serde_json::from_str::<super::ConnectionProfile>(draft);
    assert!(parsed.is_ok(), "草稿配置反序列化失败: {:?}", parsed.err());

    let profile = match parsed {
      Ok(profile) => profile,
      Err(error) => unreachable!("上面已断言成功: {error}"),
    };
    assert_eq!(profile.id, "");
    assert_eq!(profile.created_at, "");
  }

  use super::*;

  fn mysql_config(tls_mode: Option<TlsMode>, ssl: bool) -> ConnectionProfile {
    ConnectionProfile {
      db_type: DatabaseType::MySQL,
      host: "localhost".to_string(),
      port: 3306,
      database: Some("dataomni".to_string()),
      username: "user".to_string(),
      password: "password".to_string(),
      ssl,
      tls_mode,
      ..ConnectionProfile::default()
    }
  }

  #[test]
  fn mysql_connection_string_requires_tls_when_enabled() {
    let connection_string =
      DatabaseType::MySQL.to_connection_string(&mysql_config(Some(TlsMode::Required), false));

    assert!(connection_string.contains("ssl-mode=REQUIRED"));
    assert!(!connection_string.contains("ssl-mode=DISABLED"));
  }

  #[test]
  fn mysql_connection_string_disables_tls_when_disabled() {
    let connection_string =
      DatabaseType::MySQL.to_connection_string(&mysql_config(Some(TlsMode::Disabled), true));

    assert!(connection_string.contains("ssl-mode=DISABLED"));
    assert!(!connection_string.contains("ssl-mode=REQUIRED"));
  }

  #[test]
  fn mysql_connection_string_verifies_host_identity() {
    let mut config = mysql_config(Some(TlsMode::VerifyFull), false);
    config.ca_certificate_path = Some("/certs/root ca.pem".to_string());
    config.client_certificate_path = Some("/certs/client.pem".to_string());
    config.client_key_path = Some("/certs/client.key".to_string());
    let connection_string = DatabaseType::MySQL.to_connection_string(&config);

    assert!(connection_string.contains("ssl-mode=VERIFY_IDENTITY"));
    assert!(connection_string.contains("ssl-ca=%2Fcerts%2Froot%20ca.pem"));
    assert!(connection_string.contains("ssl-cert=%2Fcerts%2Fclient.pem"));
    assert!(connection_string.contains("ssl-key=%2Fcerts%2Fclient.key"));
  }

  #[test]
  fn legacy_ssl_flag_maps_to_required_tls() {
    let connection_string = DatabaseType::MySQL.to_connection_string(&mysql_config(None, true));

    assert!(connection_string.contains("ssl-mode=REQUIRED"));
  }

  #[test]
  fn postgres_connection_string_uses_certificate_paths() {
    let config = ConnectionProfile {
      db_type: DatabaseType::PostgreSQL,
      host: "localhost".to_string(),
      port: 5432,
      database: Some("dataomni".to_string()),
      username: "user".to_string(),
      password: "password".to_string(),
      tls_mode: Some(TlsMode::VerifyFull),
      ca_certificate_path: Some("/certs/root ca.pem".to_string()),
      client_certificate_path: Some("/certs/client.pem".to_string()),
      client_key_path: Some("/certs/client.key".to_string()),
      ..ConnectionProfile::default()
    };

    let connection_string = DatabaseType::PostgreSQL.to_connection_string(&config);

    assert!(connection_string.contains("sslmode=verify-full"));
    assert!(connection_string.contains("sslrootcert=%2Fcerts%2Froot%20ca.pem"));
    assert!(connection_string.contains("sslcert=%2Fcerts%2Fclient.pem"));
    assert!(connection_string.contains("sslkey=%2Fcerts%2Fclient.key"));
  }

  #[test]
  fn legacy_connection_profile_defaults_new_fields() {
    let json = r#"{
      "id":"profile-1",
      "name":"Local",
      "db_type":"sqlite",
      "host":"",
      "port":0,
      "database":":memory:",
      "username":"",
      "password":"",
      "ssl":false,
      "options":{},
      "tags":[],
      "created_at":"2026-01-01T00:00:00Z",
      "updated_at":"2026-01-01T00:00:00Z"
    }"#;

    let profile: ConnectionProfile =
      serde_json::from_str(json).expect("legacy profile should load");

    assert_eq!(profile.environment, ConnectionEnvironment::Development);
    assert_eq!(profile.credential_ref, None);
    assert_eq!(profile.tls_mode, None);
    assert_eq!(profile.ca_certificate_path, None);
    assert_eq!(profile.client_certificate_path, None);
    assert_eq!(profile.client_key_path, None);
    assert!(profile.save_password);
    assert_eq!(profile.effective_tls_mode(), TlsMode::Disabled);
  }
}
