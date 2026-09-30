import { save } from '@tauri-apps/plugin-dialog';
import { DatabaseType, type ConnectionProfile } from '../contracts';
import { translateNow } from '../stores/languageStore';
import { useTaskStore } from '../stores/taskStore';
import { isFileDatabase } from './databaseFiles';
import { serverPresetOf } from './serverPresets';

/**
 * 「备份这个连接」的入口（连接信息、命令面板）给不给。MongoDB 不在这里：它按库备份，
 * 入口在对象树的库上（见 `startDatabaseBackup` 的 `database`）。
 *
 * 能不能在这里备份：嵌入式库用库里自带的办法；PostgreSQL / MySQL 用本机的 pg_dump / mysqldump
 * （找不到时任务里说装什么）。CockroachDB、TiDB 走兼容的连接类型，但那两个工具对它们不管用，
 * 各有自己的办法（`BACKUP`、Dumpling）；mysqldump 一次备份一个库，连接上没填库名就不给入口
 */
export function backupSupported(connection: Pick<ConnectionProfile, 'db_type' | 'options' | 'database'>): boolean {
  if (isFileDatabase(connection.db_type)) {
    return true;
  }
  if (connection.db_type === DatabaseType.PostgreSQL) {
    return serverPresetOf(connection) !== 'cockroachdb';
  }
  return connection.db_type === DatabaseType.MySQL
    && serverPresetOf(connection) !== 'tidb'
    && !!connection.database?.trim();
}

/**
 * 备份的默认名字：原文件名加上本地时间戳。SQLite 保留原来的扩展名（打开对话框按扩展名认库）；
 * DuckDB 的备份是个目录，不带扩展名——带 `.duckdb` 会让人以为它能直接打开
 */
export function backupName(databasePath: string, dbType: DatabaseType, now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // 网络库的 database 是库名不是路径，库名里的点也不是扩展名；pg_dump 的 custom 格式惯用 .dump
  if (dbType === DatabaseType.PostgreSQL) {
    return `${databasePath}-backup-${stamp}.dump`;
  }
  if (dbType === DatabaseType.MySQL) {
    return `${databasePath}-backup-${stamp}.sql`;
  }
  // mongorestore 要 --gzip 才认，扩展名把两件事都说了
  if (dbType === DatabaseType.MongoDB) {
    return `${databasePath}-backup-${stamp}.archive.gz`;
  }
  const fileName = databasePath.split(/[\\/]/).pop() || 'database';
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : '.db';
  return dbType === DatabaseType.DuckDB ? `${base}-backup-${stamp}` : `${base}-backup-${stamp}${extension}`;
}

/** 任务标题里的名字。MongoDB 一个连接下有多个库，同一连接备份两个库时只写连接名就分不出来 */
export function backupTaskName(connection: Pick<ConnectionProfile, 'name' | 'db_type'>, database?: string): string {
  return connection.db_type === DatabaseType.MongoDB && database ? `${connection.name} / ${database}` : connection.name;
}

/**
 * 选好位置就交给后台任务：大库的 VACUUM INTO 要跑一阵，任务面板里看得到进度与结果。
 * `database` 只给 MongoDB：备份哪个库（它连接上的「数据库」那格是认证库）
 */
export async function startDatabaseBackup(connection: ConnectionProfile, database?: string): Promise<void> {
  const mongo = connection.db_type === DatabaseType.MongoDB;
  if (mongo ? !database : !backupSupported(connection)) {
    return;
  }
  const source = (mongo ? database : connection.database) || connection.name;
  const path = await save({ defaultPath: backupName(source, connection.db_type) });
  // 取消保存对话框不是错误
  if (!path) {
    return;
  }
  useTaskStore.getState().start({
    kind: 'backup',
    title: translateNow('backup.taskTitle', { name: backupTaskName(connection, database) }),
    payload: { connectionId: connection.id, path, ...(mongo ? { database } : {}) }
  });
}
