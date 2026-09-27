import { describe, expect, it } from 'vitest';
import { buildMongoDesignMessages, parseMongoDesign, planMongoDesign, validateMongoDesign, type MongoDesign } from './mongoDesign';

const design: MongoDesign = {
  collections: [
    {
      name: 'users',
      jsonSchema: {
        bsonType: 'object',
        required: ['email'],
        properties: { email: { bsonType: 'string', pattern: '^.+@.+$' }, tags: { bsonType: 'array', items: { bsonType: 'string' } } }
      },
      indexes: [{ keys: { email: 1 }, unique: true }]
    },
    { name: 'posts', jsonSchema: { bsonType: 'object' }, indexes: [{ keys: { author_id: 1, created_at: -1 }, unique: false }] }
  ]
};

const codes = (value: MongoDesign, existing: string[] = []) =>
  validateMongoDesign(value, existing).map((issue) => `${issue.code}:${issue.collection}:${issue.detail}`);

describe('validateMongoDesign', () => {
  it('正常的设计没有问题', () => {
    expect(codes(design)).toEqual([]);
  });

  it('又包了一层 $jsonSchema 是错误（实验里 10 份有 3 份这样）', () => {
    const wrapped = { collections: [{ ...design.collections[0]!, jsonSchema: { $jsonSchema: design.collections[0]!.jsonSchema } }] };
    expect(codes(wrapped)).toEqual(['schema-wrapped:users:$jsonSchema']);
  });

  it('MongoDB 不认的关键字逐个点出位置，嵌套里的也算', () => {
    const value = {
      collections: [{
        name: 'users',
        jsonSchema: {
          bsonType: 'object',
          default: {},
          properties: {
            email: { bsonType: 'string', format: 'email' },
            addresses: { bsonType: 'array', items: { bsonType: 'object', properties: { zip: { bsonType: 'string', examples: ['1'] } } } }
          },
          anyOf: [{ const: 1 }]
        },
        indexes: []
      }]
    };
    expect(codes(value)).toEqual([
      'unsupported-keyword:users:default',
      'unsupported-keyword:users:properties.email.format',
      'unsupported-keyword:users:properties.addresses.items.properties.zip.examples',
      'unsupported-keyword:users:anyOf[0].const'
    ]);
  });

  it('名字：空、非法、重名（区分大小写）、已存在', () => {
    const value = {
      collections: [
        { name: 'a$b', jsonSchema: {}, indexes: [] },
        { name: 'system.x', jsonSchema: {}, indexes: [] },
        { name: 'Users', jsonSchema: {}, indexes: [] },
        { name: 'users', jsonSchema: {}, indexes: [] },
        { name: 'users', jsonSchema: {}, indexes: [{ keys: {}, unique: false }] },
        { name: ' ', jsonSchema: {}, indexes: [] }
      ]
    };
    expect(codes(value, ['Users'])).toEqual([
      'invalid-name:a$b:a$b',
      'invalid-name:system.x:system.x',
      'collection-exists:Users:',
      'duplicate-collection:users:',
      'empty-index:users:indexes[0]',
      'empty-name::'
    ]);
    expect(codes({ collections: [] })).toEqual(['no-collections::']);
  });
});

describe('planMongoDesign', () => {
  it('先建全部集合（带校验规则），再建索引', () => {
    const steps = planMongoDesign(design, 'shop');
    expect(steps.map((step) => `${step.kind}:${step.collection}`)).toEqual([
      'collection:users', 'collection:posts', 'index:users', 'index:posts'
    ]);
    expect(JSON.parse(steps[0]!.document)).toEqual({ validator: { $jsonSchema: design.collections[0]!.jsonSchema } });
    expect(steps[2]).toMatchObject({ document: '{"email":1}', options: '{"unique":true}' });
    expect(steps[3]!.command).toBe("db.getSiblingDB('shop').getCollection('posts').createIndex({\"author_id\":1,\"created_at\":-1})");
  });
});

describe('buildMongoDesignMessages / parseMongoDesign', () => {
  it('提示里写明不要再包一层、只用认的关键字；只发集合名与需求', () => {
    const { system, user } = buildMongoDesignMessages(' 博客 ', ['logs'], null);
    expect(system).toContain('不要再包一层');
    expect(system).toContain('不要用 format');
    expect(user).toBe('库里已有这些集合，不要重名：logs\n\n需求：博客');
  });

  it('形状不对时说出位置', () => {
    expect(parseMongoDesign(JSON.stringify(design))).toEqual({ ok: true, design });
    expect(parseMongoDesign('{"collections":[{"name":"a","jsonSchema":[],"indexes":[]}]}')).toMatchObject({ detail: 'collections[0].jsonSchema' });
    expect(parseMongoDesign('{"collections":[{"name":"a","jsonSchema":{},"indexes":[{"keys":{"a":1}}]}]}')).toMatchObject({ detail: 'collections[0].indexes[0]' });
    expect(parseMongoDesign('nope')).toMatchObject({ reason: 'not-json' });
  });
});
