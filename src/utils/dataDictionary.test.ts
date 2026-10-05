import { describe, expect, it } from 'vitest';
import { buildAgentSkill, buildDataDictionary, skillName, type DictionarySource } from './dataDictionary';
import type { TranslationKey, TranslationParams } from '../i18n/translate';

/** 键加参数原样吐出来：这里验的是结构，文案由 i18n 的门管 */
const t = (key: TranslationKey, params?: TranslationParams) =>
  params ? `${key}${JSON.stringify(params)}` : key;

const source: DictionarySource = {
  title: 'shop: prod',
  dialect: 'PostgreSQL',
  origin: 'catalog',
  date: '2026-09-28',
  tables: [
    { schema: 'app', name: 'users', columns: [
      { name: 'id', dataType: 'bigint', isPrimaryKey: true, isNullable: false },
      { name: 'note', dataType: 'text|weird', isPrimaryKey: false, isNullable: true }
    ] },
    { schema: 'app', name: 'orders', columns: [
      { name: 'id', dataType: 'bigint', isPrimaryKey: true, isNullable: false },
      { name: 'user_id', dataType: 'bigint', isPrimaryKey: false, isNullable: false }
    ] }
  ],
  links: [{ constraintName: 'fk', from: { table: 'app.orders', column: 'user_id' }, to: { table: 'app.users', column: 'id' } }]
};

describe('buildDataDictionary', () => {
  it('每张表一节：列、类型、可空、主键、指向谁；被引用的另起一行', () => {
    const text = buildDataDictionary(source, t);
    expect(text).toContain('## app.users');
    expect(text).toContain('| `id` | bigint | dictionary.no | ✓ |  |');
    expect(text).toContain('| `user_id` | bigint | dictionary.no |  | `app.users.id` |');
    expect(text).toContain('dictionary.referencedBy{"columns":"`app.orders.user_id`"}');
    // 表格里的竖线要转义，否则那一行被切成两格
    expect(text).toContain('| `note` | text\\|weird | dictionary.yes |');
    expect(text).toContain('dictionary.coverage');
    expect(text).not.toContain('dictionary.coverageDesign');
  });

  it('主键列写不可空，即使目录说可空（SQLite 的 INTEGER PRIMARY KEY 就这么报）', () => {
    const sqliteLike = {
      ...source,
      tables: [{ schema: null, name: 't', columns: [{ name: 'id', dataType: 'INTEGER', isPrimaryKey: true, isNullable: true }] }],
      links: []
    };
    expect(buildDataDictionary(sqliteLike, t)).toContain('| `id` | INTEGER | dictionary.no | ✓ |');
  });

  it('其余的主键照目录写：SQLite 里不是 INTEGER 的主键、复合主键都存得进 NULL（sqlite3 3.x 上插过）', () => {
    const columns = (list: Array<[string, string]>) => list.map(([name, dataType]) => ({ name, dataType, isPrimaryKey: true, isNullable: true }));
    const text = buildDataDictionary({
      ...source,
      tables: [
        { schema: null, name: 'a', columns: columns([['code', 'TEXT']]) },
        { schema: null, name: 'b', columns: columns([['n', 'INT']]) },
        { schema: null, name: 'c', columns: columns([['x', 'INTEGER'], ['y', 'INTEGER']]) }
      ],
      links: []
    }, t);
    expect(text).toContain('| `code` | TEXT | dictionary.yes | ✓ |');
    expect(text).toContain('| `n` | INT | dictionary.yes | ✓ |');
    expect(text).toContain('| `x` | INTEGER | dictionary.yes | ✓ |');
  });

  it('设计页上还没建的设计，开头那句说的是设计', () => {
    expect(buildDataDictionary({ ...source, origin: 'design' }, t)).toContain('dictionary.coverageDesign');
  });
});

describe('buildAgentSkill', () => {
  it('frontmatter 的 name 合规，description 是带引号的标量（标题里的冒号不会弄坏 YAML）', () => {
    const [open, name, description, close] = buildAgentSkill(source, t).split('\n');
    expect(open).toBe('---');
    expect(name).toBe('name: shop-prod-schema');
    expect(description?.startsWith('description: "dictionary.skillDescription{')).toBe(true);
    expect(close).toBe('---');
  });
});

describe('skillName', () => {
  it('只留小写字母、数字、连字符，最长 64', () => {
    expect(skillName('Shop DB (prod)')).toBe('shop-db-prod-schema');
    expect(skillName('订单库')).toBe('database-schema');
    const long = skillName('a'.repeat(100));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});
