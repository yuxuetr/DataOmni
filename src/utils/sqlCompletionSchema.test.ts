/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import {
  CompletionContext,
  autocompletion,
  currentCompletions,
  startCompletion
} from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  MySQL,
  PostgreSQL,
  SQLite,
  StandardSQL,
  schemaCompletionSource,
  sql
} from '@codemirror/lang-sql';
import { DatabaseType } from '../contracts/connection';
import {
  buildCompletionSchema,
  normalizeCompletionRows,
  sqlDialectFor,
  type CompletionLabels,
  type CompletionRelation
} from './sqlCompletionSchema';

const LABELS: CompletionLabels = { table: '表', view: '视图', schema: 'Schema' };

const row = (
  relation_name: string,
  column_name: string,
  overrides: Record<string, unknown> = {}
) => ({
  relation_schema: 'public',
  relation_name,
  relation_kind: 'table',
  column_name,
  data_type: 'integer',
  ...overrides
});

describe('normalizeCompletionRows', () => {
  it('把扁平行按关系归组', () => {
    expect(
      normalizeCompletionRows([
        row('orders', 'id'),
        row('orders', 'total', { data_type: 'numeric(10,2)' }),
        row('users', 'id')
      ])
    ).toEqual([
      {
        schema: 'public',
        name: 'orders',
        kind: 'table',
        columns: [
          { name: 'id', dataType: 'integer' },
          { name: 'total', dataType: 'numeric(10,2)' }
        ]
      },
      { schema: 'public', name: 'users', kind: 'table', columns: [{ name: 'id', dataType: 'integer' }] }
    ]);
  });

  it('保持列在表里的顺序，不按字母排', () => {
    const [relation] = normalizeCompletionRows([
      row('t', 'id'),
      row('t', 'zeta'),
      row('t', 'alpha')
    ]);
    expect(relation.columns.map(column => column.name)).toEqual(['id', 'zeta', 'alpha']);
  });

  it('同名不同 Schema 是两张表', () => {
    const relations = normalizeCompletionRows([
      row('orders', 'id'),
      row('orders', 'code', { relation_schema: 'billing' })
    ]);
    expect(relations).toHaveLength(2);
    expect(relations.map(relation => relation.schema)).toEqual(['public', 'billing']);
  });

  it('视图标成 view', () => {
    const [relation] = normalizeCompletionRows([
      row('active_users', 'id', { relation_kind: 'view' })
    ]);
    expect(relation.kind).toBe('view');
  });

  it('SQLite 没有 Schema，是 null 而不是字符串', () => {
    const [relation] = normalizeCompletionRows([
      row('t', 'id', { relation_schema: null })
    ]);
    expect(relation.schema).toBeNull();
  });

  it('丢掉没有名字或没有列名的行', () => {
    expect(
      normalizeCompletionRows([
        row('', 'id'),
        row('t', ''),
        { relation_name: 'only', column_name: 'id' }
      ])
    ).toEqual([
      { schema: null, name: 'only', kind: 'table', columns: [{ name: 'id', dataType: '' }] }
    ]);
  });
});

describe('buildCompletionSchema', () => {
  const orders: CompletionRelation = {
    schema: 'public',
    name: 'orders',
    kind: 'table',
    columns: [
      { name: 'id', dataType: 'integer' },
      { name: 'total', dataType: 'numeric(10,2)' }
    ]
  };

  it('MySQL 不保留 Schema 一层：连接时已经选定了库', () => {
    const { schema, defaultSchema } = buildCompletionSchema(
      [{ ...orders, schema: 'shop' }],
      DatabaseType.MySQL,
      LABELS
    );
    expect(Object.keys(schema)).toEqual(['orders']);
    expect(defaultSchema).toBeUndefined();
  });

  it('SQLite 同样是一层', () => {
    const { schema } = buildCompletionSchema(
      [{ ...orders, schema: null }],
      DatabaseType.SQLite,
      LABELS
    );
    expect(Object.keys(schema)).toEqual(['orders']);
  });

  it('PostgreSQL 保留 Schema 一层，同名表不会挤在一起', () => {
    const { schema } = buildCompletionSchema(
      [orders, { ...orders, schema: 'billing' }],
      DatabaseType.PostgreSQL,
      LABELS
    );
    expect(Object.keys(schema).sort()).toEqual(['billing', 'public']);
    expect(Object.keys((schema as Record<string, { children: object }>).public.children)).toEqual([
      'orders'
    ]);
  });

  it('列带上完整类型作为说明，并按表内位置递减加权', () => {
    const { schema } = buildCompletionSchema([orders], DatabaseType.MySQL, LABELS);
    expect((schema as Record<string, { children: unknown }>).orders.children).toEqual([
      { label: 'id', type: 'property', detail: 'integer', boost: 99 },
      { label: 'total', type: 'property', detail: 'numeric(10,2)', boost: 98 }
    ]);
  });

  it('列数超过权重范围时不会越过下界', () => {
    const wide = {
      ...orders,
      columns: Array.from({ length: 260 }, (_, index) => ({
        name: `c${index}`,
        dataType: 'integer'
      }))
    };
    const { schema } = buildCompletionSchema([wide], DatabaseType.MySQL, LABELS);
    const boosts = (schema as unknown as Record<string, { children: Array<{ boost: number }> }>)
      .orders.children.map(column => column.boost);
    expect(Math.min(...boosts)).toBe(-99);
    expect(Math.max(...boosts)).toBe(99);
  });

  it('表与视图用说明区分', () => {
    const { schema } = buildCompletionSchema(
      [orders, { ...orders, name: 'active_orders', kind: 'view' }],
      DatabaseType.MySQL,
      LABELS
    );
    const entries = schema as Record<string, { self: { detail: string } }>;
    expect(entries.orders.self.detail).toBe('表');
    expect(entries.active_orders.self.detail).toBe('视图');
  });

  it('有 public 时它下面的表可以不带前缀补全', () => {
    expect(
      buildCompletionSchema([orders], DatabaseType.PostgreSQL, LABELS).defaultSchema
    ).toBe('public');
  });

  it('没有 public 就不指定默认 Schema，免得补出不存在的前缀', () => {
    expect(
      buildCompletionSchema(
        [{ ...orders, schema: 'billing' }],
        DatabaseType.PostgreSQL,
        LABELS
      ).defaultSchema
    ).toBeUndefined();
  });

  it('空目录给空命名空间，不是抛错', () => {
    expect(buildCompletionSchema([], DatabaseType.PostgreSQL, LABELS).schema).toEqual({});
  });
});

describe('sqlDialectFor', () => {
  it('三种支持的方言各用各的关键字表', () => {
    expect(sqlDialectFor(DatabaseType.MySQL)).toBe(MySQL);
    expect(sqlDialectFor(DatabaseType.PostgreSQL)).toBe(PostgreSQL);
    expect(sqlDialectFor(DatabaseType.SQLite)).toBe(SQLite);
  });

  it('认不出的类型退回标准 SQL', () => {
    expect(sqlDialectFor(DatabaseType.MongoDB)).toBe(StandardSQL);
  });

  it('方言之间的关键字确实不一样', () => {
    expect(MySQL.spec.keywords).toContain('auto_increment');
    expect(PostgreSQL.spec.keywords).not.toContain('auto_increment');
  });
});

describe('喂给 @codemirror/lang-sql 之后真的能补出来', () => {
  // 上面的测试只证明命名空间的形状是我们想要的。这一组证明**库真的会用它**：
  // 别名解析、Schema 前缀、默认 Schema 都是 lang-sql 内部的行为，
  // 形状对不上时它不会报错，只会安静地一条也补不出来。
  const catalog: CompletionRelation[] = [
    {
      schema: 'public',
      name: 'orders',
      kind: 'table',
      columns: [
        { name: 'id', dataType: 'integer' },
        { name: 'total', dataType: 'numeric(10,2)' }
      ]
    },
    {
      schema: 'billing',
      name: 'invoices',
      kind: 'view',
      columns: [{ name: 'invoice_no', dataType: 'text' }]
    }
  ];

  const complete = (doc: string, dbType: DatabaseType, relations = catalog) => {
    const { schema, defaultSchema } = buildCompletionSchema(relations, dbType, LABELS);
    const dialect = sqlDialectFor(dbType);
    const state = EditorState.create({
      doc,
      extensions: [sql({ dialect, schema, defaultSchema })]
    });
    const result = schemaCompletionSource({ dialect, schema, defaultSchema })(
      new CompletionContext(state, doc.length, true)
    );
    return result === null || 'then' in result
      ? []
      : result.options.map(option => ({ label: option.label, detail: option.detail }));
  };

  it('别名后面补出这张表自己的列，带类型', () => {
    expect(complete('SELECT * FROM orders o WHERE o.', DatabaseType.PostgreSQL)).toEqual([
      { label: 'id', detail: 'integer' },
      { label: 'total', detail: 'numeric(10,2)' }
    ]);
  });

  it('MySQL 没有 Schema 一层，别名照样解析', () => {
    expect(
      complete('SELECT * FROM orders AS o WHERE o.', DatabaseType.MySQL).map(
        option => option.label
      )
    ).toEqual(['id', 'total']);
  });

  it('Schema 前缀后面补出该 Schema 下的关系', () => {
    expect(complete('SELECT * FROM billing.', DatabaseType.PostgreSQL)).toEqual([
      { label: 'invoices', detail: '视图' }
    ]);
  });

  it('public 下的表不带前缀也能补', () => {
    const labels = complete('SELECT * FROM ', DatabaseType.PostgreSQL).map(
      option => option.label
    );
    expect(labels).toContain('orders');
    expect(labels).toContain('billing');
    // billing 下的表要写前缀，不该直接冒出来
    expect(labels).not.toContain('invoices');
  });

  it('目录里没有的表，别名后面补不出任何列', () => {
    // 这条守住「其实是把所有列都端出来了」——那样看上去一样能用，
    // 直到你发现它把另一张表的列补进了 WHERE 里
    expect(complete('SELECT * FROM nosuch n WHERE n.', DatabaseType.PostgreSQL)).toEqual([]);
  });
});

describe('弹出来的次序', () => {
  /**
   * 这一组必须起一个真的 EditorView。
   *
   * 上面那组读的是补全源**返回**的次序，而 CodeMirror 之后还会按
   * `匹配得分 + boost` 重排一次——只看补全源，等于在排序发生之前就验完了。
   * 第一版这条测试就是这么写的：去掉 boost 它照样绿，而界面上补出来的
   * 第一个已经是 `customer_id` 了。
   */
  const shownOptions = async (doc: string, relations: CompletionRelation[]) => {
    const { schema, defaultSchema } = buildCompletionSchema(
      relations,
      DatabaseType.PostgreSQL,
      LABELS
    );
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [
          autocompletion(),
          sql({ dialect: sqlDialectFor(DatabaseType.PostgreSQL), schema, defaultSchema })
        ]
      })
    });

    startCompletion(view);
    // 补全的计算是防抖的，拿结果前要让它跑完
    await new Promise(resolve => setTimeout(resolve, 200));
    const labels = currentCompletions(view.state).map(option => option.label);
    view.destroy();
    parent.remove();
    return labels;
  };

  const orders: CompletionRelation[] = [
    {
      schema: 'public',
      name: 'orders',
      kind: 'table',
      columns: [
        { name: 'id', dataType: 'integer' },
        { name: 'customer_id', dataType: 'integer' },
        { name: 'amount', dataType: 'numeric' },
        { name: 'created_at', dataType: 'timestamptz' }
      ]
    }
  ];

  it('列按表内顺序排，不按字母', async () => {
    // 表内顺序是有意义的：主键在前、审计列在后。按字母排会把 created_at
    // 顶到最前、id 埋进中间。
    expect(await shownOptions('SELECT * FROM orders o WHERE o.', orders)).toEqual([
      'id',
      'customer_id',
      'amount',
      'created_at'
    ]);
  });

  it('加权不会盖过更好的匹配', async () => {
    // 权重只在**匹配质量相同时**决定次序。这里 `a_m_code` 排在前面、权重更高，
    // 但输入 `am` 时 `amount` 是从头开始的完整前缀匹配，它必须赢。
    // 权重一旦调得比匹配质量的档距（至少 100）还大，这条就会红。
    const ambiguous: CompletionRelation[] = [
      {
        schema: 'public',
        name: 'orders',
        kind: 'table',
        columns: [
          { name: 'a_m_code', dataType: 'text' },
          { name: 'id', dataType: 'integer' },
          { name: 'note', dataType: 'text' },
          { name: 'amount', dataType: 'numeric' }
        ]
      }
    ];
    const shown = await shownOptions('SELECT * FROM orders o WHERE o.am', ambiguous);
    expect(shown).toContain('a_m_code');
    expect(shown[0]).toBe('amount');
  });
});
