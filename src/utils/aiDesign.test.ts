import { describe, expect, it } from 'vitest';
import { buildDesignMessages, parseDraftResponse } from './aiDesign';
import type { SchemaDraft } from './schemaDraft';

const draft: SchemaDraft = {
  tables: [{
    name: 'users',
    columns: [{ name: 'id', dataType: 'bigint', nullable: false, defaultValue: null }],
    primaryKey: ['id'],
    unique: [],
    indexes: [],
    foreignKeys: []
  }]
};

describe('buildDesignMessages', () => {
  it('只发结构：已有表名、当前设计与需求，不发任何别的', () => {
    const { user } = buildDesignMessages('  加一张订单表 ', 'mysql', ['users', 'logs'], draft);
    expect(user).toBe(
      '库里已有这些表，新表不要和它们重名；需要时可以用外键引用它们：users, logs\n\n'
      + `当前的设计：\n${JSON.stringify(draft)}\n\n在它的基础上修改，输出修改后的完整设计。\n\n`
      + '需求：加一张订单表'
    );
  });

  it('第一轮没有已有表与当前设计时只有需求', () => {
    expect(buildDesignMessages('博客', 'sqlite', [], null).user).toBe('需求：博客');
  });

  it('系统提示写明方言、CASCADE 的默认值与不引用序列（A0 实验的两条）', () => {
    const { system } = buildDesignMessages('博客', 'postgresql', [], null);
    expect(system).toContain('PostgreSQL');
    expect(system).toContain('onDelete 默认写 null');
    expect(system).toContain('GENERATED ALWAYS AS IDENTITY');
    expect(system).toContain('不要引用任何序列');
    expect(buildDesignMessages('博客', 'duckdb', [], null).system).toContain('onDelete 一律写 null');
  });
});

describe('parseDraftResponse', () => {
  it('裸 JSON 与 ```json 代码块都认', () => {
    expect(parseDraftResponse(JSON.stringify(draft))).toEqual({ ok: true, draft });
    expect(parseDraftResponse(`好的：\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`\n`)).toEqual({ ok: true, draft });
  });

  it('不是 JSON', () => {
    expect(parseDraftResponse('抱歉，我不能').ok).toBe(false);
    expect(parseDraftResponse('抱歉，我不能')).toMatchObject({ reason: 'not-json' });
  });

  it('形状不对时说出第一处不对的位置，不去补字段', () => {
    const missingUnique = { tables: [{ ...draft.tables[0], unique: undefined }] };
    expect(parseDraftResponse(JSON.stringify(missingUnique))).toEqual({ ok: false, reason: 'bad-shape', detail: 'tables[0].unique' });
    const badNullable = { tables: [{ ...draft.tables[0], columns: [{ name: 'id', dataType: 'int', nullable: 'no', defaultValue: null }] }] };
    expect(parseDraftResponse(JSON.stringify(badNullable))).toMatchObject({ detail: 'tables[0].columns[0].nullable' });
    const badAction = { tables: [{ ...draft.tables[0], foreignKeys: [{ columns: ['a'], referencedTable: 'b', referencedColumns: ['id'], onDelete: 'restrict' }] }] };
    expect(parseDraftResponse(JSON.stringify(badAction))).toMatchObject({ detail: 'tables[0].foreignKeys[0].onDelete' });
    expect(parseDraftResponse('{"table": []}')).toMatchObject({ detail: 'tables' });
  });
});
