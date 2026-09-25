import { describe, expect, it } from 'vitest';
import { browseQuery, cypherName, cypherString, formatCypherValue, type CypherNodeValue } from './cypherValue';

const person: CypherNodeValue = {
  kind: 'node',
  elementId: '4:x:1',
  labels: ['Person', 'Weird Label'],
  properties: [['name', { kind: 'string', value: "it's" }], ['age', { kind: 'integer', value: '30' }]]
};
const city: CypherNodeValue = { kind: 'node', elementId: '4:x:2', labels: ['City'], properties: [] };

describe('formatCypherValue', () => {
  it('标量：顶层字符串不带引号，嵌套的带；64 位整数原样', () => {
    expect(formatCypherValue({ kind: 'string', value: 'plain' })).toBe('plain');
    expect(formatCypherValue({ kind: 'list', items: [{ kind: 'string', value: 'a' }, { kind: 'null' }] })).toBe("['a', null]");
    expect(formatCypherValue({ kind: 'integer', value: '9223372036854775807' })).toBe('9223372036854775807');
    expect(formatCypherValue({ kind: 'float', value: 'NaN' })).toBe('NaN');
    expect(formatCypherValue({ kind: 'boolean', value: false })).toBe('false');
    expect(formatCypherValue({ kind: 'bytes', value: 'AAr/' })).toBe('0x000aff');
  });

  it('节点、关系与两个方向的路径写成 Cypher 的模式', () => {
    expect(formatCypherValue(person)).toBe("(:Person:`Weird Label` {name: 'it\\'s', age: 30})");
    const livesIn = {
      kind: 'relationship' as const,
      elementId: '5:x:1',
      type: 'LIVES_IN',
      startElementId: person.elementId,
      endElementId: city.elementId,
      properties: [['since', { kind: 'temporal' as const, value: "date('2020-01-01')" }] as [string, { kind: 'temporal'; value: string }]]
    };
    expect(formatCypherValue(livesIn)).toBe("[:LIVES_IN {since: date('2020-01-01')}]");
    expect(formatCypherValue({ kind: 'path', start: person, segments: [{ relationship: livesIn, forward: true, node: city }] }))
      .toBe("(:Person:`Weird Label` {name: 'it\\'s', age: 30})-[:LIVES_IN {since: date('2020-01-01')}]->(:City)");
    expect(formatCypherValue({ kind: 'path', start: city, segments: [{ relationship: livesIn, forward: false, node: person }] }))
      .toBe("(:City)<-[:LIVES_IN {since: date('2020-01-01')}]-(:Person:`Weird Label` {name: 'it\\'s', age: 30})");
  });

  it('映射的键不是简单名字时加反引号', () => {
    expect(formatCypherValue({ kind: 'map', entries: [['a b', { kind: 'integer', value: '1' }], ['ok', { kind: 'null' }]] }))
      .toBe('{`a b`: 1, ok: null}');
  });
});

describe('cypherString 与 cypherName', () => {
  it('字符串用反斜杠转义，写出来能原样粘回查询', () => {
    expect(cypherString("a'b\\c\nd")).toBe("'a\\'b\\\\c\\nd'");
  });

  it('名字：简单的原样，其余反引号括起来、里面的反引号写两个', () => {
    expect(cypherName('Person')).toBe('Person');
    expect(cypherName('has space')).toBe('`has space`');
    expect(cypherName('a`b')).toBe('`a``b`');
    expect(cypherName('1st')).toBe('`1st`');
  });
});

describe('browseQuery', () => {
  it('标签看节点，关系类型看路径；不是默认库时带 USE', () => {
    expect(browseQuery('label', 'Person', 'neo4j', 'neo4j')).toBe('MATCH (n:Person)\nRETURN n\nLIMIT 25');
    expect(browseQuery('relationship-type', 'KNOWS', 'movies', null))
      .toBe('USE movies\nMATCH p = ()-[r:KNOWS]->()\nRETURN p\nLIMIT 25');
    expect(browseQuery('label', 'a b', null, null, 10)).toBe('MATCH (n:`a b`)\nRETURN n\nLIMIT 10');
  });
});
