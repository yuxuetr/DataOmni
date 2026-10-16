import { describe, expect, it } from 'vitest';
import { translate } from '../i18n/translate';
import { buildDdlScript, dictionarySubset, mapWithConcurrency, orderByDependencies, readTableDdls } from './schemaExport';
import type { SchemaMetadataQueries } from './catalogQueries';
import type { DatabaseObject } from './databaseObjects';
import type { ErLink, ErTable } from './erLayout';

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en', key, params);

describe('buildDdlScript', () => {
  it('每张表一段原文，补上分号；读不到的只在开头列出', () => {
    const script = buildDdlScript({
      title: 'claw',
      database: 'shop',
      date: '2026-10-16',
      tables: [
        { key: 'shop.orders', ddl: 'CREATE TABLE `orders` (\n  `id` bigint\n)' },
        { key: 'shop.ghost', error: 'Table \'ghost\' doesn\'t exist\nsecond line' },
        { key: 'shop.users', ddl: 'CREATE TABLE `users` (`id` int);' }
      ],
      reconstructed: false
    }, t);

    expect(script).toBe([
      '-- claw · shop · CREATE statements for 2 tables · exported from DataOmni on 2026-10-16',
      '-- 1 table could not be read and is not included:',
      '--   shop.ghost: Table \'ghost\' doesn\'t exist second line',
      '',
      `-- ${'-'.repeat(60)}`,
      '-- shop.orders',
      `-- ${'-'.repeat(60)}`,
      'CREATE TABLE `orders` (\n  `id` bigint\n);',
      '',
      `-- ${'-'.repeat(60)}`,
      '-- shop.users',
      `-- ${'-'.repeat(60)}`,
      'CREATE TABLE `users` (`id` int);',
      ''
    ].join('\n'));
  });

  it('全都读到时没有「读不到」那一行', () => {
    const script = buildDdlScript({
      title: 'c', database: 'd', date: '2026-10-16', tables: [{ key: 'd.a', ddl: 'CREATE TABLE a (x int)' }], reconstructed: false
    }, t);
    expect(script).not.toContain('could not be read');
    expect(script).not.toContain('rebuilt from the catalog');
  });

  it('重建的在开头说明；外键统一放到最后', () => {
    const script = buildDdlScript({
      title: 'pg',
      database: 'shop',
      date: '2026-10-16',
      tables: [
        { key: 'public.lines', ddl: 'CREATE TABLE "public"."lines" (x int);', foreignKeys: ['ALTER TABLE "public"."lines" ADD CONSTRAINT fk1;'] },
        { key: 'public.orders', ddl: 'CREATE TABLE "public"."orders" (id int);' }
      ],
      reconstructed: true
    }, t);
    const lines = script.split('\n');
    expect(lines[1]).toContain('rebuilt from the catalog');
    expect(script.indexOf('ALTER TABLE')).toBeGreaterThan(script.indexOf('CREATE TABLE "public"."orders"'));
    expect(script.trimEnd().endsWith('ALTER TABLE "public"."lines" ADD CONSTRAINT fk1;')).toBe(true);
  });
});

describe('dictionarySubset', () => {
  const table = (name: string): ErTable => ({ schema: 'shop', name, columns: [] });
  const link = (from: string, to: string): ErLink => ({
    constraintName: `${from}_${to}`,
    from: { table: `shop.${from}`, column: `${to}_id` },
    to: { table: `shop.${to}`, column: 'id' }
  });

  it('只留选中的表；外键有一端在选中的表里就留着', () => {
    const subset = dictionarySubset(
      [table('orders'), table('users'), table('logs')],
      [link('orders', 'users'), link('logs', 'users'), link('orders', 'logs')],
      new Set(['shop.orders'])
    );
    expect(subset.tables.map((t) => t.name)).toEqual(['orders']);
    expect(subset.links.map((l) => l.constraintName)).toEqual(['orders_users', 'orders_logs']);
  });
});

describe('orderByDependencies', () => {
  const link = (from: string, to: string): ErLink => ({
    constraintName: `${from}_${to}`,
    from: { table: from, column: 'x' },
    to: { table: to, column: 'id' }
  });

  it('被引用的表排前面；其余保持原次序；自引用与没选中的表不算', () => {
    const ordered = orderByDependencies(
      ['a_lines', 'b_misc', 'c_orders', 'd_users'],
      [link('a_lines', 'c_orders'), link('c_orders', 'd_users'), link('d_users', 'd_users'), link('b_misc', 'z_unselected')],
      (key) => key
    );
    expect(ordered).toEqual(['b_misc', 'd_users', 'c_orders', 'a_lines']);
  });

  it('互相引用时不卡住：能排的先排，环里的按原次序', () => {
    expect(orderByDependencies(['a', 'b', 'c'], [link('a', 'b'), link('b', 'a')], (key) => key)).toEqual(['c', 'a', 'b']);
  });
});

describe('mapWithConcurrency', () => {
  it('同时最多跑 limit 个，结果按输入次序', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 3, async (delay) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, delay));
      running -= 1;
      return delay * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(3);
  });

  it('空输入直接返回', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe('readTableDdls', () => {
  const queries: SchemaMetadataQueries = {
    columns: 'COLUMNS',
    indexes: 'INDEXES',
    foreign_keys: 'FKS',
    check_constraints: 'CHECKS',
    ddl: { kind: 'bound', sql: 'VIEWDEF' },
    triggers: 'TRIGGERS',
    triggers_by_show: null,
    parameter_count: 2
  };
  const table = (name: string): DatabaseObject => ({ schema: 'public', name, kind: 'table', id: name });
  const catalog = (sql: string, params: unknown[]) => {
    if (sql === 'COLUMNS') {
      return params[0] === 'gone' ? [] : [{ column_name: 'id', data_type: 'integer', is_nullable: false, is_primary_key: true, primary_key_ordinal: 1 }];
    }
    return [];
  };

  it('PostgreSQL 不认 SHOW CREATE TABLE：从目录重建；读不到列的表单独报', async () => {
    const progress: number[] = [];
    const result = await readTableDdls({
      tables: [table('orders'), table('gone')],
      dialect: 'postgresql',
      queries,
      select: async (sql, params) => {
        if (sql.startsWith('SHOW CREATE TABLE')) throw Object.assign(new Error('syntax error'), { code: '42601' });
        return catalog(sql, params);
      },
      t,
      onProgress: (done) => progress.push(done),
      concurrency: 2
    });
    expect(result.reconstructed).toBe(true);
    expect(result.tables[0]).toEqual({
      key: 'public.orders',
      ddl: 'CREATE TABLE "public"."orders" (\n  "id" integer NOT NULL,\n  PRIMARY KEY ("id")\n);',
      foreignKeys: []
    });
    expect(result.tables[1]).toEqual({ key: 'public.gone', error: 'The database returned no definition.' });
    expect(progress).toEqual([1, 2]);
  });

  it('CockroachDB 认 SHOW CREATE TABLE：用它的原文，不算重建', async () => {
    const result = await readTableDdls({
      tables: [table('orders')],
      dialect: 'postgresql',
      queries,
      select: async (sql) => (sql === 'SHOW CREATE TABLE "public"."orders"'
        ? [{ table_name: 'orders', create_statement: 'CREATE TABLE public.orders (id INT8 PRIMARY KEY)' }]
        : []),
      t,
      onProgress: () => {},
      concurrency: 2
    });
    expect(result).toEqual({
      tables: [{ key: 'public.orders', ddl: 'CREATE TABLE public.orders (id INT8 PRIMARY KEY)' }],
      reconstructed: false
    });
  });

  it('有原文的方言走 ddl 查询；一张报错不影响别的', async () => {
    const result = await readTableDdls({
      tables: [table('a'), table('b')],
      dialect: 'oracle',
      queries,
      select: async (_sql, params) => {
        if (params[0] === 'b') throw new Error('ORA-31603: object "B" not found');
        return [{ sql: `CREATE TABLE "${String(params[0])}" (x NUMBER)` }];
      },
      t,
      onProgress: () => {},
      concurrency: 2
    });
    expect(result.reconstructed).toBe(false);
    expect(result.tables[0]).toEqual({ key: 'public.a', ddl: 'CREATE TABLE "a" (x NUMBER);' });
    expect(result.tables[1]).toMatchObject({ key: 'public.b', error: expect.stringContaining('ORA-31603') });
  });
});
