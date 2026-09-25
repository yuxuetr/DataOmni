/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLanguageStore } from '../stores/languageStore';
import { useQueryStore } from '../stores/queryStore';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { RedisConsole } = await import('./RedisConsole');

let container: HTMLDivElement;
let root: Root;

/** React 的受控输入认的是原生 setter，直接改 .value 它看不见 */
function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit(text: string): Promise<HTMLInputElement> {
  act(() => root.render(<RedisConsole database={0} onRan={() => {}} />));
  const input = container.querySelector('input') as HTMLInputElement;
  act(() => typeInto(input, text));
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  return input;
}

beforeEach(() => {
  useLanguageStore.getState().setPreference('en');
  useQueryStore.setState({ connectionString: 'redis://127.0.0.1:6379/0' });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  invoke.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('RedisConsole', () => {
  // 打包版回归时撞上的：被拒的 SELECT 1 留在框里，下一条接在后面成了「SELECT 1BLPOP x 0」
  it('命令报错之后输入框也清空，↑ 能取回来', async () => {
    invoke.mockRejectedValueOnce('DATAOMNI_REDIS_COMMAND_CONNECTION_STATE: SELECT');
    const input = await submit('SELECT 1');
    expect(input.value).toBe('');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(input.value).toBe('SELECT 1');
  });

  it('成功时同样清空', async () => {
    invoke.mockResolvedValueOnce({ kind: 'status', value: 'PONG' });
    const input = await submit('PING');
    expect(input.value).toBe('');
    expect(container.textContent).toContain('PONG');
  });
});
