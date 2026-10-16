import { describe, expect, it } from 'vitest';
import { translate } from '../i18n/translate';
import type { ColumnInfo } from '../contracts';
import type { IndexInfo } from './schemaObjects';
import { reconstructTableDdl } from './reconstructTableDdl';

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en', key, params);

const column = (name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  data_type: dataType,
  is_nullable: true,
  is_primary_key: false,
  ...extra
});

const index = (name: string, columns: string[], extra: Partial<IndexInfo> = {}): IndexInfo => ({
  name,
  columns,
  isUnique: false,
  isPrimary: false,
  isPartial: false,
  isValid: true,
  method: 'btree',
  ...extra
});

describe('reconstructTableDdl（PostgreSQL）', () => {
  it('列、复合主键按键内次序、检查约束、索引照目录写；外键单列出来', () => {
    const { ddl, foreignKeys } = reconstructTableDdl({
      schema: 'shop',
      name: 'Order Lines',
      columns: [
        column('id', 'bigint', { is_nullable: false, identity_generation: 'ALWAYS', is_generated: true }),
        column('order_id', 'bigint', { is_nullable: false, is_primary_key: true, primary_key_ordinal: 2 }),
        column('line', 'integer', { is_nullable: false, is_primary_key: true, primary_key_ordinal: 1 }),
        column('qty', 'integer', { is_nullable: false, default_value: '1' }),
        column('total', 'numeric(10,2)', { is_generated: true, default_value: '(qty * 2)' }),
        column('seq', 'integer', { is_nullable: false, default_value: "nextval('shop.lines_seq'::regclass)" })
      ],
      indexes: [
        index('order_lines_pkey', ['line', 'order_id'], { isPrimary: true, isUnique: true }),
        index('by_lower_note', ['lower(note)'], { method: 'gin' }),
        index('only_open', ['qty'], { isPartial: true })
      ],
      foreignKeys: [{
        name: 'fk_order',
        columns: ['order_id'],
        referencedSchema: 'shop',
        referencedTable: 'orders',
        referencedColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE'
      }],
      checks: [{ name: 'qty_positive', expression: 'CHECK (qty > 0)' }]
    }, 'postgresql', t);

    expect(ddl).toBe([
      '-- Column seq defaults to sequence shop.lines_seq, which is not exported',
      '-- Index only_open has a condition (partial index) that could not be read; it was not recreated',
      'CREATE TABLE "shop"."Order Lines" (',
      '  "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,',
      '  "order_id" bigint NOT NULL,',
      '  "line" integer NOT NULL,',
      '  "qty" integer NOT NULL DEFAULT 1,',
      '  "total" numeric(10,2) GENERATED ALWAYS AS ((qty * 2)) STORED,',
      `  "seq" integer NOT NULL DEFAULT nextval('shop.lines_seq'::regclass),`,
      '  CONSTRAINT "order_lines_pkey" PRIMARY KEY ("line", "order_id"),',
      '  CONSTRAINT "qty_positive" CHECK (qty > 0)',
      ');',
      'CREATE INDEX "by_lower_note" ON "shop"."Order Lines" USING gin (lower(note));'
    ].join('\n'));
    expect(foreignKeys).toEqual([
      'ALTER TABLE "shop"."Order Lines" ADD CONSTRAINT "fk_order" FOREIGN KEY ("order_id") REFERENCES "shop"."orders" ("id") ON DELETE CASCADE;'
    ]);
  });
});

describe('reconstructTableDdl（SQL Server）', () => {
  it('标识列与计算列注明；检查约束补上 CHECK；聚集与否写出来；特殊索引不拼', () => {
    const { ddl } = reconstructTableDdl({
      schema: 'dbo',
      name: 'orders',
      columns: [
        column('id', 'int', { is_nullable: false, is_primary_key: true, primary_key_ordinal: 1, identity_generation: 'ALWAYS', is_generated: true }),
        column('total', 'decimal(10,2)', { is_generated: true }),
        column('version', 'timestamp', { is_nullable: false, is_generated: true }),
        column('status', 'nvarchar(20)', { is_nullable: false, default_value: "(N'new')" })
      ],
      indexes: [
        index('PK_orders', ['id'], { isPrimary: true, isUnique: true, method: 'nonclustered' }),
        index('IX_status', ['status'], { method: 'clustered' }),
        index('CS_all', ['status'], { method: 'nonclustered columnstore' })
      ],
      foreignKeys: [],
      checks: [{ name: 'CK_status', expression: "([status]<>N'')" }]
    }, 'sqlserver', t);

    expect(ddl).toBe([
      '-- Column id is an identity column; written with seed and increment 1, 1 because the original ones could not be read',
      '-- Column total is a generated or computed column whose expression could not be read; written as a plain column',
      '-- Index CS_all is a nonclustered columnstore index; it was not recreated',
      'CREATE TABLE [dbo].[orders] (',
      '  [id] int IDENTITY NOT NULL,',
      '  [total] decimal(10,2),',
      '  [version] timestamp NOT NULL,',
      "  [status] nvarchar(20) NOT NULL DEFAULT (N'new'),",
      '  CONSTRAINT [PK_orders] PRIMARY KEY NONCLUSTERED ([id]),',
      "  CONSTRAINT [CK_status] CHECK ([status]<>N'')",
      ');',
      'CREATE CLUSTERED INDEX [IX_status] ON [dbo].[orders] ([status]);'
    ].join('\n'));
  });
});
