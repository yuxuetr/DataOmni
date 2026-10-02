/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLanguageStore } from '../stores/languageStore';
import { useQueryStore } from '../stores/queryStore';
import { DdlPreviewDialog } from './DdlPreviewDialog';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));

const TWO_STATEMENTS = {
  statements: [
    'ALTER TABLE "t" RENAME COLUMN "a" TO "b"',
    'ALTER TABLE "t" ALTER COLUMN "c" TYPE text'
  ],
  refusals: [],
  impacts: []
};

let container: HTMLDivElement;
let root: Root;

/** 服务端 `version()` 的回答 */
function serverSays(version: string) {
  const select = vi.fn(async () => [{ version }]);
  useQueryStore.setState({ database: { select } as never });
  return select;
}

async function render(plan = TWO_STATEMENTS) {
  await act(async () => {
    root.render(
      <DdlPreviewDialog plan={plan} dialect="postgresql" running={false} error={null} onApply={() => {}} onClose={() => {}} />
    );
  });
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

describe('DdlPreviewDialog', () => {
  // 那边改结构的语句逐条执行（事务里改不了要重写数据的类型）：第一条改名成功、第二条失败时改名还在
  it('CockroachDB 上说明这几条不是一个事务', async () => {
    serverSays('CockroachDB CCL v25.2.4 (aarch64-unknown-linux-gnu)');
    await render();
    expect(container.textContent).toContain('not as one transaction');
  });

  it('PostgreSQL 上整批在一个事务里，不说', async () => {
    const select = serverSays('PostgreSQL 16.4 on x86_64-pc-linux-gnu');
    await render();
    expect(select).toHaveBeenCalled();
    expect(container.textContent).not.toContain('not as one transaction');
  });

  it('只有一条时它本身是原子的，不说', async () => {
    serverSays('CockroachDB CCL v25.2.4');
    await render({ ...TWO_STATEMENTS, statements: TWO_STATEMENTS.statements.slice(0, 1) });
    expect(container.textContent).not.toContain('not as one transaction');
  });
});
