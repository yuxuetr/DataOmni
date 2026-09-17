export const splitSqlStatements = (sqlText: string): string[] =>
  sqlText
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean);

export const isSelectStatement = (sql: string): boolean =>
  sql.trimStart().toLowerCase().startsWith('select');
