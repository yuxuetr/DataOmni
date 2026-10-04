import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import { buildFilterClause, isCompleteFilter, type ColumnFilter } from './tableFilters';

function column(name: string, dataType = 'text'): ColumnInfo {
  return { name, data_type: dataType, is_nullable: true, is_primary_key: false };
}

const COLUMNS = [column('name'), column('id', 'bigint'), column('note'), column('span', 'interval')];

function filter(overrides: Partial<ColumnFilter>): ColumnFilter {
  return { id: 'f1', column: 'name', operator: 'eq', value: '', ...overrides };
}

describe('isCompleteFilter', () => {
  it('值还空着的条件不算填完', () => {
    // 选完列还没开始打字时，表不能先空掉一次
    expect(isCompleteFilter(filter({ operator: 'eq', value: '' }))).toBe(false);
    expect(isCompleteFilter(filter({ operator: 'eq', value: 'a' }))).toBe(true);
  });

  it('IS NULL 类不需要值', () => {
    expect(isCompleteFilter(filter({ operator: 'is-null', value: '' }))).toBe(true);
  });

  it('没选列就不算', () => {
    expect(isCompleteFilter(filter({ column: '', operator: 'is-null' }))).toBe(false);
  });
});

describe('buildFilterClause', () => {
  it('没有条件时返回空串，不返回一个空的 WHERE', () => {
    expect(buildFilterClause([], COLUMNS, 'postgresql')).toBe('');
    expect(buildFilterClause([filter({ value: '' })], COLUMNS, 'postgresql')).toBe('');
  });

  it('多条之间用 AND', () => {
    const clause = buildFilterClause(
      [
        filter({ id: 'a', column: 'name', operator: 'eq', value: 'ann' }),
        filter({ id: 'b', column: 'note', operator: 'is-not-null' })
      ],
      COLUMNS,
      'postgresql'
    );
    expect(clause).toBe(`WHERE "name" = 'ann' AND "note" IS NOT NULL`);
  });

  it('列名和值都被引用，撇号不会把语句拆断', () => {
    const clause = buildFilterClause(
      [filter({ column: 'name', operator: 'eq', value: "O'Brien" })],
      COLUMNS,
      'mysql'
    );
    expect(clause).toBe("WHERE `name` = 'O''Brien'");
  });

  it('LIKE 里的通配符被转义成字面字符', () => {
    // 不转义的话，搜 `100%` 会搜到所有 100 开头的值，而且不会报错
    const clause = buildFilterClause(
      [filter({ column: 'note', operator: 'contains', value: '100%' })],
      COLUMNS,
      'postgresql'
    );
    expect(clause).toBe(`WHERE "note" LIKE '%100!%%' ESCAPE '!'`);
  });

  it('starts-with 与 ends-with 把通配符放在对应的一端', () => {
    expect(
      buildFilterClause([filter({ column: 'note', operator: 'starts-with', value: 'ab' })], COLUMNS, 'sqlite')
    ).toBe(`WHERE "note" LIKE 'ab%' ESCAPE '!'`);
    expect(
      buildFilterClause([filter({ column: 'note', operator: 'ends-with', value: 'ab' })], COLUMNS, 'sqlite')
    ).toBe(`WHERE "note" LIKE '%ab' ESCAPE '!'`);
  });

  it('数值列上的数字不加引号', () => {
    // MySQL 拿字符串和数字比较时会把两边都转成 DOUBLE，
    // 超过 2^53 的 BIGINT 会和邻近几个值比成相等，筛出来的行是错的而语句不报错
    expect(
      buildFilterClause(
        [filter({ column: 'id', operator: 'gt', value: '9223372036854775806' })],
        COLUMNS,
        'mysql'
      )
    ).toBe('WHERE `id` > 9223372036854775806');
  });

  it('PostgreSQL 的 money 与 real 上数字照样加引号，交给它按列类型转', () => {
    const eq = (name: string, value: string) => filter({ column: name, operator: 'eq', value });
    // money = 12.5 报 operator does not exist: money = numeric
    expect(buildFilterClause([eq('m', '12.5')], [column('m', 'money')], 'postgresql'))
      .toBe(`WHERE "m" = '12.5'`);
    // real = 1.1 把列提升成 double 去比 1.1，1.1::real 是 1.10000002…，一行也中不了
    expect(buildFilterClause([eq('r', '1.1')], [column('r', 'real')], 'postgresql'))
      .toBe(`WHERE "r" = '1.1'`);
    expect(buildFilterClause([eq('d', '1.1')], [column('d', 'double precision')], 'postgresql'))
      .toBe('WHERE "d" = 1.1');
  });

  it('MySQL 的 FLOAT 拿同样是单精度的值去比', () => {
    // fl = 1.1 与 fl = '1.1' 都中不了，fl > 1.1 反而把存的 1.1 筛进来
    expect(buildFilterClause([filter({ column: 'f', operator: 'gt', value: '1.1' })], [column('f', 'float')], 'mysql'))
      .toBe('WHERE `f` > CAST(1.1 AS FLOAT)');
    expect(buildFilterClause([filter({ column: 'f', operator: 'eq', value: 'x' })], [column('f', 'float')], 'mysql'))
      .toBe("WHERE `f` = 'x'");
  });

  it('ClickHouse 的数值列反而要加引号', () => {
    // 它把带小数点的字面量和超过 64 位的整数读成 Float64：Int128 上 …727 会把 …728 也筛出来，
    // Decimal 上 -999999999999.0000000000 一行也筛不中。字符串字面量按列类型转，25.8 上逐个核过
    const columns = [column('i128', 'Int128'), column('dec', 'Decimal(38, 10)')];
    expect(
      buildFilterClause(
        [
          filter({ column: 'i128', operator: 'eq', value: '-170141183460469231731687303715884105727' }),
          filter({ column: 'dec', operator: 'lt', value: '-999999999999.0000000000' })
        ],
        columns,
        'clickhouse'
      )
    ).toBe("WHERE `i128` = '-170141183460469231731687303715884105727' AND `dec` < '-999999999999.0000000000'");
  });

  it('文本列上的数字仍然加引号', () => {
    // '007' 和 7 不是一回事
    expect(
      buildFilterClause([filter({ column: 'name', operator: 'eq', value: '007' })], COLUMNS, 'mysql')
    ).toBe("WHERE `name` = '007'");
  });

  it('数值列上填了非数字时退回字符串字面量', () => {
    // 让数据库去报那句「invalid input syntax」，而不是拼出一个裸的 abc
    expect(
      buildFilterClause([filter({ column: 'id', operator: 'eq', value: 'abc' })], COLUMNS, 'postgresql')
    ).toBe(`WHERE "id" = 'abc'`);
  });

  it('interval 不因为含有 int 被当成数值列', () => {
    expect(
      buildFilterClause([filter({ column: 'span', operator: 'eq', value: '3' })], COLUMNS, 'postgresql')
    ).toBe(`WHERE "span" = '3'`);
  });

  it('丢掉引用不到的列', () => {
    // 切换表之后旧条件还留在 state 里，拿去拼只会得到一句「加载失败」
    expect(
      buildFilterClause([filter({ column: 'gone', operator: 'eq', value: 'x' })], COLUMNS, 'postgresql')
    ).toBe('');
  });

  it('ClickHouse 的 LIKE 没有 ESCAPE，用反斜杠转义，字面量层再写一遍', () => {
    // 25.8 上跑过：这一句对 '100%_C:\\x' 为真，对 '100a_C:\\x'、'100%bC:\\x' 为假
    expect(
      buildFilterClause(
        [filter({ column: 'note', operator: 'contains', value: '100%_C:\\x' })],
        COLUMNS,
        'clickhouse'
      )
    ).toBe("WHERE `note` LIKE '%100\\\\%\\\\_C:\\\\\\\\x%'");
    expect(
      buildFilterClause([filter({ column: 'name', operator: 'eq', value: "O'Brien\\" })], COLUMNS, 'clickhouse')
    ).toBe("WHERE `name` = 'O''Brien\\\\'");
  });

  it('SQL Server 的 LIKE 把 [ 当字符类，搜 [draft] 要转义', () => {
    // 2022 上跑过：不转义时 '%[draft]%' 也匹配 'raw'（含 d/r/a/f/t 任一字符即中）
    expect(
      buildFilterClause(
        [filter({ column: 'note', operator: 'contains', value: '[draft]' })],
        COLUMNS,
        'sqlserver'
      )
    ).toBe("WHERE [note] LIKE N'%![draft]%' ESCAPE N'!'");
    // 其余方言的 [ 不是通配符，原样留着
    expect(
      buildFilterClause(
        [filter({ column: 'note', operator: 'contains', value: '[draft]' })],
        COLUMNS,
        'postgresql'
      )
    ).toBe(`WHERE "note" LIKE '%[draft]%' ESCAPE '!'`);
  });

  it('PostgreSQL、DuckDB、ClickHouse 在非字符串列上「包含」先转成文本', () => {
    // 这三家的 LIKE 只收字符串：PG 16 报 operator does not exist: integer ~~ text，DuckDB 报
    // No function matches like_escape(UUID, …)，ClickHouse 25.8 报 Illegal type Date of argument of function like
    const contains = (name: string) => filter({ column: name, operator: 'contains', value: '5' });
    expect(buildFilterClause([contains('id')], COLUMNS, 'postgresql'))
      .toBe(`WHERE CAST("id" AS text) LIKE '%5%' ESCAPE '!'`);
    expect(buildFilterClause([contains('u')], [column('u', 'UUID')], 'duckdb'))
      .toBe(`WHERE CAST("u" AS VARCHAR) LIKE '%5%' ESCAPE '!'`);
    expect(buildFilterClause([contains('d')], [column('d', 'Nullable(Date)')], 'clickhouse'))
      .toBe("WHERE toString(`d`) LIKE '%5%'");
    // 字符串列不转：citext 转成 text 就成了区分大小写，前缀匹配也用不上索引
    for (const dataType of ['text', 'character varying(20)', 'character(3)', 'citext']) {
      expect(buildFilterClause([contains('s')], [column('s', dataType)], 'postgresql'))
        .toBe(`WHERE "s" LIKE '%5%' ESCAPE '!'`);
    }
    expect(buildFilterClause([contains('s')], [column('s', 'LowCardinality(Nullable(String))')], 'clickhouse'))
      .toBe("WHERE `s` LIKE '%5%'");
    // 别家自己会转，原样
    expect(buildFilterClause([contains('id')], COLUMNS, 'mysql')).toBe("WHERE `id` LIKE '%5%' ESCAPE '!'");
  });

  it('ClickHouse 的 Decimal 上「包含」补齐小数位，和网格一样', () => {
    // toString 去掉末尾的 0：网格里的 12.50 是 '12.5'、3.00 是 '3'，搜 12.50 一行也中不了（25.8 上试过）
    const contains = filter({ column: 'd', operator: 'contains', value: '12.50' });
    expect(buildFilterClause([contains], [column('d', 'Decimal(10, 2)')], 'clickhouse'))
      .toBe("WHERE toDecimalString(`d`, 2) LIKE '%12.50%'");
    expect(buildFilterClause([contains], [column('d', 'Nullable(Decimal(38, 9))')], 'clickhouse'))
      .toBe("WHERE toDecimalString(`d`, 9) LIKE '%12.50%'");
    // 没有小数位的照旧
    expect(buildFilterClause([contains], [column('d', 'Decimal(18, 0)')], 'clickhouse'))
      .toBe("WHERE toString(`d`) LIKE '%12.50%'");
  });

  it('Oracle 的 NUMBER 与 TIMESTAMP 上「包含」按网格的写法转成文本', () => {
    // 隐式转换写成 `12.5`、`.5`、`03:04:05.000000`：网格里的 12.50、0.5、`03:04:05` 一行也中不了（23 Free 上试过）
    const contains = (name: string) => filter({ column: name, operator: 'contains', value: '0.5' });
    expect(buildFilterClause([contains('d')], [column('d', 'NUMBER(10,2)')], 'oracle'))
      .toBe("WHERE TO_CHAR(\"d\", 'FM99999990.00') LIKE '%0.5%' ESCAPE '!'");
    // 标度比精度大（NUMBER(2,5) 存 0.00012）时整数部分仍留一个 0
    expect(buildFilterClause([contains('s')], [column('s', 'NUMBER(2,5)')], 'oracle'))
      .toBe("WHERE TO_CHAR(\"s\", 'FM0.00000') LIKE '%0.5%' ESCAPE '!'");
    expect(buildFilterClause([contains('n')], [column('n', 'NUMBER')], 'oracle'))
      .toBe("WHERE REGEXP_REPLACE(TO_CHAR(\"n\"), '^(-?)\\.', '\\10.') LIKE '%0.5%' ESCAPE '!'");
    expect(buildFilterClause([contains('f')], [column('f', 'FLOAT(126)')], 'oracle'))
      .toBe("WHERE REGEXP_REPLACE(TO_CHAR(\"f\"), '^(-?)\\.', '\\10.') LIKE '%0.5%' ESCAPE '!'");
    expect(buildFilterClause([contains('t')], [column('t', 'TIMESTAMP(6)')], 'oracle'))
      .toBe("WHERE REGEXP_REPLACE(TO_CHAR(\"t\", 'YYYY-MM-DD HH24:MI:SS.FF'), '\\.?0*$') LIKE '%0.5%' ESCAPE '!'");
    expect(buildFilterClause([contains('l')], [column('l', 'TIMESTAMP(6) WITH LOCAL TIME ZONE')], 'oracle'))
      .toBe("WHERE REGEXP_REPLACE(TO_CHAR(\"l\", 'YYYY-MM-DD HH24:MI:SS.FF'), '\\.?0*$') LIKE '%0.5%' ESCAPE '!'");
    expect(buildFilterClause([contains('z')], [column('z', 'TIMESTAMP(6) WITH TIME ZONE')], 'oracle'))
      .toBe("WHERE REGEXP_REPLACE(TO_CHAR(\"z\", 'YYYY-MM-DD HH24:MI:SS.FF'), '\\.?0*$') || TO_CHAR(\"z\", ' TZH:TZM') LIKE '%0.5%' ESCAPE '!'");
    // 整数与 DATE 的隐式转换本来就是网格的写法（DATE 靠会话的 NLS_DATE_FORMAT），原样
    expect(buildFilterClause([contains('i')], [column('i', 'INTEGER')], 'oracle'))
      .toBe("WHERE \"i\" LIKE '%0.5%' ESCAPE '!'");
    expect(buildFilterClause([contains('e')], [column('e', 'DATE')], 'oracle'))
      .toBe("WHERE \"e\" LIKE '%0.5%' ESCAPE '!'");
  });

  it('SQL Server 的 datetime 与 xml 上「包含」按网格的写法转成文本', () => {
    // 隐式转换把 datetime 写成 `Jan  2 2024  3:04AM`，搜 2024-01 一行也中不了；xml 直接报 8116
    const contains = (name: string) => filter({ column: name, operator: 'contains', value: '2024-01' });
    expect(buildFilterClause([contains('a')], [column('a', 'datetime')], 'sqlserver'))
      .toBe("WHERE CONVERT(nvarchar(30), [a], 121) LIKE N'%2024-01%' ESCAPE N'!'");
    expect(buildFilterClause([contains('f')], [column('f', 'smalldatetime')], 'sqlserver'))
      .toBe("WHERE CONVERT(nvarchar(30), [f], 121) LIKE N'%2024-01%' ESCAPE N'!'");
    expect(buildFilterClause([contains('j')], [column('j', 'xml')], 'sqlserver'))
      .toBe("WHERE CAST([j] AS nvarchar(max)) LIKE N'%2024-01%' ESCAPE N'!'");
    // datetime2、date 隐式转换本来就是 ISO 写法，原样
    expect(buildFilterClause([contains('b')], [column('b', 'datetime2')], 'sqlserver'))
      .toBe("WHERE [b] LIKE N'%2024-01%' ESCAPE N'!'");
  });

  it('MySQL 的 BIT 上「包含」按网格显示的十进制数搜', () => {
    // 原样 LIKE 比的是那几位的字节：bit(8) 里的 54 搜 5 一行也中不了
    expect(buildFilterClause([filter({ column: 'b', operator: 'contains', value: '5' })], [column('b', 'bit(8)')], 'mysql'))
      .toBe("WHERE CAST(`b` AS UNSIGNED) LIKE '%5%' ESCAPE '!'");
    // 比较不用转：MySQL 拿字符串和 BIT 比时按数比，'6' 筛得中 6
    expect(buildFilterClause([filter({ column: 'b', operator: 'eq', value: '6' })], [column('b', 'bit(8)')], 'mysql'))
      .toBe("WHERE `b` = '6'");
  });

  it('SQL Server 的 text / ntext / image 与 Oracle 的 LOB 上比较不报错', () => {
    // 原样比较：SQL Server 402「incompatible in the equal to operator」，Oracle ORA-22848
    const compare = (name: string, operator: ColumnFilter['operator'], value: string) =>
      filter({ column: name, operator, value });
    expect(buildFilterClause([compare('t', 'eq', 'abc')], [column('t', 'text')], 'sqlserver'))
      .toBe("WHERE CAST([t] AS nvarchar(max)) = N'abc'");
    expect(buildFilterClause([compare('n', 'gt', 'a')], [column('n', 'ntext')], 'sqlserver'))
      .toBe("WHERE CAST([n] AS nvarchar(max)) > N'a'");
    expect(buildFilterClause([compare('i', 'eq', '0xDEAD')], [column('i', 'image')], 'sqlserver'))
      .toBe('WHERE CAST([i] AS varbinary(max)) = 0xdead');
    expect(buildFilterClause([compare('C', 'eq', 'abc')], [column('C', 'CLOB')], 'oracle'))
      .toBe(`WHERE DBMS_LOB.COMPARE("C", 'abc') = 0`);
    expect(buildFilterClause([compare('N', 'lt', 'b')], [column('N', 'NCLOB')], 'oracle'))
      .toBe(`WHERE DBMS_LOB.COMPARE("N", 'b') < 0`);
    expect(buildFilterClause([compare('B', 'ne', '0xDEAD')], [column('B', 'BLOB')], 'oracle'))
      .toBe(`WHERE DBMS_LOB.COMPARE("B", HEXTORAW('dead')) <> 0`);
    // 能比的照旧
    expect(buildFilterClause([compare('v', 'eq', 'abc')], [column('v', 'VARCHAR2(10)')], 'oracle'))
      .toBe(`WHERE "v" = 'abc'`);
  });

  it('MySQL 的反斜杠在 LIKE 模式里也只转义一层', () => {
    // 转义符选 `!` 而不是 `\` 就是为了避开字面量层与 LIKE 层的双重转义
    expect(
      buildFilterClause(
        [filter({ column: 'note', operator: 'contains', value: 'C:\\temp' })],
        COLUMNS,
        'mysql'
      )
    ).toBe("WHERE `note` LIKE '%C:\\\\temp%' ESCAPE '!'");
  });
});

describe('二进制列上的比较', () => {
  // 网格里二进制值显示成 0x…，照抄进「等于」拼成字符串比较，比的是那串字符的字节，一行也筛不中
  const bin = [column('id', 'binary(16)'), column('blob', 'bytea')];

  it('0x 加偶数位十六进制按字节比', () => {
    expect(buildFilterClause([filter({ column: 'id', value: '0x0AFF' })], bin, 'mysql'))
      .toBe("WHERE `id` = X'0aff'");
    expect(buildFilterClause([filter({ column: 'blob', operator: 'ne', value: '0x0aff' })], bin, 'postgresql'))
      .toBe(`WHERE "blob" <> '\\x0aff'::bytea`);
  });

  // MySQL 的二进制列内容可打印时网格里显示原文，筛原文要比得上
  it('别的文本照旧按原文比', () => {
    expect(buildFilterClause([filter({ column: 'id', value: 'cafecafe' })], bin, 'mysql'))
      .toBe("WHERE `id` = 'cafecafe'");
    expect(buildFilterClause([filter({ column: 'id', value: '0xabc' })], bin, 'mysql'))
      .toBe("WHERE `id` = '0xabc'");
  });

  it('文本列上的 0x 仍是文本', () => {
    expect(buildFilterClause([filter({ column: 'name', value: '0x0aff' })], COLUMNS, 'mysql'))
      .toBe("WHERE `name` = '0x0aff'");
  });
});
