/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '../contracts';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args), Channel: class {} }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

const switchConnection = vi.fn(async () => undefined);
vi.mock('../utils/stateSync', () => ({ useSessionManager: () => ({ switchConnection }) }));

const { useProfileConnector } = await import('./useProfileConnector');
const { useAppStore } = await import('../stores/appStore');
const { useConnectionStore } = await import('../stores/connectionStore');
const { describeError } = await import('../utils/describeError');

const profile = { id: 'p1', name: 'mss', db_type: 'sqlserver', save_password: false } as unknown as ConnectionProfile;

let connector: ReturnType<typeof useProfileConnector>;
function Probe() {
  connector = useProfileConnector();
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  invoke.mockReset();
  switchConnection.mockClear();
  useAppStore.setState({ connectionForm: null, activeConnection: null, connectionReady: false });
  useConnectionStore.setState({ connections: [profile] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * 回归时看到的：点一个没存口令的连接，弹出表单、上面写「没有保存的口令，请输入本次会话的口令」；
 * 填好、点保存，表单关了、却没连上，那句提示还挂着——要再点一次连接才连上
 */
describe('没存口令的连接', () => {
  it('在弹出的表单里填好口令保存，就接着连上，提示收起', async () => {
    invoke.mockRejectedValueOnce('SESSION_PASSWORD_REQUIRED');
    await act(async () => {
      expect(await connector.connect(profile)).toBe('password-required');
    });
    expect(connector.error).not.toBeNull();
    const form = useAppStore.getState().connectionForm;
    expect(form?.mode).toBe('edit');

    invoke.mockResolvedValueOnce('mssql://…');
    await act(async () => {
      if (form?.mode === 'edit') {
        await form.onSaved?.();
      }
    });
    expect(switchConnection).toHaveBeenCalledTimes(1);
    expect(connector.error).toBeNull();
  });
});

/**
 * R7-mac 看到的：钥匙串里这一条没了（换了签名的包、或在钥匙串访问里删过），提示写着「请重新输入」，
 * 却没有地方输入——得自己去找这条连接、点编辑。和没存口令走同一条路：直接打开表单
 */
describe('钥匙串里没有这条口令', () => {
  it('打开编辑表单，提示照旧说明原因', async () => {
    invoke.mockRejectedValueOnce('DATAOMNI_CREDENTIAL_MISSING');
    await act(async () => {
      expect(await connector.connect(profile)).toBe('password-required');
    });
    expect(connector.error).toBe(describeError('DATAOMNI_CREDENTIAL_MISSING'));
    expect(useAppStore.getState().connectionForm?.mode).toBe('edit');
  });
});

/**
 * R7-mac 看到的：⌘K 连失败留下的那条红字，换从侧边栏连上之后还一直挂在标签栏下面——
 * 两处各有一份 connector，连上的那一份清了自己的，另一份不知道
 */
describe('别处连上之后', () => {
  it('上一次连失败的提示收起', async () => {
    invoke.mockRejectedValueOnce('connection refused');
    await act(async () => {
      expect(await connector.connect(profile)).toBe('failed');
    });
    expect(connector.error).not.toBeNull();

    await act(async () => {
      useAppStore.setState({
        activeConnection: { config: profile, connectionString: 'mssql://…' },
        connectionReady: true
      });
    });
    expect(connector.error).toBeNull();
  });
});
