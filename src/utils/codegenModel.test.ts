import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import {
  camelCase,
  catalogToCodegenSchema,
  draftToCodegenSchema,
  logicalType,
  NameScope,
  pascalCase,
  planRelations,
  snakeCase,
  type CodegenDialect,
  type CodegenSchema,
  type CodegenTable,
  type LogicalType
} from './codegenModel';
import type { IndexInfo } from './schemaObjects';

describe('logicalType', () => {
  const cases: [CodegenDialect, string, LogicalType][] = [
    ['postgresql', 'integer', { kind: 'int', bytes: 4, unsigned: false }],
    ['postgresql', 'bigint', { kind: 'int', bytes: 8, unsigned: false }],
    ['postgresql', 'smallint', { kind: 'int', bytes: 2, unsigned: false }],
    ['postgresql', 'numeric(10,2)', { kind: 'decimal', precision: 10, scale: 2 }],
    ['postgresql', 'numeric', { kind: 'decimal', precision: null, scale: null }],
    ['postgresql', 'character varying(32)', { kind: 'string', length: 32, fixed: false, national: false }],
    ['postgresql', 'character(2)', { kind: 'string', length: 2, fixed: true, national: false }],
    ['postgresql', 'text', { kind: 'text' }],
    ['postgresql', 'boolean', { kind: 'bool' }],
    ['postgresql', 'uuid', { kind: 'uuid' }],
    ['postgresql', 'jsonb', { kind: 'json', binary: true }],
    ['postgresql', 'json', { kind: 'json', binary: false }],
    ['postgresql', 'bytea', { kind: 'bytes' }],
    ['postgresql', 'real', { kind: 'float', bytes: 4 }],
    ['postgresql', 'double precision', { kind: 'float', bytes: 8 }],
    ['postgresql', 'timestamp with time zone', { kind: 'timestamp', withTimeZone: true }],
    ['postgresql', 'timestamp(3) without time zone', { kind: 'timestamp', withTimeZone: false }],
    ['postgresql', 'time without time zone', { kind: 'time' }],
    ['postgresql', 'date', { kind: 'date' }],
    ['postgresql', 'integer[]', { kind: 'unknown' }],
    ['postgresql', 'interval', { kind: 'unknown' }],
    ['postgresql', 'point', { kind: 'unknown' }],
    ['mysql', 'tinyint(1)', { kind: 'bool' }],
    ['mysql', 'tinyint(4)', { kind: 'int', bytes: 1, unsigned: false }],
    ['mysql', 'int unsigned', { kind: 'int', bytes: 4, unsigned: true }],
    ['mysql', 'int(11)', { kind: 'int', bytes: 4, unsigned: false }],
    ['mysql', 'bigint(20) unsigned', { kind: 'int', bytes: 8, unsigned: true }],
    ['mysql', 'float', { kind: 'float', bytes: 4 }],
    ['mysql', 'double', { kind: 'float', bytes: 8 }],
    ['mysql', 'varchar(120)', { kind: 'string', length: 120, fixed: false, national: false }],
    ['mysql', "enum('a','b')", { kind: 'text' }],
    ['mysql', 'longtext', { kind: 'text' }],
    ['mysql', 'datetime', { kind: 'timestamp', withTimeZone: false }],
    ['mysql', 'timestamp', { kind: 'timestamp', withTimeZone: true }],
    ['mysql', 'bit(1)', { kind: 'bool' }],
    ['mysql', 'bit(8)', { kind: 'unknown' }],
    ['mysql', 'varbinary(16)', { kind: 'bytes' }],
    ['mysql', 'year', { kind: 'unknown' }],
    ['sqlite', 'INTEGER', { kind: 'int', bytes: 8, unsigned: false }],
    ['sqlite', 'REAL', { kind: 'float', bytes: 8 }],
    ['sqlite', 'DATETIME', { kind: 'timestamp', withTimeZone: false }],
    ['sqlite', 'VARCHAR(32)', { kind: 'string', length: 32, fixed: false, national: false }],
    ['sqlite', '', { kind: 'unknown' }],
    ['sqlserver', 'nvarchar(50)', { kind: 'string', length: 50, fixed: false, national: true }],
    ['sqlserver', 'nvarchar(max)', { kind: 'string', length: 'max', fixed: false, national: true }],
    ['sqlserver', 'bit', { kind: 'bool' }],
    ['sqlserver', 'tinyint', { kind: 'int', bytes: 1, unsigned: true }],
    ['sqlserver', 'uniqueidentifier', { kind: 'uuid' }],
    ['sqlserver', 'datetime2(7)', { kind: 'timestamp', withTimeZone: false }],
    ['sqlserver', 'datetimeoffset(7)', { kind: 'timestamp', withTimeZone: true }],
    ['sqlserver', 'float', { kind: 'float', bytes: 8 }],
    ['sqlserver', 'money', { kind: 'decimal', precision: null, scale: null }],
    ['sqlserver', 'timestamp', { kind: 'bytes' }],
    ['oracle', 'NUMBER(10)', { kind: 'int', bytes: 8, unsigned: false }],
    ['oracle', 'NUMBER(5)', { kind: 'int', bytes: 4, unsigned: false }],
    ['oracle', 'NUMBER(3)', { kind: 'int', bytes: 2, unsigned: false }],
    ['oracle', 'NUMBER(10,2)', { kind: 'decimal', precision: 10, scale: 2 }],
    ['oracle', 'NUMBER', { kind: 'decimal', precision: null, scale: null }],
    ['oracle', 'INTEGER', { kind: 'int', bytes: 8, unsigned: false }],
    ['oracle', 'VARCHAR2(40 CHAR)', { kind: 'string', length: 40, fixed: false, national: false }],
    ['oracle', 'DATE', { kind: 'timestamp', withTimeZone: false }],
    ['oracle', 'TIMESTAMP(6) WITH TIME ZONE', { kind: 'timestamp', withTimeZone: true }],
    ['oracle', 'CLOB', { kind: 'text' }],
    ['oracle', 'BINARY_DOUBLE', { kind: 'float', bytes: 8 }]
  ];

  it.each(cases)('%s %s', (dialect, dataType, expected) => {
    expect(logicalType(dataType, dialect)).toEqual(expected);
  });

  it('does not mistake interval or point for an integer', () => {
    // 按子串认 int 的写法会在这两个上错
    expect(logicalType('interval', 'postgresql').kind).toBe('unknown');
    expect(logicalType('point', 'mysql').kind).toBe('unknown');
  });
});

describe('names', () => {
  it.each([
    ['user_orders', 'UserOrders', 'userOrders', 'user_orders'],
    ['UserOrders', 'UserOrders', 'userOrders', 'user_orders'],
    ['userOrders', 'UserOrders', 'userOrders', 'user_orders'],
    ['USER_ID', 'UserId', 'userId', 'user_id'],
    ['HTMLParser', 'HtmlParser', 'htmlParser', 'html_parser'],
    ['2fa codes', 'T2faCodes', 'c2faCodes', 'c_2fa_codes'],
    ['created-at', 'CreatedAt', 'createdAt', 'created_at']
  ])('%s', (name, pascal, camel, snake) => {
    expect(pascalCase(name)).toBe(pascal);
    expect(camelCase(name)).toBe(camel);
    expect(snakeCase(name)).toBe(snake);
  });

  it('falls back when nothing ASCII is left', () => {
    expect(pascalCase('订单')).toBe('Table');
    expect(camelCase('金额')).toBe('column');
  });

  it('numbers names that collide and escapes reserved words', () => {
    const scope = new NameScope(new Set(['type']));
    expect(scope.claim('type')).toBe('type_');
    expect(scope.claim('userId')).toBe('userId');
    expect(scope.claim('userId')).toBe('userId2');
    // 大小写不同也算撞：类型名还要拿去当文件名，macOS 与 Windows 的文件系统不分大小写
    expect(scope.claim('UserID')).toBe('UserID3');
  });
});

function column(name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, data_type: dataType, is_nullable: false, is_primary_key: false, ...extra };
}

function index(name: string, columns: string[], extra: Partial<IndexInfo> = {}): IndexInfo {
  return { name, columns, isUnique: true, isPrimary: false, isPartial: false, isValid: true, method: null, isConstraint: false, ...extra };
}

describe('catalogToCodegenSchema', () => {
  it('reads auto increment from identity and from serial defaults', () => {
    const schema = catalogToCodegenSchema('postgresql', [
      {
        schema: 'public',
        name: 'a',
        columns: [
          column('id', 'integer', { is_primary_key: true, primary_key_ordinal: 1, default_value: "nextval('a_id_seq'::regclass)", is_generated: false }),
          column('b', 'bigint', { is_generated: true, identity_generation: 'ALWAYS' }),
          column('total', 'integer', { is_generated: true, identity_generation: null }),
          column('status', 'text', { default_value: "'new'::text" })
        ],
        indexes: []
      }
    ], []);
    const [id, b, total, status] = schema.tables[0].columns;
    expect(id).toMatchObject({ autoIncrement: true, computed: false, defaultValue: null });
    expect(b).toMatchObject({ autoIncrement: true, computed: false });
    expect(total).toMatchObject({ autoIncrement: false, computed: true });
    expect(status.defaultValue).toBe("'new'::text");
  });

  it('turns MySQL catalog defaults back into SQL', () => {
    const schema = catalogToCodegenSchema('mysql', [
      {
        schema: 'shop',
        name: 'a',
        columns: [
          column('status', 'varchar(16)', { default_value: 'new' }),
          column('qty', 'int', { default_value: '0' }),
          column('at', 'datetime', { default_value: 'CURRENT_TIMESTAMP', column_extra: 'DEFAULT_GENERATED' })
        ],
        indexes: []
      }
    ], []);
    expect(schema.tables[0].columns.map((item) => item.defaultValue)).toEqual(["'new'", '0', 'CURRENT_TIMESTAMP']);
  });

  it('orders the primary key by key position and keeps only usable unique indexes', () => {
    const schema = catalogToCodegenSchema('postgresql', [
      {
        schema: 'public',
        name: 't',
        columns: [
          column('a', 'int', { is_primary_key: true, primary_key_ordinal: 2 }),
          column('b', 'int', { is_primary_key: true, primary_key_ordinal: 1 }),
          column('email', 'text')
        ],
        indexes: [
          index('t_pkey', ['b', 'a'], { isPrimary: true }),
          index('t_email', ['email']),
          index('t_email_again', ['email']),
          index('t_partial', ['email'], { isPartial: true }),
          index('t_invalid', ['a'], { isValid: false }),
          index('t_expr', ['<expression>']),
          index('t_plain', ['email'], { isUnique: false })
        ]
      }
    ], []);
    expect(schema.tables[0].primaryKey).toEqual(['b', 'a']);
    expect(schema.tables[0].unique).toEqual([['email']]);
  });

  it('folds one-column links back into composite foreign keys', () => {
    const schema = catalogToCodegenSchema('postgresql', [
      { schema: 'public', name: 'items', columns: [column('sku', 'text'), column('region', 'text')], indexes: [] }
    ], [
      { constraintName: 'fk_p', from: { table: 'public.items', column: 'sku' }, to: { table: 'public.products', column: 'sku' } },
      { constraintName: 'fk_p', from: { table: 'public.items', column: 'region' }, to: { table: 'public.products', column: 'region' } },
      { constraintName: 'fk_other', from: { table: 'public.other', column: 'x' }, to: { table: 'public.items', column: 'sku' } }
    ]);
    expect(schema.tables[0].foreignKeys).toEqual([
      { name: 'fk_p', columns: ['sku', 'region'], referencedTable: 'public.products', referencedColumns: ['sku', 'region'] }
    ]);
  });
});

describe('draftToCodegenSchema', () => {
  it.each<[CodegenDialect, string, string]>([
    ['postgresql', 'bigint GENERATED ALWAYS AS IDENTITY', 'bigint'],
    ['postgresql', 'bigserial', 'bigint'],
    ['mysql', 'bigint AUTO_INCREMENT', 'bigint'],
    ['sqlserver', 'bigint IDENTITY(1,1)', 'bigint'],
    ['oracle', 'NUMBER(19) GENERATED BY DEFAULT AS IDENTITY', 'NUMBER(19)'],
    ['sqlite', 'INTEGER', 'INTEGER']
  ])('%s: %s is auto increment', (dialect, dataType, plain) => {
    const schema = draftToCodegenSchema(dialect, {
      tables: [{
        name: 't',
        columns: [{ name: 'id', dataType, nullable: false, defaultValue: null }],
        primaryKey: ['id'],
        unique: [],
        indexes: [],
        foreignKeys: []
      }]
    });
    expect(schema.tables[0].columns[0]).toMatchObject({ autoIncrement: true, dataType: plain });
  });

  it('does not treat a plain integer key as auto increment outside SQLite', () => {
    const schema = draftToCodegenSchema('postgresql', {
      tables: [{
        name: 't',
        columns: [{ name: 'id', dataType: 'integer', nullable: false, defaultValue: null }],
        primaryKey: ['id'],
        unique: [['id']],
        indexes: [],
        foreignKeys: []
      }]
    });
    expect(schema.tables[0].columns[0].autoIncrement).toBe(false);
    expect(schema.tables[0].unique).toEqual([]);
  });
});

function table(name: string, extra: Partial<CodegenTable> = {}): CodegenTable {
  return { key: name, schema: null, name, columns: [], primaryKey: ['id'], unique: [], foreignKeys: [], ...extra };
}

describe('planRelations', () => {
  const users = table('users');
  const profiles = table('user_profiles', {
    primaryKey: ['user_id'],
    foreignKeys: [{ name: 'fk1', columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'] }]
  });
  const orders = table('orders', {
    foreignKeys: [
      { name: 'fk_buyer', columns: ['buyer_id'], referencedTable: 'users', referencedColumns: ['id'] },
      { name: 'fk_seller', columns: ['seller_id'], referencedTable: 'users', referencedColumns: ['id'] },
      { name: 'fk_gone', columns: ['coupon_id'], referencedTable: 'coupons', referencedColumns: ['id'] }
    ]
  });
  const categories = table('categories', {
    foreignKeys: [{ name: 'fk_parent', columns: ['parent_id'], referencedTable: 'categories', referencedColumns: ['id'] }]
  });
  const passports = table('passports', {
    unique: [['owner']],
    foreignKeys: [{ name: 'fk_owner', columns: ['owner'], referencedTable: 'users', referencedColumns: ['id'] }]
  });
  const schema: CodegenSchema = { dialect: 'postgresql', tables: [users, profiles, orders, categories, passports] };
  const { relations, dangling } = planRelations(schema);
  const byName = (name: string) => relations.find((relation) => relation.foreignKey.name === name);

  it('treats a foreign key that is the primary key or a unique key as one to one', () => {
    expect(byName('fk1')?.oneToOne).toBe(true);
    expect(byName('fk_owner')?.oneToOne).toBe(true);
    expect(byName('fk_buyer')?.oneToOne).toBe(false);
  });

  it('names the forward side after the column and the back side after the source table', () => {
    expect(byName('fk1')).toMatchObject({ forwardBase: 'user', backBase: 'user_profiles', ambiguous: false });
    // 列名不带 _id 时退回被引用表名，不然关系字段和外键列同名
    expect(byName('fk_owner')).toMatchObject({ forwardBase: 'users', backBase: 'passports' });
  });

  it('disambiguates several relations between the same tables, and self references', () => {
    expect(byName('fk_buyer')).toMatchObject({ forwardBase: 'buyer', backBase: 'orders_by_buyer', ambiguous: true });
    expect(byName('fk_seller')).toMatchObject({ forwardBase: 'seller', backBase: 'orders_by_seller', ambiguous: true });
    expect(byName('fk_parent')).toMatchObject({ forwardBase: 'parent', backBase: 'categories_by_parent', ambiguous: true });
  });

  it('reports foreign keys whose target is not in the selection', () => {
    expect(dangling.map((item) => item.foreignKey.name)).toEqual(['fk_gone']);
    expect(byName('fk_gone')).toBeUndefined();
  });
});
