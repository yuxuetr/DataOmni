/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseType, type ConnectionProfile } from '../contracts/connection';
import { useLanguageStore } from '../stores/languageStore';
import { useQueryStore } from '../stores/queryStore';
import { useHistoryStore } from '../stores/historyStore';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { EsConsole } = await import('./EsConsole');

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

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`没有「${label}」按钮`);
  return found;
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
  });
}

beforeEach(() => {
  useLanguageStore.getState().setPreference('en');
  useQueryStore.setState({ connectionString: 'https://127.0.0.1:9200' });
  useQueryStore.getState().openDocument('es-test');
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

describe('EsConsole', () => {
  // 打包版回归时撞上的：一批里有一条字段类型不对，徽标是绿的 200，后面那条 _update_by_query 照发
  it('一批里有条目没写成：算失败，后面的不发，并且说清几条没成', async () => {
    useQueryStore.getState().setSqlInput([
      'POST _bulk',
      '{"index":{"_index":"rg","_id":"b2"}}',
      '{"score":1}',
      '{"index":{"_index":"rg","_id":"b3"}}',
      '{"score":"not a number"}',
      '',
      'GET rg/_count'
    ].join('\n'));
    const sent: string[] = [];
    invoke.mockImplementation(async (_command: string, args: { path: string }) => {
      sent.push(args.path);
      return {
        status: 200,
        elapsedMs: 1,
        body: JSON.stringify({
          errors: true,
          items: [
            { index: { _id: 'b2', status: 201 } },
            { index: { _id: 'b3', status: 400, error: { type: 'document_parsing_exception' } } }
          ]
        })
      };
    });
    await act(async () => {
      root.render(<EsConsole connection={connection} />);
    });
    await click(button('Send all'));
    await click(button('Run anyway'));

    expect(sent).toEqual(['/_bulk']);
    expect(container.textContent).toContain('1 of 2 items failed');
    expect(container.textContent).toContain('Not sent: an earlier request failed');
    expect(useHistoryStore.getState().entries[0]?.status).toBe('failed');
  });

  it('只命中一份时写「1 hit」', async () => {
    useQueryStore.getState().setSqlInput('GET rg/_search');
    invoke.mockResolvedValue({
      status: 200,
      elapsedMs: 1,
      body: JSON.stringify({ took: 2, hits: { total: { value: 1, relation: 'eq' }, hits: [{ _index: 'rg', _id: 'a', _source: { n: 1 } }] } })
    });
    await act(async () => {
      root.render(<EsConsole connection={connection} />);
    });
    await click(button('Send all'));

    expect(container.textContent).toContain('1 hit ·');
  });
});
