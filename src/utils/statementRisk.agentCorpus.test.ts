import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyStatementRisk } from './statementRisk';
import type { SqlDialect } from '../contracts/queryExecution';

/**
 * 命令行给 Agent 只放行读语句，判定在 `src-tauri/src/services/read_only_gate.rs`。
 * 那边放行的每一条，界面这里也必须判成 `read`——命令行放行而界面要确认的语句，
 * 说明两边有一边判错了。Rust 那边照同一份语料核对放行与拒绝。
 */
interface AllowedCase {
  sql: string;
  dialect: SqlDialect;
}

const CORPUS_PATH = new URL('../../fixtures/agent-read-only.json', import.meta.url);
const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { allow: AllowedCase[] };

describe('命令行只读语料', () => {
  it('语料本身不能被删空', () => {
    expect(corpus.allow.length).toBeGreaterThanOrEqual(20);
  });

  it.each(corpus.allow.map((testCase) => [testCase.sql, testCase] as const))(
    '%s',
    (_sql, testCase) => {
      expect(classifyStatementRisk(testCase.sql, testCase.dialect)).toBe('read');
    }
  );
});
