import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import {
  buildTableDdl,
  columnDefaultSql,
  incompleteDraftColumns,
  type ColumnDraft,
  type TableDdlRequest
} from './tableDdl';
import type { SqlIdentifierDialect } from './sqlIdentifiers';

function column(overrides: Partial<ColumnInfo> & { name: string }): ColumnInfo {
  return {
    data_type: 'int',
    is_nullable: true,
    is_primary_key: false,
    ...overrides
  };
}

/** 未改动的草稿：界面打开时每一列的起点 */
function draftOf(origin: ColumnInfo, dialect: SqlIdentifierDialect): ColumnDraft {
  return {
    origin,
    name: origin.name,
    dataType: origin.data_type,
    nullable: origin.is_nullable,
    defaultValue: columnDefaultSql(origin, dialect),
    dropped: false
  };
}

function request(
  dialect: SqlIdentifierDialect,
  columns: readonly ColumnDraft[],
  overrides: Partial<TableDdlRequest> = {}
): TableDdlRequest {
  return {
    schema: null,
    table: 'orders',
    newTableName: 'orders',
    dialect,
    columns,
    ...overrides
  };
}

describe('columnDefaultSql', () => {
  it('MySQL 的字符串默认值在目录里是裸的，要补回引号', () => {
    // 已在 MySQL 8.4 上核对：DEFAULT 'active' 的 COLUMN_DEFAULT 就是 active
    const origin = column({ name: 's', data_type: 'varchar(16)', default_value: 'active' });
    expect(columnDefaultSql(origin, 'mysql')).toBe("'active'");
  });

  it('MySQL 的数值默认值不加引号', () => {
    const origin = column({ name: 'n', data_type: 'int', default_value: '0' });
    expect(columnDefaultSql(origin, 'mysql')).toBe('0');
  });

  it('MySQL 靠 EXTRA 区分表达式和同名的字符串', () => {
    // DEFAULT 'CURRENT_TIMESTAMP'（字符串）与 DEFAULT CURRENT_TIMESTAMP（表达式）
    // 的 COLUMN_DEFAULT 完全相同，唯一的区别是 EXTRA 里的 DEFAULT_GENERATED
    const literal = column({
      name: 'lit', data_type: 'varchar(32)', default_value: 'CURRENT_TIMESTAMP', column_extra: ''
    });
    const expression = column({
      name: 'ts', data_type: 'timestamp', default_value: 'CURRENT_TIMESTAMP',
      column_extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP'
    });
    expect(columnDefaultSql(literal, 'mysql')).toBe("'CURRENT_TIMESTAMP'");
    expect(columnDefaultSql(expression, 'mysql')).toBe('CURRENT_TIMESTAMP');
  });

  it('另两家的目录给的本来就是 SQL 原文，原样带过去', () => {
    const origin = column({ name: 's', data_type: 'text', default_value: "'active'::text" });
    expect(columnDefaultSql(origin, 'postgresql')).toBe("'active'::text");
    expect(columnDefaultSql(column({ name: 'x' }), 'sqlite')).toBeNull();
  });
});

describe('buildTableDdl / PostgreSQL', () => {
  const id = column({ name: 'id', data_type: 'integer', is_nullable: false });
  const code = column({ name: 'code', data_type: 'character varying(32)' });

  it('没动过就一条语句也不出', () => {
    const plan = buildTableDdl(request('postgresql', [
      draftOf(id, 'postgresql'), draftOf(code, 'postgresql')
    ]));
    expect(plan).toEqual({ statements: [], refusals: [], impacts: [] });
  });

  it('加列、删列与改属性合成一条 ALTER TABLE', () => {
    const plan = buildTableDdl(request('postgresql', [
      draftOf(id, 'postgresql'),
      { ...draftOf(code, 'postgresql'), dropped: true },
      {
        origin: null, name: 'note', dataType: 'text',
        nullable: false, defaultValue: "''", dropped: false
      }
    ]));
    expect(plan.statements).toEqual([
      'ALTER TABLE "orders" DROP COLUMN "code", ADD COLUMN "note" text NOT NULL DEFAULT \'\''
    ]);
    expect(plan.impacts).toEqual([{ kind: 'drop-column', column: 'code' }]);
  });

  it('每种改动各自一个窄子命令，不重述整段定义', () => {
    const plan = buildTableDdl(request('postgresql', [
      {
        ...draftOf(code, 'postgresql'),
        dataType: 'text', nullable: false, defaultValue: "'x'"
      }
    ]));
    expect(plan.statements).toEqual([
      'ALTER TABLE "orders" ALTER COLUMN "code" TYPE text,'
        + ' ALTER COLUMN "code" SET NOT NULL,'
        + ' ALTER COLUMN "code" SET DEFAULT \'x\''
    ]);
  });

  it('清掉默认值发 DROP DEFAULT，不发 SET DEFAULT NULL', () => {
    const withDefault = column({ name: 'n', data_type: 'integer', default_value: '0' });
    const plan = buildTableDdl(request('postgresql', [
      { ...draftOf(withDefault, 'postgresql'), defaultValue: null }
    ]));
    expect(plan.statements).toEqual(['ALTER TABLE "orders" ALTER COLUMN "n" DROP DEFAULT']);
  });

  it('改列名单独成句并排在最前，后面的动作用新名字', () => {
    // PostgreSQL 不允许 RENAME 与别的动作并列在同一条 ALTER TABLE 里
    const plan = buildTableDdl(request('postgresql', [
      { ...draftOf(code, 'postgresql'), name: 'sku', dataType: 'text' }
    ]));
    expect(plan.statements).toEqual([
      'ALTER TABLE "orders" RENAME COLUMN "code" TO "sku"',
      'ALTER TABLE "orders" ALTER COLUMN "sku" TYPE text'
    ]);
  });

  it('改表名排在最后，前面几条还在用旧名字', () => {
    const plan = buildTableDdl(request('postgresql', [
      { ...draftOf(code, 'postgresql'), nullable: false }
    ], { newTableName: 'sales' }));
    expect(plan.statements).toEqual([
      'ALTER TABLE "orders" ALTER COLUMN "code" SET NOT NULL',
      'ALTER TABLE "orders" RENAME TO "sales"'
    ]);
  });

  it('schema 与含引号的标识符都引用过', () => {
    const odd = column({ name: 'we"ird', data_type: 'text' });
    const plan = buildTableDdl(request('postgresql', [
      { ...draftOf(odd, 'postgresql'), nullable: false }
    ], { schema: 'public', table: 'my table', newTableName: 'my table' }));
    expect(plan.statements).toEqual([
      'ALTER TABLE "public"."my table" ALTER COLUMN "we""ird" SET NOT NULL'
    ]);
  });
});

describe('buildTableDdl / MySQL', () => {
  const code = column({
    name: 'code', data_type: 'varchar(32)', is_nullable: false,
    collation: 'utf8mb4_bin', comment: 'hello', column_extra: ''
  });
  const id = column({
    name: 'id', data_type: 'int', is_nullable: false,
    is_generated: true, column_extra: 'auto_increment'
  });

  it('全部动作合成一条语句——MySQL 的 DDL 隐式提交，多条就不再是原子的', () => {
    const plan = buildTableDdl(request('mysql', [
      { ...draftOf(id, 'mysql'), name: 'order_id' },
      { ...draftOf(code, 'mysql'), dropped: true },
      {
        origin: null, name: 'note', dataType: 'text',
        nullable: true, defaultValue: null, dropped: false
      }
    ], { newTableName: 'sales' }));
    expect(plan.statements).toEqual([
      'ALTER TABLE `orders` DROP COLUMN `code`,'
        + ' RENAME COLUMN `id` TO `order_id`,'
        + ' ADD COLUMN `note` text,'
        + ' RENAME TO `sales`'
    ]);
  });

  it('改类型要重述整段定义，排序规则、注释、自增、ON UPDATE 都得带上', () => {
    // 少写一项 MySQL 不会报错，它只是把那个属性删掉
    const ts = column({
      name: 'ts', data_type: 'timestamp', is_nullable: false,
      column_extra: 'on update CURRENT_TIMESTAMP'
    });
    const plan = buildTableDdl(request('mysql', [
      { ...draftOf(code, 'mysql'), dataType: 'varchar(64)' },
      { ...draftOf(ts, 'mysql'), nullable: true }
    ]));
    expect(plan.statements).toEqual([
      'ALTER TABLE `orders`'
        + ' MODIFY COLUMN `code` varchar(64) COLLATE utf8mb4_bin NOT NULL COMMENT \'hello\','
        + ' MODIFY COLUMN `ts` timestamp NULL ON UPDATE CURRENT_TIMESTAMP'
    ]);
  });

  it('自增列改类型时把 AUTO_INCREMENT 一起重述', () => {
    const plan = buildTableDdl(request('mysql', [
      { ...draftOf(id, 'mysql'), dataType: 'bigint' }
    ]));
    expect(plan.statements).toEqual([
      'ALTER TABLE `orders` MODIFY COLUMN `id` bigint NOT NULL AUTO_INCREMENT'
    ]);
  });

  it('既改名又改类型用 CHANGE 一次做完', () => {
    // RENAME COLUMN 之后再 MODIFY 依赖同一条 ALTER 里动作的生效次序，那没有保证
    const plan = buildTableDdl(request('mysql', [
      { ...draftOf(code, 'mysql'), name: 'sku', dataType: 'varchar(64)' }
    ]));
    expect(plan.statements).toEqual([
      'ALTER TABLE `orders`'
        + ' CHANGE COLUMN `code` `sku` varchar(64) COLLATE utf8mb4_bin NOT NULL COMMENT \'hello\''
    ]);
  });

  it('只改默认值走窄语法，不重述', () => {
    const plan = buildTableDdl(request('mysql', [
      { ...draftOf(code, 'mysql'), defaultValue: "'x'" }
    ]));
    expect(plan.statements).toEqual([
      "ALTER TABLE `orders` ALTER COLUMN `code` SET DEFAULT 'x'"
    ]);
  });

  it('表达式默认值的列拒绝改类型，不拼一条可能不等价的重述', () => {
    const ex = column({
      name: 'ex', data_type: 'varchar(32)',
      default_value: "upper(_utf8mb4\\'x\\')", column_extra: 'DEFAULT_GENERATED'
    });
    const plan = buildTableDdl(request('mysql', [
      { ...draftOf(ex, 'mysql'), dataType: 'varchar(64)' }
    ]));
    expect(plan.statements).toEqual([]);
    expect(plan.refusals).toEqual([
      { column: 'ex', action: 'change-type', reason: 'ddl.refuse.mysqlExpressionDefault' }
    ]);
  });

  it('计算列拒绝改类型', () => {
    const generated = column({
      name: 'area', data_type: 'int', is_generated: true, column_extra: 'STORED GENERATED'
    });
    const plan = buildTableDdl(request('mysql', [
      { ...draftOf(generated, 'mysql'), dataType: 'bigint' }
    ]));
    expect(plan.statements).toEqual([]);
    expect(plan.refusals.map((refusal) => refusal.reason))
      .toEqual(['ddl.refuse.mysqlGeneratedColumn']);
  });
});

describe('buildTableDdl / SQLite', () => {
  const code = column({ name: 'code', data_type: 'VARCHAR(32)', is_nullable: false });

  it('加列、删列、改列名各自一条——SQLite 的 ALTER TABLE 一次只能做一件事', () => {
    const plan = buildTableDdl(request('sqlite', [
      { ...draftOf(code, 'sqlite'), name: 'sku' },
      {
        origin: null, name: 'note', dataType: 'TEXT',
        nullable: true, defaultValue: null, dropped: false
      },
      { ...draftOf(column({ name: 'old', data_type: 'INT' }), 'sqlite'), dropped: true }
    ]));
    // 删列排在加列前面：反过来的次序在「删掉一列再建一个同名的」上会撞车
    expect(plan.statements).toEqual([
      'ALTER TABLE "orders" RENAME COLUMN "code" TO "sku"',
      'ALTER TABLE "orders" DROP COLUMN "old"',
      'ALTER TABLE "orders" ADD COLUMN "note" TEXT'
    ]);
  });

  it('改类型、可空性、默认值一律拒绝，理由说清为什么不自己重建表', () => {
    const plan = buildTableDdl(request('sqlite', [
      { ...draftOf(code, 'sqlite'), dataType: 'TEXT', nullable: true, defaultValue: "'x'" }
    ]));
    expect(plan.statements).toEqual([]);
    expect(plan.refusals).toEqual([
      { column: 'code', action: 'change-type', reason: 'ddl.refuse.sqliteRebuild' },
      { column: 'code', action: 'change-nullability', reason: 'ddl.refuse.sqliteRebuild' },
      { column: 'code', action: 'change-default', reason: 'ddl.refuse.sqliteRebuild' }
    ]);
  });

  it('被拒绝的那几项不影响同一次里能做的改名', () => {
    const plan = buildTableDdl(request('sqlite', [
      { ...draftOf(code, 'sqlite'), name: 'sku', dataType: 'TEXT' }
    ]));
    expect(plan.statements).toEqual(['ALTER TABLE "orders" RENAME COLUMN "code" TO "sku"']);
    expect(plan.refusals.map((refusal) => refusal.action)).toEqual(['change-type']);
  });
});

describe('incompleteDraftColumns', () => {
  it('点名缺名字或缺类型的列', () => {
    expect(incompleteDraftColumns([
      { origin: null, name: '', dataType: 'int', nullable: true, defaultValue: null, dropped: false },
      { origin: null, name: 'ok', dataType: '', nullable: true, defaultValue: null, dropped: false },
      { origin: null, name: 'fine', dataType: 'int', nullable: true, defaultValue: null, dropped: false }
    ])).toEqual(['', 'ok']);
  });

  it('已标记删除的列不算', () => {
    const origin = column({ name: 'gone', data_type: '' });
    expect(incompleteDraftColumns([
      { origin, name: 'gone', dataType: '', nullable: true, defaultValue: null, dropped: true }
    ])).toEqual([]);
  });
});
