import { describe, expect, it } from 'vitest';
import {
  classifyBatchRisk,
  classifyStatementRisk,
  highestRiskNeedingConfirmation,
  requiresConfirmation
} from './statementRisk';

describe('语句风险判定', () => {
  it('查询是只读', () => {
    expect(classifyStatementRisk('SELECT * FROM users')).toBe('read');
    expect(classifyStatementRisk('SHOW TABLES')).toBe('read');
    expect(classifyStatementRisk('EXPLAIN SELECT 1')).toBe('read');
  });

  it('空语句按只读处理', () => {
    expect(classifyStatementRisk('')).toBe('read');
    expect(classifyStatementRisk('   -- 只有注释\n')).toBe('read');
  });

  it('INSERT 是追加', () => {
    expect(classifyStatementRisk('INSERT INTO users (id) VALUES (1)')).toBe('append');
  });

  it('带 WHERE 的 UPDATE / DELETE 影响面有界', () => {
    expect(classifyStatementRisk('DELETE FROM users WHERE id = 1')).toBe('scoped-write');
    expect(classifyStatementRisk('UPDATE users SET a = 1 WHERE id = 1')).toBe('scoped-write');
  });

  it('不带 WHERE 的 UPDATE / DELETE 会扫掉整张表', () => {
    expect(classifyStatementRisk('DELETE FROM users')).toBe('bulk-write');
    expect(classifyStatementRisk('UPDATE users SET active = 0')).toBe('bulk-write');
  });

  it('MERGE 的影响面由数据决定，按整表操作算', () => {
    // WHEN NOT MATCHED BY SOURCE THEN DELETE 会删掉所有对不上的行
    expect(classifyStatementRisk(
      'MERGE INTO t USING s ON t.id = s.id WHEN NOT MATCHED BY SOURCE THEN DELETE;'
    )).toBe('bulk-write');
  });

  it('SELECT … INTO 是建表或写文件，不是读', () => {
    expect(classifyStatementRisk('SELECT * INTO backup_t FROM t')).toBe('scoped-write');
    // 子查询里的 INTO 不算
    expect(classifyStatementRisk("SELECT (SELECT 1) AS n FROM t WHERE note = 'into'")).toBe('read');
  });

  it('DROP 和 TRUNCATE 是破坏性的', () => {
    expect(classifyStatementRisk('DROP TABLE users')).toBe('destructive');
    expect(classifyStatementRisk('TRUNCATE TABLE users')).toBe('destructive');
    expect(classifyStatementRisk('DROP DATABASE app')).toBe('destructive');
  });

  it('ALTER 只在删列时算破坏性', () => {
    expect(classifyStatementRisk('ALTER TABLE users DROP COLUMN email')).toBe('destructive');
    expect(classifyStatementRisk('ALTER TABLE users ADD COLUMN email TEXT')).toBe('scoped-write');
  });

  it('字符串里的 DROP 不算数', () => {
    // 不跳过字符串的话，这条查询会被当成删表
    expect(classifyStatementRisk("SELECT 'DROP TABLE users' AS note")).toBe('read');
  });

  it('注释里的 WHERE 不算数', () => {
    expect(classifyStatementRisk('DELETE FROM users /* WHERE id = 1 */')).toBe('bulk-write');
    expect(classifyStatementRisk('DELETE FROM users -- WHERE id = 1')).toBe('bulk-write');
  });

  it('只有子查询里带 WHERE 时仍算整表操作', () => {
    // 子查询的 WHERE 限制不了外层影响的行数
    expect(classifyStatementRisk('DELETE FROM users_backup'))
      .toBe('bulk-write');
    expect(classifyStatementRisk(
      'UPDATE users SET tier = (SELECT tier FROM plans WHERE id = 1)'
    )).toBe('bulk-write');
  });

  it('外层带 WHERE、子查询也带时算有界', () => {
    expect(classifyStatementRisk(
      'DELETE FROM users WHERE id IN (SELECT id FROM banned WHERE active = 1)'
    )).toBe('scoped-write');
  });

  it('列名以 where 开头不会被误认成 WHERE 子句', () => {
    expect(classifyStatementRisk('DELETE FROM where_log')).toBe('bulk-write');
  });

  it('CTE 按后面那个动词定级', () => {
    expect(classifyStatementRisk('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('read');
    expect(classifyStatementRisk('WITH x AS (SELECT 1) DELETE FROM users')).toBe('bulk-write');
    expect(classifyStatementRisk('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x'))
      .toBe('append');
  });

  it('建表这类改状态但不抹数据的按有界写入处理', () => {
    expect(classifyStatementRisk('CREATE TABLE t (id INT)')).toBe('scoped-write');
  });
});

describe('是否需要确认', () => {
  it('只读和追加一律不拦', () => {
    for (const environment of ['production', 'staging', 'development', 'testing'] as const) {
      expect(requiresConfirmation('read', environment)).toBe(false);
      expect(requiresConfirmation('append', environment)).toBe(false);
    }
  });

  it('整表写入和破坏性操作在任何环境都拦', () => {
    for (const environment of ['production', 'staging', 'development', 'testing'] as const) {
      expect(requiresConfirmation('bulk-write', environment)).toBe(true);
      expect(requiresConfirmation('destructive', environment)).toBe(true);
    }
  });

  it('有界写入只在生产拦', () => {
    // 预发和开发上每改一行都弹窗，弹到第三次就没人看了
    expect(requiresConfirmation('scoped-write', 'production')).toBe(true);
    expect(requiresConfirmation('scoped-write', 'staging')).toBe(false);
    expect(requiresConfirmation('scoped-write', 'development')).toBe(false);
  });
});

describe('一批语句里最危险的那条', () => {
  it('全是只读时不拦', () => {
    expect(highestRiskNeedingConfirmation(
      ['SELECT 1', 'SELECT 2'],
      'production'
    )).toBeNull();
  });

  it('挑出最危险的那条，而不是第一条需要确认的', () => {
    const worst = highestRiskNeedingConfirmation(
      ['DELETE FROM a', 'SELECT 1', 'DROP TABLE b'],
      'development'
    );
    expect(worst?.risk).toBe('destructive');
    expect(worst?.sql).toBe('DROP TABLE b');
  });

  it('环境影响结果：同一批语句在开发上不拦、在生产上拦', () => {
    const statements = ['UPDATE users SET a = 1 WHERE id = 1'];
    expect(highestRiskNeedingConfirmation(statements, 'development')).toBeNull();
    expect(highestRiskNeedingConfirmation(statements, 'production')?.risk).toBe('scoped-write');
  });
});

describe('按 GO 分出来的一批', () => {
  it('一批里有多条语句时取最危险的那条', () => {
    expect(classifyBatchRisk('SELECT 1;\nDELETE FROM t;', 'sqlserver')).toBe('bulk-write');
    expect(classifyBatchRisk('SELECT 1 INTO #t;\nDROP TABLE x', 'sqlserver')).toBe('destructive');
  });

  it('定义过程、视图的那一批不按过程体里的语句定级', () => {
    const procedure = 'CREATE OR ALTER PROCEDURE dbo.p AS BEGIN DELETE FROM t; END';
    expect(classifyBatchRisk(procedure, 'sqlserver')).toBe('scoped-write');
    expect(classifyBatchRisk('ALTER VIEW v AS SELECT 1', 'sqlserver')).toBe('scoped-write');
  });
});

describe('Oracle 的匿名块', () => {
  it('块里的整表删除照样要确认', () => {
    expect(classifyBatchRisk('BEGIN DELETE FROM t; END;', 'oracle')).toBe('bulk-write');
    expect(classifyBatchRisk('CREATE OR REPLACE PROCEDURE p AS BEGIN DELETE FROM t; END;', 'oracle'))
      .toBe('scoped-write');
  });
});

describe('方括号里的关键字', () => {
  it('DELETE FROM [where] 仍然是整表删除', () => {
    expect(classifyStatementRisk('DELETE FROM [where]')).toBe('bulk-write');
    expect(classifyStatementRisk('DELETE FROM [t] WHERE [id] = 1')).toBe('scoped-write');
  });
});
