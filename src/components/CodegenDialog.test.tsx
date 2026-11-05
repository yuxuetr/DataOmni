/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLanguageStore } from '../stores/languageStore';
import { codegenFixture } from '../utils/codegenFixture';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args), Channel: class {} }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

const { CodegenDialog } = await import('./CodegenDialog');

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

async function render(dialect: 'postgresql' | 'oracle' | 'duckdb', load: () => Promise<never> | ReturnType<typeof Promise.resolve>) {
  await act(async () => {
    root.render(<CodegenDialog dialect={dialect} source="shop / main" load={load as never} onClose={() => {}} />);
  });
}

describe('CodegenDialog', () => {
  it('shows the generated schema with the notes on top', async () => {
    await render('postgresql', () => Promise.resolve(codegenFixture('postgresql')));
    const text = container.textContent ?? '';
    expect(text).toContain('model Users {');
    expect(text).toContain('@@map("2fa codes")');
    // 说明译成界面语言，不只是文件开头那几行英文注释
    expect(text).toContain('users.session_length: type interval has no mapping');
    expect(text).toContain('Save…');
  });

  it('says why when reading the tables failed', async () => {
    await render('postgresql', () => Promise.reject(new Error('permission denied for table orders')));
    expect(container.textContent).toContain('permission denied for table orders');
  });

  it('offers no Prisma for Oracle', async () => {
    await render('oracle', () => Promise.resolve(codegenFixture('oracle')));
    expect(container.textContent).not.toContain('Prisma');
  });
});
