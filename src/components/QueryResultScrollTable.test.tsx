/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryResult } from '../contracts/query';
import { useLanguageStore } from '../stores/languageStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));

const { QueryResultScrollTable } = await import('./QueryResultScrollTable');

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

async function render(result: QueryResult) {
  await act(async () => {
    root.render(
      <QueryResultScrollTable result={result} statementId="s1" formatExecutionTime={(ms) => `${ms}ms`} />
    );
  });
}

const buttonLabels = () => [...container.querySelectorAll('button')].map((button) => button.textContent?.trim());

describe('结果头部', () => {
  // 打包版上看到的：DROP / CREATE / INSERT 的结果上也印着「选中单元格后 ⌘C 复制」，
  // 旁边还有两个灰掉的「图表」「导出」——没有格子可选，也没有东西可画、可导
  it('不返回行的语句只说影响了几行，不出复制提示、图表与导出', async () => {
    await render({ columns: [], rows: [], affected_rows: 120, execution_time: 5 });

    expect(container.textContent).toContain('Rows affected: 120');
    expect(container.textContent).not.toContain('to copy');
    expect(buttonLabels()).not.toContain('Chart');
    expect(buttonLabels()).not.toContain('Export');
  });

  it('返回行的语句照旧', async () => {
    await render({ columns: ['n'], rows: [[1]], affected_rows: 1, execution_time: 5 });

    expect(container.textContent).toContain('to copy');
    expect(buttonLabels()).toEqual(expect.arrayContaining(['Chart', 'Export']));
  });
});
