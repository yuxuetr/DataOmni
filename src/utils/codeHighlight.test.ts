import { describe, expect, it } from 'vitest';
import { MAX_HIGHLIGHTED_CHARS, highlightSegments, type CodeLanguage } from './codeHighlight';

const toned = (code: string, language: CodeLanguage) =>
  highlightSegments(code, language).filter((segment) => segment.tone !== null).map(({ tone, text }) => `${tone}:${text}`);

describe('highlightSegments', () => {
  it('gives back the text unchanged, newlines included', () => {
    const cases: Array<[string, CodeLanguage]> = [
      ['SELECT *\n  FROM t\n\nWHERE a = \'x\' -- c\n', 'sql'],
      ['{\n  "a": [1, "b", null]\n}', 'json'],
      ['GET /idx/_search\n{"query": {}}', 'json'],
      ['db.getCollection("c").find({ n: 1 })', 'javascript'],
      ["MATCH (n) WHERE n.a = 'x'\nRETURN n", 'cypher']
    ];
    for (const [code, language] of cases) {
      expect(highlightSegments(code, language).map((segment) => segment.text).join('')).toBe(code);
    }
  });

  it('colors SQL keywords, strings, numbers and comments', () => {
    expect(toned("SELECT a FROM t WHERE x = 'y' AND n > 10 -- why", 'sql')).toEqual([
      'keyword:SELECT', 'keyword:FROM', 'keyword:WHERE', "string:'y'", 'keyword:AND', 'number:10', 'comment:-- why'
    ]);
  });

  it('colors SQL type names apart from keywords', () => {
    expect(toned('CREATE TABLE t (id INTEGER NOT NULL)', 'sql')).toEqual([
      'keyword:CREATE', 'keyword:TABLE', 'type:INTEGER', 'keyword:NOT', 'keyword:NULL'
    ]);
  });

  it('tells JSON keys from string values', () => {
    expect(toned('{"name": "a", "n": 1.50, "ok": true, "v": null, "list": ["x"]}', 'json')).toEqual([
      'property:"name"', 'string:"a"', 'property:"n"', 'number:1.50', 'property:"ok"', 'atom:true',
      'property:"v"', 'atom:null', 'property:"list"', 'string:"x"'
    ]);
  });

  it('reads MongoDB shell documents as JavaScript: bare keys, single quotes', () => {
    expect(toned("{\n  _id: ObjectId('65a'),\n  n: 1,\n  ok: true\n}", 'javascript')).toEqual([
      'property:_id', "string:'65a'", 'property:n', 'number:1', 'property:ok', 'atom:true'
    ]);
  });

  it('colors Cypher keywords and strings', () => {
    expect(toned("MATCH (n) RETURN 'x'", 'cypher')).toEqual(['keyword:MATCH', 'keyword:RETURN', "string:'x'"]);
  });

  it('leaves oversized text as one plain segment', () => {
    const big = `[${'1,'.repeat(MAX_HIGHLIGHTED_CHARS / 2)}1]`;
    expect(highlightSegments(big, 'json')).toEqual([{ text: big, tone: null }]);
    expect(highlightSegments('', 'sql')).toEqual([]);
  });
});
