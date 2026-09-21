import { describe, expect, it } from 'vitest';
import { anyChangesSchema, changesSchema } from './schemaChanges';

describe('changesSchema', () => {
  it('建表、改表、删表、重命名、清空、加注释都算', () => {
    expect(changesSchema('CREATE TABLE users (id INT)')).toBe(true);
    expect(changesSchema('ALTER TABLE users ADD COLUMN email VARCHAR(64)')).toBe(true);
    expect(changesSchema('DROP TABLE users')).toBe(true);
    expect(changesSchema('RENAME TABLE a TO b')).toBe(true);
    expect(changesSchema('TRUNCATE TABLE users')).toBe(true);
    expect(changesSchema("COMMENT ON TABLE users IS 'x'")).toBe(true);
  });

  it('只改数据的不算——INSERT 一万行也不会让图多一个框', () => {
    expect(changesSchema('INSERT INTO users VALUES (1)')).toBe(false);
    expect(changesSchema('UPDATE users SET name = 1')).toBe(false);
    expect(changesSchema('DELETE FROM users')).toBe(false);
    expect(changesSchema('SELECT * FROM users')).toBe(false);
  });

  it('字符串里的 CREATE 不算', () => {
    // 靠 topLevelKeywords 跳过字符串；用正则搜关键字的实现会在这里误判
    expect(changesSchema("SELECT 'CREATE TABLE x'")).toBe(false);
  });

  it('注释里的 DROP 不算', () => {
    expect(changesSchema('-- DROP TABLE users\nSELECT 1')).toBe(false);
  });

  it('子查询里的 CREATE 不算——只看首个顶层关键字', () => {
    expect(changesSchema('SELECT * FROM (SELECT 1) t')).toBe(false);
  });

  it('大小写与前导空白不影响判断', () => {
    expect(changesSchema('  create   table users (id int)')).toBe(true);
  });

  it('空语句不算', () => {
    expect(changesSchema('')).toBe(false);
    expect(changesSchema('   ')).toBe(false);
  });
});

describe('anyChangesSchema', () => {
  it('一批里有一条改结构就算', () => {
    expect(anyChangesSchema(['SELECT 1', 'CREATE TABLE t (id INT)'])).toBe(true);
  });

  it('全是读写数据就不算', () => {
    expect(anyChangesSchema(['SELECT 1', 'INSERT INTO t VALUES (1)'])).toBe(false);
  });

  it('空批次不算', () => {
    expect(anyChangesSchema([])).toBe(false);
  });
});
