/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLanguageStore } from '../stores/languageStore';
import { useConnectionStore } from '../stores/connectionStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

const { ConnectionForm } = await import('./ConnectionForm');

let container: HTMLDivElement;
let root: Root;

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) {
    throw new Error(`no button ${label}`);
  }
  return found;
}

beforeEach(() => {
  useLanguageStore.getState().setPreference('en');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ConnectionForm 校验没过', () => {
  // 表单比窗口高：滚到底部按「测试连接」，而空着的名称在顶部，屏幕上什么也没变
  it('焦点交给第一个出错的输入框', () => {
    const testConnection = vi.spyOn(useConnectionStore.getState(), 'testConnection');
    act(() => root.render(<ConnectionForm mode="create" onClose={() => {}} />));
    act(() => button('Test connection').click());
    const name = container.querySelector<HTMLInputElement>('input[name="connection-name"]');
    expect(name?.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(name);
    expect(testConnection).not.toHaveBeenCalled();
  });
});
