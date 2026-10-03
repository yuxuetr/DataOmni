import { describe, expect, it } from 'vitest';
import { SUPPORTED_DATABASE_TYPES, speaksSql } from '../contracts/databaseSupport';
import {
  identifierDialectFor,
  quoteQualifiedSqlIdentifier,
  quoteSqlIdentifier,
  sqlIdentifierAsTyped
} from './sqlIdentifiers';

describe('quoteSqlIdentifier', () => {
  it('quotes and escapes MySQL identifiers', () => {
    expect(quoteSqlIdentifier('order`item', 'mysql')).toBe('`order``item`');
  });

  it('quotes and escapes PostgreSQL identifiers', () => {
    expect(quoteSqlIdentifier('order"item', 'postgresql')).toBe('"order""item"');
  });

  it('quotes each part of a qualified identifier', () => {
    expect(quoteQualifiedSqlIdentifier(['public', 'order'], 'postgresql')).toBe(
      '"public"."order"'
    );
  });
});

describe('ClickHouse 标识符', () => {
  it('反引号里反斜杠也要转义（25.8 上核对过这几个名字）', () => {
    expect(quoteSqlIdentifier('a`b', 'clickhouse')).toBe('`a``b`');
    expect(quoteSqlIdentifier('e\\f', 'clickhouse')).toBe('`e\\\\f`');
  });
});

describe('identifierDialectFor', () => {
  // 不认识的类型回落到 sqlite 是给「别让界面整个打掉」的容错；而一个真的接进来的方言
  // 落到那里，就是静默地用错引用规则、分页写法、截断语句。每种走 SQL 的类型都得是它自己
  it('每种走 SQL 的类型都认得出，不回落', () => {
    for (const type of SUPPORTED_DATABASE_TYPES) {
      if (speaksSql(type)) {
        expect(identifierDialectFor(type), type).toBe(type);
      }
    }
  });
});

describe('sqlIdentifierAsTyped', () => {
  it('能裸写的原样给，不能的加上各方言的引号', () => {
    expect(sqlIdentifierAsTyped('orders', 'postgresql')).toBe('orders');
    expect(sqlIdentifierAsTyped('Orders', 'postgresql')).toBe('"Orders"');
    expect(sqlIdentifierAsTyped('ORDERS', 'oracle')).toBe('ORDERS');
    expect(sqlIdentifierAsTyped('Orders', 'oracle')).toBe('"Orders"');
    expect(sqlIdentifierAsTyped('Orders', 'sqlite')).toBe('Orders');
    expect(sqlIdentifierAsTyped('Orders', 'duckdb')).toBe('Orders');
    expect(sqlIdentifierAsTyped('a b', 'clickhouse')).toBe('`a b`');
    expect(sqlIdentifierAsTyped('2fa', 'mysql')).toBe('`2fa`');
    expect(sqlIdentifierAsTyped('订单', 'sqlserver')).toBe('[订单]');
  });

  it('保留字不分大小写都加引号', () => {
    expect(sqlIdentifierAsTyped('Order', 'mysql')).toBe('`Order`');
    expect(sqlIdentifierAsTyped('USER', 'oracle')).toBe('"USER"');
    expect(sqlIdentifierAsTyped('group', 'sqlite')).toBe('"group"');
  });
});
