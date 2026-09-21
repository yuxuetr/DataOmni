import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ER_METRICS,
  columnAnchor,
  layoutErDiagram,
  matchErTables,
  toErLinks,
  toErTables,
  truncateLabel,
  type ErLink,
  type ErTable
} from './erLayout';

const table = (name: string, ...columns: string[]): ErTable => ({
  schema: null,
  name,
  columns: columns.map((column, index) => ({
    name: column,
    dataType: 'int',
    isPrimaryKey: index === 0,
    isNullable: false
  }))
});

const link = (fromTable: string, fromColumn: string, toTable: string, toColumn: string): ErLink => ({
  constraintName: `fk_${fromTable}_${fromColumn}`,
  from: { table: fromTable, column: fromColumn },
  to: { table: toTable, column: toColumn }
});

function overlaps(a: { x: number; y: number; width: number; height: number },
                  b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('layoutErDiagram', () => {
  it('每张表都有一个节点——包括一条外键都没有的', () => {
    // 用户明确要求：有关联的和没关联的表都要画出来
    const layout = layoutErDiagram(
      [table('orders', 'id'), table('customers', 'id'), table('audit_log', 'id')],
      [link('orders', 'id', 'customers', 'id')]
    );

    expect(layout.nodes.map(node => node.key).sort()).toEqual(['audit_log', 'customers', 'orders']);
  });

  it('任何两个节点都不重叠', () => {
    // 重叠是「看上去坏掉」的主要形态，而它不会引发任何报错
    const tables = Array.from({ length: 12 }, (_, i) =>
      table(`t${i}`, 'id', 'a', 'b', 'c')
    );
    const links = [
      link('t0', 'a', 't1', 'id'),
      link('t1', 'a', 't2', 'id'),
      link('t2', 'a', 't3', 'id'),
      link('t4', 'a', 't5', 'id'),
      link('t0', 'b', 't3', 'id')
    ];

    const layout = layoutErDiagram(tables, links);

    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (let j = i + 1; j < layout.nodes.length; j += 1) {
        expect(
          overlaps(layout.nodes[i], layout.nodes[j]),
          `${layout.nodes[i].key} 与 ${layout.nodes[j].key} 重叠`
        ).toBe(false);
      }
    }
  });

  it('节点高度随列数增长', () => {
    const layout = layoutErDiagram([table('a', 'id'), table('b', 'id', 'x', 'y', 'z')], []);
    const short = layout.nodes.find(node => node.key === 'a');
    const tall = layout.nodes.find(node => node.key === 'b');
    expect(tall!.height).toBeGreaterThan(short!.height);
    expect(tall!.height - short!.height).toBe(3 * DEFAULT_ER_METRICS.rowHeight);
  });

  it('被引用的表排在引用它的表左边——外键指向的方向一眼可见', () => {
    const layout = layoutErDiagram(
      [table('orders', 'id', 'customer_id'), table('customers', 'id')],
      [link('orders', 'customer_id', 'customers', 'id')]
    );
    const orders = layout.nodes.find(node => node.key === 'orders')!;
    const customers = layout.nodes.find(node => node.key === 'customers')!;
    expect(customers.x).toBeLessThan(orders.x);
  });

  it('孤立的表排成网格，不堆成一长列', () => {
    // 每张孤立表各占一行会把图拉得极长，而右边整片空白
    const tables = Array.from({ length: 8 }, (_, i) => table(`lonely${i}`, 'id'));
    const layout = layoutErDiagram(tables, []);

    const columns = new Set(layout.nodes.map(node => node.x));
    expect(columns.size).toBeGreaterThan(1);
  });

  it('孤立的表排在有关联的分组下面', () => {
    const layout = layoutErDiagram(
      [table('orders', 'id'), table('customers', 'id'), table('lonely', 'id')],
      [link('orders', 'id', 'customers', 'id')]
    );
    const lonely = layout.nodes.find(node => node.key === 'lonely')!;
    const linked = layout.nodes.filter(node => node.key !== 'lonely');
    for (const node of linked) {
      expect(lonely.y).toBeGreaterThanOrEqual(node.y + node.height);
    }
  });

  it('画布尺寸覆盖所有节点', () => {
    const layout = layoutErDiagram(
      [table('a', 'id'), table('b', 'id'), table('c', 'id')],
      [link('a', 'id', 'b', 'id')]
    );
    for (const node of layout.nodes) {
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it('同样的输入得到同样的布局——换个顺序传进来也一样', () => {
    // 不稳定的布局会让每次刷新都换一个样子，没法对照着看
    const tables = [table('a', 'id'), table('b', 'id'), table('c', 'id')];
    const links = [link('a', 'id', 'b', 'id')];
    const first = layoutErDiagram(tables, links);
    const second = layoutErDiagram([...tables].reverse(), links);
    expect(second.nodes).toEqual(first.nodes);
  });

  it('指向不存在的表的外键被完全忽略，布局与没有这条边时一模一样', () => {
    // 跨库外键、或元数据读了一半，都可能出现这种悬空引用。
    // 只断言「没有幽灵节点」不够——悬空的边还会混进连通分量，
    // 影响分组大小与分层，把别的表挪位置。
    const tables = [table('orders', 'id'), table('customers', 'id'), table('audit', 'id')];
    const real = link('orders', 'id', 'customers', 'id');

    const withGhost = layoutErDiagram(tables, [real, link('audit', 'id', 'ghost', 'id')]);
    const without = layoutErDiagram(tables, [real]);

    expect(withGhost.nodes).toEqual(without.nodes);
  });

  it('自引用的表只占一个节点', () => {
    const layout = layoutErDiagram(
      [table('tree', 'id', 'parent_id')],
      [link('tree', 'parent_id', 'tree', 'id')]
    );
    expect(layout.nodes).toHaveLength(1);
  });

  it('空输入得到空画布，不抛', () => {
    const layout = layoutErDiagram([], []);
    expect(layout.nodes).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('PostgreSQL 的同名不同 schema 的表是两个节点', () => {
    const layout = layoutErDiagram(
      [
        { ...table('orders', 'id'), schema: 'public' },
        { ...table('orders', 'id'), schema: 'billing' }
      ],
      []
    );
    expect(layout.nodes).toHaveLength(2);
    expect(layout.nodes.map(node => node.key).sort()).toEqual(['billing.orders', 'public.orders']);
  });
});

describe('columnAnchor', () => {
  const layout = layoutErDiagram([table('orders', 'id', 'customer_id', 'total')], []);
  const node = layout.nodes[0];

  it('锚点落在那一列自己的行上，不是框的中心', () => {
    // 「关联字段的连线」要连到字段，连到框中间就看不出是哪两列在关联
    const first = columnAnchor(node, 'id');
    const second = columnAnchor(node, 'customer_id');
    expect(second!.y - first!.y).toBe(DEFAULT_ER_METRICS.rowHeight);
  });

  it('左右两侧锚点的 y 相同，x 分别在框的两边', () => {
    const anchor = columnAnchor(node, 'total')!;
    expect(anchor.leftX).toBe(node.x);
    expect(anchor.rightX).toBe(node.x + node.width);
  });

  it('第一行锚点在表头之下', () => {
    const anchor = columnAnchor(node, 'id')!;
    expect(anchor.y).toBeGreaterThan(node.y + DEFAULT_ER_METRICS.headerHeight);
  });

  it('不存在的列返回 undefined，由调用方决定怎么办', () => {
    expect(columnAnchor(node, 'nope')).toBeUndefined();
  });
});

describe('toErTables', () => {
  it('列按 ordinal 排，不按到达顺序', () => {
    // 驱动不保证行序；列顺序错了，图上每一行都对不上真实的表结构
    const [orders] = toErTables([
      { table_name: 'orders', column_name: 'total', data_type: 'int', ordinal: 3 },
      { table_name: 'orders', column_name: 'id', data_type: 'int', ordinal: 1, is_primary_key: true },
      { table_name: 'orders', column_name: 'code', data_type: 'varchar(32)', ordinal: 2 }
    ]);

    expect(orders.columns.map(column => column.name)).toEqual(['id', 'code', 'total']);
    expect(orders.columns[0].isPrimaryKey).toBe(true);
    expect(orders.columns[1].dataType).toBe('varchar(32)');
  });

  it('MySQL / SQLite 的 1 与 0 也算布尔', () => {
    const [table] = toErTables([
      { table_name: 't', column_name: 'id', data_type: 'int', ordinal: 1, is_primary_key: 1, is_nullable: 0 }
    ]);
    expect(table.columns[0].isPrimaryKey).toBe(true);
    expect(table.columns[0].isNullable).toBe(false);
  });

  it('按 schema 分开：同名不同 schema 是两张表', () => {
    const tables = toErTables([
      { table_schema: 'public', table_name: 'orders', column_name: 'id', ordinal: 1 },
      { table_schema: 'billing', table_name: 'orders', column_name: 'id', ordinal: 1 }
    ]);
    expect(tables).toHaveLength(2);
  });

  it('没有列名的行被跳过', () => {
    expect(toErTables([{ table_name: 't', column_name: null }])).toEqual([]);
  });
});

describe('toErLinks', () => {
  it('每行一条连线，复合外键自然是多条', () => {
    const links = toErLinks([
      { table_name: 'child', column_name: 'ref_a', referenced_table: 'parent', referenced_column: 'x', constraint_name: 'fk', ordinal: 1 },
      { table_name: 'child', column_name: 'ref_b', referenced_table: 'parent', referenced_column: 'y', constraint_name: 'fk', ordinal: 2 }
    ]);
    expect(links).toHaveLength(2);
    expect(links[0].from).toEqual({ table: 'child', column: 'ref_a' });
    expect(links[0].to).toEqual({ table: 'parent', column: 'x' });
  });

  it('带 schema 时表名是限定名，和节点的 key 对得上', () => {
    const [fk] = toErLinks([
      { table_schema: 'public', table_name: 'child', column_name: 'a',
        referenced_schema: 'billing', referenced_table: 'parent', referenced_column: 'x' }
    ]);
    expect(fk.from.table).toBe('public.child');
    expect(fk.to.table).toBe('billing.parent');
  });

  it('SQLite 省略被引用列时丢掉这条边，不画一条连到框中心的线', () => {
    // 连到框中心会让人以为那里有个真实字段
    expect(toErLinks([
      { table_name: 'child', column_name: 'a', referenced_table: 'parent', referenced_column: null }
    ])).toEqual([]);
  });
});

describe('truncateLabel', () => {
  it('放得下就原样返回', () => {
    expect(truncateLabel('id', 10)).toBe('id');
  });

  it('放不下时截断并加省略号，总长不超过上限', () => {
    // SVG 的文本不会自动截断：不处理的话长类型会直接压在列名上
    const result = truncateLabel('enum(\'draft\',\'paid\',\'shipped\')', 10);
    expect(result).toHaveLength(10);
    expect(result.endsWith('…')).toBe(true);
  });

  it('CJK 按两个字符宽算', () => {
    // 「用户表」占 6 个字符宽，不是 3
    expect(truncateLabel('用户表名称', 6)).toBe('用户…');
  });

  it('上限小到放不下省略号时直接截断', () => {
    expect(truncateLabel('abcdef', 1)).toBe('a');
  });

  it('上限为 0 或负数时返回空串，不抛', () => {
    expect(truncateLabel('abc', 0)).toBe('');
    expect(truncateLabel('abc', -1)).toBe('');
  });
});

describe('matchErTables', () => {
  const nodes = [
    { key: 'orders', table: table('orders', 'id', 'customer_id', 'total') },
    { key: 'customers', table: table('customers', 'id', 'name') },
    { key: 'audit_log', table: table('audit_log', 'id', 'message') }
  ];

  it('按表名匹配', () => {
    expect([...matchErTables(nodes, 'order')!]).toEqual(['orders']);
  });

  it('按列名匹配——找一张表常常是从「哪张表有这一列」开始的', () => {
    expect([...matchErTables(nodes, 'customer_id')!]).toEqual(['orders']);
  });

  it('大小写不敏感', () => {
    expect([...matchErTables(nodes, 'ORDERS')!]).toEqual(['orders']);
  });

  it('空查询返回 null——「不过滤」和「一个都没命中」是两件事', () => {
    expect(matchErTables(nodes, '')).toBeNull();
    expect(matchErTables(nodes, '   ')).toBeNull();
  });

  it('一个都没命中时返回空集合，不是 null', () => {
    // 返回 null 的话整张图会恢复成全亮，用户以为搜索没生效
    const result = matchErTables(nodes, 'zzz');
    expect(result).not.toBeNull();
    expect(result!.size).toBe(0);
  });
});
