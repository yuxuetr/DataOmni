// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // `dataomni cli …` 是给 Agent 与终端用的命令行，不起窗口。和应用共用一个二进制，
  // 钥匙串才认得它（见 `cli` 模块）
  let args: Vec<String> = std::env::args().collect();
  if args.get(1).map(String::as_str) == Some("cli") {
    std::process::exit(dataomni_lib::cli::run(&args[2..]));
  }
  dataomni_lib::run()
}
