import { describe, expect, it } from 'vitest';
import {
  cypherLiteral,
  degreeStatement,
  deleteStatement,
  draftOf,
  entityWrite,
  removeEntity,
  replaceEntity,
  type EntityDraft
} from './cypherEdit';
import type { CypherNodeValue, CypherRelationshipValue, CypherValue } from './cypherValue';

const person: CypherNodeValue = {
  kind: 'node',
  elementId: "4:db:1",
  labels: ['Person'],
  properties: [
    ['age', { kind: 'integer', value: '42' }],
    ['avatar', { kind: 'bytes', value: 'AAE=' }],
    ['name', { kind: 'string', value: "Tom's" }]
  ]
};

const city: CypherNodeValue = { kind: 'node', elementId: '4:db:2', labels: ['City'], properties: [] };

const livesIn: CypherRelationshipValue = {
  kind: 'relationship',
  elementId: '5:db:9',
  type: 'LIVES_IN',
  startElementId: person.elementId,
  endElementId: city.elementId,
  properties: [['since', { kind: 'integer', value: '2020' }]]
};

function edited(change: (draft: EntityDraft) => void, entity: CypherNodeValue | CypherRelationshipValue = person) {
  const draft = draftOf(entity);
  change(draft);
  return entityWrite(entity, draft);
}

function statementOf(write: ReturnType<typeof entityWrite>): string {
  if (write.kind !== 'write') throw new Error(`expected a write, got ${write.kind}`);
  return write.statement;
}

describe('cypherLiteral', () => {
  it('顶层字符串也带引号，写回去仍是字符串', () => {
    expect(cypherLiteral({ kind: 'string', value: "a'b\\c" })).toBe("'a\\'b\\\\c'");
  });

  it('浮点数原样；NaN 与无穷大没有字面量，写成 toFloat', () => {
    expect(cypherLiteral({ kind: 'float', value: '3.0' })).toBe('3.0');
    expect(cypherLiteral({ kind: 'float', value: 'NaN' })).toBe("toFloat('NaN')");
    expect(cypherLiteral({ kind: 'float', value: '-Infinity' })).toBe("toFloat('-Infinity')");
  });

  it('列表与映射逐项写；里面有一项写不成，整个就写不成', () => {
    expect(cypherLiteral({ kind: 'list', items: [{ kind: 'integer', value: '1' }, { kind: 'string', value: 'x' }] }))
      .toBe("[1, 'x']");
    expect(cypherLiteral({ kind: 'map', entries: [['a b', { kind: 'boolean', value: true }]] })).toBe('{`a b`: true}');
    expect(cypherLiteral({ kind: 'list', items: [{ kind: 'bytes', value: 'AA==' }] })).toBeNull();
  });

  it('时间与空间点是构造写法，原样', () => {
    expect(cypherLiteral({ kind: 'temporal', value: "date('2024-01-02')" })).toBe("date('2024-01-02')");
  });
});

describe('entityWrite', () => {
  it('什么都没动就不写', () => {
    expect(edited(() => {})).toEqual({ kind: 'unchanged' });
  });

  it('首尾空白不算改动', () => {
    expect(edited((draft) => { draft.properties[0].value = ' 42 '; })).toEqual({ kind: 'unchanged' });
  });

  it('改一个值只设那一个，按 elementId 定位', () => {
    expect(statementOf(edited((draft) => { draft.properties[0].value = '43'; }))).toBe(
      "MATCH (n) WHERE elementId(n) = '4:db:1'\nSET n.age = 43\nRETURN n"
    );
  });

  it('删一个属性、加一个属性、加摘标签', () => {
    const write = edited((draft) => {
      draft.properties = draft.properties.filter((property) => property.key !== 'age');
      draft.properties.push({ originalKey: null, key: 'born', value: "date('1980-01-01')" });
      draft.labels = ['Actor', 'Star Man'];
    });
    expect(write).toEqual({
      kind: 'write',
      statement: "MATCH (n) WHERE elementId(n) = '4:db:1'\nREMOVE n.age, n:Person\nSET n.born = date('1980-01-01'), n:Actor:`Star Man`\nRETURN n",
      labelsChanged: true
    });
  });

  it('改名后又新加一个同名的：先摘后设，新加的那个留得住', () => {
    const statement = statementOf(edited((draft) => {
      draft.properties[0].key = 'years';
      draft.properties.push({ originalKey: null, key: 'age', value: "'old'" });
    }));
    expect(statement).toBe("MATCH (n) WHERE elementId(n) = '4:db:1'\nREMOVE n.age\nSET n.years = 42, n.age = 'old'\nRETURN n");
    expect(statement.indexOf('REMOVE')).toBeLessThan(statement.indexOf('SET'));
  });

  it('写不成字面量的值不能改键也不写回；删掉它可以', () => {
    expect(edited((draft) => { draft.properties[1].key = 'photo'; })).toEqual({ kind: 'unchanged' });
    expect(statementOf(edited((draft) => { draft.properties.splice(1, 1); }))).toContain('REMOVE n.avatar');
  });

  it('刚加出来、键和值都空着的一行不算数', () => {
    expect(edited((draft) => { draft.properties.push({ originalKey: null, key: '', value: ' ' }); })).toEqual({ kind: 'unchanged' });
  });

  it('键空着、重复、值空着，都不写并说出是哪一个', () => {
    expect(edited((draft) => { draft.properties.push({ originalKey: null, key: ' ', value: '1' }); }))
      .toEqual({ kind: 'invalid', problem: { kind: 'empty-key' } });
    expect(edited((draft) => { draft.properties.push({ originalKey: null, key: 'name', value: '1' }); }))
      .toEqual({ kind: 'invalid', problem: { kind: 'duplicate-key', key: 'name' } });
    expect(edited((draft) => { draft.properties[2].value = ''; }))
      .toEqual({ kind: 'invalid', problem: { kind: 'empty-value', key: 'name' } });
  });

  it('关系：用关系的定位，标签那一项不起作用', () => {
    expect(statementOf(edited((draft) => {
      draft.properties[0].value = '2021';
      draft.labels = ['Ignored'];
    }, livesIn))).toBe("MATCH ()-[r]->() WHERE elementId(r) = '5:db:9'\nSET r.since = 2021\nRETURN r");
  });

  it('建节点：标签与属性写进 CREATE；什么都不填也能建', () => {
    const draft = draftOf(null);
    draft.labels = ['Person', ' ', 'Person'];
    draft.properties.push({ originalKey: null, key: 'name', value: "'Ann'" });
    expect(entityWrite(null, draft)).toEqual({
      kind: 'write',
      statement: "CREATE (n:Person {name: 'Ann'})\nRETURN n",
      labelsChanged: true
    });
    expect(statementOf(entityWrite(null, draftOf(null)))).toBe('CREATE (n)\nRETURN n');
  });
});

describe('删', () => {
  it('节点只在确认过之后才 DETACH；关系从来不需要', () => {
    expect(deleteStatement(person, false)).toBe("MATCH (n) WHERE elementId(n) = '4:db:1'\nDELETE n");
    expect(deleteStatement(person, true)).toBe("MATCH (n) WHERE elementId(n) = '4:db:1'\nDETACH DELETE n");
    expect(deleteStatement(livesIn, true)).toBe("MATCH ()-[r]->() WHERE elementId(r) = '5:db:9'\nDELETE r");
  });

  it('数关系用无向的模式', () => {
    expect(degreeStatement(person)).toContain('COUNT { (n)--() }');
  });
});

describe('改完、删完之后的结果', () => {
  const path: CypherValue = {
    kind: 'path',
    start: person,
    segments: [{ relationship: livesIn, forward: true, node: city }]
  };
  const rows: CypherValue[][] = [
    [person, { kind: 'string', value: 'a' }],
    [city],
    [path],
    [{ kind: 'list', items: [livesIn] }]
  ];

  it('每一处都换成改完的样子，没提到的行还是原来那个对象', () => {
    const renamed: CypherNodeValue = { ...person, properties: [['name', { kind: 'string', value: 'Tim' }]] };
    const next = replaceEntity(rows, renamed);
    expect(next[0][0]).toBe(renamed);
    expect(next[1]).toBe(rows[1]);
    expect(next[2][0].kind === 'path' && next[2][0].start).toBe(renamed);
  });

  it('关系改了，路径里那一段跟着换', () => {
    const later: CypherRelationshipValue = { ...livesIn, properties: [] };
    const next = replaceEntity(rows, later);
    expect(next[2][0].kind === 'path' && next[2][0].segments[0].relationship).toBe(later);
    expect(next[3][0]).toEqual({ kind: 'list', items: [later] });
  });

  it('删了节点：提到它的行、提到连着它的关系的行都拿掉', () => {
    expect(removeEntity(rows, person)).toEqual([[city]]);
  });

  it('删了关系：只拿掉提到这条关系的行，两头的节点还在', () => {
    expect(removeEntity(rows, livesIn)).toEqual([rows[0], rows[1]]);
  });
});
