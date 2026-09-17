import { describe, expect, it } from 'vitest';
import { quoteQualifiedSqlIdentifier, quoteSqlIdentifier } from './sqlIdentifiers';

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
