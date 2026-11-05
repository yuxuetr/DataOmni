import { describe, expect, it } from 'vitest';
import type { SqlDialect } from '../contracts/queryExecution';
import { bindParameters, nameParameterError, parameterNames, type ParameterInput } from './queryParameters';
import { sqlParameters, topLevelKeywords } from './sqlStatements';

const names = (sql: string, dialect: SqlDialect = 'postgresql') => sqlParameters(sql, dialect).map((parameter) => parameter.name);
const text = (value: string): ParameterInput => ({ value, kind: 'text', isNull: false });
const number = (value: string): ParameterInput => ({ value, kind: 'number', isNull: false });

describe('sqlParameters', () => {
  it('finds :name in plain SQL and inside array brackets', () => {
    expect(names('SELECT * FROM t WHERE a = :a AND b IN (:b, :a)')).toEqual(['a', 'b', 'a']);
    expect(names('SELECT * FROM t WHERE id = ANY(ARRAY[:first, :second])')).toEqual(['first', 'second']);
  });

  it('leaves strings, quoted identifiers and comments alone', () => {
    expect(names("SELECT ':a', \"col:b\" FROM t -- :c\n/* :d */ WHERE x = :e")).toEqual(['e']);
    expect(names('SELECT $$ :a $$, $tag$ :b $tag$, :c')).toEqual(['c']);
    expect(names("SELECT q'[it's :a]', :b FROM dual", 'oracle')).toEqual(['b']);
    expect(names('SELECT `x:a`, :b', 'mysql')).toEqual(['b']);
    expect(names('SELECT [x :a], :b', 'sqlserver')).toEqual(['b']);
  });

  it('is not a cast, an assignment or a positional marker', () => {
    expect(names('SELECT x::text, :a::int')).toEqual(['a']);
    expect(names('SET @n := 1; SELECT :1', 'mysql')).toEqual([]);
  });

  it('is not a slice, a label or a ClickHouse typed parameter', () => {
    expect(names('SELECT arr[lo:hi], arr[1:n] FROM t')).toEqual([]);
    expect(names('outer_loop:LOOP LEAVE outer_loop; END LOOP', 'mysql')).toEqual([]);
    expect(names('SELECT {id:UInt64}', 'clickhouse')).toEqual([]);
  });

  it('is not an Oracle trigger correlation name', () => {
    expect(names('BEGIN :new.updated_at := SYSDATE; END;', 'oracle')).toEqual([]);
  });

  it('does not let a parameter name pass for a keyword in the risk check', () => {
    expect(topLevelKeywords('DELETE FROM t WHERE id = :id')).toContain('WHERE');
    expect(topLevelKeywords('DELETE FROM t RETURNING :where', 'postgresql')).not.toContain('WHERE');
  });
});

describe('parameterNames', () => {
  it('shares one name across statements, in first-seen order', () => {
    expect(parameterNames(['SELECT :b, :a', 'DELETE FROM t WHERE id = :a'], 'mysql')).toEqual(['b', 'a']);
  });
});

describe('bindParameters', () => {
  const sql = 'SELECT * FROM t WHERE a = :a AND b = :b OR a = :a';

  it('writes each dialect\'s placeholders, one value per occurrence', () => {
    const inputs = { a: text('x'), b: text('y') };
    expect(bindParameters(sql, 'postgresql', inputs)).toEqual({
      ok: true, sql: 'SELECT * FROM t WHERE a = $1 AND b = $2 OR a = $3', params: ['x', 'y', 'x'], names: ['a', 'b', 'a']
    });
    expect(bindParameters(sql, 'mysql', inputs)).toMatchObject({ sql: 'SELECT * FROM t WHERE a = ? AND b = ? OR a = ?' });
    expect(bindParameters(sql, 'sqlserver', inputs)).toMatchObject({ sql: 'SELECT * FROM t WHERE a = @P1 AND b = @P2 OR a = @P3' });
    expect(bindParameters(sql, 'oracle', inputs)).toMatchObject({ sql: 'SELECT * FROM t WHERE a = :1 AND b = :2 OR a = :3' });
  });

  it('keeps text as text: 007 is not 7', () => {
    expect(bindParameters('SELECT :code', 'mysql', { code: text('007') })).toMatchObject({ params: ['007'] });
  });

  it('sends a number only when asked, and only one that survives JSON', () => {
    expect(bindParameters('SELECT 1 LIMIT :n', 'mysql', { n: number(' 10 ') })).toMatchObject({ params: [10] });
    expect(bindParameters('SELECT :x', 'sqlite', { x: number('-1.5e3') })).toMatchObject({ params: [-1500] });
    expect(bindParameters('SELECT :x', 'mysql', { x: number('ten') })).toEqual({ ok: false, reason: 'not-a-number', name: 'x' });
    expect(bindParameters('SELECT :x', 'mysql', { x: number('9007199254740993') })).toEqual({ ok: false, reason: 'out-of-range', name: 'x' });
  });

  it('leaves the type to the driver on PostgreSQL', () => {
    expect(bindParameters('SELECT :n', 'postgresql', { n: number('10') })).toMatchObject({ params: ['10'] });
  });

  it('sends NULL whatever the kind', () => {
    expect(bindParameters('SELECT :x', 'mysql', { x: { value: 'abc', kind: 'number', isNull: true } })).toMatchObject({ params: [null] });
  });

  it('refuses ClickHouse and leaves a statement without parameters untouched', () => {
    expect(bindParameters('SELECT :x', 'clickhouse', { x: text('1') })).toEqual({ ok: false, reason: 'unsupported-dialect' });
    expect(bindParameters("SELECT ':x'", 'clickhouse', {})).toEqual({ ok: true, sql: "SELECT ':x'", params: [], names: [] });
  });
});

describe('nameParameterError', () => {
  it('puts the parameter name where the backend only knew the position', () => {
    const error = { message: 'DATAOMNI_PARAMETER_NOT_CONVERTIBLE: 2 · INT4 · abc', code: null };
    expect(nameParameterError(error, ['since', 'id'])).toEqual({ message: 'DATAOMNI_PARAMETER_NOT_CONVERTIBLE: :id · INT4 · abc', code: null });
  });

  it('leaves every other error alone', () => {
    const error = { message: 'syntax error at or near "FORM"' };
    expect(nameParameterError(error, ['id'])).toBe(error);
    expect(nameParameterError('plain text', ['id'])).toBe('plain text');
  });
});
