/**
 * 对话框与确认框里给人看的 mongosh 命令。只是文字，真正发出去的是后端的命令文档；
 * 写成 mongosh 能直接粘去跑的样子，人才核得出「要做的就是这个」。
 */

/** mongosh 的单引号字符串：反斜杠与单引号转义 */
export function shellString(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** `db.getSiblingDB(库)`：命令不依赖 mongosh 当前 `use` 的是哪个库 */
function database(name: string): string {
  return `db.getSiblingDB(${shellString(name)})`;
}

export function createCollectionCommand(databaseName: string, collection: string, options: string): string {
  const trimmed = options.trim();
  return `${database(databaseName)}.createCollection(${shellString(collection)}${trimmed ? `, ${trimmed}` : ''})`;
}

export function dropCollectionCommand(databaseName: string, collection: string): string {
  return `${database(databaseName)}.getCollection(${shellString(collection)}).drop()`;
}
