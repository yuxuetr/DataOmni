import { beforeEach, describe, expect, it, vi } from 'vitest';
import { translateNow } from './languageStore';

/**
 * executeStatement 走 Tauri 的 invoke + Channel，这里把它们换成可控的替身，
 * 以便在一次执行「进行中」的时刻切换活动文档。
 */
const invokeMock = vi.fn();

class FakeChannel<T> {
  onmessage: ((message: T) => void) | null = null;
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: FakeChannel
}));

const { selectActiveSqlDocument, selectSqlDocumentHasUnsavedContent, useQueryStore } =
  await import('./queryStore');

function resetStore() {
  useQueryStore.setState({
    documents: {},
    activeDocumentId: null,
    executions: [],
    connectionString: 'sqlite:memory',
    connectionId: 'profile-a',
    session: { id: 'session-a', profileId: 'profile-a', database: null } as never,
    database: {} as never,
    error: null
  });
}

describe('SQL 文档分片', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetStore();
  });

  it('每个标签的草稿彼此独立', () => {
    const store = useQueryStore.getState();

    store.openDocument('tab-a');
    store.setSqlInput('SELECT 1;');
    store.openDocument('tab-b');
    store.setSqlInput('SELECT 2;');

    const { documents } = useQueryStore.getState();
    expect(documents['tab-a'].sqlInput).toBe('SELECT 1;');
    expect(documents['tab-b'].sqlInput).toBe('SELECT 2;');
  });

  it('解析语句只影响当前文档', () => {
    const store = useQueryStore.getState();

    store.openDocument('tab-a');
    store.setSqlInput('SELECT 1; SELECT 2;');
    store.parseStatements();
    const parsedInA = useQueryStore.getState().documents['tab-a'].statements.length;

    store.openDocument('tab-b');
    store.setSqlInput('SELECT 3;');
    store.parseStatements();

    const { documents } = useQueryStore.getState();
    expect(parsedInA).toBe(2);
    expect(documents['tab-a'].statements).toHaveLength(2);
    expect(documents['tab-b'].statements).toHaveLength(1);
  });

  it('openDocument 对已存在的文档只切换，不清空内容', () => {
    const store = useQueryStore.getState();

    store.openDocument('tab-a');
    store.setSqlInput('SELECT 1;');
    store.openDocument('tab-b');
    store.openDocument('tab-a');

    expect(useQueryStore.getState().activeDocumentId).toBe('tab-a');
    expect(selectActiveSqlDocument(useQueryStore.getState()).sqlInput).toBe('SELECT 1;');
  });

  it('closeDocument 丢弃文档及其执行记录并改选其它文档', () => {
    const store = useQueryStore.getState();

    store.openDocument('tab-a');
    store.openDocument('tab-b');
    useQueryStore.setState((state) => ({
      executions: [
        { id: 'exec-a', tabId: 'tab-a' } as never,
        { id: 'exec-b', tabId: 'tab-b' } as never,
        ...state.executions
      ]
    }));

    useQueryStore.getState().closeDocument('tab-b');

    const state = useQueryStore.getState();
    expect(Object.keys(state.documents)).toEqual(['tab-a']);
    expect(state.activeDocumentId).toBe('tab-a');
    expect(state.executions.map((execution) => execution.id)).toEqual(['exec-a']);
  });

  it('关闭未选中的文档不改变当前选择', () => {
    const store = useQueryStore.getState();

    store.openDocument('tab-a');
    store.openDocument('tab-b');
    useQueryStore.getState().closeDocument('tab-a');

    expect(useQueryStore.getState().activeDocumentId).toBe('tab-b');
  });

  it('执行期间切换标签时，结果仍回到发起执行的文档', async () => {
    const store = useQueryStore.getState();

    store.openDocument('tab-a');
    store.setSqlInput('SELECT 1;');
    store.parseStatements();
    const statementId = useQueryStore.getState().documents['tab-a'].statements[0].id;

    // 让 execute_query 挂起，在「执行中」切到另一个标签
    let releaseQuery: () => void = () => {};
    const queryInFlight = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });

    invokeMock.mockImplementation(async (command: string) => {
      if (command !== 'execute_query') {
        return undefined;
      }

      await queryInFlight;
      return {
        kind: 'affected',
        rows_affected: 7
      };
    });

    const execution = useQueryStore.getState().executeStatement(statementId);

    // 查询还在飞行途中，用户切到另一个 SQL 标签
    useQueryStore.getState().openDocument('tab-b');
    expect(useQueryStore.getState().activeDocumentId).toBe('tab-b');

    releaseQuery();
    await expect(execution).resolves.toBe(true);

    const { documents } = useQueryStore.getState();
    // 结果落在 tab-a，而不是执行结束时可见的 tab-b
    expect(documents['tab-a'].statements[0].result?.affected_rows).toBe(7);
    expect(documents['tab-b'].statements).toHaveLength(0);
  });

  it('执行记录归属于发起它的文档', async () => {
    const store = useQueryStore.getState();

    store.openDocument('tab-a');
    store.setSqlInput('SELECT 1;');
    store.parseStatements();
    const statementId = useQueryStore.getState().documents['tab-a'].statements[0].id;

    invokeMock.mockResolvedValue({ kind: 'affected', rows_affected: 1 });
    await useQueryStore.getState().executeStatement(statementId);

    const { executions } = useQueryStore.getState();
    expect(executions).toHaveLength(1);
    expect(executions[0].tabId).toBe('tab-a');
  });

  it('有草稿文本的标签算作未保存', () => {
    const store = useQueryStore.getState();

    store.openDocument('tab-a');
    store.setSqlInput('SELECT 1;');

    expect(selectSqlDocumentHasUnsavedContent(useQueryStore.getState(), 'tab-a')).toBe(true);
  });

  it('空白草稿不算未保存，避免关闭刚建的空标签也被拦', () => {
    const store = useQueryStore.getState();

    store.openDocument('tab-a');
    expect(selectSqlDocumentHasUnsavedContent(useQueryStore.getState(), 'tab-a')).toBe(false);

    store.setSqlInput('   \n  ');
    expect(selectSqlDocumentHasUnsavedContent(useQueryStore.getState(), 'tab-a')).toBe(false);
  });

  it('不存在的文档不算未保存', () => {
    expect(selectSqlDocumentHasUnsavedContent(useQueryStore.getState(), 'missing')).toBe(false);
  });

  it('没有活动文档时不执行也不崩溃', async () => {
    useQueryStore.setState({ activeDocumentId: null });

    await expect(useQueryStore.getState().executeSql('SELECT 1;')).resolves.toBe(false);
    // 文案走 i18n，测试不该跟某一种语言绑死；断言的是「报了这条错」
    expect(useQueryStore.getState().error).toBe(translateNow('error.noActiveSqlTab'));
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
