// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// 模块导入
#[cfg(target_os = "macos")]
mod app_menu;
pub mod cli;
mod commands;
// 集成测试要按 DatabaseType 取目录查询，枚举得公开；
// 用字符串代替会丢掉穷尽匹配，新增方言时编译器不再提醒。
pub mod models;
pub mod services;

use commands::{connection_commands::ConnectionServiceState, *};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // 崩溃原因进日志文件。打包版没有控制台，默认的钩子印在标准错误上，谁也看不到。
  // 默认钩子照样调用：开发时终端里还是那一段
  let default_hook = std::panic::take_hook();
  std::panic::set_hook(Box::new(move |info| {
    log::error!("panic: {info}");
    default_hook(info);
  }));

  let builder = tauri::Builder::default();
  #[cfg(target_os = "macos")]
  let builder = builder
    .menu(app_menu::build)
    .on_menu_event(|app, event| app_menu::handle_event(app, event.id().as_ref()));
  builder
    // 第一个装：后面的插件与 setup 里打的日志才进得了文件。
    // 一个文件上限 2 MB、写满轮转、只留最近两份：日志是给报缺陷时贴的，不是审计
    .plugin(
      tauri_plugin_log::Builder::new()
        .targets([
          tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
          tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
            file_name: Some(commands::app_commands::LOG_FILE_NAME.to_string()),
          }),
        ])
        .level(log::LevelFilter::Info)
        .max_file_size(2 * 1024 * 1024)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(2))
        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
        .build(),
    )
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
    .manage(services::redis::RedisRegistry::default())
    .manage(services::neo4j::Neo4jRegistry::default())
    .manage(services::elasticsearch::EsRegistry::default())
    .manage(services::duckdb::DuckDbRegistry::default())
    .manage(services::clickhouse::ClickHouseRegistry::default())
    .setup(|app| {
      // 启动日志留着：窗口起不来时，这一行是唯一能说明进程到底跑没跑的证据
      log::info!("DataOmni {} 启动", app.package_info().version);
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
      diagnostics,
      reveal_log_file,
      latest_release,
      open_release_page,
      export_connections,
      import_connections,
      test_connection,
      open_database_pool,
      sqlx_select,
      close_sqlx_pool,
      diagnose_connection,
      database_file_type,
      close_ssh_tunnel,
      sql_server_select,
      close_sql_server,
      oracle_select,
      close_oracle,
      duckdb_select,
      close_duckdb,
      clickhouse_select,
      close_clickhouse,
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
      mongodb_plan_command,
      mongodb_run_command,
      mongodb_aggregate,
      mongodb_create_collection,
      mongodb_explain,
      redis_list_keyspaces,
      redis_scan,
      redis_read_value,
      redis_execute,
      redis_change_key,
      redis_change_element,
      redis_create_key,
      close_redis,
      neo4j_list_objects,
      neo4j_run,
      neo4j_query_type,
      close_neo4j,
      elasticsearch_list_objects,
      elasticsearch_run,
      close_elasticsearch,
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
      backup_database,
      // AI 设计（没编进 `ai` feature 时命令照样在，一律回答「这个构建没有 AI」）
      ai_available,
      ai_complete,
      ai_save_key,
      ai_has_key,
      // 文件写入
      write_text_file,
      write_binary_file,
      read_text_file,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
