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
