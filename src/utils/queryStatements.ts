import type { QueryExecutionError } from '../contracts/queryExecution';
import type { QueryResult, SqlStatement } from '../contracts/query';
import { splitSqlStatements } from './sqlStatements';

export function reconcileSqlStatements(
  sqlText: string,
  previousStatements: SqlStatement[],
  createId: (index: number) => string = (index) => `stmt_${crypto.randomUUID()}_${index}`
): SqlStatement[] {
  const sqlStatements = splitSqlStatements(sqlText).map(withTrailingSemicolon);
  const assignments = new Map<number, SqlStatement>();
  const usedPreviousIndexes = new Set<number>();

  for (const [newIndex, sql] of sqlStatements.entries()) {
    const matchingIndex = previousStatements.findIndex(
      (statement, previousIndex) =>
        !usedPreviousIndexes.has(previousIndex) && statement.sql === sql
    );

    if (matchingIndex !== -1) {
      assignments.set(newIndex, previousStatements[matchingIndex]);
      usedPreviousIndexes.add(matchingIndex);
    }
  }

  if (sqlStatements.length === previousStatements.length) {
    for (const newIndex of sqlStatements.keys()) {
      if (!assignments.has(newIndex) && !usedPreviousIndexes.has(newIndex)) {
        assignments.set(newIndex, previousStatements[newIndex]);
        usedPreviousIndexes.add(newIndex);
      }
    }
  }

  return sqlStatements.map((sql, index) => {
    const previous = assignments.get(index);
    if (!previous) {
      return {
        id: createId(index),
        sql,
        isExecuting: false
      };
    }

    return {
      ...previous,
      sql,
      error: undefined,
      resultSql: previous.result
        ? previous.resultSql ?? previous.sql
        : undefined
    };
  });
}

export function completeSqlStatement(
  statement: SqlStatement,
  result: QueryResult,
  executedAt: string,
  sqlSnapshot: string = statement.sql
): SqlStatement {
  return {
    ...statement,
    isExecuting: false,
    result,
    resultSql: sqlSnapshot,
    executedAt,
    error: undefined
  };
}

export function failSqlStatement(
  statement: SqlStatement,
  error: string,
  errorDetails?: QueryExecutionError
): SqlStatement {
  return {
    ...statement,
    isExecuting: false,
    error,
    errorDetails
  };
}

export function clearSqlStatementResult(statement: SqlStatement): SqlStatement {
  return {
    ...statement,
    result: undefined,
    resultSql: undefined,
    error: undefined,
    executedAt: undefined
  };
}

function withTrailingSemicolon(sql: string): string {
  return sql.endsWith(';') ? sql : `${sql};`;
}
