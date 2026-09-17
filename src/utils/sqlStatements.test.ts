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
});

describe('isSelectStatement', () => {
  it('recognizes SELECT regardless of leading whitespace or case', () => {
    expect(isSelectStatement('  SeLeCt 1')).toBe(true);
  });

  it('does not classify mutation statements as SELECT', () => {
    expect(isSelectStatement('UPDATE users SET active = true')).toBe(false);
  });
});
