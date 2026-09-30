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

const { RedisKeyBrowser } = await import('./RedisKeyBrowser');

let container: HTMLDivElement;
let root: Root;

const text = (value: string) => ({ raw: btoa(value), text: value, binary: false });
const stringValue = (value: string) => ({ kind: 'string', size: value.length, value: text(value), truncated: false });

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`没有「${label}」按钮`);
  return found;
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
  });
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

describe('RedisKeyBrowser', () => {
  // 打包版回归时撞上的：提示说「取消就能看到当前值」，取消后印的仍是打开时那份，
  // 再改一次拿去比对的也还是它——这个键从此存不进去，除非换个键再点回来
  it('保存撞上别处的改动后，取消显示服务端当前的值', async () => {
    let serverValue = 'opened';
    invoke.mockImplementation(async (command: string) => {
      if (command === 'redis_scan') return { keys: [{ key: text('k'), kind: 'string', ttlMs: -1 }], cursor: null };
      if (command === 'redis_read_value') return stringValue(serverValue);
      if (command === 'redis_change_key') throw 'DATAOMNI_REDIS_VALUE_CHANGED';
      throw new Error(`没料到的命令 ${command}`);
    });
    await act(async () => {
      root.render(<RedisKeyBrowser database={0} />);
    });
    await click(button('stringk'));
    await click(button('Edit'));
    serverValue = 'changed elsewhere';
    await click(button('Save'));
    expect(container.textContent).toContain('changed elsewhere after you opened it');

    await click(button('Cancel'));
    expect(container.textContent).toContain('changed elsewhere');
    expect(container.textContent).not.toContain('opened');
  });
});
