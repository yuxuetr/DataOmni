import { describe, expect, it } from 'vitest';
import { batchReversibility, statementReversibility } from './statementReversibility';

describe('statementReversibility', () => {
  it('自动提交下执行就是落库，但事务这条路还在', () => {
    expect(
      statementReversibility(['DELETE FROM orders'], 'postgresql', true, 'idle')
    ).toEqual({ kind: 'autocommit' });
  });

  it('关掉自动提交之后同一条语句可以回滚', () => {
    expect(
      statementReversibility(['DELETE FROM orders'], 'postgresql', false, 'idle')
    ).toEqual({ kind: 'transactional' });
  });

  it('已经开着事务时，自动提交的开关不再决定什么', () => {
    expect(
      statementReversibility(['DELETE FROM orders'], 'postgresql', true, 'active')
    ).toEqual({ kind: 'transactional' });
  });

  it('废止的事务里语句根本跑不起来，也就谈不上落库', () => {
    expect(
      statementReversibility(['DELETE FROM orders'], 'postgresql', true, 'failed')
    ).toEqual({ kind: 'transactional' });
  });

  // 这条是整个模块存在的理由：同一条 SQL，两个方言两个答案
  it('PostgreSQL 的 DROP TABLE 能回滚，MySQL 的不能', () => {
    expect(
      statementReversibility(['DROP TABLE orders'], 'postgresql', false, 'idle')
    ).toEqual({ kind: 'transactional' });
    expect(
      statementReversibility(['DROP TABLE orders'], 'mysql', false, 'idle')
    ).toEqual({ kind: 'not-transactional', keyword: 'DROP' });
  });

  it('MySQL 的 DDL 在开着的事务里也一样撤不回来——它会把事务一起提交掉', () => {
    expect(
      statementReversibility(['TRUNCATE TABLE orders'], 'mysql', false, 'active')
    ).toEqual({ kind: 'not-transactional', keyword: 'TRUNCATE' });
  });

  it('SQLite 的 DDL 是事务性的', () => {
    expect(
      statementReversibility(['DROP TABLE orders'], 'sqlite', false, 'idle')
    ).toEqual({ kind: 'transactional' });
  });

  it('PostgreSQL 里不许进事务的那几条要认出来', () => {
    expect(
      statementReversibility(['VACUUM FULL orders'], 'postgresql', false, 'idle')
    ).toEqual({ kind: 'not-transactional', keyword: 'VACUUM' });
    expect(
      statementReversibility(['CREATE DATABASE analytics'], 'postgresql', false, 'idle')
    ).toEqual({ kind: 'not-transactional', keyword: 'CREATE DATABASE' });
    expect(
      statementReversibility(
        ['CREATE INDEX CONCURRENTLY idx_orders ON orders (id)'],
        'postgresql',
        false,
        'idle'
      )
    ).toEqual({ kind: 'not-transactional', keyword: 'CREATE INDEX CONCURRENTLY' });
  });

  // 前缀匹配而不是包含匹配：语句里出现 DATABASE 这个词不代表它是 CREATE DATABASE
  it('句子中间出现的 DATABASE 不该把普通建表判成不可回滚', () => {
    expect(
      statementReversibility(
        ['CREATE TABLE snapshot AS SELECT database FROM pg_stat_activity'],
        'postgresql',
        false,
        'idle'
      )
    ).toEqual({ kind: 'transactional' });
  });

  it('普通的 CREATE INDEX 在 PostgreSQL 上是能回滚的', () => {
    expect(
      statementReversibility(
        ['CREATE INDEX idx_orders ON orders (id)'],
        'postgresql',
        false,
        'idle'
      )
    ).toEqual({ kind: 'transactional' });
  });

  // 弹窗只展示风险最高的那条，而拖累整批的可能是另一条
  it('一批里任何一条包不住，整批就包不住', () => {
    expect(
      statementReversibility(
        ['DELETE FROM orders', 'ALTER TABLE orders DROP COLUMN note'],
        'mysql',
        false,
        'idle'
      )
    ).toEqual({ kind: 'not-transactional', keyword: 'ALTER' });
  });

});

describe('batchReversibility', () => {
  // 表结构编辑器那条路：事务是它自己开的，跑完就提交，用户手里没有回滚按钮
  it('整批自带事务但立刻提交，所以不是「可以回滚」', () => {
    expect(
      batchReversibility(['ALTER TABLE orders DROP COLUMN note'], 'postgresql')
    ).toEqual({ kind: 'atomic-batch' });
  });

  it('MySQL 上连「整体」都算不上：第一条 ALTER 就把自己提交了', () => {
    expect(
      batchReversibility(
        ['ALTER TABLE orders DROP COLUMN note', 'ALTER TABLE orders RENAME TO archive'],
        'mysql'
      )
    ).toEqual({ kind: 'not-transactional', keyword: 'ALTER' });
  });
});
