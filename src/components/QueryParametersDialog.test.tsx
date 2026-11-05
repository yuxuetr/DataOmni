/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLanguageStore } from '../stores/languageStore';
import type { SqlDialect } from '../contracts/queryExecution';
import type { ParameterInput } from '../utils/queryParameters';
import { QueryParametersDialog } from './QueryParametersDialog';

let container: HTMLDivElement;
let root: Root;

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

function render(dialect: SqlDialect, initial: Record<string, ParameterInput> = {}) {
  const onSubmit = vi.fn();
  act(() => {
    root.render(<QueryParametersDialog names={['code', 'n']} initial={initial} dialect={dialect} onSubmit={onSubmit} onClose={() => {}} />);
  });
  return onSubmit;
}

/** React 受控输入框要走原生的 setter 才会触发 onChange */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const runButton = () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Run') as HTMLButtonElement;
const textInputs = () => [...container.querySelectorAll<HTMLInputElement>('input:not([type=checkbox])')];

describe('QueryParametersDialog', () => {
  it('prefills what the tab remembered and hands back every parameter', () => {
    const onSubmit = render('mysql', { code: { value: '007', kind: 'text', isNull: false } });
    expect(textInputs()[0].value).toBe('007');
    type(textInputs()[1], '10');
    act(() => runButton().click());
    expect(onSubmit).toHaveBeenCalledWith({
      code: { value: '007', kind: 'text', isNull: false },
      n: { value: '10', kind: 'text', isNull: false }
    });
  });

  it('will not run a Number that is not a number', () => {
    const onSubmit = render('sqlserver', { n: { value: 'ten', kind: 'number', isNull: false } });
    expect(container.textContent).toContain(':n is set to Number, but the value is not a number.');
    expect(runButton().disabled).toBe(true);
    act(() => runButton().click());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('asks for no type on PostgreSQL: the driver decides', () => {
    render('postgresql');
    expect(container.querySelectorAll('select')).toHaveLength(0);
    expect(container.textContent).toContain('PostgreSQL converts each value');
    render('mysql');
    expect(container.querySelectorAll('select')).toHaveLength(2);
  });
});
