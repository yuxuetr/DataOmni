// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// 模块导入
mod commands;
// 集成测试要按 DatabaseType 取目录查询，枚举得公开；
// 用字符串代替会丢掉穷尽匹配，新增方言时编译器不再提醒。
pub mod models;
pub mod services;

use commands::{connection_commands::ConnectionServiceState, *};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // 记住窗口大小与位置；默认在退出时保存、启动时恢复
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_sql::Builder::new().build())
    .manage(ConnectionServiceState::default())
    .manage(QueryCancellationState::default())
    .manage(ImportPauseState::default())
    .manage(services::QuerySessionState::default())
    .manage(services::TunnelRegistry::default())
    .setup(|_app| {
      // 启动日志留着：窗口起不来时，这一行是唯一能说明进程到底跑没跑的证据
      println!("🎯 DataOmni 启动");
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      // 连接管理命令
      create_connection,
      update_connection,
      delete_connection,
      get_connections,
      test_connection,
      diagnose_connection,
      close_ssh_tunnel,
      // 数据库操作命令
      execute_query,
      execute_write_batch,
      export_query_to_file,
      cancel_export,
      preview_csv_file,
      import_csv_file,
      cancel_import,
      set_import_paused,
      cancel_query,
      release_database_session,
      get_session_transaction,
      explain_query,
      get_schema_metadata_queries,
      get_object_catalog_queries,
      get_er_diagram_queries,
      get_completion_catalog_query,
      get_session_target_query,
      // 文件写入
      write_text_file,
      write_binary_file,
      read_text_file,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
