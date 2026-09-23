import type { SqlDialect } from '../contracts/queryExecution';
import type { TransactionContext } from '../contracts/session';
import { topLevelKeywords } from './sqlStatements';

/**
 * 这一批语句执行完之后，还能不能反悔。
 *
 * - `transactional`：语句会进一个**由用户握着**的事务，回滚就当没发生过。
 * - `autocommit`：现在是自动提交，执行即落库；但改成在事务里跑就能回滚。
 * - `atomic-batch`：整批自带一个事务，但执行完立刻提交——中途出错什么都不改，
 *   提交之后同样撤不回来。表结构编辑器走的 `execute_write_batch` 就是这样。
 * - `not-transactional`：这个方言下事务包不住它，怎么跑都撤不回来。
 *   `keyword` 是肇事的那个动词，用来把原因说清楚。
 */
export type ExecutionReversibility =
  | { kind: 'transactional' }
  | { kind: 'autocommit' }
  | { kind: 'atomic-batch' }
  | { kind: 'not-transactional'; keyword: string };

/** 要按顺序匹配语句开头的若干个关键字 */
type KeywordPrefix = readonly string[];

/**
 * 事务包不住的语句，按**关键字前缀**匹配（`topLevelKeywords` 的开头若干项）。
 *
 * 两种情形都在这里，因为对「我还能不能反悔」这个问题它们的答案一样：
 * - **隐式提交**：MySQL 的 DDL。更坏的是它会顺带把你事务里已有的改动一起提交。
 * - **根本不许进事务**：PostgreSQL 的 `VACUUM`、SQLite 的 `ATTACH`，直接报错。
 *
 * 前缀而不是「包含」：`CREATE TABLE x AS SELECT … FROM database` 里也有
 * DATABASE 这个词，按包含匹配会把一条普通的建表当成 `CREATE DATABASE`。
 *
 * MySQL 的 `CREATE TEMPORARY TABLE` 其实不触发隐式提交，这里没有排除它——
 * 往「撤不回来」的方向猜错，代价是用户多开一个用不上的事务；往另一个方向
 * 猜错，代价是他以为能回滚。
 */
const NON_TRANSACTIONAL: Record<SqlDialect, readonly KeywordPrefix[]> = {
  // MySQL 的 DDL 与权限语句全部隐式提交
  mysql: [
    ['CREATE'],
    ['ALTER'],
    ['DROP'],
    ['RENAME'],
    ['TRUNCATE'],
    ['GRANT'],
    ['REVOKE'],
    ['ANALYZE'],
    ['OPTIMIZE'],
    ['REPAIR'],
    ['FLUSH'],
    ['LOCK'],
    ['UNLOCK']
  ],
  // PostgreSQL 的 DDL 是事务性的——`DROP TABLE` 能回滚。只有这几条不行
  postgresql: [
    ['VACUUM'],
    ['CREATE', 'DATABASE'],
    ['DROP', 'DATABASE'],
    ['CREATE', 'TABLESPACE'],
    ['DROP', 'TABLESPACE'],
    ['CREATE', 'INDEX', 'CONCURRENTLY'],
    ['DROP', 'INDEX', 'CONCURRENTLY'],
    ['ALTER', 'SYSTEM']
  ],
  // SQLite 的 DDL 也是事务性的
  sqlite: [['VACUUM'], ['ATTACH'], ['DETACH']],
  // SQL Server 的 DDL 同样能回滚；库级与备份类的语句不许进用户事务，
  // 全文目录的增删也不行
  // Oracle 和 MySQL 一样：每条 DDL 前后各隐式提交一次，事务包不住
  oracle: [
    ['CREATE'],
    ['ALTER'],
    ['DROP'],
    ['TRUNCATE'],
    ['RENAME'],
    ['GRANT'],
    ['REVOKE'],
    ['COMMENT'],
    ['ANALYZE'],
    ['PURGE'],
    ['FLASHBACK']
  ],
  sqlserver: [
    ['CREATE', 'DATABASE'],
    ['ALTER', 'DATABASE'],
    ['DROP', 'DATABASE'],
    ['BACKUP'],
    ['RESTORE'],
    ['RECONFIGURE'],
    ['CREATE', 'FULLTEXT', 'CATALOG'],
    ['ALTER', 'FULLTEXT', 'CATALOG'],
    ['DROP', 'FULLTEXT', 'CATALOG']
  ]
};

/** 这一批里第一条事务包不住的语句，返回它的关键字；都能包住就是 `null` */
function blockingKeyword(
  statements: readonly string[],
  dialect: SqlDialect
): string | null {
  for (const sql of statements) {
    const keywords = topLevelKeywords(sql);
    for (const prefix of NON_TRANSACTIONAL[dialect]) {
      if (prefix.every((word, position) => keywords[position] === word)) {
        return prefix.join(' ');
      }
    }
  }
  return null;
}

/**
 * 弹出确认框的那一刻，「执行完还能不能反悔」由三件事决定：
 * 方言、当前是不是自动提交、有没有已经开着的事务。
 *
 * 方言先判：事务里撞上一条 MySQL 的 DDL，不只是这条撤不回来，之前攒在
 * 事务里的改动会被它一起提交掉——那种时候说「可以回滚」是最坏的一种错。
 *
 * `failed`（PostgreSQL 的废止事务）算在事务里：那条语句根本跑不起来，
 * 更谈不上落库。
 */
export function statementReversibility(
  statements: readonly string[],
  dialect: SqlDialect,
  autocommit: boolean,
  transactionStatus: TransactionContext['status']
): ExecutionReversibility {
  const keyword = blockingKeyword(statements, dialect);
  if (keyword !== null) {
    return { kind: 'not-transactional', keyword };
  }

  if (!autocommit || transactionStatus !== 'idle') {
    return { kind: 'transactional' };
  }
  return { kind: 'autocommit' };
}

/**
 * 表结构编辑器那条路：`execute_write_batch` 自带一个事务，跑完立刻提交。
 *
 * 所以它**永远**撤不回来，区别只在于是不是一个整体——MySQL 的 DDL 会隐式
 * 提交，一批两条 ALTER 里第二条失败时，第一条已经落库了。
 */
export function batchReversibility(
  statements: readonly string[],
  dialect: SqlDialect
): ExecutionReversibility {
  const keyword = blockingKeyword(statements, dialect);
  return keyword !== null ? { kind: 'not-transactional', keyword } : { kind: 'atomic-batch' };
}
