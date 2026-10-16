import { describe, expect, it } from 'vitest';
import { translate } from '../i18n/translate';
import { buildDdlScript, dictionarySubset, mapWithConcurrency } from './schemaExport';
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
      ]
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
      title: 'c', database: 'd', date: '2026-10-16', tables: [{ key: 'd.a', ddl: 'CREATE TABLE a (x int)' }]
    }, t);
    expect(script).not.toContain('could not be read');
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
