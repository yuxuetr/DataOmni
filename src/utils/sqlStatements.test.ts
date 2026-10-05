import { describe, expect, it } from 'vitest';
import {
  findSqlStatementAtOffset,
  getSqlStatementRanges,
  isSelectStatement,
  returnsResultSet,
  splitSqlStatements
} from './sqlStatements';

describe('splitSqlStatements', () => {
  it('splits and trims multiple statements', () => {
    expect(splitSqlStatements(' SELECT 1;  SELECT 2; ')).toEqual([
      'SELECT 1',
      'SELECT 2',
    ]);
  });

  it('ignores empty statements', () => {
    expect(splitSqlStatements('SELECT 1;;;')).toEqual(['SELECT 1']);
  });

  it('does not split semicolons inside strings or quoted identifiers', () => {
    expect(splitSqlStatements(`
      SELECT ';' AS value, "semi;colon", \`other;column\`;
      SELECT 'it''s;safe', 'backslash\\';safe';
    `)).toEqual([
      `SELECT ';' AS value, "semi;colon", \`other;column\``,
      `SELECT 'it''s;safe', 'backslash\\';safe'`
    ]);
  });

  it('ends a block comment at the first */ where the dialect does not nest them', () => {
    // MySQL、SQLite、Oracle 的块注释不嵌套：`/* a /* b */` 到第一个 `*/` 就完了，
    // 后面是真的语句。按嵌套读的话整段脚本都在注释里，切出 0 条，执行时什么也不发
    const script = '/* old /* note */ DELETE FROM orders; SELECT 2;';
    for (const dialect of ['mysql', 'sqlite', 'oracle'] as const) {
      expect(splitSqlStatements(script, dialect)).toEqual(['/* old /* note */ DELETE FROM orders', 'SELECT 2']);
    }
    // PostgreSQL、SQL Server、DuckDB、ClickHouse 嵌套（四家都在真库上试过）
    for (const dialect of ['postgresql', 'sqlserver', 'duckdb', 'clickhouse'] as const) {
      expect(splitSqlStatements('/* a /* b */ ; */ SELECT 1; SELECT 2', dialect))
        .toEqual(['/* a /* b */ ; */ SELECT 1', 'SELECT 2']);
    }
  });

  it('does not split semicolons inside line or nested block comments', () => {
    expect(splitSqlStatements(`
      SELECT 1 -- ignored ; delimiter
      ;
      /* outer ; /* nested ; */ still outer ; */
      SELECT 2;
    `)).toEqual([
      'SELECT 1 -- ignored ; delimiter',
      '/* outer ; /* nested ; */ still outer ; */\n      SELECT 2'
    ]);
  });

  it('preserves PostgreSQL dollar-quoted function bodies', () => {
    expect(splitSqlStatements(`
      CREATE FUNCTION greet() RETURNS text AS $body$
      BEGIN
        RETURN 'hello;world';
      END;
      $body$ LANGUAGE plpgsql;
      SELECT greet();
    `)).toEqual([
      `CREATE FUNCTION greet() RETURNS text AS $body$
      BEGIN
        RETURN 'hello;world';
      END;
      $body$ LANGUAGE plpgsql`,
      'SELECT greet()'
    ]);
  });

  it('honors MySQL DELIMITER directives for procedure bodies', () => {
    expect(splitSqlStatements(`
      DELIMITER $$
      CREATE PROCEDURE load_users()
      BEGIN
        SELECT 'first;value';
        SELECT 2;
      END$$
      DELIMITER ;
      CALL load_users();
    `)).toEqual([
      `CREATE PROCEDURE load_users()
      BEGIN
        SELECT 'first;value';
        SELECT 2;
      END`,
      'CALL load_users()'
    ]);
  });
});

describe('SQL statement ranges', () => {
  it('locates statements using source offsets', () => {
    const sql = '  SELECT 1;\n\nSELECT 2;';

    expect(getSqlStatementRanges(sql)).toEqual([
      { index: 0, sql: 'SELECT 1', from: 2, to: 10 },
      { index: 1, sql: 'SELECT 2', from: 13, to: 21 },
    ]);
    expect(findSqlStatementAtOffset(sql, 6)?.sql).toBe('SELECT 1');
    expect(findSqlStatementAtOffset(sql, 17)?.sql).toBe('SELECT 2');
  });

  it('uses the nearest statement when the cursor is on a delimiter', () => {
    const sql = 'SELECT 1;\nSELECT 2;';

    expect(findSqlStatementAtOffset(sql, 8)?.sql).toBe('SELECT 1');
    expect(findSqlStatementAtOffset(sql, 10)?.sql).toBe('SELECT 2');
  });
});

describe('isSelectStatement', () => {
  it('recognizes SELECT regardless of leading whitespace or case', () => {
    expect(isSelectStatement('  SeLeCt 1')).toBe(true);
  });

  it('does not classify mutation statements as SELECT', () => {
    expect(isSelectStatement('UPDATE users SET active = true')).toBe(false);
  });
});

describe('returnsResultSet', () => {
  it.each([
    'SELECT 1',
    'SHOW TABLES',
    'DESCRIBE users',
    'EXPLAIN SELECT * FROM users',
    'PRAGMA table_info(users)',
    'VALUES (1), (2)',
    'TABLE users'
  ])('recognizes %s as returning rows', (sql) => {
    expect(returnsResultSet(sql)).toBe(true);
  });

  it('recognizes SELECT and RETURNING after common table expressions', () => {
    expect(returnsResultSet(`
      WITH active_users AS (
        SELECT id FROM users WHERE note = 'UPDATE; RETURNING'
      )
      SELECT * FROM active_users
    `)).toBe(true);
    expect(returnsResultSet(`
      WITH changed AS (
        SELECT id FROM users
      )
      UPDATE users SET active = true
      WHERE id IN (SELECT id FROM changed)
      RETURNING id
    `)).toBe(true);
  });

  it('recognizes DML RETURNING but ignores keywords in comments and strings', () => {
    expect(returnsResultSet("INSERT INTO users(name) VALUES ('a') RETURNING id")).toBe(true);
    expect(returnsResultSet("UPDATE users SET note = 'RETURNING'")).toBe(false);
    expect(returnsResultSet('DELETE FROM users /* RETURNING id */')).toBe(false);
  });

  it('recognizes leading comments before result-producing statements', () => {
    expect(returnsResultSet('-- report\nSELECT 1')).toBe(true);
    expect(returnsResultSet('/* report */ WITH data AS (SELECT 1) SELECT * FROM data')).toBe(true);
  });

  it('keeps ordinary mutations on the execute path', () => {
    expect(returnsResultSet('INSERT INTO users(name) VALUES (\'a\')')).toBe(false);
    expect(returnsResultSet('UPDATE users SET active = true')).toBe(false);
    expect(returnsResultSet('DELETE FROM users')).toBe(false);
  });
});

describe('按方言切语句', () => {
  it('# 只有 MySQL 是注释', () => {
    // SQL Server 的临时表、PostgreSQL 的按位异或：当成注释，那一行的分号就被吞了
    expect(splitSqlStatements('SELECT 1 INTO #t; SELECT * FROM #t;', 'sqlserver'))
      .toEqual(['SELECT 1 INTO #t', 'SELECT * FROM #t']);
    expect(splitSqlStatements('SELECT 5 # 3; SELECT 2;', 'postgresql'))
      .toEqual(['SELECT 5 # 3', 'SELECT 2']);
    expect(splitSqlStatements('SELECT 1 # note; still comment\nSELECT 2;', 'mysql'))
      .toEqual(['SELECT 1 # note; still comment\nSELECT 2']);
    expect(splitSqlStatements('SELECT 1 # note; still comment\nSELECT 2;', 'clickhouse'))
      .toEqual(['SELECT 1 # note; still comment\nSELECT 2']);
    // ClickHouse 字符串里 `\'` 是转义的撇号，后面的分号仍在字面量里
    expect(splitSqlStatements("SELECT 'it\\'s; odd'; SELECT 2;", 'clickhouse'))
      .toEqual(["SELECT 'it\\'s; odd'", 'SELECT 2']);
  });

  it('反斜杠只在 MySQL / ClickHouse 与 PostgreSQL 的 E 字符串里是转义', () => {
    // 别的地方 `'C:\'` 就是一个完整的字面量；当成转义的话后面整段都被吞进字符串
    const script = "SELECT 'C:\\'; SELECT \"a\\\"; SELECT 2;";
    for (const dialect of ['postgresql', 'sqlserver', 'oracle', 'sqlite', 'duckdb'] as const) {
      expect(splitSqlStatements(script, dialect)).toEqual(["SELECT 'C:\\'", 'SELECT "a\\"', 'SELECT 2']);
    }
    expect(splitSqlStatements("SELECT E'it\\'s; ok'; SELECT e'\\\\'; SELECT 2;", 'postgresql'))
      .toEqual(["SELECT E'it\\'s; ok'", "SELECT e'\\\\'", 'SELECT 2']);
    // 标识符末尾的 e 不是前缀
    expect(splitSqlStatements("SELECT name'x\\'; SELECT 2;", 'postgresql'))
      .toEqual(["SELECT name'x\\'", 'SELECT 2']);
    expect(splitSqlStatements("SELECT 'it\\'s; ok'; SELECT 2;", 'mysql'))
      .toEqual(["SELECT 'it\\'s; ok'", 'SELECT 2']);
  });

  it('SQLite 触发器体与 PostgreSQL 的 BEGIN ATOMIC 到配对的 END 为止，CASE … END 不算', () => {
    const trigger = [
      'CREATE TEMP TRIGGER IF NOT EXISTS tr AFTER INSERT ON t BEGIN',
      "  SELECT CASE WHEN NEW.a < 0 THEN RAISE(ABORT, 'neg; no') END;",
      '  UPDATE t SET backend = 1;',
      'END;',
      'SELECT 1;'
    ].join('\n');
    expect(splitSqlStatements(trigger, 'sqlite')).toEqual([
      trigger.slice(0, trigger.lastIndexOf('END;') + 3),
      'SELECT 1'
    ]);
    const atomic = 'CREATE OR REPLACE FUNCTION f(x int) RETURNS int LANGUAGE sql BEGIN ATOMIC'
      + ' SELECT CASE WHEN x > 0 THEN 1 END; SELECT 2; END; SELECT f(1);';
    expect(splitSqlStatements(atomic, 'postgresql')).toEqual([
      'CREATE OR REPLACE FUNCTION f(x int) RETURNS int LANGUAGE sql BEGIN ATOMIC'
        + ' SELECT CASE WHEN x > 0 THEN 1 END; SELECT 2; END',
      'SELECT f(1)'
    ]);
    // 事务的 BEGIN 不是块：照旧切
    expect(splitSqlStatements('BEGIN; DELETE FROM t; COMMIT;', 'sqlite'))
      .toEqual(['BEGIN', 'DELETE FROM t', 'COMMIT']);
    expect(splitSqlStatements('BEGIN; SELECT CASE WHEN true THEN 1 END; COMMIT;', 'postgresql'))
      .toEqual(['BEGIN', 'SELECT CASE WHEN true THEN 1 END', 'COMMIT']);
  });

  it('SQL Server 的方括号标识符里的引号与分号不算数', () => {
    expect(splitSqlStatements("SELECT [it's; odd]]name] FROM t; SELECT 2;", 'sqlserver'))
      .toEqual(["SELECT [it's; odd]]name] FROM t", 'SELECT 2']);
  });

  it('MySQL 的 -- 后面要跟空白才是注释，5--x 是减负数', () => {
    // MySQL 8.4 上 `SELECT 1--1` 得 2；`--x` 当注释的话后面的分号被吞，两条拼成一条发出去
    expect(splitSqlStatements('SELECT 5--x FROM d; SELECT 2', 'mysql'))
      .toEqual(['SELECT 5--x FROM d', 'SELECT 2']);
    expect(splitSqlStatements('SELECT 1 -- note; still\nSELECT 2;', 'mysql'))
      .toEqual(['SELECT 1 -- note; still\nSELECT 2']);
    expect(splitSqlStatements('SELECT 1 --\tnote;\n; SELECT 2', 'mysql'))
      .toEqual(['SELECT 1 --\tnote;', 'SELECT 2']);
    expect(splitSqlStatements('SELECT 1; --', 'mysql')).toEqual(['SELECT 1']);
    // 别家的 -- 照旧不论后面是什么
    expect(splitSqlStatements('SELECT 5--x;\nSELECT 2', 'postgresql'))
      .toEqual(['SELECT 5--x;\nSELECT 2']);
  });

  it('只有注释的一段不算一条语句', () => {
    // 脚本末尾的注释（mysqldump 的 `-- Dump completed on …`）切出来是单独一段。发给 Oracle 是
    // ORA-00900，「执行全部」最后一条报错；23ai 上实测 `-- x;` 与 `/* c */;` 都是这样
    expect(splitSqlStatements('SELECT 1 FROM dual;\n-- end of script\n', 'oracle'))
      .toEqual(['SELECT 1 FROM dual']);
    expect(splitSqlStatements('SELECT 1;\n/* trailer */\n-- and more', 'postgresql')).toEqual(['SELECT 1']);
    expect(splitSqlStatements('-- only a note', 'sqlite')).toEqual([]);
    // 写在语句前面的注释仍跟着那条语句
    expect(splitSqlStatements('-- header\nSELECT 1;', 'sqlite')).toEqual(['-- header\nSELECT 1']);
    // MySQL 的 `/*! … */` 看着是注释，服务端照样执行；mysqldump 里满是这种
    expect(splitSqlStatements('/*!40101 SET NAMES utf8mb4 */;\nSELECT 1;', 'mysql'))
      .toEqual(['/*!40101 SET NAMES utf8mb4 */', 'SELECT 1']);
    expect(splitSqlStatements('SELECT 1\nGO\n-- done\nGO', 'sqlserver')).toEqual(['SELECT 1']);
  });

  it('SQLite 也认方括号标识符：里面的引号不会吞掉后面的脚本', () => {
    // sqlite3 3.x 上 `CREATE TABLE t([it's;x] int)` 建得出、查得到
    expect(splitSqlStatements("SELECT [it's;x] FROM t; SELECT 2;", 'sqlite'))
      .toEqual(["SELECT [it's;x] FROM t", 'SELECT 2']);
  });

  it('有 GO 行时只按 GO 切，过程体里的分号不切', () => {
    const script = [
      'CREATE PROCEDURE dbo.p AS',
      'BEGIN',
      '  SELECT 1;',
      '  SELECT 2;',
      'END',
      'go  -- 第一批完',
      'EXEC dbo.p;',
      'GO'
    ].join('\n');
    expect(splitSqlStatements(script, 'sqlserver')).toEqual([
      'CREATE PROCEDURE dbo.p AS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND',
      'EXEC dbo.p;'
    ]);
  });

  it('没有 GO 时过程、函数、触发器的定义到脚本末尾，前面的语句照旧切', () => {
    // T-SQL 的过程体到批的末尾为止；没有 GO，整段脚本就是一批
    expect(splitSqlStatements(
      'DROP PROCEDURE IF EXISTS dbo.p;\nCREATE OR ALTER PROC dbo.p AS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND;',
      'sqlserver'
    )).toEqual(['DROP PROCEDURE IF EXISTS dbo.p', 'CREATE OR ALTER PROC dbo.p AS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND;']);
    expect(splitSqlStatements('ALTER TRIGGER tr ON t AFTER INSERT AS SET NOCOUNT ON; UPDATE t SET a = 1;', 'sqlserver'))
      .toEqual(['ALTER TRIGGER tr ON t AFTER INSERT AS SET NOCOUNT ON; UPDATE t SET a = 1;']);
    // 视图只有一条 SELECT，照旧切
    expect(splitSqlStatements('CREATE VIEW v AS SELECT 1 AS a; SELECT * FROM v;', 'sqlserver'))
      .toEqual(['CREATE VIEW v AS SELECT 1 AS a', 'SELECT * FROM v']);
  });

  it('GO 带次数、在字符串里、在一行中间都不是分隔符', () => {
    expect(splitSqlStatements('SELECT 1\nGO 5\n', 'sqlserver')).toEqual(['SELECT 1\nGO 5']);
    expect(splitSqlStatements("SELECT 'a\nGO\nb'; SELECT 2;", 'sqlserver'))
      .toEqual(["SELECT 'a\nGO\nb'", 'SELECT 2']);
    expect(splitSqlStatements('SELECT go FROM t; SELECT 2;', 'sqlserver'))
      .toEqual(['SELECT go FROM t', 'SELECT 2']);
    // 别的方言里 GO 行没有意义，照旧按分号切
    expect(splitSqlStatements('SELECT 1;\nGO\nSELECT 2;', 'postgresql'))
      .toEqual(['SELECT 1', 'GO\nSELECT 2']);
  });

  it('语句范围照同一套规则算', () => {
    const script = 'SELECT 1;\nGO\nSELECT 2;';
    expect(getSqlStatementRanges(script, 'sqlserver').map((range) => range.sql))
      .toEqual(['SELECT 1;', 'SELECT 2;']);
    expect(findSqlStatementAtOffset(script, script.length, 'sqlserver')?.sql).toBe('SELECT 2;');
  });
});

describe('Oracle 的 PL/SQL 块', () => {
  it('块里的分号不切，块到单独一行的 / 为止', () => {
    const script = [
      'BEGIN',
      '  DELETE FROM t;',
      '  COMMIT;',
      'END;',
      '/',
      'SELECT 1 FROM dual;',
      'SELECT 2 FROM dual;'
    ].join('\n');
    expect(splitSqlStatements(script, 'oracle')).toEqual([
      'BEGIN\n  DELETE FROM t;\n  COMMIT;\nEND;',
      'SELECT 1 FROM dual',
      'SELECT 2 FROM dual'
    ]);
  });

  it('没有 / 的块到脚本末尾；CREATE OR REPLACE 的过程同样是块', () => {
    expect(splitSqlStatements('CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;', 'oracle'))
      .toEqual(['CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;']);
    expect(splitSqlStatements('SELECT 1 FROM dual; BEGIN NULL; END;', 'oracle'))
      .toEqual(['SELECT 1 FROM dual', 'BEGIN NULL; END;']);
  });

  it("q'…' 字符串里的引号与分号不算数，到配对的右括号或同一个字符加引号为止", () => {
    const script = "SELECT q'[it's; ok]', Q'{a'b;}', nq'(x;)', q'<y;>', q'!it's; ok!' FROM dual; SELECT 2 FROM dual;";
    expect(splitSqlStatements(script, 'oracle')).toEqual([
      "SELECT q'[it's; ok]', Q'{a'b;}', nq'(x;)', q'<y;>', q'!it's; ok!' FROM dual",
      'SELECT 2 FROM dual'
    ]);
    // 标识符末尾的 q 不是前缀
    expect(splitSqlStatements("SELECT seq'a;'; SELECT 2;", 'oracle')).toEqual(["SELECT seq'a;'", 'SELECT 2']);
  });

  it('别的方言不认 / 这一行', () => {
    expect(splitSqlStatements('SELECT 1;\n/\nSELECT 2;', 'postgresql'))
      .toEqual(['SELECT 1', '/\nSELECT 2']);
  });
});
