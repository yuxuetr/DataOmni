/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseType, type ConnectionProfile } from '../contracts';
import { createDefaultConfig } from '../stores/connectionStore';
import { useLanguageStore } from '../stores/languageStore';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const { WelcomeScreen } = await import('./WelcomeScreen');

let container: HTMLDivElement;
let root: Root;

const profile: ConnectionProfile = {
  ...createDefaultConfig(DatabaseType.PostgreSQL),
  id: 'p1',
  name: 'shop',
  created_at: '',
  updated_at: '',
};

beforeEach(() => {
  useLanguageStore.getState().setPreference('en');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => (command === 'get_connections' ? [profile] : null));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('WelcomeScreen', () => {
  it('每个连接都能从这里打开编辑，而且编辑不会顺带去连它', async () => {
    const onEdit = vi.fn();
    await act(async () => {
      root.render(<WelcomeScreen onConnect={() => undefined} onEdit={onEdit} />);
    });
    const edit = container.querySelector<HTMLButtonElement>('button[aria-label="Edit connection: shop"]');
    expect(edit).not.toBeNull();
    await act(async () => {
      edit?.click();
    });
    expect(onEdit).toHaveBeenCalledWith(profile);
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(['get_connections']);
  });
});
