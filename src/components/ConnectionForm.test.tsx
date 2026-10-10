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

  // 这一格排在类型上面，照着表单从上往下填，选完它才点类型。点类型会把表单盖回那个
  // 类型的默认值，没保住它就悄悄存成了「关」——界面上明明选过只读
  it('先选只读再点类型，存下来的仍是只读', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const calls = vi.mocked(invoke);
    calls.mockClear();
    act(() => root.render(<ConnectionForm mode="create" onClose={() => {}} />));
    type(container.querySelector<HTMLInputElement>('input[name="connection-name"]'), 'cli-probe');
    choose(select('connection-agent-access'), 'read');
    act(() => button('PostgreSQL').click());
    expect(select('connection-agent-access').value).toBe('read');

    type(container.querySelector<HTMLInputElement>('input[name="username"]'), 'postgres');
    type(container.querySelector<HTMLInputElement>('input[type="password"]'), 'secret');
    await act(async () => button('Save connection').click());
    const created = calls.mock.calls.find(([command]) => command === 'create_connection');
    expect(created?.[1]).toMatchObject({
      config: { db_type: 'postgresql', agent_access: 'read', save_password: true, password: 'secret' }
    });
  });
});

describe('ConnectionForm 命令行访问与保存口令', () => {
  // 命令行是另一个进程，拿不到只在这次会话里输的口令。开了只读又不保存口令，
  // 命令行就只会报 SESSION_PASSWORD_REQUIRED，而表单上什么也没说
  it('开了只读却不保存口令时提醒，文件库不提醒', () => {
    act(() => root.render(<ConnectionForm mode="create" onClose={() => {}} />));
    const warned = () => container.textContent?.includes('the command line cannot connect') ?? false;
    act(() => button('PostgreSQL').click());
    choose(select('connection-agent-access'), 'read');
    expect(warned()).toBe(false);

    const savePassword = container.querySelector<HTMLInputElement>('#save-password');
    act(() => savePassword?.click());
    expect(warned()).toBe(true);

    act(() => button('SQLite').click());
    expect(warned()).toBe(false);
  });
});

function type(input: HTMLInputElement | null, value: string) {
  if (!input) {
    throw new Error('no input');
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
