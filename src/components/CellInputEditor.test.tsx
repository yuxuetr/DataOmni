/**
 * @vitest-environment happy-dom
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CellInputEditor } from './CellInputEditor';
import { useLanguageStore } from '../stores/languageStore';
import type { CellInput } from '../utils/cellInput';

let container: HTMLDivElement;
let root: Root;

/** 受控的编辑器，和网格里的用法一样：值由外面持有 */
function Harness({ initial }: { initial: CellInput }) {
  const [value, setValue] = useState<CellInput>(initial);
  return <CellInputEditor value={value} onChange={setValue} dataType="text" />;
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label || candidate.getAttribute('aria-label') === label
  );
  if (!found) {
    throw new Error(`no button ${label}`);
  }
  return found;
}

/** React 的受控输入认的是原生 setter，直接改 .value 它看不见 */
function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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

describe('CellInputEditor', () => {
  it('从菜单换成「值」之后光标在编辑框里', () => {
    act(() => root.render(<Harness initial={{ kind: 'null' }} />));
    act(() => button('Choose what to write').click());
    act(() => button('Value').click());
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  // 反向：unset 的框里敲第一个字就变成 value，那一下不能重挂把焦点弄丢
  it('在「不改」的框里打字，焦点留在原地', () => {
    act(() => root.render(<Harness initial={{ kind: 'unset' }} />));
    const input = container.querySelector('input') as HTMLInputElement;
    act(() => input.focus());
    act(() => typeInto(input, 'a'));
    expect(container.querySelector('input')).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  // macOS 的 WKWebView 里，确认输入法候选的那一下 Enter 到的时候合成已经结束，
  // 只剩 keyCode 229 能认出来。那一下提交的话，选字就把单元格改掉了
  it('输入法确认候选的 Enter 不提交，平常的 Enter 提交', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    act(() =>
      root.render(
        <CellInputEditor
          value={{ kind: 'value', value: '北京' }}
          onChange={() => {}}
          onCommit={onCommit}
          onCancel={onCancel}
          dataType="text"
        />
      )
    );
    const input = container.querySelector('input');
    if (!input) {
      throw new Error('no input');
    }
    const press = (key: string, keyCode: number) =>
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode, bubbles: true }));
      });

    press('Enter', 229);
    press('Escape', 229);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    press('Enter', 13);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  // 打包版上撞到的：单行文本框按规范把值里的换行剥掉，多行文本末尾补一个字，
  // 存进去的就少了换行，而语句不报错
  it('多行文本改一个字，换行还在', () => {
    const onChange = vi.fn();
    act(() => root.render(
      <CellInputEditor value={{ kind: 'value', value: '第一行\n第二行' }} onChange={onChange} dataType="VARCHAR" />
    ));
    const field = container.querySelector('textarea');
    if (!field) throw new Error('多行文本没有用 textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(field, `${field.value}!`);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'value', value: '第一行\n第二行!' });
  });

  it('删掉最后一个换行之后仍是同一个框，焦点不丢', () => {
    act(() => root.render(<Harness initial={{ kind: 'value', value: 'a\nb' }} />));
    const field = container.querySelector('textarea');
    if (!field) throw new Error('多行文本没有用 textarea');
    field.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(field, 'ab');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('textarea')).toBe(field);
    expect(document.activeElement).toBe(field);
  });
});
