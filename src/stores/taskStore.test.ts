import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {}
}));

const { useTaskStore } = await import('./taskStore');

async function settled(id: string) {
  await vi.waitFor(() => {
    const task = useTaskStore.getState().tasks.find((candidate) => candidate.id === id);
    expect(task?.finishedAt).not.toBeNull();
  });
  return useTaskStore.getState().tasks.find((candidate) => candidate.id === id);
}

describe('任务失败', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useTaskStore.setState({ tasks: [] });
  });

  it('原因写在那一行上，不必展开日志才看得到', async () => {
    // 此前一行只写「失败」，原因只在日志里
    invokeMock.mockRejectedValue('pg_dump: error: connection refused');
    const backup = useTaskStore.getState().start({
      kind: 'backup',
      title: 'b',
      payload: { connectionId: 'c', path: '/tmp/x.dump' }
    });
    expect((await settled(backup))?.detail).toContain('connection refused');

    invokeMock.mockRejectedValue('permission denied');
    const exported = useTaskStore.getState().start({
      kind: 'export',
      title: 'e',
      payload: { connectionId: 'c', sql: 'SELECT 1', path: '/x.csv', options: {} as never }
    });
    expect((await settled(exported))?.detail).toContain('permission denied');
  });

  it('导入失败也一样，进度那句换成原因', async () => {
    invokeMock.mockRejectedValue('relation "t" does not exist');
    const id = useTaskStore.getState().start({
      kind: 'import',
      title: 'i',
      payload: {
        connectionId: 'c',
        schema: null,
        table: 't',
        path: '/x.csv',
        csv: { delimiter: ',', hasHeader: true, nullText: '' },
        columns: [],
        batchSize: 100,
        strategy: 'single-transaction',
        onError: 'abort'
      }
    });
    expect((await settled(id))?.detail).toContain('does not exist');
  });

  it('取消的导出不算失败，也不写原因', async () => {
    invokeMock.mockRejectedValue({ code: 'EXPORT_CANCELLED', message: 'cancelled' });
    const id = useTaskStore.getState().start({
      kind: 'export',
      title: 'e',
      payload: { connectionId: 'c', sql: 'SELECT 1', path: '/x.csv', options: {} as never }
    });
    const task = await settled(id);
    expect(task?.status).toBe('cancelled');
    expect(task?.detail).toBeNull();
  });
});
