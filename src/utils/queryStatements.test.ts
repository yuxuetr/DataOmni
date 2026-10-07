import { describe, expect, it } from 'vitest';
import type { QueryResult, SqlStatement } from '../contracts/query';
import type { QueryExecutionStatus } from '../contracts/queryExecution';
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

  // R7-mac：敲完立刻 ⌘↵，语句在防抖解析之前就跑完、失败了；半秒后的解析把红字抹掉，
  // 结果区只剩一行 SQL。SQL 没变，报错就还是这一条的
  it('keeps the error of a statement whose SQL did not change', () => {
    const failed = failSqlStatement({ id: 'statement-1', sql: 'SELECT 1;', isExecuting: false }, 'connection lost');
    const [statement] = reconcileSqlStatements('SELECT 1;', [failed], () => 'new-id');

    expect(statement.error).toBe('connection lost');
  });

  it('drops the error once the SQL is edited', () => {
    const failed = failSqlStatement({ id: 'statement-1', sql: 'SELCT 1;', isExecuting: false }, 'syntax error');
    const [statement] = reconcileSqlStatements('SELECT 1;', [failed], () => 'new-id');

    expect(statement.error).toBeUndefined();
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
  const ran = (status: QueryExecutionStatus, sqlSnapshot = 'SELECT 1;') => ({ status, sqlSnapshot });

  it('停下的那次不算成功，哪怕卡片上还留着上一次的结果', () => {
    // 打包版上看到的：同一条语句再跑一遍、中途停下，卡片照样打绿勾、摊着上一次的行数，
    // 看上去就是这一次跑完了
    expect(statementOutcome(executedStatement, ran('cancelled'))).toBe('cancelled');
    expect(statementOutcome({ ...executedStatement, result: undefined }, ran('cancelled'))).toBe('cancelled');
  });

  it('停下的是改写之前的那段 SQL，改写之后的这段没跑过', () => {
    // 打包版上看到的：停掉 pg_sleep 之后把编辑器里的语句整个换掉，新语句的卡片上还写着「已停止」
    const rewritten = { id: 's', sql: 'SELECT 2;', isExecuting: false };
    expect(statementOutcome(rewritten, ran('cancelled', 'SELECT pg_sleep(25);'))).toBe('idle');
    expect(statementOutcome({ ...executedStatement, sql: 'SELECT 2;' }, ran('cancelled'))).toBe('succeeded');
  });

  it('其余照卡片上的状态', () => {
    expect(statementOutcome(executedStatement, ran('succeeded'))).toBe('succeeded');
    expect(statementOutcome(executedStatement, undefined)).toBe('succeeded');
    expect(statementOutcome({ ...executedStatement, isExecuting: true }, ran('running'))).toBe('running');
    expect(statementOutcome({ ...executedStatement, error: 'boom' }, ran('failed'))).toBe('failed');
    expect(statementOutcome({ id: 's', sql: 'SELECT 1;', isExecuting: false }, undefined)).toBe('idle');
  });
});
