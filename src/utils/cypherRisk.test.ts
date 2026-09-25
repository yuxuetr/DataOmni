import { describe, expect, it } from 'vitest';
import { classifyCypherRisk, cypherMayWrite, riskiestCypherStatement } from './cypherRisk';

describe('cypherMayWrite', () => {
  it('没有会写的词就不必问服务端；字符串与名字里的不算', () => {
    expect(cypherMayWrite('MATCH (n:Person) RETURN n LIMIT 25')).toBe(false);
    expect(cypherMayWrite("MATCH (n) WHERE n.note = 'DELETE me' RETURN n")).toBe(false);
    expect(cypherMayWrite('MATCH (n:`SET`) RETURN n')).toBe(false);
    expect(cypherMayWrite('CALL db.labels()')).toBe(true);
    expect(cypherMayWrite('match (n) detach delete n')).toBe(true);
  });
});

describe('classifyCypherRisk', () => {
  it('服务端说是读就是读，哪怕字面上有 CALL', () => {
    expect(classifyCypherRisk('CALL db.labels() YIELD label RETURN label', 'r')).toBe('read');
    expect(classifyCypherRisk('MATCH (n) RETURN n', null)).toBe('read');
  });

  it('按代价分级：删与摘标签看不出范围，按批量写', () => {
    expect(classifyCypherRisk('MATCH (n) DETACH DELETE n', 'w')).toBe('bulk-write');
    expect(classifyCypherRisk('MATCH (n:Person {id: 1}) REMOVE n:Person', 'w')).toBe('bulk-write');
    expect(classifyCypherRisk('MATCH (n:Person {id: 1}) SET n.age = 31', 'w')).toBe('scoped-write');
    expect(classifyCypherRisk('CREATE (n:Person {name: $name})', 'w')).toBe('append');
    expect(classifyCypherRisk('MERGE (n:City {name: "x"}) RETURN n', 'rw')).toBe('append');
    expect(classifyCypherRisk('CREATE INDEX person_name FOR (n:Person) ON (n.name)', 's')).toBe('append');
    expect(classifyCypherRisk('DROP INDEX person_name', 's')).toBe('destructive');
    expect(classifyCypherRisk('DROP DATABASE movies', null)).toBe('destructive');
  });

  it('改权限按批量写；问不到类型的过程调用从严', () => {
    expect(classifyCypherRisk('GRANT ROLE admin TO alice', null)).toBe('bulk-write');
    expect(classifyCypherRisk('CREATE USER bob SET PASSWORD $p', null)).toBe('bulk-write');
    expect(classifyCypherRisk('CALL apoc.periodic.iterate($a, $b, {})', null)).toBe('scoped-write');
    expect(classifyCypherRisk('UNWIND $rows AS r CREATE (n) FOREACH (x IN [] | SET n.a = 1)', 'w')).toBe('scoped-write');
  });
});

describe('riskiestCypherStatement', () => {
  it('挑最该确认的那条；开发环境默认只拦批量写与破坏性的', () => {
    const batch = [
      { text: 'CREATE (n:A)', queryType: 'w' as const },
      { text: 'MATCH (n:A) DETACH DELETE n', queryType: 'w' as const },
      { text: 'MATCH (n) RETURN n', queryType: 'r' as const }
    ];
    expect(riskiestCypherStatement(batch, 'development')).toEqual({ text: 'MATCH (n:A) DETACH DELETE n', risk: 'bulk-write' });
    expect(riskiestCypherStatement(batch.slice(0, 1), 'development')).toBeNull();
    // 生产上有界的改动也拦
    expect(riskiestCypherStatement([{ text: 'MATCH (n {id: 1}) SET n.a = 1', queryType: 'w' }], 'production'))
      .toEqual({ text: 'MATCH (n {id: 1}) SET n.a = 1', risk: 'scoped-write' });
  });
});
