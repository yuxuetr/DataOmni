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

function labelled(label: string): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)];
}

/** 列表 a、b、c 打开之后，服务端那边在表头插了一个 z */
function listShiftedElsewhere(onChange: () => never) {
  let items = ['a', 'b', 'c'];
  invoke.mockImplementation(async (command: string) => {
    if (command === 'redis_scan') return { keys: [{ key: text('l'), kind: 'list', ttlMs: -1 }], cursor: null };
    if (command === 'redis_read_value') {
      return { kind: 'list', length: items.length, offset: 0, items: items.map(text), next: null };
    }
    if (command === 'redis_change_element') {
      items = ['z', 'a', 'b', 'c'];
      onChange();
    }
    throw new Error(`没料到的命令 ${command}`);
  });
}

const cellTexts = () => [...container.querySelectorAll('td')].map((cell) => cell.textContent?.trim()).filter(Boolean);

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

  it('按下标删列表元素撞上别处的改动：什么也没删，并且立刻显示现在的内容', async () => {
    // 删除没有草稿可留，「草稿还在，取消后看得到」对它是句空话——表里照旧印着打开时那份
    listShiftedElsewhere(() => {
      throw 'DATAOMNI_REDIS_VALUE_CHANGED';
    });
    await act(async () => {
      root.render(<RedisKeyBrowser database={0} />);
    });
    await click(button('listl'));
    await click(labelled('Delete')[0]);
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button, [role="alertdialog"] button')]
      .find((candidate) => candidate.textContent?.trim() === 'Delete');
    if (!confirm) throw new Error('没有确认框');
    await click(confirm);

    expect(container.textContent).toContain('nothing was deleted');
    expect(container.textContent).not.toContain('Your draft is kept');
    expect(cellTexts()).toContain('z');
  });

  it('改元素撞上别处的改动后，取消会显示现在的内容', async () => {
    listShiftedElsewhere(() => {
      throw 'DATAOMNI_REDIS_VALUE_CHANGED';
    });
    await act(async () => {
      root.render(<RedisKeyBrowser database={0} />);
    });
    await click(button('listl'));
    await click(labelled('Edit')[0]);
    await click(labelled('Save')[0]);
    expect(container.textContent).toContain('Your draft is kept');

    await click(labelled('Cancel')[0]);
    expect(cellTexts()).toContain('z');
  });
});
