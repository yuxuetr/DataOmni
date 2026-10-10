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

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function select(id: string): HTMLSelectElement {
  const found = container.querySelector<HTMLSelectElement>(`#${id}`);
  if (!found) {
    throw new Error(`no select ${id}`);
  }
  return found;
}

describe('ConnectionForm 命令行访问', () => {
  it('新连接默认不开放', () => {
    act(() => root.render(<ConnectionForm mode="create" onClose={() => {}} />));
    expect(select('connection-agent-access').value).toBe('off');
  });

  // 生产连接命令行本来就看不见（后端 `open_to_agents`）。界面上还显示「只读」就是在说假话，
  // 改回开发环境时也不该悄悄恢复成开放
  it('选了生产环境就关掉并置灰', () => {
    act(() => root.render(<ConnectionForm mode="create" onClose={() => {}} />));
    choose(select('connection-agent-access'), 'read');
    expect(select('connection-agent-access').value).toBe('read');

    choose(select('connection-environment'), 'production');
    expect(select('connection-agent-access').value).toBe('off');
    expect(select('connection-agent-access').disabled).toBe(true);

    choose(select('connection-environment'), 'development');
    expect(select('connection-agent-access').value).toBe('off');
    expect(select('connection-agent-access').disabled).toBe(false);
  });
});
