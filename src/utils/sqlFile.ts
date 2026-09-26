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

/** 标签记下的来源文件：路径，以及上次读进来或写出去时那份内容的指纹 */
export interface SqlFileLink {
  path: string;
  contentHash: string;
}

/**
 * 文本的指纹（cyrb53）。只用来判断「和上次一样吗」，不是安全用途；
 * 存指纹而不存原文，是因为标签快照和历史共用 localStorage 的 5MB 配额
 */
function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function linkSqlFile(path: string, text: string): SqlFileLink {
  return { path, contentHash: fingerprint(text) };
}

/** 编辑器里的内容就是文件里的内容：标签上不画「未保存」，关的时候也不用问 */
export function savedToFile(link: SqlFileLink | undefined, text: string): boolean {
  return link !== undefined && fingerprint(text) === link.contentHash;
}

/**
 * ⌘S 该做什么。`diskText` 是文件现在的内容，读不到（删了、不再是 UTF-8）时为 `null`。
 *
 * 磁盘上的不是上次读写的那份，说明别的程序动过它——照写会把别人的改动悄悄盖掉，
 * 所以先问
 */
export function planSqlSave(
  link: SqlFileLink | undefined,
  diskText: string | null
): 'choose-path' | 'write' | 'confirm-overwrite' {
  if (!link) {
    return 'choose-path';
  }
  return diskText !== null && fingerprint(stripBom(diskText)) === link.contentHash ? 'write' : 'confirm-overwrite';
}
