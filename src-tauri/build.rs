fn main() {
  // Linux 上 Instant Client 的 libclntsh 按名字找它的依赖（libnnz.so 没有 SONAME，
  // 预先 dlopen 也配不上），走的是系统搜索路径。它的文件不能改（许可要求原样分发），
  // 所以在**我们的**可执行文件上写 DT_RPATH——不是 RUNPATH：RPATH 对间接加载的依赖
  // 也生效。deb 与 AppImage 都是 usr/bin 对 usr/lib/<产品名>，资源在后者下面。
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
    println!(
      "cargo:rustc-link-arg-bins=-Wl,--disable-new-dtags,-rpath,$ORIGIN/../lib/DataOmni/instantclient"
    );
  }
  tauri_build::build()
}
