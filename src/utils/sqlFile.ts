/**
 * `.sql` 脚本的存取。
 *
 * 存和开都经过 Tauri 命令而不是 `tauri-plugin-fs`：这里真正需要的只有
 * 「写一个用户刚选定的路径」和「读一个用户刚选中的文件」，用插件就得把
 * 读写 scope 开到整个主目录。
 */

export const SQL_FILE_FILTER = { name: 'SQL', extensions: ['sql'] };

/**
 * 去掉 UTF-8 BOM。
 *
 * 带 BOM 的 `.sql` 在别的工具里很常见（Windows 上的编辑器默认就加）。那个
 * 字符在编辑器里**不可见**，却会跟在第一条语句前面一起发给数据库，于是
 * 得到一条指着第 1 行第 1 列的语法错误，而那一行看上去完全正常。
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// 控制字符是故意列进来的：标签名可能带换行，而带换行的文件名在多数系统上
// 会被拒绝，报的还是一句看不出原因的错
// eslint-disable-next-line no-control-regex
const ILLEGAL_IN_FILE_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * 由标签名猜一个文件名。
 *
 * 标签名是拿来显示的，可以带斜杠、冒号和换行（表标签会是 `public.orders`，
 * 用户也可能自己改）。原样塞进保存对话框，轻则被系统拒绝，重则在某些平台上
 * 被当成路径分隔符落到别的目录里。
 */
export function suggestSqlFileName(title: string): string {
  const cleaned = title.replace(ILLEGAL_IN_FILE_NAME, ' ').trim().replace(/\s+/g, ' ');
  const base = cleaned === '' || cleaned === '.' || cleaned === '..' ? 'query' : cleaned;
  return base.toLowerCase().endsWith('.sql') ? base : `${base}.sql`;
}

/** 由文件路径猜一个标签名：取文件名、去掉 `.sql` 后缀 */
export function tabTitleFromSqlPath(path: string): string {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  return fileName.replace(/\.sql$/i, '') || fileName;
}
