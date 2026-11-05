import { describe, expect, it } from 'vitest';
import { codegenFixture } from './codegenFixture';
import type { CodegenSchema, CodegenTable } from './codegenModel';
import { generateSeaorm, type SeaormDialect } from './codegenSeaorm';
import { generateSqlx, type SqlxDialect } from './codegenSqlx';

/** 快照就是语料：`scripts/codegen-verify.sh` 把它们放进一个依赖 sea-orm 1.1 与 sqlx 0.8 的 crate，`cargo check` 不许有警告 */
describe('generateSeaorm', () => {
  const fixture = (dialect: SeaormDialect) => codegenFixture(dialect) as CodegenSchema & { dialect: SeaormDialect };

  it.each<SeaormDialect>(['postgresql', 'mysql', 'sqlite'])('%s fixture', async (dialect) => {
    const { files } = generateSeaorm(fixture(dialect), 'fixture');
    for (const file of files) {
      await expect(file.contents).toMatchFileSnapshot(`./__snapshots__/codegen/seaorm-${dialect}/${file.path}`);
    }
  });

  it('writes Related only for a pair of tables joined by exactly one relation', () => {
    // Related<T> 对同一个 T 只能实现一次（两次是 E0119），has_many 又要对面有 Related<本表>
    const { files } = generateSeaorm(fixture('postgresql'), 'x');
    const orders = files.find((file) => file.path === 'orders.rs')?.contents ?? '';
    expect(orders).not.toContain('impl Related<super::users::Entity>');
    expect(orders).toContain('impl Related<super::order_items::Entity>');
    const categories = files.find((file) => file.path === 'categories.rs')?.contents ?? '';
    expect(categories).toContain('belongs_to = "Entity"');
    expect(categories).not.toContain('impl Related<super::categories::Entity>');
  });

  it('also drops Related when two tables reference each other', () => {
    const table = (name: string, other: string): CodegenTable => ({
      key: name, schema: null, name,
      columns: [
        { name: 'id', dataType: 'integer', nullable: false, autoIncrement: true, computed: false, defaultValue: null },
        { name: `${other}_id`, dataType: 'integer', nullable: true, autoIncrement: false, computed: false, defaultValue: null }
      ],
      primaryKey: ['id'], unique: [],
      foreignKeys: [{ name: `fk_${name}`, columns: [`${other}_id`], referencedTable: other, referencedColumns: ['id'] }]
    });
    const { files } = generateSeaorm({ dialect: 'postgresql', tables: [table('a', 'b'), table('b', 'a')] }, 'x');
    for (const file of files) expect(file.contents).not.toContain('impl Related');
  });

  it('marks keys that are not auto increment, and escapes keywords', () => {
    const { files } = generateSeaorm(fixture('postgresql'), 'x');
    const items = files.find((file) => file.path === 'order_items.rs')?.contents ?? '';
    expect(items).toContain('#[sea_orm(primary_key, auto_increment = false)]');
    const orders = files.find((file) => file.path === 'orders.rs')?.contents ?? '';
    expect(orders).toContain('#[sea_orm(column_name = "type")]\n    pub type_: Option<String>,');
  });
});

describe('generateSqlx', () => {
  it.each<SqlxDialect>(['postgresql', 'mysql', 'sqlite'])('%s fixture', async (dialect) => {
    const { files } = generateSqlx(codegenFixture(dialect) as CodegenSchema & { dialect: SqlxDialect }, 'fixture');
    expect(files.map((file) => file.path)).toEqual(['models.rs']);
    await expect(files[0].contents).toMatchFileSnapshot(`./__snapshots__/codegen/sqlx-${dialect}/models.rs`);
  });

  it('keeps integer widths exact, since sqlx checks them when decoding', () => {
    const { files } = generateSqlx(codegenFixture('mysql') as CodegenSchema & { dialect: 'mysql' }, 'x');
    const text = files[0].contents;
    expect(text).toContain('pub id: u64,'); // bigint unsigned
    expect(text).toContain('pub buyer_id: i32,');
    expect(text).toContain('pub is_active: bool,'); // tinyint(1)
  });
});
