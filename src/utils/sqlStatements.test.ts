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
