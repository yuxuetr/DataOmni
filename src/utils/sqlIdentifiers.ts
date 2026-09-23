import type { SqlDialect } from '../contracts/queryExecution';

export type SqlIdentifierDialect = SqlDialect;

export const quoteSqlIdentifier = (
  identifier: string,
  dialect: SqlIdentifierDialect
): string => {
  // SQL Server 的双引号只在 QUOTED_IDENTIFIER 打开时才是标识符（连接选项可以
  // 关掉它），方括号不受这个开关影响；右方括号成对转义
  if (dialect === 'sqlserver') {
    return `[${identifier.split(']').join(']]')}]`;
  }
  const quote = dialect === 'mysql' ? '`' : '"';
  return `${quote}${identifier.split(quote).join(quote + quote)}${quote}`;
};

export const quoteQualifiedSqlIdentifier = (
  identifiers: string[],
  dialect: SqlIdentifierDialect
): string => identifiers.map(identifier => quoteSqlIdentifier(identifier, dialect)).join('.');

/**
 * 连接类型 → 标识符引用方言。
 *
 * 已经是第三个调用点了。不认识的类型按 `sqlite` 走（双引号是 SQL 标准写法），
 * 而不是抛错——这条路径上真正重要的是「别让一个陌生类型把界面整个打掉」。
 */
export function identifierDialectFor(dbType: string): SqlIdentifierDialect {
  if (dbType === 'mysql' || dbType === 'sqlserver') {
    return dbType;
  }
  return dbType === 'postgresql' ? 'postgresql' : 'sqlite';
}
