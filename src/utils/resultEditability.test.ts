import { describe, expect, it } from 'vitest';
import { describeResultEditability, parseSingleTableSelect } from './resultEditability';
import type { RowIdentityResult } from './rowIdentity';

const identity = (columns: string[]): RowIdentityResult => ({
  identity: { columns, source: 'primary-key', indexName: null },
  absence: null
});

describe('parseSingleTableSelect', () => {
  it('认出最常见的形态', () => {
    expect(parseSingleTableSelect('SELECT * FROM users', 'mysql')).toEqual({
      schema: null,
      table: 'users',
      projection: null
    });
  });

  it('带 schema 的表名不再被拒', () => {
    expect(parseSingleTableSelect('select * from public.users', 'postgresql')).toEqual({
      schema: 'public',
      table: 'users',
      projection: null
    });
  });

  it('PostgreSQL 把不带引号的标识符折成小写', () => {
    // `FROM Users` 在 PostgreSQL 里指的是表 users；原样查目录会一行都查不到，
    // 而现象是「这张表好像没有主键」
    expect(parseSingleTableSelect('SELECT * FROM Users', 'postgresql')?.table).toBe('users');
    expect(parseSingleTableSelect('SELECT * FROM "Users"', 'postgresql')?.table).toBe('Users');
  });

  it('MySQL 不折大小写', () => {
    expect(parseSingleTableSelect('SELECT * FROM Users', 'mysql')?.table).toBe('Users');
  });

  it('列清单里的裸列名可以认', () => {
    expect(parseSingleTableSelect('SELECT id, `name` FROM t', 'mysql')?.projection)
      .toEqual(['id', 'name']);
  });

  it('WHERE / ORDER BY / LIMIT 之后仍然可认', () => {
    expect(parseSingleTableSelect('SELECT * FROM t WHERE a = 1 ORDER BY a LIMIT 10', 'sqlite'))
      .not.toBeNull();
  });

  it('子查询里的 JOIN 不影响外层每行对应哪一行', () => {
    expect(parseSingleTableSelect(
      'SELECT * FROM t WHERE id IN (SELECT id FROM u JOIN v ON u.id = v.id)',
      'sqlite'
    )).not.toBeNull();
  });

  it('字符串里的 group by 不算分组', () => {
    expect(parseSingleTableSelect("SELECT * FROM t WHERE note = 'group by'", 'sqlite'))
      .not.toBeNull();
  });

  it.each([
    ['连接', 'SELECT * FROM a JOIN b ON a.id = b.id'],
    ['逗号连接', 'SELECT * FROM a, b'],
    ['并集', 'SELECT * FROM a UNION SELECT * FROM b'],
    ['分组', 'SELECT * FROM a GROUP BY x'],
    ['去重', 'SELECT DISTINCT * FROM a'],
    ['表别名', 'SELECT * FROM a x WHERE x.id = 1'],
    ['列别名', 'SELECT id AS key FROM a'],
    ['表达式列', 'SELECT id + 1 FROM a'],
    ['函数列', 'SELECT count(*) FROM a'],
    ['带限定的列', 'SELECT a.id FROM a'],
    ['CTE', 'WITH x AS (SELECT * FROM a) SELECT * FROM x'],
    ['不是 SELECT', 'UPDATE a SET b = 1'],
    ['尾巴不认识', 'SELECT * FROM a FOR UPDATE']
  ])('%s 不认', (_label, sql) => {
    expect(parseSingleTableSelect(sql, 'sqlite')).toBeNull();
  });

  // 这几条的关键字都在 WHERE **后面**：语句开头的形状完全合法，只有扫过
  // 整条语句才看得出来。`... WHERE a = 1 UNION SELECT * FROM u` 尤其要命——
  // 它会被当成「表 a 的结果」，而其中一半的行来自 u
  it.each([
    ['WHERE 之后的并集', 'SELECT * FROM a WHERE x = 1 UNION SELECT * FROM b'],
    ['WHERE 之后的分组', 'SELECT * FROM a WHERE x = 1 GROUP BY y'],
    ['WHERE 之后的 HAVING', 'SELECT * FROM a WHERE x = 1 HAVING count(*) > 1'],
    ['ORDER BY 之后的并集', 'SELECT * FROM a ORDER BY x EXCEPT SELECT * FROM b']
  ])('%s 不认', (_label, sql) => {
    expect(parseSingleTableSelect(sql, 'sqlite')).toBeNull();
  });
});

describe('describeResultEditability', () => {
  const parsed = { schema: null, table: 'users', projection: null };

  it('认得出表又有键才可改', () => {
    expect(describeResultEditability(parsed, identity(['id']))).toEqual({
      editable: true,
      schema: null,
      table: 'users',
      keyColumns: ['id']
    });
  });

  it('认不出形态就只读', () => {
    expect(describeResultEditability(null, identity(['id'])))
      .toEqual({ editable: false, reason: 'complex-query' });
  });

  it('表没有唯一键就只读', () => {
    expect(describeResultEditability(parsed, { identity: null, absence: 'no-unique-key' }))
      .toEqual({ editable: false, reason: 'missing-unique-key' });
  });

  it('元数据还没读到时说「还不知道」，不说「没有键」', () => {
    expect(describeResultEditability(parsed, { identity: null, absence: 'metadata-pending' }).editable)
      .toBe(false);
    expect(describeResultEditability(parsed, { identity: null, absence: 'metadata-unavailable' }))
      .toEqual({ editable: false, reason: 'metadata-pending' });
  });

  it('键列没被投影出来就只读——拿不到键值就拼不出 WHERE', () => {
    expect(describeResultEditability(
      { schema: null, table: 'users', projection: ['name'] },
      identity(['id'])
    )).toEqual({ editable: false, reason: 'key-not-projected' });
  });

  it('复合键要求每一列都在投影里', () => {
    expect(describeResultEditability(
      { schema: null, table: 'users', projection: ['tenant', 'name'] },
      identity(['tenant', 'sku'])
    ).editable).toBe(false);
    expect(describeResultEditability(
      { schema: null, table: 'users', projection: ['tenant', 'sku', 'name'] },
      identity(['tenant', 'sku'])
    ).editable).toBe(true);
  });
});
