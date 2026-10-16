/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLanguageStore } from '../stores/languageStore';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { QueryPlanDialog } = await import('./QueryPlanDialog');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useLanguageStore.getState().setPreference('en');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  invoke.mockReset();
  invoke.mockImplementation(async () => ({ roots: [], analyzed: false, planningMs: null, executionMs: null, raw: '' }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function analyzeCheckbox(dbType: string): Promise<HTMLInputElement> {
  await act(async () => {
    root.render(
      <QueryPlanDialog sql="SELECT 1" connectionId="c" dbType={dbType} databaseLabel={dbType} onClose={() => {}} />
    );
  });
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!checkbox) throw new Error('没有「真的执行一遍」');
  return checkbox;
}

// 与 Rust 的 `supports_analyze` 是同一个判断：两边分叉时后端报错，不降级成估算
describe('QueryPlanDialog 的「真的执行一遍」', () => {
  it('PostgreSQL 与 SQL Server 可以勾', async () => {
    expect((await analyzeCheckbox('postgresql')).disabled).toBe(false);
    expect((await analyzeCheckbox('sqlserver')).disabled).toBe(false);
  });

  it('MySQL 是灰的', async () => {
    expect((await analyzeCheckbox('mysql')).disabled).toBe(true);
  });
});
