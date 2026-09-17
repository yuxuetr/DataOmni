export type SqlIdentifierDialect = 'mysql' | 'postgresql' | 'sqlite';

export const quoteSqlIdentifier = (
  identifier: string,
  dialect: SqlIdentifierDialect
): string => {
  const quote = dialect === 'mysql' ? '`' : '"';
  return `${quote}${identifier.replaceAll(quote, quote + quote)}${quote}`;
};

export const quoteQualifiedSqlIdentifier = (
  identifiers: string[],
  dialect: SqlIdentifierDialect
): string => identifiers.map(identifier => quoteSqlIdentifier(identifier, dialect)).join('.');
