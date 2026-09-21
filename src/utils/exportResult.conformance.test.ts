import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { serializeExport, type ExportOptions } from './exportResult';
import type { SerializedResultValue } from '../contracts/resultSet';

/**
 * 导出有两份实现：对话框里的预览由这里的 `serializeExport` 算，而整表导出写进
 * 文件的字节由 `src-tauri/src/services/export_writer.rs` 写。两边分叉时预览就会
 * 变成谎话——而这种分叉不会让任何一侧自己的测试变红。
 *
 * 这份语料是同一组输入的唯一期望输出，两边各自照它核对。
 */
interface ConformanceCase {
  name: string;
  columns: string[];
  rows: Array<Record<string, SerializedResultValue>>;
  options: ExportOptions;
  expected: string;
}

// 用 `new URL` 而不是相对的 cwd 路径：vitest 的工作目录不保证是仓库根
const CORPUS_PATH = new URL('../../fixtures/export-conformance.json', import.meta.url);
const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { cases: ConformanceCase[] };

describe('导出语料', () => {
  it('语料本身不能被删空——一道不会红的门等于没有门', () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(16);
  });

  it.each(corpus.cases.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    (_name, testCase) => {
      // 前端拿到的批次行也是「列名 → 值」的映射，重名列在这里同样是后一列顶前一列
      const rows = testCase.rows.map((row) =>
        testCase.columns.map((column) => row[column] ?? null)
      );
      expect(serializeExport(testCase.columns, rows, testCase.options)).toBe(testCase.expected);
    }
  );
});
