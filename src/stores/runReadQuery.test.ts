import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GRID_PAGE_SIZE_OPTIONS } from '../utils/gridPagination';

type BatchCallback = (batch: { index: number; offset: number; rows: Record<string, unknown>[] }) => void;

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: class {
    callback: BatchCallback;
    constructor(callback: BatchCallback) {
      this.callback = callback;
    }
  }
}));

const { runReadQuery, useQueryStore } = await import('./queryStore');
const { useLanguageStore } = await import('./languageStore');

/** 后端发一批行，再按给定的截断情况收尾 */
function driverReturns(rows: Record<string, unknown>[], truncation: 'row_limit' | 'byte_limit' | null) {
  invoke.mockImplementation(async (_command: string, args: { onBatch: { callback: BatchCallback } }) => {
    args.onBatch.callback({ index: 0, offset: 0, rows });
    return {
      kind: 'rows',
      columns: ['id'],
      column_metadata: [],
      row_count: rows.length,
      batch_count: 1,
      truncated: truncation !== null,
      truncation_reason: truncation,
      row_limit: 1000,
      byte_limit: 12 * 1024 * 1024,
      bytes_read: 0,
      omitted_result_sets: 0
    };
  });
}

beforeEach(() => {
  useLanguageStore.getState().setPreference('en');
  invoke.mockReset();
  useQueryStore.setState({
    connectionId: 'c',
    session: { id: 's' } as never,
    queryResultRowLimit: 100
  });
});

describe('runReadQuery', () => {
  it('一页超过读取上限时报错，不悄悄只给前几行', async () => {
    // 表数据页每页 50 行，后端读到第 3 行就满了 12 MiB：只交回 3 行的话网格画 3 行，
    // 下一页从第 51 行起，第 4–50 行再也看不到
    driverReturns([{ id: 1 }, { id: 2 }, { id: 3 }], 'byte_limit');
    await expect(runReadQuery('SELECT 1')).rejects.toThrow(/3 rows/);
  });

  it('行数上限不跟编辑器的设置走：编辑器选 100 行时，每页 200 行的表数据页照样读满', async () => {
    driverReturns([{ id: 1 }], null);
    await runReadQuery('SELECT 1');
    const request = (invoke.mock.calls[0]?.[1] as { request: { rowLimit: number } }).request;
    expect(request.rowLimit).toBeGreaterThan(Math.max(...GRID_PAGE_SIZE_OPTIONS));
  });

  it('没截断时原样交回', async () => {
    driverReturns([{ id: 1 }, { id: 2 }], null);
    await expect(runReadQuery('SELECT 1')).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  });
});
