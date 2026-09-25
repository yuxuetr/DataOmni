import { describe, expect, it } from 'vitest';
import { browseRequest, classifyEsRisk, esRequestAt, parseEsConsole, riskiestEsRequest } from './esConsole';

describe('parseEsConsole', () => {
  it('splits requests at method lines and keeps the body as written', () => {
    const source = [
      '# 先看一眼',
      'GET books/_search',
      '{',
      '  "query": { "match": { "title": "dune" } },',
      '  "size": 9007199254740993',
      '}',
      '',
      'get /_cat/indices?format=json',
      'DELETE smoke'
    ].join('\n');
    const requests = parseEsConsole(source);
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /books/_search',
      'GET /_cat/indices?format=json',
      'DELETE /smoke'
    ]);
    // 原文照发：大整数不经过 JSON.parse 再写回
    expect(requests[0].body).toBe('{\n  "query": { "match": { "title": "dune" } },\n  "size": 9007199254740993\n}');
    expect(requests[0].ndjson).toBe(false);
    expect(requests[1].body).toBeNull();
    // 范围不含末尾的空行
    expect(source.slice(requests[0].from, requests[0].to).endsWith('}')).toBe(true);
    expect(source.slice(requests[2].from, requests[2].to)).toBe('DELETE smoke');
  });

  it('sends several JSON values, or any body to _bulk, as one line each', () => {
    const [bulk, msearch, single] = parseEsConsole([
      'POST _bulk',
      '{ "index": { "_index": "books", "_id": "1" } }',
      '{',
      '  "title": "Dune"',
      '}',
      'POST books/_msearch',
      '{}',
      '{"query": {"match_all": {}}}',
      'POST _bulk',
      '{"delete": {"_index": "books", "_id": "1"}}'
    ].join('\n'));
    expect(bulk.ndjson).toBe(true);
    expect(bulk.body).toBe('{ "index": { "_index": "books", "_id": "1" } }\n{ "title": "Dune" }\n');
    expect(msearch.body).toBe('{}\n{"query": {"match_all": {}}}\n');
    expect(single.body).toBe('{"delete": {"_index": "books", "_id": "1"}}\n');
  });

  it('does not end a value at braces inside strings, nor start a request inside a body', () => {
    const [request] = parseEsConsole([
      'PUT books/_doc/1',
      '{',
      '  "note": "a } and a { and \\" quote",',
      '  "text": "GET not/a/request"',
      '}'
    ].join('\n'));
    expect(request.problem).toBeNull();
    expect(request.ndjson).toBe(false);
  });

  it('names the line of a body that is not JSON instead of sending it', () => {
    const requests = parseEsConsole(['GET a/_search', '{ "size": 1 }', '', 'POST b/_search', '{', '  "size": ,', '}'].join('\n'));
    expect(requests[0].problem).toBeNull();
    expect(requests[1].problem?.line).toBe(5);
    expect(parseEsConsole('POST a/_doc\n{ "unclosed": 1\n')[0].problem?.line).toBe(2);
  });

  it('finds the request under the cursor', () => {
    const source = 'GET a/_search\n\nGET b/_search\n{}\n';
    expect(esRequestAt(source, 0)?.path).toBe('/a/_search');
    expect(esRequestAt(source, 14)?.path).toBe('/a/_search');
    expect(esRequestAt(source, source.length)?.path).toBe('/b/_search');
    expect(esRequestAt('not a request', 0)).toBeNull();
  });

  it('opens an object as a search that parses back', () => {
    const [request] = parseEsConsole(browseRequest('logs-app web'));
    expect(request.path).toBe('/logs-app%20web/_search');
    expect(request.problem).toBeNull();
  });
});

describe('classifyEsRisk', () => {
  it('reads what only reads, whatever the method', () => {
    expect(classifyEsRisk('GET', '/books/_doc/1')).toBe('read');
    expect(classifyEsRisk('POST', '/books/_search?size=1')).toBe('read');
    expect(classifyEsRisk('POST', '/_query')).toBe('read');
    expect(classifyEsRisk('POST', '/_sql?format=txt')).toBe('read');
    expect(classifyEsRisk('HEAD', '/books')).toBe('read');
    expect(classifyEsRisk('DELETE', '/_search/scroll')).toBe('scoped-write');
  });

  it('grades writes by how far they reach', () => {
    expect(classifyEsRisk('POST', '/books/_doc')).toBe('append');
    expect(classifyEsRisk('PUT', '/books')).toBe('append');
    expect(classifyEsRisk('PUT', '/books/_doc/1')).toBe('scoped-write');
    expect(classifyEsRisk('POST', '/books/_update/1')).toBe('scoped-write');
    expect(classifyEsRisk('DELETE', '/books/_doc/1')).toBe('scoped-write');
    expect(classifyEsRisk('PUT', '/books/_mapping')).toBe('scoped-write');
    expect(classifyEsRisk('POST', '/books/_delete_by_query')).toBe('bulk-write');
    expect(classifyEsRisk('POST', '/_bulk')).toBe('bulk-write');
    expect(classifyEsRisk('PUT', '/_security/user/x')).toBe('bulk-write');
    expect(classifyEsRisk('PUT', '/_cluster/settings')).toBe('bulk-write');
    expect(classifyEsRisk('DELETE', '/books')).toBe('destructive');
    expect(classifyEsRisk('DELETE', '/books,logs-*')).toBe('destructive');
    expect(classifyEsRisk('DELETE', '/_data_stream/logs-app')).toBe('destructive');
    expect(classifyEsRisk('DELETE', '/books/_alias/library')).toBe('scoped-write');
    expect(classifyEsRisk('DELETE', '/_index_template/logs')).toBe('scoped-write');
  });

  it('asks about the riskiest request in a batch, under the configured threshold', () => {
    const batch = [
      { method: 'GET' as const, path: '/books/_search' },
      { method: 'DELETE' as const, path: '/books' },
      { method: 'PUT' as const, path: '/books/_doc/1' }
    ];
    expect(riskiestEsRequest(batch, 'development')).toEqual({ request: batch[1], risk: 'destructive' });
    expect(riskiestEsRequest(batch.slice(0, 1), 'production')).toBeNull();
    expect(riskiestEsRequest([batch[2]], 'development')).toBeNull();
    expect(riskiestEsRequest([batch[2]], 'production')?.risk).toBe('scoped-write');
  });
});
