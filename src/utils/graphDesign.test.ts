import { describe, expect, it } from 'vitest';
import { buildGraphDesignMessages, layoutGraph, parseGraphDesign, planGraphDesign, validateGraphDesign, type GraphDesign } from './graphDesign';

const design: GraphDesign = {
  labels: [
    { name: 'User', properties: [{ name: 'id', type: 'STRING' }, { name: 'name', type: 'STRING' }], key: ['id'], indexes: [['name']] },
    { name: 'Post', properties: [{ name: 'id', type: 'STRING' }, { name: 'createdAt', type: 'DATETIME' }], key: ['id'], indexes: [['id'], ['createdAt']] }
  ],
  relationships: [
    { type: 'WROTE', from: 'User', to: 'Post', properties: [] },
    { type: 'FOLLOWS', from: 'User', to: 'User', properties: [{ name: 'since', type: 'DATE' }] }
  ]
};

const codes = (value: GraphDesign, existing: string[] = []) =>
  validateGraphDesign(value, existing).map((issue) => `${issue.severity}:${issue.code}:${issue.subject}:${issue.detail}`);

describe('validateGraphDesign', () => {
  it('和唯一键重复的索引报警告：唯一约束自带索引，再建一条是多余的', () => {
    expect(codes(design)).toEqual(['warning:redundant-index:Post:id']);
  });

  it('关系两端只能是设计里或库里已有的标签', () => {
    const value = { ...design, relationships: [{ type: 'LIKES', from: 'User', to: 'Comment', properties: [] }] };
    expect(codes(value)).toContain('error:unknown-label:(:User)-[:LIKES]->(:Comment):Comment');
    expect(codes(value, ['Comment'])).not.toContain('error:unknown-label:(:User)-[:LIKES]->(:Comment):Comment');
  });

  it('键与索引里的属性要存在；重名（区分大小写）', () => {
    const value: GraphDesign = {
      labels: [
        { name: 'A', properties: [{ name: 'x', type: 'STRING' }, { name: 'x', type: 'STRING' }], key: ['y'], indexes: [['z']] },
        { name: 'A', properties: [], key: [], indexes: [] },
        { name: 'a', properties: [], key: [], indexes: [] }
      ],
      relationships: [{ type: 'R', from: 'A', to: 'a', properties: [] }, { type: 'R', from: 'A', to: 'a', properties: [] }]
    };
    expect(codes(value)).toEqual([
      'error:duplicate-property:A:x',
      'error:unknown-property:A:y',
      'error:unknown-property:A:z',
      'error:duplicate-label:A:',
      'error:duplicate-relationship:(:A)-[:R]->(:a):'
    ]);
    expect(codes({ labels: [], relationships: [] })).toEqual(['error:no-labels::']);
  });
});

describe('planGraphDesign', () => {
  it('先建唯一约束，再建索引；和唯一键重复的索引不列', () => {
    expect(planGraphDesign(design)).toEqual([
      'CREATE CONSTRAINT `User_key` IF NOT EXISTS FOR (n:`User`) REQUIRE n.`id` IS UNIQUE',
      'CREATE CONSTRAINT `Post_key` IF NOT EXISTS FOR (n:`Post`) REQUIRE n.`id` IS UNIQUE',
      'CREATE INDEX `User_name` IF NOT EXISTS FOR (n:`User`) ON (n.`name`)',
      'CREATE INDEX `Post_createdAt` IF NOT EXISTS FOR (n:`Post`) ON (n.`createdAt`)'
    ]);
  });

  it('复合键写成括号；名字里的反引号写两遍', () => {
    const value: GraphDesign = {
      labels: [{ name: 'Se`at', properties: [{ name: 'row', type: 'INTEGER' }, { name: 'col', type: 'INTEGER' }], key: ['row', 'col'], indexes: [] }],
      relationships: []
    };
    expect(planGraphDesign(value)).toEqual([
      'CREATE CONSTRAINT `Se``at_key` IF NOT EXISTS FOR (n:`Se``at`) REQUIRE (n.`row`, n.`col`) IS UNIQUE'
    ]);
  });
});

describe('layoutGraph / parse / messages', () => {
  it('节点排成圆，彼此不重叠', () => {
    const { nodes } = layoutGraph({ labels: Array.from({ length: 8 }, (_, i) => ({ name: `L${i}`, properties: [], key: [], indexes: [] })), relationships: [] }, 140);
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        expect(Math.hypot(nodes[i]!.x - nodes[j]!.x, nodes[i]!.y - nodes[j]!.y)).toBeGreaterThan(140);
      }
    }
  });

  it('形状不对时说出位置；提示里说不要重复索引 key', () => {
    expect(parseGraphDesign(JSON.stringify(design))).toEqual({ ok: true, design });
    expect(parseGraphDesign('{"labels":[{"name":"A","properties":[],"key":"id","indexes":[]}],"relationships":[]}')).toMatchObject({ detail: 'labels[0].key' });
    expect(parseGraphDesign('{"labels":[],"relationships":[{"type":"R","from":"A"}]}')).toMatchObject({ detail: 'relationships[0].to' });
    expect(buildGraphDesignMessages('社交', [], null).system).toContain('indexes 里不要再写 key 里的属性');
  });
});
