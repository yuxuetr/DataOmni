import { describe, expect, it } from 'vitest';
import { cypherKeywords, cypherPreamble, cypherStatementAt, splitCypherStatements } from './cypherStatements';

const texts = (source: string) => splitCypherStatements(source).map((statement) => statement.text);

describe('splitCypherStatements', () => {
  it('按顶层分号拆，前后空白去掉，偏移指回原文', () => {
    const source = 'CREATE (a);\n  MATCH (n) RETURN n ;';
    const statements = splitCypherStatements(source);
    expect(statements.map((statement) => statement.text)).toEqual(['CREATE (a)', 'MATCH (n) RETURN n']);
    for (const statement of statements) {
      expect(source.slice(statement.from, statement.to)).toBe(statement.text);
    }
  });

  it('字符串、反引号名字与注释里的分号不算', () => {
    expect(texts("RETURN 'a;b' AS x; RETURN \"c;d\"")).toEqual(["RETURN 'a;b' AS x", 'RETURN "c;d"']);
    expect(texts('MATCH (n:`we;ird`) RETURN n')).toEqual(['MATCH (n:`we;ird`) RETURN n']);
    expect(texts('RETURN 1 // no; split\n; RETURN 2')).toEqual(['RETURN 1 // no; split', 'RETURN 2']);
    expect(texts('RETURN /* ; */ 1')).toEqual(['RETURN /* ; */ 1']);
  });

  it('反斜杠转义的引号不结束字符串；Cypher 不认 SQL 的两个单引号', () => {
    expect(texts("RETURN 'it\\'s; fine'; RETURN 2")).toEqual(["RETURN 'it\\'s; fine'", 'RETURN 2']);
    expect(texts('RETURN `a``;b`; RETURN 2')).toEqual(['RETURN `a``;b`', 'RETURN 2']);
  });

  it('只有空白与注释的段落不算一条', () => {
    expect(texts(';;  // 注释\n; /* x */')).toEqual([]);
    expect(texts('')).toEqual([]);
  });
});

describe('cypherKeywords', () => {
  it('只取代码里的词，大写', () => {
    expect(cypherKeywords("match (n) where n.x = 'delete me' // set\nreturn n")).toEqual([
      'MATCH', 'N', 'WHERE', 'N', 'X', 'RETURN', 'N'
    ]);
    expect(cypherKeywords('MATCH (n:`DELETE`) RETURN n')).not.toContain('DELETE');
  });
});

describe('cypherStatementAt', () => {
  it('光标所在的那条；在分号后的空白里算前一条', () => {
    const source = 'RETURN 1;  RETURN 2';
    expect(cypherStatementAt(source, 3)?.text).toBe('RETURN 1');
    expect(cypherStatementAt(source, 10)?.text).toBe('RETURN 1');
    expect(cypherStatementAt(source, 12)?.text).toBe('RETURN 2');
    expect(cypherStatementAt('', 0)).toBeNull();
  });
});

describe('cypherPreamble', () => {
  it('开头的 EXPLAIN / PROFILE，大小写都认；前面可以有注释与 CYPHER 选项', () => {
    expect(cypherPreamble('EXPLAIN MATCH (n) RETURN n').mode).toBe('explain');
    expect(cypherPreamble('profile match (n) return n').mode).toBe('profile');
    expect(cypherPreamble('// 看计划\nCYPHER 25 runtime=slotted EXPLAIN CREATE (n)').mode).toBe('explain');
    expect(cypherPreamble('EXPLAIN CYPHER planner = cost MATCH (n) RETURN n').mode).toBe('explain');
    expect(cypherPreamble('MATCH (n) RETURN n').mode).toBeNull();
  });

  it('查询里的、字符串里的、名字里的都不算', () => {
    expect(cypherPreamble("RETURN 'EXPLAIN'").mode).toBeNull();
    expect(cypherPreamble('MATCH (n:`PROFILE`) RETURN n').mode).toBeNull();
    expect(cypherPreamble('MATCH (explain) RETURN explain').mode).toBeNull();
    expect(cypherPreamble('CYPHER EXPLAIN_x=1 MATCH (n) RETURN n').mode).toBeNull();
  });

  it('body 是摘掉那个词的原文：问服务端查询类型时要它，服务端不接受 EXPLAIN PROFILE', () => {
    expect(cypherPreamble('PROFILE MATCH (n) SET n.x = 1').body).toBe(' MATCH (n) SET n.x = 1');
    expect(cypherPreamble('CYPHER 25 profile CREATE (n)').body).toBe('CYPHER 25  CREATE (n)');
    expect(cypherPreamble('MATCH (n) RETURN n').body).toBe('MATCH (n) RETURN n');
  });
});
