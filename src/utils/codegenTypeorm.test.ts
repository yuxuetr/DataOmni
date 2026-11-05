import { describe, expect, it } from 'vitest';
import { codegenFixture } from './codegenFixture';
import type { CodegenDialect } from './codegenModel';
import { generateTypeorm } from './codegenTypeorm';

/** 快照就是语料：`scripts/codegen-verify.sh` 把它们编译（tsc）并交给五种驱动各建一次元数据 */
describe('generateTypeorm', () => {
  it.each<CodegenDialect>(['postgresql', 'mysql', 'sqlite', 'sqlserver', 'oracle'])('%s fixture', async (dialect) => {
    const { files } = generateTypeorm(codegenFixture(dialect), 'fixture');
    for (const file of files) {
      await expect(file.contents).toMatchFileSnapshot(`./__snapshots__/codegen/typeorm-${dialect}/${file.path}`);
    }
  });

  it('skips the table without a primary key and says so', () => {
    const { files, notes } = generateTypeorm(codegenFixture('postgresql'), 'x');
    expect(files.map((file) => file.path)).not.toContain('audit-log.entity.ts');
    expect(notes).toContainEqual({ kind: 'skipped-table', table: 'audit_log', reason: 'no-primary-key' });
  });

  it('always writes a column type, even for types it cannot map', () => {
    // 不写 type 时 TypeORM 拿装饰器元数据推断，`string | null` 只剩 Object，启动就报错
    const { files, notes } = generateTypeorm(codegenFixture('postgresql'), 'x');
    const users = files.find((file) => file.path === 'users.entity.ts')?.contents ?? '';
    expect(users).toContain("@Column({ name: 'session_length', type: 'interval', nullable: true })");
    expect(notes).toContainEqual({ kind: 'unknown-type', table: 'users', column: 'session_length', dataType: 'interval' });
    for (const file of files) {
      expect(file.contents).not.toMatch(/@(?:Column|PrimaryColumn)\(\{(?![^}]*type:)[^}]*\}\)/);
    }
  });

  it('points join columns at the property name of the referenced column', () => {
    const { files } = generateTypeorm(codegenFixture('postgresql'), 'x');
    const items = files.find((file) => file.path === 'order-items.entity.ts')?.contents ?? '';
    expect(items).toContain(
      "@JoinColumn([{ name: 'sku', referencedColumnName: 'sku' }, { name: 'region', referencedColumnName: 'region' }])"
    );
  });
});
