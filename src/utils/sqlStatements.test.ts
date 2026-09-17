import { describe, expect, it } from 'vitest';
import { isSelectStatement, splitSqlStatements } from './sqlStatements';

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

describe('isSelectStatement', () => {
  it('recognizes SELECT regardless of leading whitespace or case', () => {
    expect(isSelectStatement('  SeLeCt 1')).toBe(true);
  });

  it('does not classify mutation statements as SELECT', () => {
    expect(isSelectStatement('UPDATE users SET active = true')).toBe(false);
  });
});
