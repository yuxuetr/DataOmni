/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DestructiveStatementPrompt } from './DestructiveStatementPrompt';
import { useLanguageStore } from '../stores/languageStore';

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

describe('DestructiveStatementPrompt', () => {
  it('没有事务的工作区不提「自动提交」：MongoDB 的控制台没有这个开关', () => {
    act(() => {
      root.render(
        <DestructiveStatementPrompt
          sql="{ drop: 'orders' }"
          language="javascript"
          risk="destructive"
          connectionName="mongo"
          environment="development"
          statementCount={1}
          databaseLabel="MongoDB"
          reversibility={{ kind: 'no-transaction' }}
          onConfirm={() => undefined}
          onCancel={() => undefined}
        />
      );
    });
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/autocommit/i);
    expect(text).toContain('There is no transaction here');
  });
});
