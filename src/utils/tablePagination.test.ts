import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import {
  createSortedOrderClause,
  createTablePaginationOrder,
  firstRowsQuery,
  pageClause,
  tableProjection
} from './tablePagination';

const column = (
  name: string,
  isPrimaryKey = false,
  primaryKeyOrdinal?: number
): ColumnInfo => ({
  name,
  data_type: 'text',
  is_nullable: false,
  is_primary_key: isPrimaryKey,
  primary_key_ordinal: primaryKeyOrdinal
});

describe('createTablePaginationOrder', () => {
  it('orders by every primary key column in key order', () => {
    const order = createTablePaginationOrder([
      column('tenant_id', true, 2),
      column('record_id', true, 1),
      column('payload')
    ], 'postgresql');

    expect(order).toEqual({
      clause: 'ORDER BY "record_id", "tenant_id"',
      strategy: 'primary-key',
      columns: ['record_id', 'tenant_id'],
      stableAcrossChanges: true
    });
  });

  it('uses physical row identifiers for SQLite and PostgreSQL tables without keys', () => {
    expect(createTablePaginationOrder([column('value')], 'sqlite').clause)
      .toBe('ORDER BY rowid');
    expect(createTablePaginationOrder([column('rowid'), column('value')], 'sqlite').clause)
      .toBe('ORDER BY _rowid_');
    expect(createTablePaginationOrder([column('value')], 'postgresql').clause)
      .toBe('ORDER BY ctid');
  });

  it('DuckDB 的表同样按 rowid 翻页；只有这一个别名，被列名占了就退回全部列', () => {
    expect(createTablePaginationOrder([column('value')], 'duckdb').clause).toBe('ORDER BY rowid');
    expect(createTablePaginationOrder([column('rowid'), column('value')], 'duckdb').clause)
      .toBe('ORDER BY "rowid", "value"');
  });

  it('uses all MySQL columns as a deterministic fallback', () => {
    expect(createTablePaginationOrder([
      column('group'),
      column('created_at')
    ], 'mysql')).toMatchObject({
      clause: 'ORDER BY `group`, `created_at`',
      strategy: 'all-columns',
      stableAcrossChanges: false
    });
  });

  it('SQL Server 没有主键时跳过不能排序的列：ORDER BY 里有一列 xml，整张表就打不开', () => {
    const typed = (name: string, dataType: string): ColumnInfo => ({
      name, data_type: dataType, is_nullable: true, is_primary_key: false
    });
    const order = createTablePaginationOrder([
      typed('a', 'int'), typed('x', 'xml'), typed('t', 'text'), typed('nt', 'ntext'),
      typed('im', 'image'), typed('g', 'geography'), typed('gm', 'geometry'),
      typed('h', 'hierarchyid'), typed('m', 'nvarchar(max)')
    ], 'sqlserver');
    expect(order.clause).toBe('ORDER BY [a], [h], [m]');
    expect(order.strategy).toBe('all-columns');
    // 一列都排不了时不抛：分页那一步会补 ORDER BY (SELECT NULL)
    const none = createTablePaginationOrder([typed('x', 'xml')], 'sqlserver');
    expect(none.clause).toBe('');
    expect(pageClause(createSortedOrderClause(none, null, 'sqlserver'), 50, 0, 'sqlserver'))
      .toBe('ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY');
  });
});

describe('用户排序与分页排序的合并', () => {
  const columns: ColumnInfo[] = [
    { name: 'id', data_type: 'int', is_nullable: false, is_primary_key: true },
    { name: 'city', data_type: 'text', is_nullable: true, is_primary_key: false }
  ] as ColumnInfo[];

  it('没有用户排序时就是分页排序本身', () => {
    const order = createTablePaginationOrder(columns, 'postgresql');
    expect(createSortedOrderClause(order, null, 'postgresql')).toBe(order.clause);
  });

  it('用户排序在前，主键追加在后作为决胜条件', () => {
    // 少了决胜条件，按不唯一的 city 排序时翻页会重复或漏行
    const order = createTablePaginationOrder(columns, 'postgresql');
    expect(createSortedOrderClause(order, { column: 'city', direction: 'asc' }, 'postgresql'))
      .toBe('ORDER BY "city" ASC, "id"');
  });

  it('降序同样保留决胜条件', () => {
    const order = createTablePaginationOrder(columns, 'postgresql');
    expect(createSortedOrderClause(order, { column: 'city', direction: 'desc' }, 'postgresql'))
      .toBe('ORDER BY "city" DESC, "id"');
  });

  it('排序列本身就是主键时不重复追加', () => {
    const order = createTablePaginationOrder(columns, 'postgresql');
    expect(createSortedOrderClause(order, { column: 'id', direction: 'desc' }, 'postgresql'))
      .toBe('ORDER BY "id" DESC');
  });

  it('MySQL 用反引号', () => {
    const order = createTablePaginationOrder(columns, 'mysql');
    expect(createSortedOrderClause(order, { column: 'city', direction: 'asc' }, 'mysql'))
      .toBe('ORDER BY `city` ASC, `id`');
  });

  it('没有主键时 PostgreSQL 用 ctid 决胜，且不加引号', () => {
    const noPrimaryKey = [
      { name: 'city', data_type: 'text', is_nullable: true, is_primary_key: false }
    ] as ColumnInfo[];
    const order = createTablePaginationOrder(noPrimaryKey, 'postgresql');
    expect(createSortedOrderClause(order, { column: 'city', direction: 'asc' }, 'postgresql'))
      .toBe('ORDER BY "city" ASC, ctid');
  });

  it('没有主键时 SQLite 用 rowid 决胜，且不加引号', () => {
    const noPrimaryKey = [
      { name: 'city', data_type: 'text', is_nullable: true, is_primary_key: false }
    ] as ColumnInfo[];
    const order = createTablePaginationOrder(noPrimaryKey, 'sqlite');
    expect(createSortedOrderClause(order, { column: 'city', direction: 'asc' }, 'sqlite'))
      .toBe('ORDER BY "city" ASC, rowid');
  });

  it('列名里的引号被转义，不会拼出越界的 SQL', () => {
    const order = createTablePaginationOrder(columns, 'postgresql');
    expect(createSortedOrderClause(order, { column: 'we"ird', direction: 'asc' }, 'postgresql'))
      .toBe('ORDER BY "we""ird" ASC, "id"');
  });
});

describe('没有列的表', () => {
  /**
   * 空列不是一张「没有列的表」——SQL 里没有这种表。它意味着**读结构失败了**，
   * 所以这里抛而不是返回一个空的 ORDER BY：静默地拼出一条没有次序的查询，
   * 翻页时同一行会重复出现或整行消失，而没有任何地方提示过。
   *
   * 抛出去的前提是调用方接得住。两个调用点都在 async 的加载函数里、外面套着
   * try/catch；**渲染期一处都不许有**——那里抛出去是整个应用白屏。
   */
  it('抛错而不是拼出一条没有次序的查询', () => {
    expect(() => createTablePaginationOrder([], 'mysql')).toThrow();
  });
});

describe('pageClause', () => {
  it('uses LIMIT / OFFSET where it exists', () => {
    expect(pageClause('ORDER BY "id"', 50, 100, 'postgresql')).toBe('ORDER BY "id" LIMIT 50 OFFSET 100');
    expect(pageClause('ORDER BY `id`', 50, 0, 'mysql')).toBe('ORDER BY `id` LIMIT 50 OFFSET 0');
  });

  it('uses OFFSET … FETCH on SQL Server, which has no LIMIT and needs an ORDER BY', () => {
    expect(pageClause('ORDER BY [id]', 50, 100, 'sqlserver'))
      .toBe('ORDER BY [id] OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY');
    expect(pageClause('', 25, 0, 'sqlserver'))
      .toBe('ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 25 ROWS ONLY');
  });
});

describe('firstRowsQuery', () => {
  it('quotes the names and uses the dialect\'s own row limit', () => {
    expect(firstRowsQuery('order items', 'sales', 100, 'postgresql'))
      .toBe('SELECT * FROM "sales"."order items" LIMIT 100;');
    expect(firstRowsQuery('order', undefined, 100, 'mysql')).toBe('SELECT * FROM `order` LIMIT 100;');
    expect(firstRowsQuery('order]x', 'dbo', 100, 'sqlserver')).toBe('SELECT TOP 100 * FROM [dbo].[order]]x];');
  });
});

describe('ClickHouse 的分页排序', () => {
  it('主键不唯一：主键列在前，其余列跟上，不说「翻页稳定」', () => {
    const columns = [
      { name: 'name', data_type: 'String', is_nullable: false, is_primary_key: false },
      { name: 'ts', data_type: 'DateTime', is_nullable: false, is_primary_key: true, primary_key_ordinal: 2 },
      { name: 'id', data_type: 'UInt64', is_nullable: false, is_primary_key: true, primary_key_ordinal: 1 }
    ];
    const order = createTablePaginationOrder(columns, 'clickhouse');
    expect(order.clause).toBe('ORDER BY `id`, `ts`, `name`');
    expect(order.strategy).toBe('all-columns');
    expect(order.stableAcrossChanges).toBe(false);
  });
});

describe('取表数据的投影', () => {
  const column = (name: string, extra: string | null = null) => ({
    name, data_type: 'UInt64', is_nullable: false, is_primary_key: false,
    is_generated: extra !== null, column_extra: extra
  });

  it('ClickHouse 的 * 不含 MATERIALIZED / ALIAS：有这种列就点名，EPHEMERAL 不点', () => {
    expect(tableProjection([column('id'), column('m', 'MATERIALIZED id * 2'), column('raw', 'EPHEMERAL ')], 'clickhouse'))
      .toBe('`id`, `m`');
    expect(tableProjection([column('id'), column('v')], 'clickhouse')).toBe('*');
    expect(tableProjection([column('id'), column('g', 'STORED GENERATED')], 'mysql')).toBe('*');
  });

  it('* 不含 MySQL 的 INVISIBLE 与 SQL Server 的 HIDDEN 列：有这种列就点名，不然网格里那一列整列是 NULL', () => {
    const extra = (name: string, columnExtra: string | null) => ({
      name, data_type: 'int', is_nullable: true, is_primary_key: false, column_extra: columnExtra
    });
    expect(tableProjection([extra('id', ''), extra('secret', 'INVISIBLE')], 'mysql')).toBe('`id`, `secret`');
    // MariaDB 的 EXTRA 写法
    expect(tableProjection([extra('id', ''), extra('ts', 'on update current_timestamp(3), INVISIBLE')], 'mysql'))
      .toBe('`id`, `ts`');
    expect(tableProjection([extra('id', null), extra('vt', 'HIDDEN')], 'sqlserver')).toBe('[id], [vt]');
    expect(tableProjection([extra('id', null), extra('sp', 'SPARSE')], 'sqlserver')).toBe('*');
    // Oracle 12c 的 INVISIBLE（列目录在 column_extra 里标出来）
    expect(tableProjection([extra('ID', null), extra('SECRET', 'INVISIBLE')], 'oracle')).toBe('"ID", "SECRET"');
    expect(tableProjection([extra('id', ''), extra('n', 'auto_increment')], 'mysql')).toBe('*');
  });

  it('SQL Server 驱动读不了的列转成文本再取：不然这张表整张打不开，而报错让用户去改一条他看不到的查询', () => {
    const typed = (name: string, dataType: string) => ({
      name, data_type: dataType, is_nullable: true, is_primary_key: false
    });
    expect(tableProjection([
      typed('id', 'int'), typed('v', 'sql_variant'), typed('g', 'geography'),
      typed('gm', 'geometry'), typed('h', 'hierarchyid')
    ], 'sqlserver')).toBe(
      '[id], CAST([v] AS nvarchar(max)) AS [v], CAST([g] AS nvarchar(max)) AS [g], '
      + 'CAST([gm] AS nvarchar(max)) AS [gm], CAST([h] AS nvarchar(max)) AS [h]'
    );
    // 没有这种列时照旧是 *
    expect(tableProjection([typed('id', 'int'), typed('x', 'xml')], 'sqlserver')).toBe('*');
  });

  it('SQL Server 的 money 转成 decimal 再取：驱动按 f64 解，九千亿以上末几位不对，守卫拿它比也永远比不上', () => {
    const typed = (name: string, dataType: string) => ({
      name, data_type: dataType, is_nullable: true, is_primary_key: false
    });
    expect(tableProjection([typed('id', 'int'), typed('m', 'money'), typed('s', 'smallmoney')], 'sqlserver')).toBe(
      '[id], CAST([m] AS decimal(19,4)) AS [m], [s]'
    );
  });

  it('PostgreSQL 解码器不认的列转成文本再取：一列 inet 或枚举，整张表就打不开', () => {
    const typed = (name: string, dataType: string) => ({
      name, data_type: dataType, is_nullable: true, is_primary_key: false
    });
    expect(tableProjection([
      typed('id', 'bigint'), typed('ip', 'inet'), typed('mood', 'mood'), typed('m', 'public."Money Kind"')
    ], 'postgresql')).toBe(
      '"id", "ip"::text AS "ip", "mood"::text AS "mood", "m"::text AS "m"'
    );
    // 按整个类型名认，不按首词：timetz 与 float8[] 解码器都不认，首词却是 time 与 double
    expect(tableProjection([
      typed('t', 'time with time zone'), typed('f', 'double precision[]')
    ], 'postgresql')).toBe('"t"::text AS "t", "f"::text AS "f"');
    // 全是认得的（类型修饰去掉再比）时照旧是 *
    expect(tableProjection([
      typed('a', 'character varying(20)'), typed('b', 'numeric(10,2)'),
      typed('c', 'timestamp(3) with time zone'), typed('d', 'character varying(8)[]'),
      typed('e', 'double precision'), typed('f', 'time without time zone'), typed('g', 'jsonb'),
      typed('h', 'bigint[]'), typed('i', 'interval'), typed('j', 'uuid'), typed('k', 'bytea')
    ], 'postgresql')).toBe('*');
  });

  it('Oracle 带时区的时间戳由服务端写成文本：存的是地区名时，客户端时区文件版本不同就整条 ORA-01805', () => {
    const typed = (name: string, dataType: string) => ({
      name, data_type: dataType, is_nullable: true, is_primary_key: false
    });
    // 与驱动读出来的写法相同：小数秒去掉末尾的 0，时区写成偏移——会话的格式按偏移解析，写得回去
    expect(tableProjection([
      typed('ID', 'NUMBER(10)'), typed('AT', 'TIMESTAMP(3) WITH TIME ZONE'), typed('LT', 'TIMESTAMP(6) WITH LOCAL TIME ZONE')
    ], 'oracle')).toBe(
      `"ID", REGEXP_REPLACE(TO_CHAR("AT", 'YYYY-MM-DD HH24:MI:SS.FF'), '\\.?0*$') || TO_CHAR("AT", ' TZH:TZM') AS "AT", "LT"`
    );
    expect(tableProjection([typed('ID', 'NUMBER(10)'), typed('T', 'TIMESTAMP(6)')], 'oracle')).toBe('*');
  });

  it('Oracle 的原生 JSON 与 VECTOR 列由服务端写成文本：驱动读不了，整条查询失败', () => {
    const typed = (name: string, dataType: string) => ({
      name, data_type: dataType, is_nullable: true, is_primary_key: false
    });
    expect(tableProjection([typed('ID', 'NUMBER(10)'), typed('DOC', 'JSON')], 'oracle')).toBe(
      '"ID", JSON_SERIALIZE("DOC" RETURNING CLOB) AS "DOC"'
    );
    // 23ai 的 VECTOR 同样：驱动不认这个类型号（unknown Oracle type number 2033）
    expect(tableProjection([typed('ID', 'NUMBER(10)'), typed('EMB', 'VECTOR')], 'oracle')).toBe(
      '"ID", VECTOR_SERIALIZE("EMB" RETURNING CLOB) AS "EMB"'
    );
    // 存成 CLOB / VARCHAR2 的 JSON 驱动读得了，不动
    expect(tableProjection([typed('ID', 'NUMBER(10)'), typed('DOC', 'CLOB')], 'oracle')).toBe('*');
  });
});
