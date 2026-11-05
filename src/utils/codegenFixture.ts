import type { CodegenColumn, CodegenDialect, CodegenSchema, CodegenTable } from './codegenModel';

/**
 * 代码生成的共用语料：生成器的单测逐字比对它的输出，`scripts/codegen-verify.sh` 把同样的输出交给
 * `prisma validate`、`tsc`、`cargo check`。关系的形状照 `examples/sample-schema.sql`：
 * 一对一（外键就是主键）、同一对表之间两条外键、自引用、复合主键与复合外键、没有主键的表、
 * 以数字开头并带空格的表名、撞上关键字的列名，外加一条指向不在这份模型里的表的外键
 */

type ColumnTypes = Record<'id' | 'bigId' | 'shortText' | 'longText' | 'money' | 'when' | 'flag' | 'real' | 'json' | 'uuid' | 'blob' | 'day' | 'odd', string>;

const TYPES: Record<CodegenDialect, ColumnTypes> = {
  postgresql: {
    id: 'integer', bigId: 'bigint', shortText: 'character varying(120)', longText: 'text', money: 'numeric(10,2)',
    when: 'timestamp with time zone', flag: 'boolean', real: 'double precision', json: 'jsonb', uuid: 'uuid',
    blob: 'bytea', day: 'date', odd: 'interval'
  },
  mysql: {
    id: 'int', bigId: 'bigint unsigned', shortText: 'varchar(120)', longText: 'text', money: 'decimal(10,2)',
    when: 'datetime', flag: 'tinyint(1)', real: 'double', json: 'json', uuid: 'char(36)',
    blob: 'blob', day: 'date', odd: 'year'
  },
  sqlite: {
    id: 'INTEGER', bigId: 'INTEGER', shortText: 'VARCHAR(120)', longText: 'TEXT', money: 'DECIMAL(10,2)',
    when: 'DATETIME', flag: 'BOOLEAN', real: 'REAL', json: 'JSON', uuid: 'TEXT',
    blob: 'BLOB', day: 'DATE', odd: 'GEOMETRY'
  },
  sqlserver: {
    id: 'int', bigId: 'bigint', shortText: 'nvarchar(120)', longText: 'nvarchar(max)', money: 'decimal(10,2)',
    when: 'datetime2(7)', flag: 'bit', real: 'float', json: 'nvarchar(max)', uuid: 'uniqueidentifier',
    blob: 'varbinary(max)', day: 'date', odd: 'geography'
  },
  oracle: {
    id: 'NUMBER(10)', bigId: 'NUMBER(19)', shortText: 'VARCHAR2(120 CHAR)', longText: 'CLOB', money: 'NUMBER(10,2)',
    when: 'TIMESTAMP(6) WITH TIME ZONE', flag: 'NUMBER(1)', real: 'BINARY_DOUBLE', json: 'CLOB', uuid: 'RAW(16)',
    blob: 'BLOB', day: 'DATE', odd: 'SDO_GEOMETRY'
  }
};

const NOW: Record<CodegenDialect, string> = {
  postgresql: 'now()',
  mysql: 'CURRENT_TIMESTAMP',
  sqlite: 'CURRENT_TIMESTAMP',
  sqlserver: '(sysdatetime())',
  oracle: 'SYSTIMESTAMP'
};

function column(name: string, dataType: string, extra: Partial<CodegenColumn> = {}): CodegenColumn {
  return { name, dataType, nullable: false, autoIncrement: false, computed: false, defaultValue: null, ...extra };
}

export function codegenFixture(dialect: CodegenDialect): CodegenSchema {
  const type = TYPES[dialect];
  const literal = (text: string) => (dialect === 'sqlserver' ? `('${text}')` : `'${text}'`);
  const tables: CodegenTable[] = [
    {
      key: 'users', schema: null, name: 'users',
      columns: [
        column('id', type.id, { autoIncrement: true }),
        column('email', type.shortText),
        column('display_name', type.longText, { nullable: true }),
        column('created_at', type.when, { defaultValue: NOW[dialect] }),
        column('is_active', type.flag, { defaultValue: dialect === 'postgresql' ? 'true' : dialect === 'sqlserver' ? '((1))' : '1' }),
        column('settings', type.json, { nullable: true }),
        column('external_id', type.uuid, { nullable: true }),
        column('avatar', type.blob, { nullable: true }),
        column('birthday', type.day, { nullable: true }),
        column('session_length', type.odd, { nullable: true })
      ],
      primaryKey: ['id'], unique: [['email']], foreignKeys: []
    },
    {
      key: 'user_profiles', schema: null, name: 'user_profiles',
      columns: [column('user_id', type.id), column('bio', type.longText, { nullable: true })],
      primaryKey: ['user_id'], unique: [],
      foreignKeys: [{ name: 'fk_profiles_user', columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'] }]
    },
    {
      key: 'categories', schema: null, name: 'categories',
      columns: [
        column('id', type.id, { autoIncrement: true }),
        column('parent_id', type.id, { nullable: true }),
        column('name', type.shortText)
      ],
      primaryKey: ['id'], unique: [],
      foreignKeys: [{ name: 'fk_categories_parent', columns: ['parent_id'], referencedTable: 'categories', referencedColumns: ['id'] }]
    },
    {
      key: 'orders', schema: null, name: 'orders',
      columns: [
        column('id', type.bigId, { autoIncrement: true }),
        column('buyer_id', type.id),
        column('seller_id', type.id, { nullable: true }),
        column('coupon_id', type.id, { nullable: true }),
        column('total', type.money, { defaultValue: dialect === 'sqlserver' ? '((0))' : '0' }),
        column('status', type.shortText, { defaultValue: literal('new') }),
        column('type', type.shortText, { nullable: true }),
        column('total_with_tax', type.money, { nullable: true, computed: true })
      ],
      primaryKey: ['id'], unique: [],
      foreignKeys: [
        { name: 'fk_orders_buyer', columns: ['buyer_id'], referencedTable: 'users', referencedColumns: ['id'] },
        { name: 'fk_orders_seller', columns: ['seller_id'], referencedTable: 'users', referencedColumns: ['id'] },
        { name: 'fk_orders_coupon', columns: ['coupon_id'], referencedTable: 'coupons', referencedColumns: ['id'] }
      ]
    },
    {
      key: 'products', schema: null, name: 'products',
      columns: [
        column('sku', type.shortText),
        column('region', type.shortText),
        column('category_id', type.id, { nullable: true }),
        column('price', type.real, { nullable: true })
      ],
      primaryKey: ['sku', 'region'], unique: [],
      foreignKeys: [{ name: 'fk_products_category', columns: ['category_id'], referencedTable: 'categories', referencedColumns: ['id'] }]
    },
    {
      key: 'order_items', schema: null, name: 'order_items',
      columns: [
        column('order_id', type.bigId),
        column('sku', type.shortText),
        column('region', type.shortText),
        column('qty', type.id, { defaultValue: dialect === 'sqlserver' ? '((1))' : '1' })
      ],
      primaryKey: ['order_id', 'sku', 'region'], unique: [],
      foreignKeys: [
        { name: 'fk_items_order', columns: ['order_id'], referencedTable: 'orders', referencedColumns: ['id'] },
        { name: 'fk_items_product', columns: ['sku', 'region'], referencedTable: 'products', referencedColumns: ['sku', 'region'] }
      ]
    },
    {
      key: 'audit_log', schema: null, name: 'audit_log',
      columns: [column('at', type.when, { nullable: true }), column('message', type.longText, { nullable: true })],
      primaryKey: [], unique: [], foreignKeys: []
    },
    {
      key: '2fa codes', schema: null, name: '2fa codes',
      columns: [
        column('id', type.id, { autoIncrement: true }),
        column('class', type.shortText, { nullable: true }),
        column('user', type.id, { nullable: true })
      ],
      primaryKey: ['id'], unique: [],
      foreignKeys: [{ name: 'fk_codes_user', columns: ['user'], referencedTable: 'users', referencedColumns: ['id'] }]
    }
  ];
  return { dialect, tables };
}
