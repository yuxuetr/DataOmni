import { describe, expect, it, vi } from 'vitest';
import { DatabaseType, type SqlStatement } from '../contracts';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {}
}));

const { applySelectedTablePreview } = await import('./SqlWorkbench');

describe('applySelectedTablePreview', () => {
  it('按方言生成首屏查询并立即执行解析出的第一条语句', async () => {
    const selectTable = vi.fn();
    const clearSelectedTable = vi.fn();
    const setSqlInput = vi.fn();
    const parseStatements = vi.fn((): SqlStatement[] => [
      { id: 'stmt-1', sql: 'SELECT * FROM "public"."orders" LIMIT 100;', isExecuting: false }
    ]);
    const executeStatement = vi.fn(async () => true);

    await applySelectedTablePreview(
      { name: 'orders', schema: 'public' },
      true,
      DatabaseType.PostgreSQL,
      { selectTable, clearSelectedTable, setSqlInput, parseStatements, executeStatement }
    );

    expect(selectTable).toHaveBeenCalledWith('orders', 'public');
    expect(setSqlInput).toHaveBeenCalledWith('SELECT * FROM "public"."orders" LIMIT 100;');
    expect(executeStatement).toHaveBeenCalledWith('stmt-1');
    expect(clearSelectedTable).not.toHaveBeenCalled();
  });

  it('解析耗时 200 ms 时仍等待解析结果执行新语句，不会像 100 ms 定时器那样漏执行或读旧状态', async () => {
    vi.useFakeTimers();
    try {
      const executeStatement = vi.fn(async () => true);
      const parseStatements = vi.fn(
        () =>
          new Promise<SqlStatement[]>((resolve) => {
            setTimeout(() => {
              resolve([{ id: 'stmt-after-200ms', sql: 'SELECT * FROM `users` LIMIT 100;', isExecuting: false }]);
            }, 200);
          })
      );

      const pending = applySelectedTablePreview(
        { name: 'users' },
        true,
        DatabaseType.MySQL,
        {
          selectTable: vi.fn(),
          clearSelectedTable: vi.fn(),
          setSqlInput: vi.fn(),
          parseStatements,
          executeStatement
        }
      );

      // 100 ms 时（旧实现定时器触发时刻）解析尚未完成，不应提前读旧状态
      await vi.advanceTimersByTimeAsync(100);
      expect(executeStatement).not.toHaveBeenCalled();

      // 200 ms 解析完成后立即执行新语句
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(executeStatement).toHaveBeenCalledWith('stmt-after-200ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('selectedTable 为空时清理选中表状态且不执行查询', async () => {
    const clearSelectedTable = vi.fn();
    const executeStatement = vi.fn(async () => true);

    await applySelectedTablePreview(
      undefined,
      true,
      DatabaseType.SQLite,
      {
        selectTable: vi.fn(),
        clearSelectedTable,
        setSqlInput: vi.fn(),
        parseStatements: vi.fn(() => []),
        executeStatement
      }
    );

    expect(clearSelectedTable).toHaveBeenCalledOnce();
    expect(executeStatement).not.toHaveBeenCalled();
  });
});
