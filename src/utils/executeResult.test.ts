import { describe, expect, it } from 'vitest';
import { assertSingleRowAffected } from './executeResult';

describe('assertSingleRowAffected', () => {
  it('accepts exactly one affected row', () => {
    expect(() => assertSingleRowAffected({ rowsAffected: 1 }, '更新')).not.toThrow();
  });

  it('rejects a missing target row', () => {
    expect(() => assertSingleRowAffected({ rowsAffected: 0 }, '更新')).toThrow(
      '目标记录不存在或已被其他操作修改'
    );
  });

  it('rejects updates affecting multiple rows', () => {
    expect(() => assertSingleRowAffected({ rowsAffected: 2 }, '删除')).toThrow(
      '预期影响 1 行，实际影响 2 行'
    );
  });
});
