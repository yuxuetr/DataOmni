import { describe, expect, it } from 'vitest';
import { cypherKeywords, cypherStatementAt, splitCypherStatements } from './cypherStatements';

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
