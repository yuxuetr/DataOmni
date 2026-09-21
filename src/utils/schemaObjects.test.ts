import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPRESSION_COLUMN_PLACEHOLDER,
  groupForeignKeyRows,
  groupIndexRows,
  extractDdlStatements,
  joinDdlStatements,
  toCheckConstraints,
  toTriggers
} from './schemaObjects';

describe('groupIndexRows', () => {
  it('把同名索引的多行合成一条，列按 ordinal 排序', () => {
    // 故意打乱送进来的行序：驱动不保证顺序，靠 ordinal 才可靠
    const indexes = groupIndexRows([
      { index_name: 'uq_ab', column_name: 'b', ordinal: 2, is_unique: true, is_primary: false },
      { index_name: 'uq_ab', column_name: 'a', ordinal: 1, is_unique: true, is_primary: false }
    ]);

    expect(indexes).toEqual([
      { name: 'uq_ab', columns: ['a', 'b'], isUnique: true, isPrimary: false, method: null }
    ]);
  });

  it('MySQL / SQLite 的 1 与 0 也算布尔', () => {
    const [index] = groupIndexRows([
      { index_name: 'PRIMARY', column_name: 'id', ordinal: 1, is_unique: 1, is_primary: 1 }
    ]);
    expect(index.isUnique).toBe(true);
    expect(index.isPrimary).toBe(true);
  });

  it('0 不能被当成真', () => {
    const [index] = groupIndexRows([
      { index_name: 'ix', column_name: 'a', ordinal: 1, is_unique: 0, is_primary: 0 }
    ]);
    expect(index.isUnique).toBe(false);
    expect(index.isPrimary).toBe(false);
  });

  it('占位符自己不带括号——外层渲染已经包了一层，否则是 ((表达式))', () => {
    expect(DEFAULT_EXPRESSION_COLUMN_PLACEHOLDER.startsWith('(')).toBe(false);
  });

  it('占位符可以由调用方替换，用于按界面语言显示', () => {
    const [index] = groupIndexRows(
      [{ index_name: 'ix', column_name: '', ordinal: 1, is_unique: 0, is_primary: 0 }],
      '<表达式>'
    );
    expect(index.columns).toEqual(['<表达式>']);
  });

  it('列名为空的表达式索引显示成占位符，不是空白格', () => {
    // SQLite 对表达式索引既不给列名也不给表达式原文
    const [index] = groupIndexRows([
      { index_name: 'ix_expr', column_name: '', ordinal: 1, is_unique: 0, is_primary: 0 }
    ]);
    expect(index.columns).toEqual([DEFAULT_EXPRESSION_COLUMN_PLACEHOLDER]);
  });

  it('列名为 null 时同样用占位符', () => {
    const [index] = groupIndexRows([
      { index_name: 'ix_expr', column_name: null, ordinal: 1, is_unique: 0, is_primary: 0 }
    ]);
    expect(index.columns).toEqual([DEFAULT_EXPRESSION_COLUMN_PLACEHOLDER]);
  });

  it('主键排最前，其次唯一索引，同类按名字', () => {
    const indexes = groupIndexRows([
      { index_name: 'ix_b', column_name: 'b', ordinal: 1, is_unique: 0, is_primary: 0 },
      { index_name: 'ix_a', column_name: 'a', ordinal: 1, is_unique: 0, is_primary: 0 },
      { index_name: 'uq_c', column_name: 'c', ordinal: 1, is_unique: 1, is_primary: 0 },
      { index_name: 'pk', column_name: 'id', ordinal: 1, is_unique: 1, is_primary: 1 }
    ]);
    expect(indexes.map(index => index.name)).toEqual(['pk', 'uq_c', 'ix_a', 'ix_b']);
  });

  it('保留索引方法', () => {
    const [index] = groupIndexRows([
      { index_name: 'ix', column_name: 'a', ordinal: 1, is_unique: 0, is_primary: 0, method: 'btree' }
    ]);
    expect(index.method).toBe('btree');
  });

  it('空输入得到空数组', () => {
    expect(groupIndexRows([])).toEqual([]);
  });
});

describe('groupForeignKeyRows', () => {
  it('本表列与被引用列按 ordinal 一一配对', () => {
    // 打乱行序。若实现按到达顺序 push，复合外键就会错位——
    // 而错位之后的结果看上去完全正常
    const [fk] = groupForeignKeyRows([
      {
        constraint_name: 'fk',
        ordinal: 2,
        column_name: 'ref_b',
        referenced_table: 'parent',
        referenced_column: 'y',
        referenced_schema: 'public',
        on_update: 'RESTRICT',
        on_delete: 'CASCADE'
      },
      {
        constraint_name: 'fk',
        ordinal: 1,
        column_name: 'ref_a',
        referenced_table: 'parent',
        referenced_column: 'x',
        referenced_schema: 'public',
        on_update: 'RESTRICT',
        on_delete: 'CASCADE'
      }
    ]);

    expect(fk.columns).toEqual(['ref_a', 'ref_b']);
    expect(fk.referencedColumns).toEqual(['x', 'y']);
    expect(fk.referencedTable).toBe('parent');
    expect(fk.referencedSchema).toBe('public');
    expect(fk.onUpdate).toBe('RESTRICT');
    expect(fk.onDelete).toBe('CASCADE');
  });

  it('多条外键各自成组', () => {
    const foreignKeys = groupForeignKeyRows([
      { constraint_name: 'fk_a', ordinal: 1, column_name: 'a', referenced_table: 't1', referenced_column: 'id' },
      { constraint_name: 'fk_b', ordinal: 1, column_name: 'b', referenced_table: 't2', referenced_column: 'id' }
    ]);
    expect(foreignKeys.map(fk => fk.name)).toEqual(['fk_a', 'fk_b']);
  });

  it('SQLite 省略被引用列时保留 null，不伪造一个列名', () => {
    const [fk] = groupForeignKeyRows([
      { constraint_name: 'fk_0', ordinal: 1, column_name: 'a', referenced_table: 'parent', referenced_column: null }
    ]);
    expect(fk.referencedColumns).toEqual([null]);
  });

  it('没有 schema 时是 null', () => {
    const [fk] = groupForeignKeyRows([
      { constraint_name: 'fk_0', ordinal: 1, column_name: 'a', referenced_table: 'parent', referenced_column: 'id' }
    ]);
    expect(fk.referencedSchema).toBeNull();
  });
});

describe('toCheckConstraints', () => {
  it('取出名字与表达式', () => {
    expect(toCheckConstraints([{ constraint_name: 'ck', expression: 'score >= 0' }]))
      .toEqual([{ name: 'ck', expression: 'score >= 0' }]);
  });

  it('空表达式不会变成 undefined', () => {
    expect(toCheckConstraints([{ constraint_name: 'ck', expression: null }]))
      .toEqual([{ name: 'ck', expression: '' }]);
  });
});

describe('extractDdlStatements', () => {
  it('MySQL 的列名字面就叫 `Create Table`（带空格）', () => {
    expect(
      extractDdlStatements([{ Table: 'orders', 'Create Table': 'CREATE TABLE `orders` (...)' }])
    ).toEqual(['CREATE TABLE `orders` (...)']);
  });

  it('对视图 MySQL 返回的是 `Create View`', () => {
    expect(
      extractDdlStatements([{ View: 'v', 'Create View': 'CREATE VIEW v AS SELECT 1' }])
    ).toEqual(['CREATE VIEW v AS SELECT 1']);
  });

  it('SQLite 的多行按顺序拼成多条语句', () => {
    expect(
      extractDdlStatements([
        { sql: 'CREATE TABLE t (...)' },
        { sql: 'CREATE INDEX ix ON t (a)' }
      ])
    ).toEqual(['CREATE TABLE t (...)', 'CREATE INDEX ix ON t (a)']);
  });

  it('认不出来的行被跳过，而不是塞进一个 [object Object]', () => {
    expect(extractDdlStatements([{ unexpected: 'CREATE TABLE t' }])).toEqual([]);
  });

  it('空字符串不算一条语句', () => {
    expect(extractDdlStatements([{ sql: '' }, { sql: '   ' }])).toEqual([]);
  });
});

describe('joinDdlStatements', () => {
  it('每条以分号结尾，条与条之间空一行', () => {
    expect(joinDdlStatements(['CREATE TABLE t (a INT)', 'CREATE INDEX ix ON t (a)']))
      .toBe('CREATE TABLE t (a INT);\n\nCREATE INDEX ix ON t (a);');
  });

  it('本来就带分号的不再补一个', () => {
    expect(joinDdlStatements(['CREATE TABLE t (a INT);'])).toBe('CREATE TABLE t (a INT);');
  });

  it('没有语句时是空串', () => {
    expect(joinDdlStatements([])).toBe('');
  });
});

describe('toTriggers', () => {
  it('PostgreSQL / SQLite 给完整定义原文，时机与事件为空', () => {
    expect(
      toTriggers([
        {
          trigger_name: 'trg_audit',
          timing: null,
          event: null,
          definition: 'CREATE TRIGGER trg_audit BEFORE INSERT ON t ...'
        }
      ])
    ).toEqual([
      {
        name: 'trg_audit',
        timing: null,
        event: null,
        definition: 'CREATE TRIGGER trg_audit BEFORE INSERT ON t ...'
      }
    ]);
  });

  it('MySQL 给拆开的组件，原样保留不拼成 CREATE TRIGGER', () => {
    // 拼出来的 CREATE TRIGGER 未必能照着执行——那是伪造原文
    const [trigger] = toTriggers([
      {
        trigger_name: 'trg_score',
        timing: 'BEFORE',
        event: 'INSERT',
        definition: 'SET NEW.score = 1'
      }
    ]);
    expect(trigger.timing).toBe('BEFORE');
    expect(trigger.event).toBe('INSERT');
    expect(trigger.definition).toBe('SET NEW.score = 1');
    expect(trigger.definition).not.toContain('CREATE TRIGGER');
  });

  it('空定义不会变成 undefined', () => {
    expect(toTriggers([{ trigger_name: 'trg', definition: null }])[0].definition).toBe('');
  });

  it('空输入得到空数组', () => {
    expect(toTriggers([])).toEqual([]);
  });
});
