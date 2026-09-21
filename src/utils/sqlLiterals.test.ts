import { describe, expect, it } from 'vitest';
import { escapeLikePattern, quoteSqlStringLiteral } from './sqlLiterals';

describe('quoteSqlStringLiteral', () => {
  it('单引号写两遍', () => {
    expect(quoteSqlStringLiteral("O'Brien", 'postgresql')).toBe("'O''Brien'");
    expect(quoteSqlStringLiteral("O'Brien", 'mysql')).toBe("'O''Brien'");
    expect(quoteSqlStringLiteral("O'Brien", 'sqlite')).toBe("'O''Brien'");
  });

  it('反斜杠只在 MySQL 里写两遍', () => {
    // MySQL 默认开反斜杠转义，`C:\temp` 里的 `\t` 会变成制表符；
    // PostgreSQL 与 SQLite 反过来——多写一个就凭空多一个反斜杠
    expect(quoteSqlStringLiteral('C:\\temp', 'mysql')).toBe("'C:\\\\temp'");
    expect(quoteSqlStringLiteral('C:\\temp', 'postgresql')).toBe("'C:\\temp'");
    expect(quoteSqlStringLiteral('C:\\temp', 'sqlite')).toBe("'C:\\temp'");
  });

  it('空字符串是一对引号，不是空', () => {
    expect(quoteSqlStringLiteral('', 'mysql')).toBe("''");
  });

  it('不去掉首尾空白', () => {
    // 用户要筛的可能正是一个带空格的值，静默 trim 会让他查不到而无从察觉
    expect(quoteSqlStringLiteral('  a  ', 'postgresql')).toBe("'  a  '");
  });
});

describe('escapeLikePattern', () => {
  it('把通配符变成字面字符', () => {
    // 想搜 `100%` 的人不转义会搜到所有 100 开头的值，且结果不会报错
    expect(escapeLikePattern('100%')).toBe('100!%');
    expect(escapeLikePattern('a_b')).toBe('a!_b');
  });

  it('转义字符本身也要转义', () => {
    expect(escapeLikePattern('a!b')).toBe('a!!b');
  });

  it('反斜杠不参与——转义符不是它', () => {
    expect(escapeLikePattern('C:\\temp')).toBe('C:\\temp');
  });

  it('普通文本原样返回', () => {
    expect(escapeLikePattern('hello')).toBe('hello');
  });
});
