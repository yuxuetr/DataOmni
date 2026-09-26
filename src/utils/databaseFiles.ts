import { DatabaseType } from '../contracts/connection';

/**
 * 「库就是一个文件」的两种：SQLite 与 DuckDB。选文件时按类型过滤，打开一个文件时
 * 按扩展名认它是哪一种。
 *
 * 只看扩展名，不读文件头：`.db` 两家都有人用，这里归 SQLite（历史上这一格只有它）。
 * 认错了也不会写坏什么——驱动打开时报「不是这种库」，诊断那一步会指出文件头不对。
 */
const EXTENSIONS: Readonly<Record<DatabaseType.SQLite | DatabaseType.DuckDB, readonly string[]>> = {
  [DatabaseType.SQLite]: ['db', 'sqlite', 'sqlite3', 'db3'],
  [DatabaseType.DuckDB]: ['duckdb', 'ddb']
};

export type FileDatabaseType = keyof typeof EXTENSIONS;

export function isFileDatabase(type: DatabaseType | undefined): type is FileDatabaseType {
  return type === DatabaseType.SQLite || type === DatabaseType.DuckDB;
}

export function databaseFileExtensions(type: FileDatabaseType): readonly string[] {
  return EXTENSIONS[type];
}

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** 打开一个文件时它该是哪种连接 */
export function databaseTypeOfFile(path: string): FileDatabaseType {
  return EXTENSIONS[DatabaseType.DuckDB].includes(extensionOf(path)) ? DatabaseType.DuckDB : DatabaseType.SQLite;
}

/** 连接的默认名字：文件名去掉认得的扩展名 */
export function connectionNameFromFile(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const extension = extensionOf(name);
  const known = Object.values(EXTENSIONS).some((extensions) => extensions.includes(extension));
  return (known ? name.slice(0, name.length - extension.length - 1) : name) || name;
}
