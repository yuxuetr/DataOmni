import { save } from '@tauri-apps/plugin-dialog';
import { DatabaseType, type ConnectionProfile } from '../contracts';
import { translateNow } from '../stores/languageStore';
import { useTaskStore } from '../stores/taskStore';
import { isFileDatabase } from './databaseFiles';
import { serverPresetOf } from './serverPresets';

/**
 * 能不能在这里备份：嵌入式库用库里自带的办法；PostgreSQL 用本机的 pg_dump（找不到时任务里说装什么）。
 * CockroachDB 走 PostgreSQL 连接类型，但 pg_dump 对它不管用——它有自己的 `BACKUP` 语句
 */
export function backupSupported(connection: Pick<ConnectionProfile, 'db_type' | 'options'>): boolean {
  if (isFileDatabase(connection.db_type)) {
    return true;
  }
  return connection.db_type === DatabaseType.PostgreSQL && serverPresetOf(connection) !== 'cockroachdb';
}

/**
 * 备份的默认名字：原文件名加上本地时间戳。SQLite 保留原来的扩展名（打开对话框按扩展名认库）；
 * DuckDB 的备份是个目录，不带扩展名——带 `.duckdb` 会让人以为它能直接打开
 */
export function backupName(databasePath: string, dbType: DatabaseType, now: Date = new Date()): string {
  const fileName = databasePath.split(/[\\/]/).pop() || 'database';
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : '.db';
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  if (dbType === DatabaseType.PostgreSQL) {
    // 网络库的 database 是库名不是路径；pg_dump 的 custom 格式惯用 .dump
    return `${base}-backup-${stamp}.dump`;
  }
  return dbType === DatabaseType.DuckDB ? `${base}-backup-${stamp}` : `${base}-backup-${stamp}${extension}`;
}

/** 选好位置就交给后台任务：大库的 VACUUM INTO 要跑一阵，任务面板里看得到进度与结果 */
export async function startDatabaseBackup(connection: ConnectionProfile): Promise<void> {
  if (!backupSupported(connection)) {
    return;
  }
  const source = connection.database || connection.name;
  const path = await save({ defaultPath: backupName(source, connection.db_type) });
  // 取消保存对话框不是错误
  if (!path) {
    return;
  }
  useTaskStore.getState().start({
    kind: 'backup',
    title: translateNow('backup.taskTitle', { name: connection.name }),
    payload: { connectionId: connection.id, path }
  });
}
