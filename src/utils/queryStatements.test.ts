import { describe, expect, it } from 'vitest';
import type { QueryResult, SqlStatement } from '../contracts/query';
import {
  clearSqlStatementResult,
  completeSqlStatement,
  failSqlStatement,
  reconcileSqlStatements,
  statementOutcome
} from './queryStatements';

const result: QueryResult = {
  columns: ['value'],
  rows: [[1]],
  affected_rows: 1,
  execution_time: 5
};

const executedStatement: SqlStatement = {
  id: 'statement-1',
  sql: 'SELECT 1;',
  isExecuting: false,
  result,
  resultSql: 'SELECT 1;',
  executedAt: '10:00:00'
};

describe('query statement lifecycle', () => {
  it('preserves the last successful result when SQL is edited', () => {
    const [statement] = reconcileSqlStatements(
      'SELECT 2;',
      [executedStatement],
      () => 'new-id'
    );

    expect(statement).toMatchObject({
      id: 'statement-1',
      sql: 'SELECT 2;',
      result,
      resultSql: 'SELECT 1;',
      executedAt: '10:00:00'
    });
  });

  it('does not cancel an in-flight execution when its SQL is edited', () => {
    const [statement] = reconcileSqlStatements(
      'SELECT 2;',
      [{ ...executedStatement, isExecuting: true }],
      () => 'new-id'
    );

    expect(statement.isExecuting).toBe(true);
  });

  it('matches unchanged statements after a new statement is inserted', () => {
    const statements = reconcileSqlStatements(
      'SELECT 0; SELECT 1;',
      [executedStatement],
      (index) => `new-${index}`
    );

    expect(statements[0]).toMatchObject({
      id: 'new-0',
      sql: 'SELECT 0;'
    });
    expect(statements[0].result).toBeUndefined();
    expect(statements[1]).toMatchObject({
      id: 'statement-1',
      result,
      resultSql: 'SELECT 1;'
    });
  });

  it('records the SQL snapshot only after a successful execution', () => {
    const edited = { ...executedStatement, sql: 'SELECT 2;' };
    const completed = completeSqlStatement(
      edited,
      result,
      '10:01:00',
      'SELECT 1;'
    );

    expect(completed.sql).toBe('SELECT 2;');
    expect(completed.resultSql).toBe('SELECT 1;');
    expect(completed.executedAt).toBe('10:01:00');
  });

  it('retains the previous result when a new execution fails', () => {
    const failed = failSqlStatement(
      { ...executedStatement, sql: 'SELECT missing;' },
      'column does not exist'
    );

    expect(failed.result).toBe(result);
    expect(failed.resultSql).toBe('SELECT 1;');
    expect(failed.error).toBe('column does not exist');
  });

  it('keeps a collapsed result collapsed when the editor re-splits the text', () => {
    const [kept] = reconcileSqlStatements('SELECT 1;', [{ ...executedStatement, collapsed: true }]);
    expect(kept.collapsed).toBe(true);
    // 改了这条语句（结果成了上一次的）也还是它，照样收着
    const [edited] = reconcileSqlStatements('SELECT 2;', [{ ...executedStatement, collapsed: true }]);
    expect(edited.collapsed).toBe(true);
  });

  it('clearing a result also expands it, so the next run shows up', () => {
    expect(clearSqlStatementResult({ ...executedStatement, collapsed: true }).collapsed).toBeUndefined();
  });

  it('removes results only through the explicit clear action', () => {
    expect(clearSqlStatementResult(executedStatement)).toMatchObject({
      result: undefined,
      resultSql: undefined,
      executedAt: undefined
    });
  });
});

describe('statementOutcome', () => {
  it('停下的那次不算成功，哪怕卡片上还留着上一次的结果', () => {
    // 打包版上看到的：同一条语句再跑一遍、中途停下，卡片照样打绿勾、摊着上一次的行数，
    // 看上去就是这一次跑完了
    expect(statementOutcome(executedStatement, 'cancelled')).toBe('cancelled');
    expect(statementOutcome({ ...executedStatement, result: undefined }, 'cancelled')).toBe('cancelled');
  });

  it('其余照卡片上的状态', () => {
    expect(statementOutcome(executedStatement, 'succeeded')).toBe('succeeded');
    expect(statementOutcome(executedStatement, undefined)).toBe('succeeded');
    expect(statementOutcome({ ...executedStatement, isExecuting: true }, 'running')).toBe('running');
    expect(statementOutcome({ ...executedStatement, error: 'boom' }, 'failed')).toBe('failed');
    expect(statementOutcome({ id: 's', sql: 'SELECT 1;', isExecuting: false }, undefined)).toBe('idle');
  });
});
