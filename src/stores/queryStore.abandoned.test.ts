import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 事务里取消一条语句（或它超时），PostgreSQL、MySQL、SQL Server、Oracle 都是结束那条连接，
 * 服务端随之回滚整个事务——前面没提交的那几条也没了；SQLite 打断的是写语句时也一样。状态栏从「事务中」变回「无事务」，
 * 可「已停止」那一行什么也没说，以为只停了这一条的人会接着写、最后提交一个空事务。
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
const { useLanguageStore } = await import('./languageStore');

type Status = 'idle' | 'active' | 'failed';

function sessionIn(status: Status) {
  useQueryStore.setState({
    documents: {},
    activeDocumentId: null,
    executions: [],
    connectionString: 'postgres://u@h/db',
    connectionId: 'profile-a',
    session: {
      id: 'session-a',
      profileId: 'profile-a',
      database: null,
      transaction: { status, startedAt: status === 'idle' ? null : '2026-10-02T00:00:00Z' }
    } as never,
    database: { close: vi.fn() } as never,
    connectionLost: false,
    error: null
  });
}

/** 执行被放弃，之后后端报的事务状态是 `after` */
async function abandon(code: 'QUERY_CANCELLED' | 'QUERY_TIMEOUT', after: Status) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'execute_query') {
      throw { code, message: code };
    }
    if (command === 'get_session_transaction') {
      return { status: after, startedAt: after === 'idle' ? null : '2026-10-02T00:00:00Z' };
    }
    return undefined;
  });
  const store = useQueryStore.getState();
  store.openDocument('tab-a');
  store.setSqlInput('UPDATE t SET v = 1;');
  store.parseStatements();
  const statement = selectActiveSqlDocument(useQueryStore.getState()).statements[0];
  await useQueryStore.getState().executeStatement(statement.id);
  return selectActiveSqlDocument(useQueryStore.getState()).statements[0];
}

describe('事务里放弃一条语句', () => {
  beforeEach(() => {
    useLanguageStore.getState().setPreference('en');
    invokeMock.mockReset();
  });

  it('取消之后事务没了，就在那一行说整个事务回滚了', async () => {
    sessionIn('active');
    const statement = await abandon('QUERY_CANCELLED', 'idle');
    // 「已停止」的标记让位给错误图标，那就由第一行说是自己停的
    expect(statement.error).toContain('Query cancelled');
    expect(statement.error).toContain('whole transaction was rolled back');
  });

  it('超时同样要说，跟在超时那句后面', async () => {
    sessionIn('active');
    const statement = await abandon('QUERY_TIMEOUT', 'idle');
    expect(statement.error).toContain('timed out');
    expect(statement.error).toContain('whole transaction was rolled back');
  });

  // SQLite 打断的是读语句时，事务还在
  it('事务还在就不说', async () => {
    sessionIn('active');
    const statement = await abandon('QUERY_CANCELLED', 'active');
    expect(statement.error ?? '').not.toContain('rolled back');
  });

  it('本来就不在事务里也不说', async () => {
    sessionIn('idle');
    const statement = await abandon('QUERY_CANCELLED', 'idle');
    expect(statement.error ?? '').not.toContain('rolled back');
  });
});
