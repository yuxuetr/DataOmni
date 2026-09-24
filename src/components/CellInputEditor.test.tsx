/**
 * @vitest-environment happy-dom
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
