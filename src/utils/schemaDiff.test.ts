import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import type { TableCatalog } from './reconstructTableDdl';
import { comparableType, diffSchemas, type SchemaDiffDialect, type SchemaSnapshot } from './schemaDiff';
import type { ForeignKeyInfo, IndexInfo } from './schemaObjects';
import { buildSyncScript, defaultSelection, renderSyncScript, type SyncOptions } from './schemaSync';

const column = (name: string, data_type: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  data_type,
  is_nullable: true,
  is_primary_key: false,
  ...extra
});
const id = (data_type = 'integer'): ColumnInfo => column('id', data_type, { is_nullable: false, is_primary_key: true, primary_key_ordinal: 1 });
const index = (name: string, columns: string[], extra: Partial<IndexInfo> = {}): IndexInfo => ({
  name, columns, isUnique: false, isPrimary: false, isPartial: false, isValid: true, method: null, isConstraint: false, ...extra
});
const foreignKey = (name: string, columns: string[], referencedTable: string, referencedColumns: string[], extra: Partial<ForeignKeyInfo> = {}): ForeignKeyInfo => ({
  name, columns, referencedSchema: null, referencedTable, referencedColumns, onUpdate: null, onDelete: null, ...extra
});
const table = (name: string, columns: ColumnInfo[], extra: Partial<TableCatalog> = {}): TableCatalog => ({
  schema: null, name, columns, indexes: [], foreignKeys: [], checks: [], ...extra
});
const snapshot = (dialect: SchemaDiffDialect, tables: TableCatalog[]): SchemaSnapshot => ({ dialect, tables });

const t = ((key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ''}`) as SyncOptions['t'];
const options = (dialect: SchemaDiffDialect, extra: Partial<SyncOptions> = {}): SyncOptions => ({
  dialect, serverVersion: null, nativeDdl: new Map(), t, ...extra
});
const script = (source: SchemaSnapshot, target: SchemaSnapshot, extra: Partial<SyncOptions> = {}) => {
  const diff = diffSchemas(source, target);
  return buildSyncScript(diff, defaultSelection(diff), options(target.dialect, extra));
};

describe('diffSchemas', () => {
  const users = () => table('users', [id(), column('email', 'varchar(64)', { is_nullable: false })], {
    indexes: [index('uq_users_email', ['email'], { isUnique: true })]
  });

  it('finds nothing between two copies', () => {
    expect(diffSchemas(snapshot('postgresql', [users()]), snapshot('postgresql', [users()])).differences).toEqual([]);
  });

  it('reports tables only on one side; dropping one is not selected by default', () => {
    const diff = diffSchemas(snapshot('postgresql', [users()]), snapshot('postgresql', [table('legacy', [id()])]));
    expect(diff.differences.map((difference) => difference.kind)).toEqual(['table-added', 'table-removed']);
    expect([...defaultSelection(diff)]).toEqual([0]);
  });

  it('reports added, removed and changed columns, never a rename', () => {
    const source = table('users', [id(), column('email', 'varchar(128)', { is_nullable: false, default_value: "''::character varying" }), column('mail', 'text')]);
    const target = table('users', [id(), column('email', 'VARCHAR(64)'), column('phone', 'text')]);
    const differences = diffSchemas(snapshot('postgresql', [source]), snapshot('postgresql', [target])).differences;
    expect(differences.map((difference) => [difference.kind, 'changes' in difference ? difference.changes : null])).toEqual([
      ['column-changed', ['type', 'nullable', 'default']],
      ['column-added', null],
      ['column-removed', null]
    ]);
  });

  it('matches indexes by definition, not by name', () => {
    const renamed = users();
    renamed.indexes = [index('users_email_key', ['email'], { isUnique: true, isConstraint: true })];
    expect(diffSchemas(snapshot('postgresql', [users()]), snapshot('postgresql', [renamed])).differences).toEqual([]);
  });

  it('counts a duplicate index as a difference', () => {
    const doubled = users();
    doubled.indexes = [...doubled.indexes, index('uq_again', ['email'], { isUnique: true })];
    expect(diffSchemas(snapshot('postgresql', [users()]), snapshot('postgresql', [doubled])).differences.map((d) => d.kind)).toEqual(['index-removed']);
  });

  it('compares foreign keys by definition, including what happens on delete', () => {
    const orders = (rule: string | null, name = 'fk_orders_user') => table('orders', [id(), column('user_id', 'integer')], {
      foreignKeys: [foreignKey(name, ['user_id'], 'users', ['id'], { onDelete: rule })]
    });
    const same = diffSchemas(snapshot('postgresql', [users(), orders(null)]), snapshot('postgresql', [users(), orders('NO ACTION', 'orders_user_id_fkey')]));
    expect(same.differences).toEqual([]);
    const changed = diffSchemas(snapshot('postgresql', [users(), orders('CASCADE')]), snapshot('postgresql', [users(), orders(null)]));
    expect(changed.differences.map((difference) => difference.kind)).toEqual(['foreign-key-added', 'foreign-key-removed']);
  });

  it('reports a different primary key without offering to change it', () => {
    const target = table('users', [column('id', 'integer', { is_nullable: false }), column('email', 'varchar(64)', { is_nullable: false, is_primary_key: true, primary_key_ordinal: 1 })], {
      indexes: users().indexes
    });
    const diff = diffSchemas(snapshot('postgresql', [users()]), snapshot('postgresql', [target]));
    expect(diff.differences).toEqual([expect.objectContaining({ kind: 'primary-key-changed', source: ['id'], target: ['email'] })]);
    expect(defaultSelection(diff).size).toBe(0);
    expect(buildSyncScript(diff, new Set([0]), options('postgresql'))).toEqual({
      statements: [],
      refusals: [{ table: 'users', subject: '', reason: 'schemaSync.refuse.primaryKey', params: { source: 'id', target: 'email' } }],
      impacts: []
    });
  });

  it('pairs tables across differently named schemas when each side has only one', () => {
    const dev = { ...users(), schema: 'dev' };
    const prod = { ...users(), schema: 'prod' };
    const diff = diffSchemas(snapshot('postgresql', [dev]), snapshot('postgresql', [prod]));
    expect(diff.ignoreSchema).toBe(true);
    expect(diff.differences).toEqual([]);
    // 有一边不止一个 schema 时 schema 名要对得上
    const other = { ...users(), schema: 'other' };
    expect(diffSchemas(snapshot('postgresql', [dev, other]), snapshot('postgresql', [prod])).differences.map((d) => d.kind))
      .toEqual(['table-added', 'table-added', 'table-removed']);
  });

  it("ignores the schema in a serial column's sequence when schemas are ignored", () => {
    const counter = (schema: string) => table('t', [id(), column('n', 'integer', { default_value: `nextval('${schema}.t_n_seq'::regclass)` })], { schema });
    expect(diffSchemas(snapshot('postgresql', [counter('dev')]), snapshot('postgresql', [counter('prod')])).differences).toEqual([]);
    const plain = table('t', [id(), column('n', 'integer', { default_value: "nextval('t_n_seq'::regclass)" })], { schema: 'prod' });
    expect(diffSchemas(snapshot('postgresql', [counter('dev')]), snapshot('postgresql', [plain])).differences).toEqual([]);
  });

  it('matches table names regardless of case and column names exactly', () => {
    const upper = table('USERS', [id(), column('Email', 'varchar(64)', { is_nullable: false })], { indexes: [index('x', ['Email'], { isUnique: true })] });
    const kinds = diffSchemas(snapshot('postgresql', [users()]), snapshot('postgresql', [upper])).differences.map((d) => d.kind);
    expect(kinds).toEqual(['column-added', 'column-removed', 'index-added', 'index-removed']);
  });

  it('compares only presence and nullability across dialects', () => {
    const mysql = table('users', [id('int'), column('email', 'varchar(64)', { is_nullable: false, default_value: 'x' })]);
    const diff = diffSchemas(snapshot('mysql', [mysql]), snapshot('postgresql', [users()]));
    expect(diff.sameDialect).toBe(false);
    expect(diff.differences.map((d) => d.kind)).toEqual(['index-removed']);
  });
});

describe('comparableType', () => {
  it.each([
    ['int(11)', 'int', 'mysql', true],
    ['INT(10) UNSIGNED', 'int unsigned', 'mysql', true],
    ['tinyint(1)', 'tinyint(4)', 'mysql', true],
    ['decimal(10, 2)', 'DECIMAL(10,2)', 'postgresql', true],
    ['varchar(64)', 'varchar(65)', 'mysql', false],
    // 显示宽度只在 MySQL 上去掉
    ['int(11)', 'int', 'postgresql', false]
  ] as const)('%s vs %s on %s', (left, right, dialect, same) => {
    expect(comparableType(left, dialect) === comparableType(right, dialect)).toBe(same);
  });
});

describe('buildSyncScript', () => {
  it('orders the PostgreSQL script: drop keys, drop indexes, create, alter, index, add keys', () => {
    const source = [
      table('users', [id(), column('email', 'text', { is_nullable: false })], { schema: 'public', indexes: [index('idx_email', ['lower(email)'])] }),
      table('orders', [id(), column('user_id', 'integer')], { schema: 'public', foreignKeys: [foreignKey('fk_user', ['user_id'], 'users', ['id'], { referencedSchema: 'public', onDelete: 'CASCADE' })] }),
      table('tags', [id(), column('label', 'text')], { schema: 'public', indexes: [index('tags_label_key', ['label'], { isUnique: true, isConstraint: true })] })
    ];
    const target = [
      table('users', [id(), column('email', 'varchar(64)'), column('legacy', 'text')], { schema: 'public', indexes: [index('users_email_key', ['email'], { isUnique: true, isConstraint: true })] }),
      table('orders', [id(), column('user_id', 'integer')], { schema: 'public', foreignKeys: [foreignKey('old_fk', ['user_id'], 'users', ['id'], { referencedSchema: 'public' })] })
    ];
    const plan = script(snapshot('postgresql', source), snapshot('postgresql', target));
    expect(plan.statements).toEqual([
      'ALTER TABLE "public"."orders" DROP CONSTRAINT "old_fk"',
      'ALTER TABLE "public"."users" DROP CONSTRAINT "users_email_key"',
      'CREATE TABLE "public"."tags" (\n  "id" integer NOT NULL,\n  "label" text,\n  PRIMARY KEY ("id")\n);\nCREATE UNIQUE INDEX "tags_label_key" ON "public"."tags" (label);',
      'ALTER TABLE "public"."users" DROP COLUMN "legacy", ALTER COLUMN "email" TYPE text, ALTER COLUMN "email" SET NOT NULL',
      'CREATE INDEX "idx_email" ON "public"."users" (lower(email))',
      'ALTER TABLE "public"."orders" ADD CONSTRAINT "fk_user" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE'
    ]);
    expect(plan.impacts).toEqual([{ kind: 'drop-column', table: 'users', column: 'legacy' }]);
    expect(plan.refusals).toEqual([]);
  });

  it('creates the sequence a serial column needs and hands it to the column', () => {
    const counters = table('counters', [id(), column('n', 'integer', { default_value: "nextval('counters_n_seq'::regclass)" })]);
    expect(script(snapshot('postgresql', [counters]), snapshot('postgresql', [])).statements).toEqual([
      'CREATE SEQUENCE IF NOT EXISTS counters_n_seq',
      expect.stringContaining('"n" integer DEFAULT nextval(\'counters_n_seq\'::regclass)'),
      'ALTER SEQUENCE counters_n_seq OWNED BY "counters"."n"'
    ]);
  });

  it('moves a serial column and its sequence into the target schema', () => {
    const tags = table('tags', [id(), column('n', 'integer', { default_value: "nextval('dev.tags_n_seq'::regclass)" })], { schema: 'dev' });
    const plan = script(snapshot('postgresql', [tags]), snapshot('postgresql', [table('users', [id()], { schema: 'prod' })]));
    expect(plan.statements[0]).toBe('CREATE SEQUENCE IF NOT EXISTS prod.tags_n_seq');
    expect(plan.statements[1]).toContain("DEFAULT nextval('prod.tags_n_seq'::regclass)");
    expect(plan.statements[2]).toBe('ALTER SEQUENCE prod.tags_n_seq OWNED BY "prod"."tags"."n"');
  });

  it('drops and re-adds the MySQL foreign keys around a column whose type changes', () => {
    const users = (type: string) => table('users', [id(type)]);
    const orders = (type: string) => table('orders', [id('int'), column('user_id', type)], { foreignKeys: [foreignKey('fk_user', ['user_id'], 'users', ['id'])] });
    const plan = script(snapshot('mysql', [users('bigint'), orders('bigint')]), snapshot('mysql', [users('int'), orders('int')]));
    expect(plan.statements).toEqual([
      'ALTER TABLE `orders` DROP FOREIGN KEY `fk_user`',
      expect.stringMatching(/^ALTER TABLE `users` MODIFY COLUMN `id` bigint NOT NULL/),
      expect.stringMatching(/^ALTER TABLE `orders` MODIFY COLUMN `user_id` bigint NULL/),
      'ALTER TABLE `orders` ADD CONSTRAINT `fk_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)'
    ]);
  });

  it('creates a MySQL table from the definition the source gave, and says so when there is none', () => {
    const source = snapshot('mysql', [table('a', [id('int')]), table('b', [id('int')])]);
    const plan = script(source, snapshot('mysql', []), { nativeDdl: new Map<string, string | { error: string }>([['a', 'CREATE TABLE `a` (`id` int NOT NULL)'], ['b', { error: 'denied' }]]) });
    expect(plan.statements).toEqual(['CREATE TABLE `a` (`id` int NOT NULL)']);
    expect(plan.refusals).toEqual([{ table: 'b', subject: '', reason: 'schemaSync.refuse.ddlUnavailable', params: { error: 'denied' } }]);
  });

  it('creates referenced tables first', () => {
    const child = table('child', [id(), column('parent_id', 'integer')], { foreignKeys: [foreignKey('fk', ['parent_id'], 'parent', ['id'])] });
    const parent = table('parent', [id()]);
    const plan = script(snapshot('sqlite', [child, parent]), snapshot('sqlite', []), {
      nativeDdl: new Map([['child', 'CREATE TABLE child (…)'], ['parent', 'CREATE TABLE parent (…)']])
    });
    expect(plan.statements).toEqual(['CREATE TABLE parent (…)', 'CREATE TABLE child (…)']);
  });

  it('refuses what SQLite cannot do after the table exists, and renames an automatic index it recreates', () => {
    const source = table('t', [id(), column('a', 'text'), column('b', 'text')], {
      indexes: [index('sqlite_autoindex_t_1', ['a'], { isUnique: true, isConstraint: true })],
      foreignKeys: [foreignKey('fk_0', ['b'], 'u', ['id'])]
    });
    const target = table('t', [id(), column('a', 'text'), column('b', 'text')], {
      indexes: [index('sqlite_autoindex_t_2', ['b'], { isUnique: true, isConstraint: true })]
    });
    const plan = script(snapshot('sqlite', [source]), snapshot('sqlite', [target]));
    expect(plan.statements).toEqual(['CREATE UNIQUE INDEX "uq_t_a" ON "t" ("a")']);
    expect(plan.refusals.map((refusal) => [refusal.subject, refusal.reason])).toEqual([
      ['sqlite_autoindex_t_2', 'schemaSync.refuse.constraintIndex'],
      ['fk_0', 'schemaSync.refuse.foreignKeyAfterCreate']
    ]);
  });

  it('will not copy an Oracle definition into a differently named schema', () => {
    const plan = script(
      snapshot('oracle', [table('T', [id('NUMBER')], { schema: 'DEV' })]),
      snapshot('oracle', [table('OTHER', [id('NUMBER')], { schema: 'PROD' })]),
      { nativeDdl: new Map([['DEV.T', 'CREATE TABLE "DEV"."T" ("ID" NUMBER)']]) }
    );
    expect(plan.statements).toEqual([]);
    expect(plan.refusals).toEqual([{ table: 'T', subject: '', reason: 'schemaSync.refuse.createAcrossSchemas', params: { schema: 'PROD' } }]);
  });

  it('rebuilds a PostgreSQL table into the target schema when schemas are ignored', () => {
    const source = [
      table('users', [id()], { schema: 'dev' }),
      table('orders', [id(), column('user_id', 'integer')], { schema: 'dev', foreignKeys: [foreignKey('fk', ['user_id'], 'users', ['id'], { referencedSchema: 'dev' })] })
    ];
    const plan = script(snapshot('postgresql', source), snapshot('postgresql', [table('users', [id()], { schema: 'prod' })]));
    expect(plan.statements[0]).toMatch(/^CREATE TABLE "prod"\."orders"/);
    expect(plan.statements[1]).toBe('ALTER TABLE "prod"."orders" ADD CONSTRAINT "fk" FOREIGN KEY ("user_id") REFERENCES "prod"."users" ("id");');
  });

  it('drops a table only when asked, and lists it as data that goes away', () => {
    const diff = diffSchemas(snapshot('sqlserver', []), snapshot('sqlserver', [table('old', [id('int')], { schema: 'dbo' })]));
    expect(buildSyncScript(diff, defaultSelection(diff), options('sqlserver')).statements).toEqual([]);
    const plan = buildSyncScript(diff, new Set([0]), options('sqlserver'));
    expect(plan.statements).toEqual(['DROP TABLE [dbo].[old]']);
    expect(plan.impacts).toEqual([{ kind: 'drop-table', table: 'old', column: null }]);
  });

  it('passes the refusals of the column change through', () => {
    const plan = script(snapshot('sqlite', [table('t', [id(), column('a', 'integer')])]), snapshot('sqlite', [table('t', [id(), column('a', 'text')])]));
    expect(plan.statements).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ table: 't', subject: 'a' })]);
  });
});

describe('renderSyncScript', () => {
  it('ends each statement with a semicolon once', () => {
    expect(renderSyncScript(['DROP TABLE a', 'CREATE TABLE b (x int);\nCREATE INDEX i ON b (x);'])).toBe(
      'DROP TABLE a;\n\nCREATE TABLE b (x int);\nCREATE INDEX i ON b (x);'
    );
  });
});
