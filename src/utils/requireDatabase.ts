import type { DatabaseHandle } from './databaseHandle';
import { translateNow } from '../stores/languageStore';

/**
 * 取出数据库句柄，没有就抛一条**看得懂**的错误。
 *
 * 不要写 `database!.select(...)`：句柄为 null 时那里抛的是
 * `Cannot read properties of null (reading 'select')`——用户只看到一句
 * 「null 类型错误」，既不知道发生了什么也不知道该做什么。
 *
 * 句柄为 null 是正常状态，不是异常：ER 图这类标签页会从工作区快照里恢复，
 * 在任何连接建立之前就挂载。
 */
export function requireDatabase(database: DatabaseHandle | null): DatabaseHandle {
  if (!database) {
    throw new Error(translateNow('error.notConnected'));
  }
  return database;
}
