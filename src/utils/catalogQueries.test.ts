import { describe, expect, it } from 'vitest';
import { catalogQueryParams, ddlRequest, readTriggersByShow } from './catalogQueries';

describe('catalogQueryParams', () => {
  it('声明两个参数时补上 schema', () => {
    expect(catalogQueryParams(2, 'users', 'public')).toEqual(['users', 'public']);
  });

  // 没有 schema 也要占住那一位：查询里写的是 COALESCE($2, current_schema())，
  // 少绑一个的后果不是「按当前 schema 查」，是整条语句报错
  it('没有 schema 时补 null，而不是少绑一个', () => {
    expect(catalogQueryParams(2, 'users', undefined)).toEqual(['users', null]);
  });

  it('声明一个参数时只绑表名', () => {
    expect(catalogQueryParams(1, 'users', 'ignored')).toEqual(['users']);
  });
});

describe('ddlRequest', () => {
  // 这条是 PostgreSQL 上「结构」页整片空白的那个缺陷：视图定义要两个参数，
  // 而此前这里照 SQLite 的形状只绑了表名
  it('绑定形态按 parameter_count 绑，和同方言其它目录查询一样', () => {
    expect(
      ddlRequest({ kind: 'bound', sql: 'SELECT … WHERE relname = $1 AND nspname = $2' }, 2, 'orders', 'shop', 'postgresql')
    ).toEqual({
      sql: 'SELECT … WHERE relname = $1 AND nspname = $2',
      params: ['orders', 'shop']
    });
  });

  it('SQLite 只绑表名', () => {
    expect(ddlRequest({ kind: 'bound', sql: 'SELECT sql FROM sqlite_master WHERE tbl_name = ?1' }, 1, 'orders', null, 'sqlite').params)
      .toEqual(['orders']);
  });

  // SHOW CREATE TABLE 不接受占位符：表名当字符串绑进去是语法错误
  it('插值形态把表名引成标识符，且一个参数都不绑', () => {
    expect(ddlRequest({ kind: 'interpolated', sql: 'SHOW CREATE TABLE {table}' }, 2, 'orders', 'shop', 'mysql'))
      .toEqual({ sql: 'SHOW CREATE TABLE `shop`.`orders`', params: [] });
  });

  it('插值形态没有 schema 时不拼出一个空限定名', () => {
    expect(ddlRequest({ kind: 'interpolated', sql: 'SHOW CREATE TABLE {table}' }, 2, 'orders', null, 'mysql').sql)
      .toBe('SHOW CREATE TABLE `orders`');
  });

  // 名字里带反引号的表会把语句截断——引用规则必须走 quoteQualifiedSqlIdentifier
  it('插值形态转义名字里的引号', () => {
    expect(ddlRequest({ kind: 'interpolated', sql: 'SHOW CREATE TABLE {table}' }, 2, 'we`ird', null, 'mysql').sql)
      .toBe('SHOW CREATE TABLE `we``ird`');
  });
});

describe('readTriggersByShow', () => {
  const show = {
    list: 'SHOW TRIGGERS FROM {table}',
    definition: 'SHOW CREATE TRIGGER {trigger} ON {table}'
  };

  it('先列名字，再逐个取原文；表名带 schema、名字都按标识符引用', async () => {
    const sent: string[] = [];
    const select = async (sql: string): Promise<unknown> => {
      sent.push(sql);
      if (sql.startsWith('SHOW TRIGGERS')) {
        return [{ trigger_name: 'audit', enabled: true }, { trigger_name: 'odd"name', enabled: true }];
      }
      return [{ trigger_name: 'x', create_statement: `CREATE TRIGGER for ${sql}` }];
    };

    const triggers = await readTriggersByShow(show, select, 'or"ders', 'shop');

    expect(sent).toEqual([
      'SHOW TRIGGERS FROM "shop"."or""ders"',
      'SHOW CREATE TRIGGER "audit" ON "shop"."or""ders"',
      'SHOW CREATE TRIGGER "odd""name" ON "shop"."or""ders"'
    ]);
    expect(triggers).toEqual([
      {
        name: 'audit',
        timing: null,
        event: null,
        definition: 'CREATE TRIGGER for SHOW CREATE TRIGGER "audit" ON "shop"."or""ders"'
      },
      {
        name: 'odd"name',
        timing: null,
        event: null,
        definition: 'CREATE TRIGGER for SHOW CREATE TRIGGER "odd""name" ON "shop"."or""ders"'
      }
    ]);
  });

  // 字符串形式的替换会把 `$&` 换成匹配到的 `{table}`
  it('名字里的 $ 原样保留', async () => {
    const sent: string[] = [];
    const select = async (sql: string): Promise<unknown> => {
      sent.push(sql);
      return sql.startsWith('SHOW TRIGGERS') ? [{ trigger_name: 't$&' }] : [];
    };
    await readTriggersByShow(show, select, 'a$&b', null);
    expect(sent).toEqual(['SHOW TRIGGERS FROM "a$&b"', 'SHOW CREATE TRIGGER "t$&" ON "a$&b"']);
  });

  it('没有 schema 时只写表名', async () => {
    const sent: string[] = [];
    await readTriggersByShow(show, async (sql) => { sent.push(sql); return []; }, 'orders', null);
    expect(sent).toEqual(['SHOW TRIGGERS FROM "orders"']);
  });

  // 服务端不认 SHOW TRIGGERS（24.3 之前的 CockroachDB 根本没有触发器、或者不是 CockroachDB）：
  // 说「列不出」，而不是把一句语法错印在结构页上
  it('不认 SHOW TRIGGERS 时返回 null', async () => {
    const select = async (): Promise<unknown> => {
      throw Object.assign(new Error('at or near "triggers": syntax error'), { code: '42601' });
    };
    await expect(readTriggersByShow(show, select, 'orders', null)).resolves.toBeNull();
  });

  // 没有权限（42501）这类是真的读失败，原话照报
  it('别的错误照样抛出', async () => {
    const denied = Object.assign(new Error('user r has no privileges on relation orders'), { code: '42501' });
    const select = async (): Promise<unknown> => {
      throw denied;
    };
    await expect(readTriggersByShow(show, select, 'orders', null)).rejects.toBe(denied);
  });
});
