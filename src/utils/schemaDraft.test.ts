import { describe, expect, it } from 'vitest';
import {
  buildCreateSchema,
  draftToEr,
  orderForCreation,
  validateSchemaDraft,
  type ColumnSpec,
  type SchemaDraft,
  type TableDraft
} from './schemaDraft';

const column = (name: string, dataType: string, nullable = false): ColumnSpec =>
  ({ name, dataType, nullable, defaultValue: null });

const table = (name: string, columns: ColumnSpec[], extra: Partial<TableDraft> = {}): TableDraft => ({
  name,
  columns,
  primaryKey: ['id'],
  unique: [],
  indexes: [],
  foreignKeys: [],
  ...extra
});

/** 故意倒着写：评论引用文章，文章引用用户 */
const blog: SchemaDraft = {
  tables: [
    table('comments', [column('id', 'bigint'), column('post_id', 'bigint'), column('body', 'text')], {
      foreignKeys: [{ columns: ['post_id'], referencedTable: 'posts', referencedColumns: ['id'], onDelete: 'cascade' }],
      indexes: [{ columns: ['post_id'] }]
    }),
    table('posts', [column('id', 'bigint'), column('author_id', 'bigint', true), column('title', 'varchar(200)')], {
      foreignKeys: [{ columns: ['author_id'], referencedTable: 'users', referencedColumns: ['id'], onDelete: 'set null' }]
    }),
    table('users', [column('id', 'bigint'), column('email', 'varchar(255)')], { unique: [['email']] })
  ]
};

const codes = (draft: SchemaDraft, dialect: Parameters<typeof validateSchemaDraft>[1] = 'postgresql', existing: string[] = []) =>
  validateSchemaDraft(draft, dialect, existing).map((issue) => `${issue.severity}:${issue.code}:${issue.table}:${issue.column}`);

describe('validateSchemaDraft', () => {
  it('一份正常的设计没有任何问题', () => {
    expect(codes(blog)).toEqual([]);
  });

  it('空设计是错误', () => {
    expect(codes({ tables: [] })).toEqual(['error:no-tables::']);
  });

  it('表名、列名重名不分大小写', () => {
    const draft = { tables: [table('Users', [column('id', 'int'), column('ID', 'int')]), table('users', [column('id', 'int')])] };
    expect(codes(draft)).toEqual(['error:duplicate-table:users:', 'error:duplicate-column:Users:ID']);
  });

  it('撞上库里已有的表', () => {
    expect(codes(blog, 'postgresql', ['USERS'])).toEqual(['error:table-exists:users:']);
  });

  it('外键指向不存在的表或列', () => {
    const draft = {
      tables: [
        table('a', [column('id', 'int'), column('b_id', 'int')], {
          foreignKeys: [
            { columns: ['b_id'], referencedTable: 'missing', referencedColumns: ['id'], onDelete: null },
            { columns: ['nope'], referencedTable: 'a', referencedColumns: ['nothing'], onDelete: null }
          ]
        })
      ]
    };
    expect(codes(draft)).toEqual([
      'error:unknown-table:a:b_id',
      'error:unknown-column:a:nope',
      'error:unknown-column:a:nothing'
    ]);
  });

  it('外键指向库里已有的表只是警告：那张表的列由数据库在建表时核对', () => {
    const draft = {
      tables: [table('articles', [column('id', 'int'), column('author_id', 'int')], {
        foreignKeys: [{ columns: ['author_id'], referencedTable: 'Authors', referencedColumns: ['id'], onDelete: null }]
      })]
    };
    expect(codes(draft, 'postgresql', ['authors'])).toEqual(['warning:references-existing-table:articles:author_id']);
    expect(codes(draft)).toEqual(['error:unknown-table:articles:author_id']);
    expect(buildCreateSchema(draft, 'postgresql')[0]).toContain('REFERENCES "Authors" ("id")');
  });

  it('外键只能指向主键或唯一约束', () => {
    const draft = {
      tables: [
        table('users', [column('id', 'int'), column('email', 'text')]),
        table('logins', [column('id', 'int'), column('email', 'text')], {
          foreignKeys: [{ columns: ['email'], referencedTable: 'users', referencedColumns: ['email'], onDelete: null }]
        })
      ]
    };
    expect(codes(draft)).toEqual(['error:reference-not-unique:logins:email']);
    const withUnique = { tables: [{ ...draft.tables[0]!, unique: [['EMAIL']] }, draft.tables[1]!] };
    expect(codes(withUnique)).toEqual([]);
  });

  it('两端类型不一致只是警告，大小写与空白不算不一致', () => {
    const draft = {
      tables: [
        table('users', [column('id', 'BIGINT')]),
        table('posts', [column('id', 'int'), column('author_id', 'int'), column('editor_id', 'big int')], {
          foreignKeys: [
            { columns: ['author_id'], referencedTable: 'users', referencedColumns: ['id'], onDelete: null },
            { columns: ['editor_id'], referencedTable: 'users', referencedColumns: ['id'], onDelete: null }
          ]
        })
      ]
    };
    expect(codes(draft)).toEqual(['warning:type-mismatch:posts:author_id']);
  });

  it('PostgreSQL 的 serial 家族与对应整数是同一种类型，别的方言里不是', () => {
    const draft = {
      tables: [
        table('users', [column('id', 'bigserial')]),
        table('posts', [column('id', 'serial'), column('author_id', 'bigint'), column('parent_id', 'int')], {
          foreignKeys: [
            { columns: ['author_id'], referencedTable: 'users', referencedColumns: ['id'], onDelete: null },
            { columns: ['parent_id'], referencedTable: 'posts', referencedColumns: ['id'], onDelete: null }
          ]
        })
      ]
    };
    expect(codes(draft)).toEqual([]);
    expect(codes(draft, 'mysql')).toEqual(['warning:type-mismatch:posts:author_id', 'warning:type-mismatch:posts:parent_id']);
  });

  it('自增的写法不算类型不一致', () => {
    const draft = (dataType: string) => ({
      tables: [
        table('users', [column('id', dataType)]),
        table('posts', [column('id', 'int'), column('author_id', 'bigint')], {
          foreignKeys: [{ columns: ['author_id'], referencedTable: 'users', referencedColumns: ['id'], onDelete: null }]
        })
      ]
    });
    expect(codes(draft('bigint GENERATED ALWAYS AS IDENTITY'))).toEqual([]);
    expect(codes(draft('BIGINT generated by default as identity (start with 100)'))).toEqual([]);
    expect(codes(draft('bigint AUTO_INCREMENT'), 'mysql')).toEqual([]);
    expect(codes(draft('bigint IDENTITY(1,1)'), 'sqlserver')).toEqual([]);
    expect(codes(draft('int IDENTITY(1,1)'), 'sqlserver')).toEqual(['warning:type-mismatch:posts:author_id']);
  });

  it('默认值引用序列是错误：设计里没有序列，建不出来', () => {
    const draft = { tables: [table('users', [{ ...column('id', 'bigint'), defaultValue: "nextval('users_id_seq'::regclass)" }])] };
    expect(codes(draft)).toEqual(['error:unknown-sequence:users:id']);
  });

  it('ON DELETE SET NULL 落在 NOT NULL 列上是错误', () => {
    const draft = {
      tables: [
        table('users', [column('id', 'int')]),
        table('posts', [column('id', 'int'), column('author_id', 'int')], {
          foreignKeys: [{ columns: ['author_id'], referencedTable: 'users', referencedColumns: ['id'], onDelete: 'set null' }]
        })
      ]
    };
    expect(codes(draft)).toEqual(['error:set-null-on-not-null:posts:author_id']);
  });

  it('PostgreSQL 的名字按字节算上限：21 个汉字就是 63 字节', () => {
    const fits = '订'.repeat(21);
    const tooLong = '订'.repeat(22);
    expect(codes({ tables: [table(fits, [column('id', 'int')])] })).toEqual([]);
    expect(codes({ tables: [table(tooLong, [column('id', 'int')])] })).toEqual([`error:name-too-long:${tooLong}:`]);
    expect(codes({ tables: [table(tooLong, [column('id', 'int')])] }, 'sqlite')).toEqual([]);
  });

  it('生成的索引名也算长度', () => {
    const long = 'a'.repeat(30);
    const draft = { tables: [table(long, [column('id', 'int'), column(long, 'int')], { indexes: [{ columns: [long] }] })] };
    expect(codes(draft)).toEqual([`error:name-too-long:${long}:${long}`]);
    expect(codes(draft, 'sqlserver')).toEqual([]);
  });

  // 索引名由表名与列名拼成，拼出同一个名字时第二条 CREATE INDEX 失败，前面的表已经建好了
  it('拼出来的索引名撞上是错误：同一个索引写两遍、(a_b) 与 (a, b)', () => {
    const draft = {
      tables: [table('t', [column('id', 'int'), column('a', 'int'), column('b', 'int'), column('a_b', 'int')], {
        indexes: [{ columns: ['a'] }, { columns: ['A'] }, { columns: ['a_b'] }, { columns: ['a', 'b'] }]
      })]
    };
    expect(codes(draft, 'mysql')).toEqual([
      'error:duplicate-index:t:A',
      'error:duplicate-index:t:a, b'
    ]);
  });

  it('跨表撞名只在索引名归 schema 管的方言里算', () => {
    const draft = {
      tables: [
        table('a_b', [column('id', 'int'), column('c', 'int')], { indexes: [{ columns: ['c'] }] }),
        table('a', [column('id', 'int'), column('b_c', 'int')], { indexes: [{ columns: ['b_c'] }] })
      ]
    };
    expect(codes(draft, 'postgresql')).toEqual(['error:duplicate-index:a:b_c']);
    expect(codes(draft, 'sqlite')).toEqual(['error:duplicate-index:a:b_c']);
    // MySQL、SQL Server 的索引名只在表内唯一
    expect(codes(draft, 'mysql')).toEqual([]);
    expect(codes(draft, 'sqlserver')).toEqual([]);
  });

  it('没有主键只是警告', () => {
    expect(codes({ tables: [table('log', [column('at', 'timestamp')], { primaryKey: [] })] }))
      .toEqual(['warning:no-primary-key:log:']);
  });

  it('DuckDB 的外键不收 ON DELETE 动作', () => {
    expect(codes(blog, 'duckdb')).toEqual([
      'error:on-delete-unsupported:comments:post_id',
      'error:on-delete-unsupported:posts:author_id'
    ]);
  });

  it('DuckDB 不能事后加外键，环是错误；别的方言不是', () => {
    expect(codes(cycle, 'duckdb')).toEqual(['error:cycle-unsupported:a:b_id']);
    expect(codes(cycle, 'postgresql')).toEqual([]);
  });
});

/** a.b_id → b，b.a_id → a */
const cycle: SchemaDraft = {
  tables: [
    table('a', [column('id', 'int'), column('b_id', 'int', true)], {
      foreignKeys: [{ columns: ['b_id'], referencedTable: 'b', referencedColumns: ['id'], onDelete: null }]
    }),
    table('b', [column('id', 'int'), column('a_id', 'int', true)], {
      foreignKeys: [{ columns: ['a_id'], referencedTable: 'a', referencedColumns: ['id'], onDelete: null }]
    })
  ]
};

describe('orderForCreation', () => {
  it('被引用的先建，其余保持设计里的次序', () => {
    expect(orderForCreation(blog).tables.map((entry) => entry.name)).toEqual(['users', 'posts', 'comments']);
    expect(orderForCreation(blog).deferred).toEqual([]);
  });

  it('自引用不算依赖，也不挪到后面', () => {
    const tree = {
      tables: [table('nodes', [column('id', 'int'), column('parent_id', 'int', true)], {
        foreignKeys: [{ columns: ['parent_id'], referencedTable: 'nodes', referencedColumns: ['id'], onDelete: null }]
      })]
    };
    expect(orderForCreation(tree).deferred).toEqual([]);
  });

  it('自引用的表被别人引用时，照样先建它，不必挪任何外键', () => {
    const draft = {
      tables: [
        table('employees', [column('id', 'int'), column('team_id', 'int')], {
          foreignKeys: [{ columns: ['team_id'], referencedTable: 'teams', referencedColumns: ['id'], onDelete: null }]
        }),
        table('teams', [column('id', 'int'), column('parent_id', 'int', true)], {
          foreignKeys: [{ columns: ['parent_id'], referencedTable: 'teams', referencedColumns: ['id'], onDelete: null }]
        })
      ]
    };
    const { tables, deferred } = orderForCreation(draft);
    expect(tables.map((entry) => entry.name)).toEqual(['teams', 'employees']);
    expect(deferred).toEqual([]);
  });

  it('环上前向的那条外键挪到后面', () => {
    const { tables, deferred } = orderForCreation(cycle);
    expect(tables.map((entry) => entry.name)).toEqual(['a', 'b']);
    expect(deferred.map((entry) => `${entry.table}.${entry.key.columns.join()}`)).toEqual(['a.b_id']);
  });
});

/** 名字按 fold 认：引用处与声明处只差大小写，校验照过 */
const mixedCase: SchemaDraft = {
  tables: [
    table('users', [column('id', 'bigint'), column('email', 'varchar(255)')], { primaryKey: ['ID'], unique: [['Email']] }),
    table('posts', [column('id', 'bigint'), column('author_id', 'bigint')], {
      foreignKeys: [{ columns: ['Author_Id'], referencedTable: 'Users', referencedColumns: ['ID'], onDelete: null }],
      indexes: [{ columns: ['AUTHOR_ID'] }]
    })
  ]
};

describe('buildCreateSchema', () => {
  // 建表语句给名字加引号，PostgreSQL、Oracle 上 "Users" 与 "users" 是两个名字：
  // 照原样拼，校验过了的设计建表时报 relation "Users" does not exist
  it('引用处只差大小写的名字写成声明处的样子', () => {
    expect(codes(mixedCase).filter((code) => code.startsWith('error'))).toEqual([]);
    expect(buildCreateSchema(mixedCase, 'postgresql')).toEqual([
      'CREATE TABLE "users" (\n  "id" bigint NOT NULL,\n  "email" varchar(255) NOT NULL,\n  PRIMARY KEY ("id"),\n  UNIQUE ("email")\n)',
      'CREATE TABLE "posts" (\n  "id" bigint NOT NULL,\n  "author_id" bigint NOT NULL,\n  PRIMARY KEY ("id"),\n'
        + '  FOREIGN KEY ("author_id") REFERENCES "users" ("id")\n)',
      'CREATE INDEX "ix_posts_author_id" ON "posts" ("author_id")'
    ]);
  });

  it('指向库里已有的表照原样：那边的写法这里不知道', () => {
    const draft = {
      tables: [table('posts', [column('id', 'bigint'), column('author_id', 'bigint')], {
        foreignKeys: [{ columns: ['author_id'], referencedTable: 'Accounts', referencedColumns: ['ID'], onDelete: null }]
      })]
    };
    expect(buildCreateSchema(draft, 'postgresql')[0]).toContain('REFERENCES "Accounts" ("ID")');
  });

  it('PostgreSQL：按依赖排好，约束内联，索引最后', () => {
    expect(buildCreateSchema(blog, 'postgresql', 'app')).toEqual([
      'CREATE TABLE "app"."users" (\n  "id" bigint NOT NULL,\n  "email" varchar(255) NOT NULL,\n  PRIMARY KEY ("id"),\n  UNIQUE ("email")\n)',
      'CREATE TABLE "app"."posts" (\n  "id" bigint NOT NULL,\n  "author_id" bigint,\n  "title" varchar(200) NOT NULL,\n  PRIMARY KEY ("id"),\n'
        + '  FOREIGN KEY ("author_id") REFERENCES "app"."users" ("id") ON DELETE SET NULL\n)',
      'CREATE TABLE "app"."comments" (\n  "id" bigint NOT NULL,\n  "post_id" bigint NOT NULL,\n  "body" text NOT NULL,\n  PRIMARY KEY ("id"),\n'
        + '  FOREIGN KEY ("post_id") REFERENCES "app"."posts" ("id") ON DELETE CASCADE\n)',
      'CREATE INDEX "ix_comments_post_id" ON "app"."comments" ("post_id")'
    ]);
  });

  it('复合主键按主键的次序写，列的次序不动，主键列一律 NOT NULL', () => {
    const draft = { tables: [table('t', [column('id', 'int', true), column('tenant', 'int', true)], { primaryKey: ['tenant', 'id'] })] };
    expect(buildCreateSchema(draft, 'mysql')).toEqual([
      'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `tenant` int NOT NULL,\n  PRIMARY KEY (`tenant`, `id`)\n)'
    ]);
  });

  it('环：前向外键用 ALTER 补上；SQLite 不能 ALTER，照样内联', () => {
    const sqlServer = buildCreateSchema(cycle, 'sqlserver');
    expect(sqlServer[sqlServer.length - 1])
      .toBe('ALTER TABLE [a] ADD FOREIGN KEY ([b_id]) REFERENCES [b] ([id])');
    const sqlite = buildCreateSchema(cycle, 'sqlite');
    expect(sqlite).toHaveLength(2);
    expect(sqlite[0]).toContain('FOREIGN KEY ("b_id") REFERENCES "b" ("id")');
  });
});

describe('draftToEr', () => {
  it('引用处只差大小写时连线照样连到声明的表和列', () => {
    expect(draftToEr(mixedCase).links).toEqual([
      { constraintName: 'posts#0', from: { table: 'posts', column: 'author_id' }, to: { table: 'users', column: 'id' } }
    ]);
  });

  it('主键列标出来，复合外键拆成逐列的线', () => {
    const draft = {
      tables: [
        table('t', [column('tenant', 'int'), column('id', 'int'), column('parent_tenant', 'int', true), column('parent_id', 'int', true)], {
          primaryKey: ['tenant', 'id'],
          foreignKeys: [{ columns: ['parent_tenant', 'parent_id'], referencedTable: 't', referencedColumns: ['tenant', 'id'], onDelete: null }]
        })
      ]
    };
    const { tables, links } = draftToEr(draft);
    expect(tables[0]?.columns.map((entry) => entry.isPrimaryKey)).toEqual([true, true, false, false]);
    expect(links).toEqual([
      { constraintName: 't#0', from: { table: 't', column: 'parent_tenant' }, to: { table: 't', column: 'tenant' } },
      { constraintName: 't#0', from: { table: 't', column: 'parent_id' }, to: { table: 't', column: 'id' } }
    ]);
  });
});
