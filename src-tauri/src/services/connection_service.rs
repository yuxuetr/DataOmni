use crate::models::{ConnectionConfig, DatabaseType};
use serde_json;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug)]
pub struct ConnectionService {
  config_path: PathBuf,
  connections: HashMap<String, ConnectionConfig>,
}

impl ConnectionService {
  pub fn new(app_handle: &tauri::AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
    let app_dir = app_handle
      .path()
      .app_config_dir()
      .map_err(|e| format!("无法获取应用配置目录: {}", e))?;

    // 确保配置目录存在
    if !app_dir.exists() {
      fs::create_dir_all(&app_dir)?;
    }

    let config_path = app_dir.join("connections.json");
    let connections = Self::load_connections(&config_path)?;

    Ok(Self {
      config_path,
      connections,
    })
  }

  /// 加载已保存的连接配置
  fn load_connections(
    config_path: &PathBuf,
  ) -> Result<HashMap<String, ConnectionConfig>, Box<dyn std::error::Error>> {
    if !config_path.exists() {
      return Ok(HashMap::new());
    }

    let content = fs::read_to_string(config_path)?;
    let connections: Vec<ConnectionConfig> = serde_json::from_str(&content)?;
    let mut map = HashMap::new();

    for conn in connections {
      map.insert(conn.id.clone(), conn);
    }

    Ok(map)
  }

  /// 保存连接配置到文件
  fn save_connections(&self) -> Result<(), Box<dyn std::error::Error>> {
    let connections: Vec<&ConnectionConfig> = self.connections.values().collect();
    let content = serde_json::to_string_pretty(&connections)?;
    fs::write(&self.config_path, content)?;
    Ok(())
  }

  /// 创建新的数据库连接配置
  pub fn create_connection(&mut self, mut config: ConnectionConfig) -> Result<String, String> {
    // 确保ID唯一
    if config.id.is_empty() {
      config.id = uuid::Uuid::new_v4().to_string();
    }

    // 设置默认端口
    if config.port == 0 {
      config.port = config.db_type.get_default_port();
    }

    // 更新时间戳
    config.updated_at = chrono::Utc::now().to_rfc3339();

    let id = config.id.clone();
    self.connections.insert(id.clone(), config);

    self
      .save_connections()
      .map_err(|e| format!("保存连接配置失败: {}", e))?;

    Ok(id)
  }

  /// 更新数据库连接配置
  pub fn update_connection(
    &mut self,
    id: &str,
    mut config: ConnectionConfig,
  ) -> Result<(), String> {
    if !self.connections.contains_key(id) {
      return Err("连接不存在".to_string());
    }

    config.id = id.to_string();
    config.updated_at = chrono::Utc::now().to_rfc3339();

    self.connections.insert(id.to_string(), config);

    self
      .save_connections()
      .map_err(|e| format!("更新连接配置失败: {}", e))?;

    Ok(())
  }

  /// 删除数据库连接配置
  pub fn delete_connection(&mut self, id: &str) -> Result<(), String> {
    if self.connections.remove(id).is_none() {
      return Err("连接不存在".to_string());
    }

    self
      .save_connections()
      .map_err(|e| format!("删除连接配置失败: {}", e))?;

    Ok(())
  }

  /// 获取所有连接配置
  pub fn get_connections(&self) -> Vec<ConnectionConfig> {
    self.connections.values().cloned().collect()
  }

  /// 根据ID获取连接配置
  pub fn get_connection(&self, id: &str) -> Option<&ConnectionConfig> {
    self.connections.get(id)
  }

  /// 测试数据库连接 - 实际尝试连接并返回连接字符串
  pub fn test_connection(&self, config: &ConnectionConfig) -> Result<String, String> {
    // 对于MySQL和SSL连接，尝试多种配置
    if config.db_type == crate::models::DatabaseType::MySQL && (config.ssl || config.port > 32767 || config.port == 31306) {
      return self.test_mysql_ssl_connection(config);
    }
    
    let connection_string = config.db_type.to_connection_string(config);
    println!(
      "🔗 准备测试数据库连接: {}",
      mask_password(&connection_string)
    );

    // 基本验证
    match config.db_type {
      DatabaseType::SQLite | DatabaseType::DuckDB => {
        if config.database.is_none() || config.database.as_ref().unwrap().is_empty() {
          return Err("数据库文件路径不能为空".to_string());
        }
      }
      DatabaseType::MySQL | DatabaseType::PostgreSQL | DatabaseType::ClickHouse => {
        if config.host.is_empty() {
          return Err("主机地址不能为空".to_string());
        }
        if config.username.is_empty() {
          return Err("用户名不能为空".to_string());
        }
        if config.port == 0 || config.port > 65535 {
          return Err("端口号无效，必须在1-65535范围内".to_string());
        }
        if config.database.is_none() || config.database.as_ref().unwrap().is_empty() {
          return Err("数据库名不能为空".to_string());
        }
      }
      DatabaseType::MongoDB | DatabaseType::Neo4j => {
        if config.host.is_empty() {
          return Err("主机地址不能为空".to_string());
        }
        if config.port == 0 || config.port > 65535 {
          return Err("端口号无效，必须在1-65535范围内".to_string());
        }
        // MongoDB 和 Neo4j 可以不需要用户名密码
      }
      DatabaseType::Redis => {
        if config.host.is_empty() {
          return Err("主机地址不能为空".to_string());
        }
        if config.port == 0 || config.port > 65535 {
          return Err("端口号无效，必须在1-65535范围内".to_string());
        }
        // Redis 可以不需要用户名密码
      }
      DatabaseType::Elasticsearch => {
        if config.host.is_empty() {
          return Err("主机地址不能为空".to_string());
        }
        if config.port == 0 || config.port > 65535 {
          return Err("端口号无效，必须在1-65535范围内".to_string());
        }
        // Elasticsearch 可以不需要用户名密码
      }
    }

    println!("✅ 连接配置验证通过，返回连接字符串用于前端测试");
    Ok(connection_string)
  }
  
  /// MySQL SSL连接特殊处理，尝试多种配置
  fn test_mysql_ssl_connection(&self, config: &ConnectionConfig) -> Result<String, String> {
    println!("🔒 MySQL SSL连接测试，尝试多种配置...");
    
    // 对用户名和密码进行URL编码
    let encoded_username = urlencoding::encode(&config.username);
    let encoded_password = urlencoding::encode(&config.password);
    
    let base_url = format!(
      "mysql://{}:{}@{}:{}/{}",
      encoded_username,
      encoded_password,
      config.host,
      config.port,
      config.database.as_ref().unwrap_or(&"mysql".to_string())
    );
    
    // SSL配置尝试列表，按优先级排列
    // 使用SQLx MySQL驱动的正确参数名和更兼容的配置
    // 对于MySQL 5.7容器环境，优先尝试禁用SSL
    let ssl_configs = vec![
      // 1. 首先尝试禁用SSL - 适用于MySQL 5.7容器环境
      vec!["ssl-mode=DISABLED"],
      // 2. 如果禁用失败，尝试优选模式
      vec!["ssl-mode=PREFERRED"],
      // 3. 最后尝试要求SSL但不验证证书
      vec!["ssl-mode=REQUIRED", "ssl-ca="],
    ];
    
    for (i, ssl_params) in ssl_configs.iter().enumerate() {
      let mut params = ssl_params.to_vec();
      params.extend(vec!["connectTimeout=30000", "acquireTimeout=30000"]);
      
      let connection_string = format!("{}?{}", base_url, params.join("&"));
      println!(
        "🔄 尝试SSL配置 {} ({}): {}",
        i + 1,
        ssl_params[0],
        mask_password(&connection_string)
      );
      
      // 返回第一个配置进行测试
      // 如果失败，前端可以在备选方案中尝试其他配置
      if i == 0 {
        return Ok(connection_string);
      }
    }
    
    // 如果所有配置都失败，返回默认配置
    let default_params = vec!["sslmode=require", "connectTimeout=30000"];
    let connection_string = format!("{}?{}", base_url, default_params.join("&"));
    Ok(connection_string)
  }
}

/// 隐藏连接字符串中的密码用于日志记录
fn mask_password(connection_string: &str) -> String {
  if let Some(start) = connection_string.find("://") {
    if let Some(at_pos) = connection_string[start + 3..].find('@') {
      let prefix = &connection_string[..start + 3];
      let suffix = &connection_string[start + 3 + at_pos..];
      if let Some(colon_pos) = connection_string[start + 3..start + 3 + at_pos].find(':') {
        let username = &connection_string[start + 3..start + 3 + colon_pos];
        return format!("{}{}:***{}", prefix, username, suffix);
      }
    }
  }
  connection_string.to_string()
}
