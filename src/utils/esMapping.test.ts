import { describe, expect, it } from 'vitest';
import { parseJson } from './esJson';
import { filterMappingFields, readIndexAliases, readIndexMapping, readIndexSettings } from './esMapping';

// cu 上 9.5.3 对一个什么都写了一点的索引给的原话
const MAPPING = parseJson(`{"map_probe":{"mappings":{"dynamic":"strict","runtime":{"day":{"type":"keyword","script":{"source":"emit(\\"x\\")","lang":"painless"}}},"properties":{"alias_title":{"type":"alias","path":"title"},"author":{"properties":{"name":{"type":"keyword"}}},"blob":{"type":"object","enabled":false},"published":{"type":"date","format":"yyyy-MM-dd"},"reviews":{"type":"nested","properties":{"stars":{"type":"byte"}}},"title":{"type":"text","fields":{"kw":{"type":"keyword","ignore_above":256}},"analyzer":"english"},"vec":{"type":"dense_vector","dims":3,"index":true,"similarity":"cosine","index_options":{"type":"int8_hnsw","m":16,"ef_construction":100}}}}}}`);

describe('readIndexMapping', () => {
  it('lays fields out by path, with objects, nested and multi-fields in place', () => {
    const mapping = readIndexMapping(MAPPING, 'map_probe');
    expect(mapping?.fields.map((field) => `${'  '.repeat(field.depth)}${field.path}: ${field.type}${field.multiField ? ' (multi)' : ''}`)).toEqual([
      'alias_title: alias',
      'author: object',
      '  author.name: keyword',
      'blob: object',
      'published: date',
      'reviews: nested',
      '  reviews.stars: byte',
      'title: text',
      '  title.kw: keyword (multi)',
      'vec: dense_vector'
    ]);
  });

  it('keeps every parameter it does not nest into, as written', () => {
    const fields = readIndexMapping(MAPPING, 'map_probe')?.fields ?? [];
    const details = (path: string) => fields.find((field) => field.path === path)?.details;
    expect(details('title')).toEqual([['analyzer', 'english']]);
    expect(details('title.kw')).toEqual([['ignore_above', '256']]);
    expect(details('blob')).toEqual([['enabled', 'false']]);
    expect(details('alias_title')).toEqual([['path', 'title']]);
    expect(details('vec')?.find(([key]) => key === 'index_options')?.[1]).toBe('{"type":"int8_hnsw","m":16,"ef_construction":100}');
  });

  it('reads runtime fields, dynamic and a disabled _source', () => {
    const mapping = readIndexMapping(MAPPING, 'map_probe');
    expect(mapping?.runtime.map((field) => [field.path, field.type])).toEqual([['day', 'keyword']]);
    expect(mapping?.dynamic).toBe('strict');
    expect(mapping?.sourceDisabled).toBe(false);
    const bare = readIndexMapping(parseJson('{"x":{"mappings":{"_source":{"enabled":false}}}}'), 'x');
    expect(bare).toEqual({ fields: [], runtime: [], dynamic: 'true', sourceDisabled: true });
  });

  it('picks the group of the index asked for, or the first one', () => {
    const two = parseJson('{"a":{"mappings":{"properties":{"x":{"type":"long"}}}},"b":{"mappings":{"properties":{"y":{"type":"text"}}}}}');
    expect(readIndexMapping(two, 'b')?.fields[0].path).toBe('y');
    expect(readIndexMapping(two, 'an-alias')?.fields[0].path).toBe('x');
    expect(readIndexMapping(parseJson('{}'), 'a')).toBeNull();
    expect(readIndexMapping(parseJson('{"error":{"type":"index_not_found_exception"},"status":404}'), 'a')).toBeNull();
  });
});

describe('settings and aliases', () => {
  it('reads shards, replicas, creation time and uuid from flat settings', () => {
    const settings = readIndexSettings(parseJson('{"map_probe":{"settings":{"index.creation_date":"1790344610782","index.number_of_replicas":"0","index.number_of_shards":"1","index.uuid":"v5Cn"}}}'), 'map_probe');
    expect(settings).toEqual({ shards: '1', replicas: '0', createdAt: 1790344610782, uuid: 'v5Cn' });
  });

  it('lists the aliases pointing at the index', () => {
    expect(readIndexAliases(parseJson('{"books":{"aliases":{"library":{},"shelf":{"is_write_index":true}}}}'), 'books')).toEqual(['library', 'shelf']);
    expect(readIndexAliases(parseJson('{"books":{"aliases":{}}}'), 'books')).toEqual([]);
  });
});

describe('filterMappingFields', () => {
  it('matches a path segment, or a whole type name', () => {
    const fields = readIndexMapping(MAPPING, 'map_probe')?.fields ?? [];
    expect(filterMappingFields(fields, 'TITLE').map((field) => field.path)).toEqual(['alias_title', 'title', 'title.kw']);
    expect(filterMappingFields(fields, 'keyword').map((field) => field.path)).toEqual(['author.name', 'title.kw']);
    expect(filterMappingFields(fields, '  ')).toHaveLength(fields.length);
  });
});
