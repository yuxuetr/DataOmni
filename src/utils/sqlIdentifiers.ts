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
