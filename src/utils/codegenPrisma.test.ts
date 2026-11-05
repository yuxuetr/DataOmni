import { describe, expect, it } from 'vitest';
import { codegenFixture } from './codegenFixture';
import type { CodegenSchema, CodegenTable } from './codegenModel';
import { generatePrisma, prismaDefault, type PrismaDialect } from './codegenPrisma';

/**
 * 快照文件就是语料：`scripts/codegen-verify.sh` 把它们交给 `prisma validate`。
 * 改了生成器、快照跟着变时，要重跑那个脚本
 */
describe('generatePrisma', () => {
  it.each<PrismaDialect>(['postgresql', 'mysql', 'sqlite', 'sqlserver'])('%s fixture', async (dialect) => {
    const schema = codegenFixture(dialect) as CodegenSchema & { dialect: PrismaDialect };
    const { files } = generatePrisma(schema, 'fixture');
    expect(files.map((file) => file.path)).toEqual(['schema.prisma']);
    await expect(files[0].contents).toMatchFileSnapshot(`./__snapshots__/codegen/prisma-${dialect}.prisma`);
  });

  it('lists what it could not map, skipped and left out', () => {
    const { notes } = generatePrisma(codegenFixture('postgresql') as CodegenSchema & { dialect: 'postgresql' }, 'x');
    expect(notes).toEqual([
      { kind: 'unknown-type', table: 'users', column: 'session_length', dataType: 'interval' },
      { kind: 'ignored-table', table: 'audit_log', reason: 'no-unique-identifier' },
      { kind: 'dangling-foreign-key', table: 'orders', constraint: 'fk_orders_coupon', referencedTable: 'coupons' }
    ]);
  });

  const table = (name: string, schema: string | null, extra: Partial<CodegenTable> = {}): CodegenTable => ({
    key: schema ? `${schema}.${name}` : name,
    schema,
    name,
    columns: [{ name: 'id', dataType: 'integer', nullable: false, autoIncrement: true, computed: false, defaultValue: null }],
    primaryKey: ['id'],
    unique: [],
    foreignKeys: [],
    ...extra
  });

  it('prefixes the schema when two schemas have a table with the same name', () => {
    const { files } = generatePrisma({
      dialect: 'postgresql',
      tables: [table('orders', 'public'), table('orders', 'billing')]
    }, 'x');
    const text = files[0].contents;
    expect(text).toContain('model PublicOrders {');
    expect(text).toContain('model BillingOrders {');
    expect(text).toContain('previewFeatures = ["multiSchema"]');
    expect(text).toContain('schemas  = ["public", "billing"]');
    expect(text).toContain('@@schema("billing")');
  });

  it('skips a relation whose referenced columns are not unique (MySQL allows it, Prisma does not)', () => {
    const parent = table('parent', null, {
      columns: [
        { name: 'id', dataType: 'int', nullable: false, autoIncrement: true, computed: false, defaultValue: null },
        { name: 'code', dataType: 'int', nullable: false, autoIncrement: false, computed: false, defaultValue: null }
      ]
    });
    const child = table('child', null, {
      columns: [
        { name: 'id', dataType: 'int', nullable: false, autoIncrement: true, computed: false, defaultValue: null },
        { name: 'parent_code', dataType: 'int', nullable: false, autoIncrement: false, computed: false, defaultValue: null }
      ],
      foreignKeys: [{ name: 'fk_code', columns: ['parent_code'], referencedTable: 'parent', referencedColumns: ['code'] }]
    });
    const { files, notes } = generatePrisma({ dialect: 'mysql', tables: [parent, child] }, 'x');
    expect(notes).toContainEqual({ kind: 'skipped-relation', table: 'child', constraint: 'fk_code', reason: 'target-not-unique' });
    expect(files[0].contents).not.toContain('@relation');
  });

  it('writes the delete rule the design asked for', () => {
    const parent = table('parent', null);
    const child = table('child', null, {
      columns: [
        { name: 'id', dataType: 'integer', nullable: false, autoIncrement: true, computed: false, defaultValue: null },
        { name: 'parent_id', dataType: 'integer', nullable: true, autoIncrement: false, computed: false, defaultValue: null }
      ],
      foreignKeys: [{ name: 'fk', columns: ['parent_id'], referencedTable: 'parent', referencedColumns: ['id'], onDelete: 'set null' }]
    });
    const { files } = generatePrisma({ dialect: 'postgresql', tables: [parent, child] }, 'x');
    expect(files[0].contents).toContain('onDelete: SetNull, onUpdate: NoAction');
  });
});

describe('prismaDefault', () => {
  it.each([
    ["'new'::text", 'String', '"new"'],
    ["'it''s'", 'String', '"it\'s"'],
    ["('new')", 'String', '"new"'],
    ["(N'新')", 'String', '"新"'],
    ['((0))', 'Int', '0'],
    ["'0'::numeric", 'Decimal', '0'],
    ['1.50', 'Decimal?', '1.50'],
    ['true', 'Boolean', 'true'],
    ['1', 'Boolean', 'true'],
    ["b'0'", 'Boolean', 'false'],
    ['now()', 'DateTime', 'now()'],
    ['CURRENT_TIMESTAMP', 'DateTime?', 'now()'],
    ['current_timestamp(3)', 'DateTime', 'now()'],
    ['(sysdatetime())', 'DateTime', 'now()'],
    ['(getdate())', 'DateTime', 'now()'],
    ["'{}'::jsonb", 'Json', '"{}"'],
    ['gen_random_uuid()', 'String', 'dbgenerated("gen_random_uuid()")'],
    ["'2020-01-01'::date", 'DateTime', 'dbgenerated("\'2020-01-01\'::date")'],
    ['(lower("x"))', 'String', 'dbgenerated("(lower(\\"x\\"))")'],
    // 字符串列上的数字默认值不是字符串字面量，原样交给数据库
    ['0', 'String', 'dbgenerated("0")'],
    // 括号不配对的不剥
    ['(a) + (b)', 'Int', 'dbgenerated("(a) + (b)")']
  ])('%s on %s', (sql, type, expected) => {
    expect(prismaDefault(sql, type)).toBe(expected);
  });
});
