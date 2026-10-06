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

  it('不以 SELECT 开头的查询也是只读', () => {
    // PostgreSQL 与 MySQL 8 的 TABLE、DuckDB 先写 FROM 的查询和它的 SUMMARIZE / PIVOT、
    // ClickHouse 的 EXISTS
    expect(classifyStatementRisk('TABLE t', 'postgresql')).toBe('read');
    expect(classifyStatementRisk('FROM t SELECT a', 'duckdb')).toBe('read');
    expect(classifyStatementRisk('FROM t', 'duckdb')).toBe('read');
    expect(classifyStatementRisk('SUMMARIZE t', 'duckdb')).toBe('read');
    expect(classifyStatementRisk('PIVOT t ON a USING sum(b)', 'duckdb')).toBe('read');
    expect(classifyStatementRisk('UNPIVOT t ON a, b INTO NAME k VALUE v', 'duckdb')).toBe('read');
    expect(classifyStatementRisk('EXISTS TABLE t', 'clickhouse')).toBe('read');
    // 括号开头的只能是查询：顶层第一个词是 UNION，不是动词
    expect(classifyStatementRisk('(SELECT 1) UNION (SELECT 2)', 'postgresql')).toBe('read');
    expect(classifyStatementRisk('(TABLE a) EXCEPT (TABLE b)', 'postgresql')).toBe('read');
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

  it('清空分区和删分区一样算破坏性', () => {
    // MySQL 与 Oracle 的 TRUNCATE PARTITION 清掉整个分区的数据，和 TRUNCATE TABLE 是一回事
    expect(classifyStatementRisk('ALTER TABLE orders TRUNCATE PARTITION p2025')).toBe('destructive');
  });

  it('整张换掉已有的表和 DROP 一样算破坏性', () => {
    // DuckDB、MariaDB、ClickHouse 的 CREATE OR REPLACE TABLE 与 ClickHouse 的 REPLACE TABLE：
    // 原表连同数据一起没了，等于先 DROP 再 CREATE
    expect(classifyStatementRisk('CREATE OR REPLACE TABLE t AS SELECT 1', 'duckdb')).toBe('destructive');
    expect(classifyStatementRisk('CREATE OR REPLACE TEMP TABLE t (a int)', 'duckdb')).toBe('destructive');
    expect(classifyStatementRisk('CREATE OR REPLACE TABLE t (a int)', 'mysql')).toBe('destructive');
    expect(classifyStatementRisk('REPLACE TABLE t (a Int8) ENGINE = Memory', 'clickhouse')).toBe('destructive');
    // 换掉视图、函数不丢数据；REPLACE INTO 是插入
    expect(classifyStatementRisk('CREATE OR REPLACE VIEW v AS SELECT 1', 'postgresql')).toBe('scoped-write');
    expect(classifyStatementRisk('CREATE TABLE t (a int)', 'duckdb')).toBe('scoped-write');
    expect(classifyStatementRisk('REPLACE INTO t VALUES (1)', 'mysql')).toBe('append');
  });

  it('ClickHouse 清空一列和删列一样算破坏性', () => {
    expect(classifyStatementRisk('ALTER TABLE t CLEAR COLUMN a', 'clickhouse')).toBe('destructive');
    // CLEAR INDEX 只清掉能重建的索引数据
    expect(classifyStatementRisk('ALTER TABLE t CLEAR INDEX i', 'clickhouse')).toBe('scoped-write');
  });

  it('字符串里的 DROP 不算数', () => {
    // 不跳过字符串的话，这条查询会被当成删表
    expect(classifyStatementRisk("SELECT 'DROP TABLE users' AS note")).toBe('read');
  });

  it('注释里的 WHERE 不算数', () => {
    expect(classifyStatementRisk('DELETE FROM users /* WHERE id = 1 */')).toBe('bulk-write');
    expect(classifyStatementRisk('DELETE FROM users -- WHERE id = 1')).toBe('bulk-write');
  });

  it('块注释不嵌套的库里，第一个 */ 后面的语句照样定级', () => {
    // MySQL 执行的是这条 DELETE；按嵌套读成注释的话定级为只读，生产库上不弹确认
    expect(classifyBatchRisk('/* old /* note */ DELETE FROM orders', 'mysql')).toBe('bulk-write');
    expect(classifyStatementRisk('/* old /* note */ DELETE FROM orders', 'sqlite')).toBe('bulk-write');
    // PostgreSQL 嵌套，这一句整个是注释
    expect(classifyBatchRisk('/* a /* b */ DELETE FROM orders */ SELECT 1', 'postgresql')).toBe('read');
  });

  it('`#` 与反斜杠按方言读：SQL Server 的临时表、PostgreSQL 的异或不吞掉后面的 WHERE', () => {
    // SQL Server 的 `#tmp` 是临时表，PostgreSQL 的 `#` 是按位异或；当成注释的话 WHERE 被吞，
    // 判成「没有 WHERE、影响整张表」，而这一档在哪个环境都弹确认
    expect(classifyBatchRisk('DELETE FROM #tmp WHERE id = 1', 'sqlserver')).toBe('scoped-write');
    expect(classifyBatchRisk('UPDATE #tmp SET x = 1 WHERE id = 1', 'sqlserver')).toBe('scoped-write');
    expect(classifyBatchRisk('UPDATE t SET flags = flags # 4 WHERE id = 1', 'postgresql')).toBe('scoped-write');
    // 反斜杠只在 MySQL 的引号与 PostgreSQL 的 E'…' 里转义；别处 'C:\' 是完整的字面量
    expect(classifyBatchRisk("UPDATE t SET p = 'C:\\' WHERE id = 1", 'postgresql')).toBe('scoped-write');
    expect(classifyBatchRisk("UPDATE t SET p = E'C:\\' WHERE id = 1", 'postgresql')).toBe('bulk-write');
    // MySQL 的 `#` 确实是注释，被注释掉的 WHERE 不算数
    expect(classifyBatchRisk('DELETE FROM t # WHERE id = 1', 'mysql')).toBe('bulk-write');
    // 不知道方言时照旧往危险那边读
    expect(classifyStatementRisk('DELETE FROM #tmp WHERE id = 1')).toBe('bulk-write');
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

  it('PostgreSQL 的 CTE 里本身就能写：括号里的 DELETE / UPDATE 照样定级', () => {
    // 归档写法：删掉的行由外层 SELECT 交回来，顶层只看得到 SELECT
    expect(classifyStatementRisk(
      'WITH gone AS (DELETE FROM orders RETURNING *) SELECT count(*) FROM gone'
    )).toBe('bulk-write');
    expect(classifyStatementRisk(
      'WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x'
    )).toBe('bulk-write');
    // 它自己括号里的 WHERE 才限制它；外层 SELECT 的 WHERE 不算
    expect(classifyStatementRisk(
      'WITH gone AS (DELETE FROM orders WHERE id = 1 RETURNING *) SELECT * FROM gone'
    )).toBe('scoped-write');
    expect(classifyStatementRisk(
      'WITH gone AS (DELETE FROM orders RETURNING id) SELECT * FROM gone WHERE id > 0'
    )).toBe('bulk-write');
    expect(classifyStatementRisk(
      'WITH a AS (DELETE FROM t RETURNING *), b AS (SELECT * FROM u WHERE true) SELECT 1'
    )).toBe('bulk-write');
    expect(classifyStatementRisk(
      'WITH moved AS (INSERT INTO archive SELECT * FROM t RETURNING *) SELECT * FROM moved'
    )).toBe('append');
  });

  it('CTE 里的 FOR UPDATE、ON CONFLICT DO UPDATE 不是改写语句', () => {
    expect(classifyStatementRisk(
      'WITH x AS (SELECT * FROM t WHERE id = 1 FOR UPDATE) SELECT * FROM x'
    )).toBe('read');
    expect(classifyStatementRisk(
      'WITH x AS (SELECT * FROM t FOR NO KEY UPDATE) SELECT * FROM x'
    )).toBe('read');
    expect(classifyStatementRisk(
      'WITH x AS (INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET n = 2 RETURNING *) '
        + 'SELECT * FROM x'
    )).toBe('append');
  });

  it('EXPLAIN ANALYZE 真的执行，按被解释的那条定级', () => {
    expect(classifyStatementRisk('EXPLAIN ANALYZE DELETE FROM t')).toBe('bulk-write');
    expect(classifyStatementRisk('EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1')).toBe('bulk-write');
    expect(classifyStatementRisk('EXPLAIN ANALYZE VERBOSE DELETE FROM t WHERE id = 1'))
      .toBe('scoped-write');
    // MySQL 8 的 EXPLAIN ANALYZE 同样执行多表 DELETE
    expect(classifyStatementRisk('EXPLAIN ANALYZE DELETE t FROM t JOIN u ON t.id = u.id'))
      .toBe('bulk-write');
    expect(classifyStatementRisk(
      'EXPLAIN ANALYZE WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone'
    )).toBe('bulk-write');
    // 不带 ANALYZE 只出计划，不执行
    expect(classifyStatementRisk('EXPLAIN DELETE FROM t')).toBe('read');
    expect(classifyStatementRisk('EXPLAIN ANALYZE SELECT * FROM t')).toBe('read');
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

// 回归时看到的：SQL Server 上 `IF OBJECT_ID(…) IS NOT NULL DROP TABLE` 删了表、一声没问——
// 第一个词是 IF，落到兜底的有界写入
describe('T-SQL 的 IF / ELSE / WHILE', () => {
  it('按条件后面那条语句定级', () => {
    expect(classifyBatchRisk("IF OBJECT_ID('dbo.t') IS NOT NULL DROP TABLE dbo.t", 'sqlserver')).toBe('destructive');
    expect(classifyBatchRisk('IF EXISTS (SELECT 1 FROM t WHERE id = 1) DELETE FROM t', 'sqlserver')).toBe('bulk-write');
    expect(classifyBatchRisk('IF @x = 1 DELETE FROM t WHERE id = 1', 'sqlserver')).toBe('scoped-write');
    expect(classifyBatchRisk('WHILE @@ROWCOUNT > 0 DELETE TOP (1000) FROM t', 'sqlserver')).toBe('bulk-write');
  });

  it('两个分支取更危险的那个；BEGIN … END 里的也算', () => {
    expect(classifyBatchRisk('IF @x = 1 SELECT 1 ELSE TRUNCATE TABLE t', 'sqlserver')).toBe('destructive');
    expect(classifyBatchRisk('IF @x = 1 BEGIN UPDATE t SET a = 1; END', 'sqlserver')).toBe('bulk-write');
    // ELSE 分支里的 WHERE 限制不了前一个分支
    expect(classifyBatchRisk('IF @x = 1 DELETE FROM a ELSE DELETE FROM b WHERE id = 1', 'sqlserver')).toBe('bulk-write');
  });

  // 反向：条件里的子查询不是要执行的写语句，只建不删的照旧是有界写入
  it('条件里只是查询、要做的只是建表时不升级', () => {
    expect(classifyBatchRisk("IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 't') CREATE TABLE t (id INT)", 'sqlserver'))
      .toBe('scoped-write');
    expect(classifyBatchRisk('IF @x = 1 SELECT 1', 'sqlserver')).toBe('scoped-write');
  });
});
