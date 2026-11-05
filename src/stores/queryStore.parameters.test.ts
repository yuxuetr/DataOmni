import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 编辑器参数（rfcs/bind-parameters.md）：发给后端的是换好占位符的 SQL 与值，
 * 记录与历史留的还是带 `:name` 的原文；后端按位置报的错换成参数名。
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

function connectTo(connectionString: string) {
  useQueryStore.setState({
    documents: {},
    activeDocumentId: null,
    executions: [],
    connectionString,
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
}

async function run(sql: string) {
  const store = useQueryStore.getState();
  store.openDocument('tab-a');
  store.setSqlInput(sql);
  store.parseStatements();
  const statement = selectActiveSqlDocument(useQueryStore.getState()).statements[0];
  await useQueryStore.getState().executeStatement(statement.id);
  return selectActiveSqlDocument(useQueryStore.getState()).statements[0];
}

const lastExecution = () => {
  const { executions } = useQueryStore.getState();
  return executions[executions.length - 1];
};

const sentRequest = () => {
  const call = invokeMock.mock.calls.find(([command]) => command === 'execute_query');
  return (call?.[1] as { request: { sql: string; params?: unknown[] } }).request;
};

describe('编辑器参数', () => {
  beforeEach(() => {
    useLanguageStore.getState().setPreference('en');
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) =>
      command === 'execute_query' ? { kind: 'affected', rows_affected: 1 } : undefined
    );
  });

  it('sends placeholders and values, and keeps the :name text everywhere else', async () => {
    connectTo('mysql://u@h/db');
    useQueryStore.getState().openDocument('tab-a');
    useQueryStore.getState().setParameters({
      code: { value: '007', kind: 'text', isNull: false },
      n: { value: '10', kind: 'number', isNull: false }
    });
    await run('UPDATE t SET v = 1 WHERE code = :code LIMIT :n;');
    expect(sentRequest()).toMatchObject({ sql: 'UPDATE t SET v = 1 WHERE code = ? LIMIT ?;', params: ['007', 10] });
    expect(lastExecution().sqlSnapshot).toContain(':code');
  });

  it('sends a statement without parameters exactly as before', async () => {
    connectTo('mysql://u@h/db');
    await run("UPDATE t SET v = ':not_a_parameter';");
    expect(sentRequest()).toMatchObject({ sql: "UPDATE t SET v = ':not_a_parameter';", params: [] });
  });

  it('names the parameter the backend could only number, and does not point into the rewritten text', async () => {
    connectTo('postgres://u@h/db');
    useQueryStore.getState().openDocument('tab-a');
    useQueryStore.getState().setParameters({
      since: { value: '2026-01-01', kind: 'text', isNull: false },
      id: { value: 'abc', kind: 'text', isNull: false }
    });
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_query') {
        throw { message: 'DATAOMNI_PARAMETER_NOT_CONVERTIBLE: 2 · INT4 · abc', position: 40 };
      }
      return undefined;
    });
    const statement = await run('SELECT * FROM t WHERE at >= :since AND id = :id;');
    expect(statement.error).toContain(':id · INT4 · abc');
    expect(lastExecution().error?.message).toContain(':id');
    expect(lastExecution().error?.position).toBeUndefined();
  });

  it('keeps the values per tab', () => {
    connectTo('mysql://u@h/db');
    const store = useQueryStore.getState();
    store.openDocument('tab-a');
    store.setParameters({ id: { value: '1', kind: 'text', isNull: false } });
    store.openDocument('tab-b');
    expect(selectActiveSqlDocument(useQueryStore.getState()).parameters).toEqual({});
    useQueryStore.getState().setActiveDocument('tab-a');
    expect(selectActiveSqlDocument(useQueryStore.getState()).parameters.id.value).toBe('1');
  });
});
