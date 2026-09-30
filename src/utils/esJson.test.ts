import { describe, expect, it } from 'vitest';
import { bulkFailures, formatJsonCell, parseJson, prettyBody, searchFacts, stringifyJson, toEsTable } from './esJson';

const search = JSON.stringify({
  took: 3,
  timed_out: false,
  hits: {
    total: { value: 10000, relation: 'gte' },
    hits: [
      { _index: 'books', _id: '1', _score: 1.5, _source: { title: 'Dune', author: { name: 'Herbert' } } },
      { _index: 'books', _id: '2', _score: 1.2, _source: { title: 'Emma', year: 1815 } }
    ]
  }
});

describe('parseJson', () => {
  it('keeps numbers as written, including ones a double cannot hold', () => {
    const value = parseJson('{"id": 9007199254740993, "ratio": 1.10, "e": -2E+3}');
    expect(stringifyJson(value!)).toBe('{"id":9007199254740993,"ratio":1.10,"e":-2E+3}');
    // JSON.parse 会把它改掉——这就是为什么不用它
    expect(String(JSON.parse('9007199254740993'))).toBe('9007199254740992');
  });

  it('keeps key order, even for keys that look like integers', () => {
    const value = parseJson('{"b": 1, "2": 2, "a": {"z": [], "y": {}}}');
    expect(value?.kind === 'object' && value.entries.map(([key]) => key)).toEqual(['b', '2', 'a']);
    expect(Object.keys(JSON.parse('{"b": 1, "2": 2}'))).toEqual(['2', 'b']);
  });

  it('decodes escapes and refuses what is not JSON', () => {
    expect(parseJson('"a\\u00e9\\n\\"b"')).toEqual({ kind: 'string', value: 'aé\n"b' });
    for (const bad of ['', 'health status index\ngreen open books', '{"a":1,}', '[1 2]', '{"a":1} x', 'nul']) {
      expect(parseJson(bad)).toBeNull();
    }
  });
});

describe('prettyBody', () => {
  it('indents JSON and leaves anything else alone', () => {
    expect(prettyBody('{"a":[1,{"b":null}],"c":{},"d":[]}')).toBe(
      '{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ],\n  "c": {},\n  "d": []\n}'
    );
    expect(prettyBody('green open books')).toBe('green open books');
    expect(prettyBody('')).toBe('');
  });
});

describe('toEsTable', () => {
  it('lays search hits out as id, score and top-level source fields', () => {
    const table = toEsTable(parseJson(search));
    expect(table?.source).toBe('hits');
    expect(table?.columns).toEqual(['_id', '_score', 'title', 'author', 'year']);
    const cells = table?.rows.map((row) => row.map((cell) => (cell === null ? '' : formatJsonCell(cell))));
    expect(cells).toEqual([
      ['1', '1.5', 'Dune', '{"name":"Herbert"}', ''],
      ['2', '1.2', 'Emma', '', '1815']
    ]);
  });

  it('adds the index when hits come from several, and drops the score when there is none', () => {
    const table = toEsTable(parseJson(JSON.stringify({
      hits: { hits: [{ _index: 'a', _id: '1', _score: null, _source: {} }, { _index: 'b', _id: '2', _score: null }] }
    })));
    expect(table?.columns).toEqual(['_index', '_id']);
  });

  it('reads ES|QL values, SQL rows and _cat objects', () => {
    const esql = toEsTable(parseJson('{"columns":[{"name":"title","type":"text"},{"name":"n","type":"long"}],"values":[["Dune",9007199254740993],["Emma",null]]}'));
    expect(esql?.source).toBe('columns');
    expect(esql?.rows.map((row) => row.map((cell) => cell && formatJsonCell(cell)))).toEqual([
      ['Dune', '9007199254740993'],
      ['Emma', 'null']
    ]);
    const sql = toEsTable(parseJson('{"columns":[{"name":"c","type":"long"}],"rows":[[1]]}'));
    expect(sql?.rows).toEqual([[{ kind: 'number', text: '1' }]]);
    const cat = toEsTable(parseJson('[{"index":"books","health":"yellow"},{"index":"logs","docs.count":"3"}]'));
    expect(cat?.columns).toEqual(['index', 'health', 'docs.count']);
  });

  it('gives no table for answers that are not tabular', () => {
    for (const body of ['{"acknowledged":true}', '[]', '[1,2]', 'plain text']) {
      expect(toEsTable(parseJson(body))).toBeNull();
    }
  });
});

describe('searchFacts', () => {
  it('reads the total, whether it is a lower bound, and the server time', () => {
    expect(searchFacts(parseJson(search))).toEqual({ total: '10000', atLeast: true, tookMs: '3', timedOut: false });
    expect(searchFacts(parseJson('{"hits":{"total":7,"hits":[]}}'))?.total).toBe('7');
    expect(searchFacts(parseJson('{"acknowledged":true}'))).toBeNull();
  });
});

describe('bulkFailures', () => {
  // 打包版回归时撞上的：一批里有一条字段类型不对，回答照样是 200，徽标是绿的，后面的请求照发
  it('counts the items that carry an error, out of all items', () => {
    const answer = parseJson(JSON.stringify({
      errors: true,
      took: 0,
      items: [
        { index: { _index: 'rg', _id: 'b2', status: 201, result: 'created' } },
        { index: { _index: 'rg', _id: 'b3', status: 400, error: { type: 'document_parsing_exception' } } },
        { delete: { _index: 'rg', _id: 'nope', status: 404, result: 'not_found' } }
      ]
    }));
    expect(bulkFailures(answer)).toEqual({ failed: 1, total: 3 });
  });

  it('is null for a batch that went through, and for answers that are not a batch', () => {
    expect(bulkFailures(parseJson('{"errors":false,"items":[{"index":{"status":201}}]}'))).toBeNull();
    expect(bulkFailures(parseJson(search))).toBeNull();
    expect(bulkFailures(null)).toBeNull();
  });
});
