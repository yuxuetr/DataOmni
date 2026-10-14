// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // `dataomni cli …` 是给 Agent 与终端用的命令行，不起窗口。和应用共用一个二进制，
  // 钥匙串才认得它（见 `cli` 模块）
  let args: Vec<String> = std::env::args().collect();
  if args.get(1).map(String::as_str) == Some("cli") {
    #[cfg(windows)]
    attach_parent_console();
    std::process::exit(dataomni_lib::cli::run(&args[2..]));
  }
  dataomni_lib::run()
}

/// 发布版是 GUI 子系统，从终端直接敲时没有标准输出。借用父进程（终端）的控制台；
/// 已经被重定向到管道或文件的句柄（Agent 就是这样调的）原样留着
#[cfg(windows)]
fn attach_parent_console() {
  use windows_sys::Win32::System::Console::{
    AttachConsole, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE, STD_HANDLE,
    STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
  };
  const STREAMS: [STD_HANDLE; 3] = [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE];
  // SAFETY: 只读写本进程的标准句柄表，传入的都是系统定义的常量
  unsafe {
    let before = STREAMS.map(|stream| GetStdHandle(stream));
    if before[1..].iter().all(|handle| !handle.is_null()) {
      return;
    }
    if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
      return;
    }
    for (stream, handle) in STREAMS.into_iter().zip(before) {
      if !handle.is_null() {
        SetStdHandle(stream, handle);
      }
    }
  }
}
