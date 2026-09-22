/**
 * 端口能不能用，只有一条规则：1..65535。
 *
 * 曾经还有第二条——「大于 32767 不行，因为 Tauri SQL 插件用 16 位有符号整数」，
 * 它是错的。`tauri-plugin-sql` 不接收整数端口：它收一个 URL 字符串，原样转手给
 * `sqlx::Pool::connect`（`wrapper.rs`），而 sqlx 的端口是 `u16`。插件里唯一的
 * `i16` 在 `decode/postgres.rs`，那是 SMALLINT 的取值分支，与端口无关。
 *
 * 实测过：测试库挂在本机 43306（> 32767），`database_smoke.rs` 的 MySQL 用例
 * 17 条过了 16 条，唯一失败的那条断言的是库名，与端口无关。
 *
 * 这条假约束拦掉的正是 `docker run -p 43306:3306` 这种最常见的映射，而它给出的
 * 提示是「去架 SSH 转发或 socat」——为一个不存在的问题让人多搭一层。
 */
export const MIN_PORT = 1;
export const MAX_PORT = 65535;

export function isUsablePort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}
