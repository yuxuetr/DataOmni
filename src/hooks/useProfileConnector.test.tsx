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
  useAppStore.setState({ connectionForm: null });
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
