import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DatabaseType } from '../contracts/connection';
import {
  KIND_BADGE_KEYS,
  KIND_LABEL_KEYS,
  MAX_RENDERED_TREE_ITEMS,
  buildObjectTree,
  filterObjects,
  isBrowsableKind,
  normalizeObjectRows,
  renderedTreeObjects,
  showsSchemaLevel,
  trailingSchemas,
  type DatabaseObject
} from './databaseObjects';

function objectNamed(name: string, schema: string | null = null): DatabaseObject {
  return { schema, name, kind: 'table', id: name };
}

function manyObjects(count: number): DatabaseObject[] {
  return Array.from({ length: count }, (_, index) =>
    objectNamed(`t_${String(index).padStart(5, '0')}`)
  );
}

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
  collection: '集合',
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
      // 分组抬头是复数、标一个对象是单数。混用的后果是英文界面上
      // 一个视图被标成「Views」
      expect(KIND_BADGE_KEYS[kind]).toBe(`objectKindOne.${kind}`);
    }
  });
});

describe('单组渲染上限', () => {
  /**
   * 这一条是「不做虚拟化」的重估门，写法学的是 `gridPagination.test.ts`。
   *
   * 关键在于比的是**字面量 200**，不是 `MAX_RENDERED_TREE_ITEMS` 自己。
   * 拿常量跟自己比永远是绿的，那样的门等于没有门——把常量改成 5000 也照样过，
   * 而 5000 那一档实测展开要 300ms。谁要放开这个上限，就得先重新量一遍。
   */
  it('上限不超过实测过的档位', () => {
    expect(MAX_RENDERED_TREE_ITEMS).toBeLessThanOrEqual(200);
  });

  it('超过上限时只画前面那些，剩下的个数如实报出来', () => {
    const { shown, hidden } = renderedTreeObjects(manyObjects(5000));
    expect(shown).toHaveLength(MAX_RENDERED_TREE_ITEMS);
    expect(hidden).toBe(5000 - MAX_RENDERED_TREE_ITEMS);
    // 挡住的不能凭空消失：画出来的加上报出来的，要等于全部
    expect(shown.length + hidden).toBe(5000);
  });

  it('不超上限时一个都不挡', () => {
    const { shown, hidden } = renderedTreeObjects(manyObjects(MAX_RENDERED_TREE_ITEMS));
    expect(shown).toHaveLength(MAX_RENDERED_TREE_ITEMS);
    expect(hidden).toBe(0);
  });

  it('空组不报负数', () => {
    expect(renderedTreeObjects([])).toEqual({ shown: [], hidden: 0 });
  });

  it('画出来的是前面那些，顺序不变', () => {
    const { shown } = renderedTreeObjects(manyObjects(300));
    expect(shown[0].name).toBe('t_00000');
    expect(shown[MAX_RENDERED_TREE_ITEMS - 1].name)
      .toBe(`t_${String(MAX_RENDERED_TREE_ITEMS - 1).padStart(5, '0')}`);
  });

  /**
   * 上限只在纯函数里生效是不够的：组件绕过它直接 `node.objects.map` 一样能
   * 把 5000 行画出来，而那一版看起来完全正常，只是每次展开卡 300ms。
   */
  it('对象树组件不许绕过上限直接铺 node.objects', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/DatabaseExplorer.tsx'),
      'utf8'
    );
    expect(source).toContain('renderedTreeObjects(node.objects)');
    expect(source).not.toMatch(/node\.objects\.map/);
  });
});

describe('filterObjects', () => {
  const objects = [
    objectNamed('orders', 'public'),
    objectNamed('order_items', 'public'),
    objectNamed('customers', 'public'),
    objectNamed('invoices', 'billing')
  ];

  it('空筛选词原样返回', () => {
    expect(filterObjects(objects, '')).toHaveLength(4);
    expect(filterObjects(objects, '   ')).toHaveLength(4);
  });

  it('按名字筛', () => {
    expect(filterObjects(objects, 'order').map(object => object.name))
      .toEqual(['orders', 'order_items']);
  });

  it('输 schema 名能把那个 schema 整个筛出来', () => {
    expect(filterObjects(objects, 'billing').map(object => object.name)).toEqual(['invoices']);
  });

  it('大小写不敏感', () => {
    expect(filterObjects(objects, 'CUSTOM').map(object => object.name)).toEqual(['customers']);
  });

  it('是子串不是子序列：输 or 不该把 customers 留下', () => {
    // c-u-s-t-o-m-e-r-s 在子序列意义上确实含 o…r。命令面板容得下这种宽松，
    // 因为它按分数排序、只露前 50 条；树里结果保持字母序一条不漏地铺开，
    // 噪音就摊在每一屏里。而人筛东西时第一个输入的恰恰是两三个字母
    expect(filterObjects(objects, 'or').map(object => object.name))
      .toEqual(['orders', 'order_items']);
  });

  it('筛不到就是空，不退回全部', () => {
    expect(filterObjects(objects, 'zzzz')).toEqual([]);
  });

  it('保持传进来的顺序，不按相似度重排', () => {
    // 按相似度排的话 `customers` 会跑到前面（更短、同样不在词首）；树按名字
    // 排好了，筛一下就跳位置会让人每次都要重新找一遍刚刚看到的那一行
    expect(filterObjects(objects, 'm').map(object => object.name))
      .toEqual(['order_items', 'customers']);
  });
});

describe('MongoDB 的库排序', () => {
  it('服务端自己的 admin / config / local 排在业务库后面', () => {
    const objects = ['admin', 'config', 'shop', 'local', 'analytics'].map((schema) => ({
      schema,
      name: 'c',
      kind: 'collection' as const,
      id: `${schema}.c`
    }));
    const tree = buildObjectTree(objects, true, stubLabel, trailingSchemas(DatabaseType.MongoDB));
    expect(tree.map((node) => node.label)).toEqual(['analytics', 'shop', 'admin', 'config', 'local']);
    // 反向：别的库上没有这条规则，一个叫 admin 的 schema 照字母排
    const plain = buildObjectTree(objects, true, stubLabel, trailingSchemas(DatabaseType.PostgreSQL));
    expect(plain.map((node) => node.label)[0]).toBe('admin');
  });
});
