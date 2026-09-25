import { describe, expect, it } from 'vitest';
import { parseJson } from './esJson';
import { documentAddress, readDocument, readPath, sourceProblem, writeOutcome, writePath } from './esDocument';

describe('documentAddress', () => {
  it('takes index, id and custom routing from a hit', () => {
    expect(documentAddress(parseJson('{"_index":".ds-logs-2026.09.25-000001","_id":"a/b","_score":1,"_routing":"u1","_source":{}}')!))
      .toEqual({ index: '.ds-logs-2026.09.25-000001', id: 'a/b', routing: 'u1' });
    expect(documentAddress(parseJson('{"_index":"books","_id":"1"}')!)?.routing).toBeNull();
    expect(documentAddress(parseJson('{"_id":"1"}')!)).toBeNull();
  });
});

describe('paths', () => {
  const address = { index: 'my books', id: 'a/b?c', routing: null };
  it('escapes the id and carries the version it read', () => {
    expect(readPath(address)).toBe('/my%20books/_doc/a%2Fb%3Fc');
    expect(writePath(address, { seqNo: '7', primaryTerm: '1' }))
      .toBe('/my%20books/_doc/a%2Fb%3Fc?if_seq_no=7&if_primary_term=1&refresh=wait_for');
  });

  it('routes to the shard the document lives on', () => {
    const routed = { ...address, routing: 'user 1' };
    expect(readPath(routed)).toBe('/my%20books/_doc/a%2Fb%3Fc?routing=user%201');
    expect(writePath(routed, { seqNo: '0', primaryTerm: '2' })).toContain('?routing=user%201&if_seq_no=0&');
  });
});

describe('readDocument', () => {
  it('reads the fresh source with its version, keeping big numbers as written', () => {
    const doc = readDocument(parseJson('{"_index":"b","_id":"1","_version":3,"_seq_no":12,"_primary_term":1,"found":true,"_source":{"sid":9007199254740993,"t":"x"}}'));
    expect(doc).toEqual({
      version: { seqNo: '12', primaryTerm: '1' },
      sourceText: '{\n  "sid": 9007199254740993,\n  "t": "x"\n}'
    });
  });

  it('has nothing to edit when the document is gone or its source is not stored', () => {
    expect(readDocument(parseJson('{"_index":"b","_id":"1","found":false}'))).toBeNull();
    expect(readDocument(parseJson('{"_index":"b","_id":"1","_seq_no":1,"_primary_term":1,"found":true}'))).toBeNull();
    expect(readDocument(null)).toBeNull();
  });
});

describe('sourceProblem and writeOutcome', () => {
  it('accepts only a JSON object as the new source', () => {
    expect(sourceProblem('{ "a": 1 }')).toBeNull();
    expect(sourceProblem('{ "a": }')).toBe('invalid');
    expect(sourceProblem('[1]')).toBe('not-object');
  });

  it('tells a conflict and a vanished document apart', () => {
    expect([200, 201, 409, 404, 400].map(writeOutcome)).toEqual(['done', 'done', 'conflict', 'gone', 'failed']);
  });
});
