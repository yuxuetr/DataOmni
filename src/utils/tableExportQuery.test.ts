import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import { buildTableExportQuery, type TableExportQuery } from './tableExportQuery';
import { createTablePaginationOrder } from './tablePagination';

const COLUMNS: ColumnInfo[] = [
  { name: 'id', data_type: 'bigint', is_nullable: false, is_primary_key: true, default_value: undefined },
  { name: 'name', data_type: 'text', is_nullable: true, is_primary_key: false, default_value: undefined },
  { name: 'secret', data_type: 'text', is_nullable: true, is_primary_key: false, default_value: undefined }
];

function request(overrides: Partial<TableExportQuery> = {}): TableExportQuery {
  return {
    schema: 'public',
    table: 'orders',
    columns: COLUMNS,
    visibleColumns: ['id', 'name', 'secret'],
    filters: [],
    paginationOrder: createTablePaginationOrder(COLUMNS, 'postgresql'),
    sort: null,
    dialect: 'postgresql',
    ...overrides
  };
}

describe('整表导出的 SQL', () => {
  it('投影出去的是可见列，藏起来的列不进文件', () => {
    const sql = buildTableExportQuery(request({ visibleColumns: ['id', 'name'] }));
    expect(sql).toContain('SELECT "id", "name" FROM "public"."orders"');
    expect(sql).not.toContain('secret');
  });

  it('不带 LIMIT 或 OFFSET——整表导出正是不分页的那一份', () => {
    const sql = buildTableExportQuery(request()) ?? '';
    expect(sql).not.toMatch(/\bLIMIT\b/i);
    expect(sql).not.toMatch(/\bOFFSET\b/i);
  });

  it('当前的筛选照样生效', () => {
    // 筛过之后导出的该是筛出来的那些行。漏掉 WHERE，文件会比用户预期大几个
    // 数量级，而界面上没有任何地方提示过这件事
    const sql = buildTableExportQuery(
      request({ filters: [{ id: 'f1', column: 'name', operator: 'eq', value: '张三' }] })
    );
    expect(sql).toContain('WHERE');
    expect(sql).toContain('"name"');
  });

  it('保留排序：不分页也要有确定的次序，否则导两次得到两份文件', () => {
    const sql = buildTableExportQuery(request({ sort: { column: 'name', direction: 'desc' } }));
    // 决胜列不写方向，ASC 是 SQL 的默认——createSortedOrderClause 一直这么拼
    expect(sql).toContain('ORDER BY "name" DESC, "id"');
  });

  it('没有 schema 时只引用表名', () => {
    expect(buildTableExportQuery(request({ schema: null }))).toContain('FROM "orders"');
  });

  it('MySQL 用反引号', () => {
    const sql = buildTableExportQuery(
      request({
        dialect: 'mysql',
        paginationOrder: createTablePaginationOrder(COLUMNS, 'mysql')
      })
    );
    expect(sql).toContain('SELECT `id`, `name`, `secret` FROM `public`.`orders`');
  });

  /**
   * 这一条钉的是一次真实的白屏，不是一个假想的边界。
   *
   * 表结构读不到（表被别人删了、或者账号看不到 information_schema）时，
   * `paginationOrder` 是 null。此前调用方写的是
   * `paginationOrder ?? createTablePaginationOrder(columns)`，而那个函数在列
   * 为空时会抛；它又恰好在 useMemo 里，也就是**渲染期**。渲染期抛出去的异常
   * 会把整棵 React 树卸掉——不是这个标签页报错，是整个窗口变白，其它标签和
   * 没保存的草稿一起没了。
   *
   * 这条断言同时是一道编译期的门：谁把 `paginationOrder` 的类型改回非空，
   * 这里传 null 就过不了 `bun run typecheck`，逼着重新想一遍渲染期怎么办。
   */
  it('还没有分页排序时返回 null，而不是现造一个', () => {
    expect(buildTableExportQuery(request({ paginationOrder: null }))).toBeNull();
  });

  it('一列都不可见时返回 null，而不是拼出一条不合法的 SELECT', () => {
    // `SELECT  FROM t` 会在点下导出之后才报语法错误，那时用户已经选完路径了
    expect(buildTableExportQuery(request({ visibleColumns: [] }))).toBeNull();
    expect(buildTableExportQuery(request({ visibleColumns: [''] }))).toBeNull();
  });
});
