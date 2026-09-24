import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CREATES_SCHEMAS,
  createIndexSql,
  createSchemaSql,
  dropIndexSql,
  dropObjectSql,
  truncateTableSql,
  type DroppableKind
} from './objectDdl';
import type { SqlIdentifierDialect } from './sqlIdentifiers';

/**
 * 对象级结构操作的共用语料：`fixtures/object-ddl-conformance.json`。
 *
 * 这里只证明「同一个请求生成的就是语料里那一条」；那一条在真库上跑不跑得通、
 * 跑完是不是那个结果，由各家的冒烟用例拿同一份语料去证明。
 */
type CorpusRequest =
  | { action: 'drop'; kind: DroppableKind; schema: string | null; name: string }
  | { action: 'truncate'; schema: string | null; name: string }
  | { action: 'create-schema'; name: string }
  | {
    action: 'create-index';
    schema: string | null;
    table: string;
    name: string;
    columns: string[];
    unique: boolean;
  }
  | { action: 'drop-index'; schema: string | null; table: string; name: string };

interface CorpusCase {
  name: string;
  dialect: SqlIdentifierDialect;
  request: CorpusRequest;
  statement: string;
}

const CORPUS_PATH = new URL('../../fixtures/object-ddl-conformance.json', import.meta.url);
const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { cases: CorpusCase[] };

function generate({ request, dialect }: CorpusCase): string {
  switch (request.action) {
    case 'drop':
      return dropObjectSql(request, dialect);
    case 'truncate':
      return truncateTableSql(request, dialect);
    case 'create-schema':
      return createSchemaSql(request.name, dialect);
    case 'create-index':
      return createIndexSql(request, dialect);
    case 'drop-index':
      return dropIndexSql(request, dialect);
  }
}

describe('对象级结构操作的共用语料', () => {
  it('每一家都有用例', () => {
    // 少了一家，那一家的冒烟用例就在空跑
    const dialects = new Set(corpus.cases.map((entry) => entry.dialect));
    expect([...dialects].sort()).toEqual(['mysql', 'oracle', 'postgresql', 'sqlite', 'sqlserver']);
  });

  it('能建 schema 的每一家都有建 schema 的用例', () => {
    const covered = corpus.cases
      .filter((entry) => entry.request.action === 'create-schema')
      .map((entry) => entry.dialect);
    expect([...covered].sort()).toEqual([...CREATES_SCHEMAS].sort());
  });

  for (const entry of corpus.cases) {
    it(entry.name, () => {
      expect(generate(entry)).toBe(entry.statement);
    });
  }
});
