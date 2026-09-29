import type { QueryExecutionError } from '../contracts/queryExecution';
import type { QueryResult, SqlStatement } from '../contracts/query';
import type { SqlDialect } from '../contracts/queryExecution';
import { splitSqlStatements } from './sqlStatements';

export function reconcileSqlStatements(
  sqlText: string,
  previousStatements: SqlStatement[],
  createId: (index: number) => string = (index) => `stmt_${crypto.randomUUID()}_${index}`,
  dialect?: SqlDialect
): SqlStatement[] {
  const sqlStatements = splitSqlStatements(sqlText, dialect).map(withTrailingSemicolon);
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
    executedAt: undefined,
    // 没有结果可收了；下一次执行的结果照常摊开
    collapsed: undefined
  };
}

/**
 * 语句在列表里的规范写法：以分号结尾。解析出的语句是这个写法，拿编辑器原文去找
 * 列表里的那一条之前也要先过一遍，否则永远对不上。
 */
export function withTrailingSemicolon(sql: string): string {
  return sql.endsWith(';') ? sql : `${sql};`;
}
