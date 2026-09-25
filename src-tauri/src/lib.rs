// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// 模块导入
#[cfg(target_os = "macos")]
mod app_menu;
mod commands;
// 集成测试要按 DatabaseType 取目录查询，枚举得公开；
// 用字符串代替会丢掉穷尽匹配，新增方言时编译器不再提醒。
pub mod models;
pub mod services;

use commands::{connection_commands::ConnectionServiceState, *};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default();
  #[cfg(target_os = "macos")]
  let builder = builder
    .menu(app_menu::build)
    .on_menu_event(|app, event| app_menu::handle_event(app, event.id().as_ref()));
  builder
    // 记住窗口大小与位置；默认在退出时保存、启动时恢复
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_sql::Builder::new().build())
    .manage(ConnectionServiceState::default())
    .manage(QueryCancellationState::default())
    .manage(ImportPauseState::default())
    .manage(services::QuerySessionState::default())
    .manage(services::TunnelRegistry::default())
    .manage(services::SqlServerRegistry::default())
    .manage(services::oracle::OracleRegistry::default())
    .manage(services::mongodb::MongoRegistry::default())
    .setup(|app| {
      // 启动日志留着：窗口起不来时，这一行是唯一能说明进程到底跑没跑的证据
      println!("🎯 DataOmni 启动");
      // 安装包把 Instant Client 放在资源目录的 `instantclient` 下（见
      // `scripts/fetch-oracle-client.sh`）；只记下位置，第一次连 Oracle 时才加载
      use tauri::Manager;
      if let Ok(resources) = app.path().resource_dir() {
        services::oracle::set_client_dir(resources.join("instantclient"));
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      // 连接管理命令
      create_connection,
      update_connection,
      delete_connection,
      get_connections,
      test_connection,
      open_database_pool,
      sqlx_select,
      close_sqlx_pool,
      diagnose_connection,
      close_ssh_tunnel,
      sql_server_select,
      close_sql_server,
      oracle_select,
      close_oracle,
      mongodb_list_collections,
      mongodb_find,
      mongodb_count,
      mongodb_document,
      mongodb_replace_document,
      mongodb_insert_document,
      mongodb_delete_document,
      mongodb_collection_structure,
      mongodb_export_to_file,
      mongodb_import_file,
      mongodb_create_index,
      mongodb_drop_index,
      mongodb_update_many,
      mongodb_delete_many,
      mongodb_aggregate,
      mongodb_create_collection,
      mongodb_explain,
      mongodb_drop_collection,
      close_mongodb,
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
