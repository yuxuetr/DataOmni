import { describe, expect, it } from 'vitest';
import { SUPPORTED_DATABASE_TYPES, speaksSql } from '../contracts/databaseSupport';
import { identifierDialectFor, quoteQualifiedSqlIdentifier, quoteSqlIdentifier } from './sqlIdentifiers';

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
