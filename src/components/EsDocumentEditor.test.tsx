/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseType, type ConnectionProfile } from '../contracts/connection';
import { useLanguageStore } from '../stores/languageStore';
import { useQueryStore } from '../stores/queryStore';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { EsDocumentEditor } = await import('./EsDocumentEditor');

let container: HTMLDivElement;
let root: Root;

const connection: ConnectionProfile = {
  id: 'es',
  name: 'es',
  db_type: DatabaseType.Elasticsearch,
  host: '127.0.0.1',
  port: 9200,
  username: 'elastic',
  password: '',
  ssl: false,
  save_password: false,
  options: {},
  tags: [],
  environment: 'development',
  created_at: '',
  updated_at: ''
};

const found = JSON.stringify({ _index: 'rg', _id: 'd1', _seq_no: 1, _primary_term: 1, found: true, _source: { n: 1 } });
// 带着 if_seq_no 去写一份已经没了的文档，ES 回的是 409 而不是 404
const noDocument = JSON.stringify({
  error: { type: 'version_conflict_engine_exception', reason: '[d1]: version conflict, required seqNo [1], primary term [1]. but no document was found' },
  status: 409
});

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`没有「${label}」按钮`);
  return match;
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
  });
}

beforeEach(() => {
  useLanguageStore.getState().setPreference('en');
  useQueryStore.setState({ connectionString: 'https://127.0.0.1:9200' });
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

describe('EsDocumentEditor', () => {
  // 打包版回归时撞上的：别处删了这份文档，这边点删除，提示却是「别处改过，关掉重新点开拿最新的」
  it('写的时候文档已经被别处删了：说它没了，而不是说它被改了', async () => {
    let deleted = false;
    invoke.mockImplementation(async (_command: string, args: { method: string }) => {
      if (args.method === 'GET') return deleted ? { status: 404, body: JSON.stringify({ found: false }) } : { status: 200, body: found };
      return { status: 409, body: noDocument };
    });
    const onWritten = vi.fn();
    await act(async () => {
      root.render(
        <EsDocumentEditor connection={connection} address={{ index: 'rg', id: 'd1', routing: null }} onWritten={onWritten} onClose={() => {}} />
      );
    });
    deleted = true;
    await click(button('Delete'));
    await click(button('Run anyway'));

    expect(container.textContent).toContain('it may have been deleted');
    expect(container.textContent).not.toContain('changed elsewhere');
    expect(onWritten).toHaveBeenCalled();
  });

  it('文档还在、只是版本变了：照旧说被改了', async () => {
    invoke.mockImplementation(async (_command: string, args: { method: string }) => (
      args.method === 'GET' ? { status: 200, body: found } : { status: 409, body: noDocument }
    ));
    await act(async () => {
      root.render(
        <EsDocumentEditor connection={connection} address={{ index: 'rg', id: 'd1', routing: null }} onWritten={() => {}} onClose={() => {}} />
      );
    });
    await click(button('Delete'));
    await click(button('Run anyway'));

    expect(container.textContent).toContain('changed elsewhere');
  });
});
