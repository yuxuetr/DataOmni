import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 断线之后界面还写着「已连接」，而且重连按钮按下去什么也不会发生。
 *
 * 两件事连在一起：`database` 是 `Database.load` 的返回值，驱动把连接判死
 * 之后句柄照样在那儿——状态标记看它，于是继续印「已连接」；
 * `connectToDatabase` 也看它（「已经有正常的连接」），于是直接返回。
 * 这里盯的就是 `connectionLost` 这一个标记有没有把两条路都掰过来。
 */
const invokeMock = vi.fn();
const loadMock = vi.fn();

class FakeChannel<T> {
  onmessage: ((message: T) => void) | null = null;
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: FakeChannel
}));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: (...args: unknown[]) => loadMock(...args) }
}));

const { selectActiveSqlDocument, useQueryStore } = await import('./queryStore');

const SESSION = { id: 'session-a', profileId: 'profile-a', database: null } as never;

function connectedStore() {
  useQueryStore.setState({
    documents: {},
    activeDocumentId: null,
    executions: [],
    connectionString: 'sqlite:memory',
    connectionId: 'profile-a',
    session: SESSION,
    database: { close: vi.fn() } as never,
    connectionLost: false,
    isConnecting: false,
    error: null
  });
}

async function runFailing(rejection: unknown) {
  invokeMock.mockRejectedValue(rejection);
  const store = useQueryStore.getState();
  store.openDocument('tab-a');
  store.setSqlInput('SELECT 1;');
  store.parseStatements();
  const statement = selectActiveSqlDocument(useQueryStore.getState()).statements[0];
  await useQueryStore.getState().executeStatement(statement.id);
}

describe('断线之后', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    loadMock.mockReset();
    connectedStore();
  });

  it('驱动说连接没了，store 就记下来', async () => {
    await runFailing({ code: 'CONNECTION_LOST', message: 'DATAOMNI_CONNECTION_LOST: broken pipe' });
    expect(useQueryStore.getState().connectionLost).toBe(true);
  });

  // 反过来：语句自己写错了不是断线。判错这一侧的代价是让人去重连一条好好的
  // 连接，而真正该做的是改那条语句
  it('数据库报的普通错误不算断线', async () => {
    await runFailing({ code: '42601', message: 'syntax error at or near "SELCT"' });
    expect(useQueryStore.getState().connectionLost).toBe(false);
  });

  it('超时也不算断线——连接还在，只是这条查询太久', async () => {
    await runFailing({ code: 'QUERY_TIMEOUT', message: 'DATAOMNI_QUERY_TIMEOUT: 30s' });
    expect(useQueryStore.getState().connectionLost).toBe(false);
  });

  /**
   * 这条是重连按钮到底有没有用。断线之前 `connectToDatabase` 会因为
   * 「连接 ID 相同 + 句柄还在 + 没有连接层的错误」直接返回，于是按钮按下去
   * 界面一动不动，用户只能自己去侧边栏把连接切一遍。
   */
  it('重连会真的重新连一次，而不是当成「已经连着」直接返回', async () => {
    await runFailing({ code: 'CONNECTION_LOST', message: 'DATAOMNI_CONNECTION_LOST: broken pipe' });

    loadMock.mockResolvedValue({ close: vi.fn() });
    invokeMock.mockResolvedValue(undefined);
    await useQueryStore.getState().connectToDatabase('sqlite:memory', 'profile-a', SESSION);

    expect(loadMock).toHaveBeenCalledWith('sqlite:memory');
    expect(useQueryStore.getState().connectionLost).toBe(false);
  });

  it('连着的时候切回同一条连接仍然不重连——那道短路本身是对的', async () => {
    loadMock.mockResolvedValue({ close: vi.fn() });
    await useQueryStore.getState().connectToDatabase('sqlite:memory', 'profile-a', SESSION);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('断开连接会把这个标记清掉', async () => {
    await runFailing({ code: 'CONNECTION_LOST', message: 'DATAOMNI_CONNECTION_LOST: broken pipe' });

    invokeMock.mockResolvedValue(undefined);
    useQueryStore.setState({ database: { close: vi.fn() } as never });
    await useQueryStore.getState().disconnect();

    expect(useQueryStore.getState().connectionLost).toBe(false);
  });

  it('没连过的时候掉网不该让空工作台说「连接已断开」', () => {
    useQueryStore.setState({ database: null, connectionLost: false });
    useQueryStore.getState().reportConnectionLost();
    expect(useQueryStore.getState().connectionLost).toBe(false);
  });

  it('连着的时候掉网就要记下来', () => {
    useQueryStore.getState().reportConnectionLost();
    expect(useQueryStore.getState().connectionLost).toBe(true);
  });
});
