import { describe, expect, it } from 'vitest';
import { normalizeSessionTarget, UNKNOWN_SESSION_TARGET } from './sessionTarget';

describe('normalizeSessionTarget', () => {
  it('PostgreSQL：库名、schema、布尔只读', () => {
    expect(
      normalizeSessionTarget({
        database_name: 'dataomni_demo',
        schema_name: 'public',
        read_only: false
      })
    ).toEqual({ database: 'dataomni_demo', schema: 'public', readOnly: false });
  });

  it('MySQL：schema 为 NULL，只读是 0 / 1', () => {
    expect(
      normalizeSessionTarget({
        database_name: 'shop',
        schema_name: null,
        read_only: 1
      })
    ).toEqual({ database: 'shop', schema: null, readOnly: true });
  });

  it('SQLite：库名与 schema 都没有', () => {
    expect(
      normalizeSessionTarget({ database_name: null, schema_name: null, read_only: 0 })
    ).toEqual({ database: null, schema: null, readOnly: false });
  });

  it('空串当作没有名字，不显示成一段空白', () => {
    expect(normalizeSessionTarget({ database_name: '  ', schema_name: '', read_only: 0 }))
      .toEqual({ database: null, schema: null, readOnly: false });
  });

  it('认不出的只读值按可写处理', () => {
    // 把一个可写的连接标成只读，会让人绕开本来能做的事
    expect(normalizeSessionTarget({ read_only: 'yes' }).readOnly).toBe(false);
    expect(normalizeSessionTarget({ read_only: undefined }).readOnly).toBe(false);
  });

  it('没有行时给出「未知」而不是抛错', () => {
    expect(normalizeSessionTarget(undefined)).toEqual(UNKNOWN_SESSION_TARGET);
  });
});
