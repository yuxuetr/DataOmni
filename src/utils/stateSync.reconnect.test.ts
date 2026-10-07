import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseHandle } from './databaseHandle';

/**
 * 断线后的「重新连接」。
 *
 * 走 SSH 隧道的连接，连接串里写的是本地转发端口。跳板机重启过，那条隧道就没了，
 * 旧端口要么没人听、要么还挂着一个开不出通道的监听口——拿旧串去连，驱动读到
 * 「expected to read 4 bytes, got 0 bytes at EOF」，按多少次「重新连接」都一样。
 * 重连之前必须让后端重新算一次连接串：它会把隧道重建起来，换上新端口。
 */
const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}));

const { SessionManager } = await import('./stateSync');
const { useAppStore } = await import('../stores/appStore');
const { useQueryStore } = await import('../stores/queryStore');
const { createDefaultConfig } = await import('../stores/connectionStore');
const { DatabaseType } = await import('../contracts');
const { describeError } = await import('./describeError');

const STALE = 'mysql://root@127.0.0.1:40001/om_tunnel';
const FRESH = 'mysql://root@127.0.0.1:40002/om_tunnel';

describe('重新连接', () => {
  const profile = {
    ...createDefaultConfig(DatabaseType.MySQL),
    id: 'tunnel-1',
    name: 'tunnel-mysql',
    created_at: '2026-10-07T00:00:00Z',
    updated_at: '2026-10-07T00:00:00Z'
  };
  const connectToDatabase = vi.fn(async () => {
    useQueryStore.setState({ database: {} as DatabaseHandle, error: null });
  });

  beforeEach(() => {
    invokeMock.mockReset();
    connectToDatabase.mockClear();
    invokeMock.mockImplementation(async (command: string) =>
      command === 'test_connection' ? FRESH : undefined
    );
    // 连过，然后驱动报了断线：句柄还在，标记是 lost
    useAppStore.setState({
      activeConnection: { config: profile, connectionString: STALE },
      connectionReady: true
    });
    useQueryStore.setState({ database: {} as DatabaseHandle, connectionLost: true, error: null, connectToDatabase });
  });

  it('先向后端要一份新的连接串，拿新的去连', async () => {
    await SessionManager.getInstance().manualReconnect(profile);

    expect(invokeMock).toHaveBeenCalledWith('test_connection', { config: profile });
    expect(connectToDatabase).toHaveBeenCalledWith(FRESH, profile.id, expect.anything());
    expect(useAppStore.getState().activeConnection?.connectionString).toBe(FRESH);
  });

  it('后端算不出连接串（跳板机还没起来）时报错，不拿旧串去连', async () => {
    invokeMock.mockRejectedValue('DATAOMNI_SSH_CONNECT_TIMEOUT: 10');

    await expect(SessionManager.getInstance().manualReconnect(profile)).rejects.toBeDefined();
    expect(connectToDatabase).not.toHaveBeenCalled();
    // 和握手失败落在同一处：「连不上」的横幅读的是它。没有这一句，按下「重新连接」之后
    // 界面上什么都不发生，错误只进了日志
    expect(useQueryStore.getState().error).toBe(describeError('DATAOMNI_SSH_CONNECT_TIMEOUT: 10'));
    expect(useQueryStore.getState().database).toBeNull();
  });
});
