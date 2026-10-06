import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 给一条**正连着**的连接按「测试连接」，测完把它自己的池子关了。
 *
 * 测试和真正连上走的是同一个连接串：后端按这个串登记池子，测试最后的 close
 * 关的就是正在用的那一个。之后对象树报「没有数据库会话」，页头还写着已连接。
 */
const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: vi.fn() }
}));

const { useConnectionStore } = await import('./connectionStore');
const { useQueryStore } = await import('./queryStore');
const { useAppStore } = await import('./appStore');

const LIVE = 'mysql://root@127.0.0.1:3306/app';
const CONFIG = { db_type: 'mysql', port: 3306 } as never;

function closes(): unknown[] {
  return invokeMock.mock.calls.filter(([command]) => command === 'close_sqlx_pool');
}

describe('测试连接', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) =>
      command === 'test_connection' ? LIVE : undefined
    );
    useQueryStore.setState({ connectionString: null, database: null });
  });

  it('测的是正连着的那一条：不关它的池子', async () => {
    useQueryStore.setState({ connectionString: LIVE, database: { close: vi.fn() } as never });
    await useConnectionStore.getState().testConnection(CONFIG);
    expect(useConnectionStore.getState().testResult?.ok).toBe(true);
    expect(closes()).toEqual([]);
  });

  // 反向：没连着（或连着别的）时，测试开的池子要关掉，不留在后端
  it('测的不是正连着的：测完就关', async () => {
    useQueryStore.setState({ connectionString: 'mysql://root@other:3306/x', database: { close: vi.fn() } as never });
    await useConnectionStore.getState().testConnection(CONFIG);
    expect(closes()).toEqual([['close_sqlx_pool', { connectionString: LIVE }]]);
  });
});

/**
 * 连接列表读不出来（配置文件坏了、从更新的版本退回来遇到不认识的类型）时，
 * 欢迎页原先是空的、一句话也没有——像是连接全丢了。原因要单独留着给欢迎页画，
 * 不能和表单的测试 / 保存共用 `error`：那个会在关掉表单后留下上一次测试的报错。
 */
describe('读连接列表', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useConnectionStore.setState({ connections: [], error: null, loadError: null });
  });

  it('读失败时留下原因，读成功就清掉', async () => {
    invokeMock.mockRejectedValueOnce('DATAOMNI_SERVICE_INIT_FAILED: unknown variant `cockroachdb`');
    await useConnectionStore.getState().loadConnections();
    expect(useConnectionStore.getState().loadError).toContain('unknown variant `cockroachdb`');

    invokeMock.mockResolvedValueOnce([]);
    await useConnectionStore.getState().loadConnections();
    expect(useConnectionStore.getState().loadError).toBeNull();
  });

  it('测试连接失败不算读列表失败', async () => {
    invokeMock.mockRejectedValue('connection refused');
    await useConnectionStore.getState().testConnection(CONFIG).catch(() => undefined);
    expect(useConnectionStore.getState().loadError).toBeNull();
  });
});

/**
 * 正连着的那一条在表单里改成生产环境：徽标立刻变了，工作台拿的却还是连上时那份配置，
 * 写语句照开发环境的门槛不问就跑（0.4.177 上 `UPDATE … WHERE` 直接执行）。
 */
describe('改正连着的连接', () => {
  const LIVE_PROFILE = {
    id: 'p1', name: 'shop', db_type: 'postgresql', host: 'db1', port: 5432,
    environment: 'development'
  } as never;

  beforeEach(() => {
    invokeMock.mockReset();
    useAppStore.setState({ activeConnection: { config: LIVE_PROFILE, connectionString: LIVE } });
  });

  it('名字与环境当场生效；连接参数等重连再换', async () => {
    const saved = { ...(LIVE_PROFILE as object), name: 'shop-prod', environment: 'production', host: 'db2' };
    invokeMock.mockImplementation(async (command: string) => (command === 'get_connections' ? [saved] : undefined));
    await useConnectionStore.getState().updateConnection('p1', saved as never);
    const active = useAppStore.getState().activeConnection;
    expect(active?.config.environment).toBe('production');
    expect(active?.config.name).toBe('shop-prod');
    // 池子还是连着 db1 的那一个，页头不能说成 db2
    expect(active?.config.host).toBe('db1');
    expect(active?.connectionString).toBe(LIVE);
  });

  it('改的是别的连接：正连着的不动', async () => {
    const other = { id: 'p2', name: 'other', environment: 'production' };
    invokeMock.mockImplementation(async (command: string) => (command === 'get_connections' ? [other] : undefined));
    await useConnectionStore.getState().updateConnection('p2', other as never);
    expect(useAppStore.getState().activeConnection?.config.environment).toBe('development');
  });
});
