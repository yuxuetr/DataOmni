import { topLevelKeywords } from './sqlStatements';

/**
 * 这条语句会不会改变库的结构。
 *
 * 用来决定执行完之后要不要重新拉一遍对象树与 ER 图。判据是**结构**变没变，
 * 不是数据变没变：INSERT 一万行也不会让图多一个框，而一条 CREATE TABLE 会。
 *
 * 复用 `topLevelKeywords`：它跳过字符串与注释，也不会把子查询里的词算进来。
 * 一条 `SELECT 'CREATE TABLE'` 不该触发刷新。
 */
const SCHEMA_KEYWORDS = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'RENAME',
  'TRUNCATE',
  'COMMENT',
  // ClickHouse 换表、找回删掉的表、挂上卸下；Oracle 从回收站找回或清掉
  'EXCHANGE',
  'UNDROP',
  'ATTACH',
  'DETACH',
  'FLASHBACK',
  'PURGE'
]);

/**
 * 不以这些词开头、照样改结构的两种常见写法：PostgreSQL 与 SQL Server 的 `SELECT … INTO 新表`
 * （MySQL 的 `INTO @变量` / `OUTFILE` 也会算进来，多刷新一次而已），SQL Server 改名的 `sp_rename`
 */
export function changesSchema(sql: string): boolean {
  const keywords = topLevelKeywords(sql);
  const first = keywords[0];
  if (first === undefined) {
    return false;
  }
  if (first === 'SELECT') {
    return keywords.includes('INTO');
  }
  if (first === 'EXEC' || first === 'EXECUTE') {
    return keywords.slice(1, 3).includes('SP_RENAME');
  }
  return SCHEMA_KEYWORDS.has(first);
}

/** 一批语句里只要有一条改结构，就该刷新。 */
export function anyChangesSchema(statements: readonly string[]): boolean {
  return statements.some(changesSchema);
}
