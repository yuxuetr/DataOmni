import { describe, expect, it } from 'vitest';
import { codegenFixture } from './codegenFixture';
import type { CodegenSchema } from './codegenModel';
import { generateMikroorm, type MikroormDialect } from './codegenMikroorm';

/** 快照就是语料：`scripts/codegen-verify.sh` 把它们编译（tsc）并在四种驱动上各跑一次实体发现 */
describe('generateMikroorm', () => {
  const fixture = (dialect: MikroormDialect) => codegenFixture(dialect) as CodegenSchema & { dialect: MikroormDialect };

  it.each<MikroormDialect>(['postgresql', 'mysql', 'sqlite', 'sqlserver'])('%s fixture', async (dialect) => {
    const { files } = generateMikroorm(fixture(dialect), 'fixture');
    for (const file of files) {
      await expect(file.contents).toMatchFileSnapshot(`./__snapshots__/codegen/mikroorm-${dialect}/${file.path}`);
    }
  });

  it('maps a foreign key column only through its relation, primary key included', () => {
    // MikroORM 里一列只能映射一个属性：外键列再写成普通属性，发现实体时报重复的列
    const { files } = generateMikroorm(fixture('postgresql'), 'x');
    const items = files.find((file) => file.path === 'order-items.entity.ts')?.contents ?? '';
    expect(items).not.toMatch(/orderId!|sku!|region!/);
    expect(items).toContain("joinColumns: ['sku', 'region'], primary: true");
  });

  it('skips a second relation over the same columns', () => {
    const schema = fixture('postgresql');
    const items = schema.tables.find((table) => table.name === 'order_items');
    items?.foreignKeys.push({ name: 'fk_again', columns: ['order_id'], referencedTable: 'orders', referencedColumns: ['id'] });
    const { notes } = generateMikroorm(schema, 'x');
    expect(notes).toContainEqual({ kind: 'skipped-relation', table: 'order_items', constraint: 'fk_again', reason: 'shared-column' });
  });
});
