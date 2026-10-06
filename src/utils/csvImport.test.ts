import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts/databaseMetadata';
import {
  autoMapColumns,
  canSkipInsideOneTransaction,
  columnKind,
  fitsColumn,
  importColumns,
  sampleMismatches,
  validateImport,
  type ColumnMapping,
  type CsvPreview
} from './csvImport';

function column(overrides: Partial<ColumnInfo> & { name: string }): ColumnInfo {
  return {
    data_type: 'text',
    is_nullable: true,
    is_primary_key: false,
    ...overrides
  };
}

function preview(overrides: Partial<CsvPreview> = {}): CsvPreview {
  return {
    delimiter: ',',
    headers: [],
    rows: [],
    totalBytes: 0,
    more: false,
    ragged: [],
    encoding: 'UTF-8',
    ...overrides
  };
}

describe('autoMapColumns', () => {
  it('大小写、下划线、空格都不算数', () => {
    const mappings = autoMapColumns(
      ['User ID', 'full_name'],
      [column({ name: 'user_id' }), column({ name: 'fullName' })]
    );
    expect(mappings).toEqual([
      { target: 'user_id', source: 0 },
      { target: 'fullName', source: 1 }
    ]);
  });

  it('配不上就留空，不按位置猜', () => {
    // 按位置对齐在列序不一致时会把整张表的数据错位写进去，而那看起来是成功的
    const mappings = autoMapColumns(['a', 'b'], [column({ name: 'x' }), column({ name: 'y' })]);
    expect(mappings.map((mapping) => mapping.source)).toEqual([null, null]);
  });

  it('由数据库产生的列默认不导入', () => {
    // 往 GENERATED ALWAYS AS IDENTITY 里写值，PostgreSQL 会拒绝整条语句
    const mappings = autoMapColumns(
      ['id', 'name'],
      [column({ name: 'id', is_generated: true }), column({ name: 'name' })]
    );
    expect(mappings).toEqual([
      { target: 'id', source: null },
      { target: 'name', source: 1 }
    ]);
  });

  it('CSV 里有同名列时取第一个', () => {
    // 后一个覆盖前一个的话，配对结果取决于列序，而那不该是个变量
    const mappings = autoMapColumns(['name', 'name'], [column({ name: 'name' })]);
    expect(mappings[0]?.source).toBe(0);
  });
});

describe('columnKind / fitsColumn', () => {
  it('按类型名的第一个词判断，不做子串匹配', () => {
    // interval 和 point 都含有 "int"
    expect(columnKind('interval')).toBe('text');
    expect(columnKind('int4')).toBe('integer');
    expect(columnKind('numeric(10,2)')).toBe('number');
    expect(columnKind('timestamp with time zone')).toBe('timestamp');
    expect(columnKind('character varying(32)')).toBe('text');
  });

  it('认得出常见的写法', () => {
    expect(fitsColumn('-12', 'integer')).toBe(true);
    expect(fitsColumn('12.5', 'integer')).toBe(false);
    expect(fitsColumn('1.5e3', 'number')).toBe(true);
    expect(fitsColumn('YES', 'boolean')).toBe(true);
    expect(fitsColumn('2026-01-02', 'date')).toBe(true);
    expect(fitsColumn('2026-01-02 03:04:05', 'timestamp')).toBe(true);
    expect(fitsColumn('{"a":1}', 'json')).toBe(true);
    expect(fitsColumn('{a:1}', 'json')).toBe(false);
  });

  it('认得出 PostgreSQL 写出来的时区：整点时区只有两位', () => {
    // psql 与 COPY 给 timestamptz / timetz 写 `+08`，半点时区才写 `+05:30`
    expect(fitsColumn('2026-01-02 03:04:05+08', 'timestamp')).toBe(true);
    expect(fitsColumn('2026-01-02 03:04:05.123456-03', 'timestamp')).toBe(true);
    expect(fitsColumn('2026-01-02 03:04:05+05:30', 'timestamp')).toBe(true);
    expect(fitsColumn('03:04:05+08', 'time')).toBe(true);
    expect(fitsColumn('03:04:05.5+05:30', 'time')).toBe(true);
    expect(fitsColumn('2026-01-02 03:04:05+8', 'timestamp')).toBe(false);
  });

  it('文本列什么都收', () => {
    // 判断谁能进这一列的是数据库；这里的结论只用来提醒
    expect(fitsColumn('随便什么', 'text')).toBe(true);
  });
});

describe('sampleMismatches', () => {
  const columns = [column({ name: 'n', data_type: 'integer' }), column({ name: 'tag' })];
  const mappings: ColumnMapping[] = [
    { target: 'n', source: 0 },
    { target: 'tag', source: 1 }
  ];

  it('每列只报第一个不合的值', () => {
    // 一列里有一个格式不对通常整列都不对，全列出来会把另一个问题埋掉
    const issues = sampleMismatches(mappings, columns, [['a', 'x'], ['b', 'y']], '');
    expect(issues).toEqual([{ target: 'n', value: 'a' }]);
  });

  it('NULL 不参与类型判断', () => {
    // 它要过的是非空约束，不是类型
    expect(sampleMismatches(mappings, columns, [['\\N', 'x']], '\\N')).toEqual([]);
  });

  it('没映射的列不看', () => {
    const skipped: ColumnMapping[] = [{ target: 'n', source: null }];
    expect(sampleMismatches(skipped, columns, [['a']], '')).toEqual([]);
  });

  it('Oracle 的 DATE 带时分秒，样例里的时间不是坏值', () => {
    const at = [column({ name: 'AT', data_type: 'DATE' })];
    const mapped: ColumnMapping[] = [{ target: 'AT', source: 0 }];
    const rows = [['2024-01-03 08:30:00']];
    expect(sampleMismatches(mapped, at, rows, '', 'oracle')).toEqual([]);
    // 另外几家的 DATE 只存日期，时分秒会被丢掉，照旧提醒
    expect(sampleMismatches(mapped, at, rows, '', 'postgresql')).toEqual([
      { target: 'AT', value: '2024-01-03 08:30:00' }
    ]);
  });
});

describe('validateImport', () => {
  it('不是 UTF-8、按 GB18030 读的文件提醒一句，不拦', () => {
    const columns = [column({ name: 'note' })];
    const mappings = [{ target: 'note', source: 0 }];
    const issue = (encoding: string) => validateImport(mappings, columns, preview({ rows: [['张三']], encoding }), '')
      .find((found) => found.key === 'import.issue.notUtf8');
    expect(issue('gb18030')?.level).toBe('warning');
    expect(issue('UTF-8')).toBeUndefined();
    // 带 BOM 的 UTF-16 是照 BOM 认的，不是猜的；说「按 GB18030 读」是假话
    expect(issue('UTF-16LE')).toBeUndefined();
    expect(issue('UTF-16BE')).toBeUndefined();
  });

  it('必填列没映射是 error，不是提醒', () => {
    // 不给值就一行都插不进去，报出来的是一句方言各异的约束错误
    const columns = [column({ name: 'id', is_nullable: false }), column({ name: 'note' })];
    const issues = validateImport(
      [
        { target: 'id', source: null },
        { target: 'note', source: 0 }
      ],
      columns,
      preview({ rows: [['x']] }),
      ''
    );
    const required = issues.find((issue) => issue.key === 'import.issue.requiredMissing');
    expect(required?.level).toBe('error');
    // 列名不在这里拼成串：拼接要按语言来，而这个函数不知道当前是哪种语言
    expect(required?.columns).toEqual(['id']);
    expect(required?.params?.columns).toBeUndefined();
  });

  it('有默认值或由数据库产生的非空列不算必填', () => {
    const columns = [
      column({ name: 'id', is_nullable: false, is_generated: true }),
      column({ name: 'created', is_nullable: false, default_value: 'now()' }),
      column({ name: 'note' })
    ];
    const issues = validateImport([{ target: 'note', source: 0 }], columns, preview(), '');
    expect(issues.some((issue) => issue.key === 'import.issue.requiredMissing')).toBe(false);
  });

  it('映射到由数据库产生的列是 error', () => {
    const columns = [column({ name: 'id', is_generated: true })];
    const issues = validateImport([{ target: 'id', source: 0 }], columns, preview(), '');
    expect(issues.find((issue) => issue.key === 'import.issue.generatedTarget')?.level).toBe(
      'error'
    );
  });

  it('自增列收得下值：MySQL 与 SQLite 不提，计数器不跟着走的 PostgreSQL 与 Oracle 只是 warning', () => {
    const columns = [column({ name: 'id', is_generated: true, identity_generation: 'BY DEFAULT' })];
    const mapped: ColumnMapping[] = [{ target: 'id', source: 0 }];
    const keysFor = (dialect: 'mysql' | 'sqlite' | 'postgresql' | 'oracle') =>
      validateImport(mapped, columns, preview(), '', dialect).map((issue) => [issue.key, issue.level]);
    expect(keysFor('mysql')).toEqual([]);
    expect(keysFor('sqlite')).toEqual([]);
    expect(keysFor('postgresql')).toEqual([['import.issue.identityNotAdvanced', 'warning']]);
    expect(keysFor('oracle')).toEqual([['import.issue.identityNotAdvanced', 'warning']]);
    const always = [column({ name: 'id', is_generated: true, identity_generation: 'ALWAYS' })];
    expect(validateImport(mapped, always, preview(), '', 'postgresql').map((issue) => issue.key))
      .toEqual(['import.issue.generatedTarget']);
  });

  it('默认值取序列的列（serial 一类）同样提醒序列不跟着走', () => {
    const mapped: ColumnMapping[] = [{ target: 'id', source: 0 }];
    const keysFor = (defaultValue: string, dialect: 'mysql' | 'postgresql' | 'oracle' | 'sqlserver' | 'duckdb') =>
      validateImport(mapped, [column({ name: 'id', is_nullable: false, default_value: defaultValue })], preview(), '', dialect)
        .map((issue) => issue.key);
    expect(keysFor("nextval('t_id_seq'::regclass)", 'postgresql')).toEqual(['import.issue.identityNotAdvanced']);
    expect(keysFor("nextval('s')", 'duckdb')).toEqual(['import.issue.identityNotAdvanced']);
    expect(keysFor('"OM"."S"."NEXTVAL"', 'oracle')).toEqual(['import.issue.identityNotAdvanced']);
    expect(keysFor('(NEXT VALUE FOR [dbo].[s])', 'sqlserver')).toEqual(['import.issue.identityNotAdvanced']);
    // MariaDB 的序列也不跟着走；MySQL 不提的只是 AUTO_INCREMENT
    expect(keysFor('nextval(`om`.`s`)', 'mysql')).toEqual(['import.issue.identityNotAdvanced']);
    expect(keysFor('now()', 'postgresql')).toEqual([]);
  });

  it('一列都没映射是 error', () => {
    const issues = validateImport([{ target: 'a', source: null }], [column({ name: 'a' })], preview(), '');
    expect(issues.find((issue) => issue.key === 'import.issue.noColumns')?.level).toBe('error');
  });

  it('字段数对不上只是提醒，并且点出第一行的行号', () => {
    const issues = validateImport(
      [{ target: 'a', source: 0 }],
      [column({ name: 'a' })],
      preview({ ragged: [{ line: 7, fields: 3 }] }),
      ''
    );
    const ragged = issues.find((issue) => issue.key === 'import.issue.ragged');
    expect(ragged?.level).toBe('warning');
    expect(ragged?.params?.line).toBe(7);
  });

  it('类型对不上只是提醒，不拦', () => {
    // 做成闸门就会在 2026/01/02（MySQL 收）这种值上挡住一次本来能成的导入
    const issues = validateImport(
      [{ target: 'd', source: 0 }],
      [column({ name: 'd', data_type: 'date' })],
      preview({ rows: [['2026/01/02']] }),
      ''
    );
    const mismatch = issues.find((issue) => issue.key === 'import.issue.typeMismatch');
    expect(mismatch?.level).toBe('warning');
    expect(mismatch?.params?.value).toBe('2026/01/02');
    expect(issues.every((issue) => issue.level === 'warning')).toBe(true);
  });

  it('非空列的样例里有 NULL 会提醒', () => {
    const issues = validateImport(
      [{ target: 'a', source: 0 }],
      [column({ name: 'a', is_nullable: false })],
      preview({ rows: [['x'], ['']] }),
      ''
    );
    expect(issues.find((issue) => issue.key === 'import.issue.nullInNotNull')?.params?.column).toBe(
      'a'
    );
  });
});

describe('importColumns', () => {
  it('带上目标类型——PostgreSQL 的占位符要靠它转换', () => {
    const columns = [
      column({ name: 'n', data_type: 'integer' }),
      column({ name: 'skip', data_type: 'text' })
    ];
    expect(
      importColumns(
        [
          { target: 'n', source: 2 },
          { target: 'skip', source: null }
        ],
        columns
      )
    ).toEqual([{ source: 2, target: 'n', targetType: 'integer' }]);
  });
});

describe('canSkipInsideOneTransaction', () => {
  it('DuckDB 没有保存点，单事务里跳不了坏行；别家都行', () => {
    expect(canSkipInsideOneTransaction('duckdb')).toBe(false);
    for (const dialect of ['mysql', 'postgresql', 'sqlite', 'sqlserver', 'oracle'] as const) {
      expect(canSkipInsideOneTransaction(dialect)).toBe(true);
    }
  });
});
