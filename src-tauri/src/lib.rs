// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::env;
use tauri_plugin_cli::CliExt;

// 模块导入
mod commands;
mod models;
pub mod services;

use commands::{connection_commands::ConnectionServiceState, *};

#[tauri::command]
fn greet(name: &str) -> String {
  format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_sql::Builder::new().build())
    .plugin(tauri_plugin_cli::init())
    .manage(ConnectionServiceState::default())
    .manage(QueryCancellationState::default())
    .manage(services::QuerySessionState::default())
    .setup(|app| {
      println!("🎯 DataOmni应用启动成功");

      // 检查是否在开发环境或GUI模式
      let is_dev_mode = cfg!(debug_assertions) && env::var("TAURI_ENV_PLATFORM").is_ok();
      let args: Vec<String> = env::args().collect();

      // 如果不是开发模式，且有命令行参数，则处理CLI
      if !is_dev_mode && args.len() > 1 {
        println!("📋 CLI模式启动");

        match app.cli().matches() {
          Ok(matches) => {
            let mut handled = false;

            // 处理verbose参数
            if let Some(verbose_arg) = matches.args.get("verbose") {
              let level = verbose_arg.occurrences;
              match level {
                1 => println!("📝 启用基础日志模式"),
                2 => println!("📝 启用详细日志模式"),
                3.. => println!("📝 启用调试日志模式"),
                _ => {}
              }
              handled = true;
            }

            // 处理子命令
            if let Some(subcommand) = &matches.subcommand {
              match subcommand.name.as_str() {
                "run" => {
                  println!("🚀 执行run子命令");
                  if subcommand.matches.args.contains_key("debug") {
                    println!("🐛 调试模式已启用");
                  }
                  if subcommand.matches.args.contains_key("release") {
                    println!("🎯 发布模式已启用");
                  }
                }
                _ => println!("❓ 未知子命令: {}", subcommand.name),
              }
              handled = true;
            }

            if handled {
              println!("✅ CLI任务完成");
              std::process::exit(0);
            }
          }
          Err(e) => {
            eprintln!("❌ CLI参数解析失败: {}", e);
            std::process::exit(1);
          }
        }
      }

      // 如果到达这里，说明应该启动GUI模式
      println!("🖥️  启动GUI模式");
      println!("🔧 数据库连接功能已就绪");
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      greet,
      // 连接管理命令
      create_connection,
      update_connection,
      delete_connection,
      get_connections,
      test_connection,
      // 数据库操作命令
      get_databases_query,
      get_tables_query,
      get_table_columns_query,
      get_table_data_query,
      get_table_list_query,
      get_database_metadata_query,
      get_table_quick_view_query,
      execute_query,
      cancel_query,
      release_database_session,
      validate_query,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_greet_function() {
    let result = greet("世界");
    assert!(result.contains("世界"));
    assert!(result.contains("Hello"));
  }
}
