import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 执行一条语句时不把语句原文打到控制台。
 *
 * WebKitGTK（Linux 打包版）打印一个长字符串是平方级的：打包版上实测一条 200KB 的
 * INSERT 光这一句 console.log 就停了 38.5 秒（IPC 往返 62ms、后端 11ms），1MB 的
 * mysqldump 扩展 INSERT 就是整个界面卡死。语句本来就在编辑器、结果卡片和历史里
 */
const invokeMock = vi.fn();

class FakeChannel<T> {
  onmessage: ((message: T) => void) | null = null;
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: FakeChannel
}));

const { selectActiveSqlDocument, useQueryStore } = await import('./queryStore');

describe('执行语句时的控制台输出', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('不带语句原文', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_query') {
        return { kind: 'affected', rows_affected: 1 };
      }
      if (command === 'get_session_transaction') {
        return { status: 'idle', startedAt: null };
      }
      return undefined;
    });
    useQueryStore.setState({
      documents: {},
      activeDocumentId: null,
      executions: [],
      connectionString: 'sqlite:///tmp/a.db',
      connectionId: 'profile-a',
      session: {
        id: 'session-a',
        profileId: 'profile-a',
        database: null,
        transaction: { status: 'idle', startedAt: null }
      } as never,
      database: { close: vi.fn() } as never,
      connectionLost: false,
      error: null
    });
    const printed: unknown[] = [];
    for (const method of ['log', 'info', 'debug', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(...args);
      });
    }

    const marker = `om_marker_${'x'.repeat(64)}`;
    const store = useQueryStore.getState();
    store.openDocument('tab-a');
    store.setSqlInput(`INSERT INTO t VALUES ('${marker}');`);
    store.parseStatements();
    const statement = selectActiveSqlDocument(useQueryStore.getState()).statements[0];
    expect(await useQueryStore.getState().executeStatement(statement.id)).toBe(true);

    expect(printed.filter((value) => String(value).includes(marker))).toEqual([]);
  });
});
