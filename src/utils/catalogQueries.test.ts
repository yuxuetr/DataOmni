import { describe, expect, it } from 'vitest';
import { catalogQueryParams, ddlRequest } from './catalogQueries';

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
