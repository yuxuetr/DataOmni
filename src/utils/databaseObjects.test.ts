import { describe, expect, it } from 'vitest';
import { DatabaseType } from '../contracts/connection';
import {
  KIND_LABEL_KEYS,
  buildObjectTree,
  isBrowsableKind,
  normalizeObjectRows,
  showsSchemaLevel
} from './databaseObjects';

describe('normalizeObjectRows', () => {
  it('取出名字、类型、schema 与 id', () => {
    expect(
      normalizeObjectRows([
        { object_schema: 'public', object_name: 'orders', object_kind: 'table', object_id: '16384' }
      ])
    ).toEqual([{ schema: 'public', name: 'orders', kind: 'table', id: '16384' }]);
  });

  it('SQLite 没有 schema，是 null 而不是字符串 "null"', () => {
    const [object] = normalizeObjectRows([
      { object_schema: null, object_name: 't', object_kind: 'table', object_id: 't' }
    ]);
    expect(object.schema).toBeNull();
  });

  it('认不出的类型归为 table，不凭空造一个分组', () => {
    const [object] = normalizeObjectRows([
      { object_schema: null, object_name: 'x', object_kind: 'FOREIGN TABLE', object_id: 'x' }
    ]);
    expect(object.kind).toBe('table');
  });

  it('没有 id 时退回用名字', () => {
    const [object] = normalizeObjectRows([
      { object_schema: null, object_name: 'x', object_kind: 'view' }
    ]);
    expect(object.id).toBe('x');
  });

  it('没有名字的行被跳过', () => {
    expect(normalizeObjectRows([{ object_name: null, object_kind: 'table' }])).toEqual([]);
  });
});

describe('showsSchemaLevel', () => {
  it('PostgreSQL 保留 schema 层：一个连接能横跨多个 schema', () => {
    expect(showsSchemaLevel(DatabaseType.PostgreSQL)).toBe(true);
  });

  it('MySQL 连接时已经选定了库，再显示一层库名是噪音', () => {
    expect(showsSchemaLevel(DatabaseType.MySQL)).toBe(false);
  });

  it('SQLite 根本没有 schema', () => {
    expect(showsSchemaLevel(DatabaseType.SQLite)).toBe(false);
  });
});

/** 分组标签由调用方翻译；这里用固定中文，测的是分组与排序本身 */
const LABELS: Record<string, string> = {
  table: '表',
  view: '视图',
  'materialized-view': '物化视图',
  function: '函数',
  procedure: '存储过程',
  sequence: '序列'
};
const stubLabel = (kind: string) => LABELS[kind];

describe('buildObjectTree', () => {
  const objects = [
    { schema: 'public', name: 'orders', kind: 'table' as const, id: '1' },
    { schema: 'public', name: 'customers', kind: 'table' as const, id: '2' },
    { schema: 'public', name: 'orders_v', kind: 'view' as const, id: '3' },
    { schema: 'billing', name: 'invoices', kind: 'table' as const, id: '4' }
  ];

  it('不带 schema 层时只按类型分组', () => {
    const tree = buildObjectTree(objects, false, stubLabel);
    expect(tree.map(group => [group.label, group.objects.length]))
      .toEqual([['表', 3], ['视图', 1]]);
  });

  it('带 schema 层时先按 schema 再按类型', () => {
    const tree = buildObjectTree(objects, true, stubLabel);
    expect(tree.map(group => group.label)).toEqual(['billing', 'public']);
    expect(tree[1].children?.map(child => [child.label, child.objects.length]))
      .toEqual([['表', 2], ['视图', 1]]);
  });

  it('空的类型分组不出现', () => {
    const tree = buildObjectTree([{ schema: null, name: 't', kind: 'table' as const, id: 't' }], false, stubLabel);
    expect(tree.map(group => group.label)).toEqual(['表']);
  });

  it('分组次序固定：表、视图、物化视图、函数、存储过程、序列', () => {
    const mixed = [
      { schema: null, name: 's', kind: 'sequence' as const, id: 's' },
      { schema: null, name: 'f', kind: 'function' as const, id: 'f' },
      { schema: null, name: 't', kind: 'table' as const, id: 't' },
      { schema: null, name: 'p', kind: 'procedure' as const, id: 'p' },
      { schema: null, name: 'm', kind: 'materialized-view' as const, id: 'm' },
      { schema: null, name: 'v', kind: 'view' as const, id: 'v' }
    ];
    expect(buildObjectTree(mixed, false, stubLabel).map(group => group.label))
      .toEqual(['表', '视图', '物化视图', '函数', '存储过程', '序列']);
  });

  it('组内按名字排序', () => {
    const tree = buildObjectTree(objects, false, stubLabel);
    expect(tree[0].objects.map(object => object.name))
      .toEqual(['customers', 'invoices', 'orders']);
  });
});

describe('isBrowsableKind', () => {
  it('表、视图、物化视图有数据，能当表打开', () => {
    expect(isBrowsableKind('table')).toBe(true);
    expect(isBrowsableKind('view')).toBe(true);
    expect(isBrowsableKind('materialized-view')).toBe(true);
  });

  it('函数、存储过程、序列没有行，打开表视图只会查询失败', () => {
    expect(isBrowsableKind('function')).toBe(false);
    expect(isBrowsableKind('procedure')).toBe(false);
    expect(isBrowsableKind('sequence')).toBe(false);
  });
});

describe('KIND_LABEL_KEYS', () => {
  it('每种类型都有对应的文案键', () => {
    for (const kind of ['table', 'view', 'materialized-view', 'function', 'procedure', 'sequence'] as const) {
      expect(KIND_LABEL_KEYS[kind]).toBe(`objectKind.${kind}`);
    }
  });
});
