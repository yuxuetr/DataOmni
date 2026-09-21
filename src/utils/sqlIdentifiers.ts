import type { SqlDialect } from '../contracts/queryExecution';

export type SqlIdentifierDialect = SqlDialect;

export const quoteSqlIdentifier = (
  identifier: string,
  dialect: SqlIdentifierDialect
): string => {
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
  if (dbType === 'mysql') {
    return 'mysql';
  }
  return dbType === 'postgresql' ? 'postgresql' : 'sqlite';
}
