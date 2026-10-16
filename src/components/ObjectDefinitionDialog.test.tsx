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
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args), Channel: class {} }));

const { ObjectDefinitionDialog } = await import('./ObjectDefinitionDialog');

const connection: ConnectionProfile = {
  id: 'og',
  name: 'og',
  db_type: DatabaseType.PostgreSQL,
  host: '127.0.0.1',
  port: 5432,
  username: 'gaussdb',
  password: '',
  ssl: false,
  save_password: false,
  options: {},
  tags: [],
  environment: 'development',
  created_at: '',
  updated_at: ''
};

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

describe('ObjectDefinitionDialog（openGauss 的序列）', () => {
  // openGauss 没有 pg_sequences，属性页此前只显示「relation "pg_sequences" does not exist」
  it('没有 pg_sequences 时查序列关系本身，列出属性', async () => {
    const select = vi.fn(async (sql: string) => {
      if (sql === 'BY_OID') {
        throw Object.assign(new Error('relation "pg_sequences" does not exist on gaussdb'), { code: '42P01' });
      }
      if (sql === 'SELECT * FROM "gaussdb"."order_seq" s') return [{ start_value: '5', increment_by: '3' }];
      return [];
    });
    useQueryStore.setState({ connectionId: 'og', database: { select } as never });
    invoke.mockImplementation(async (command: string) => (
      command === 'get_object_catalog_queries'
        ? {
          objects: 'OBJECTS',
          routine_definition: 'ROUTINE',
          sequence_properties: 'BY_OID',
          sequence_properties_by_relation: 'SELECT * FROM {sequence} s',
          object_parameter_count: 0,
          routine_parameter_count: 1
        }
        : null
    ));

    await act(async () => {
      root.render(
        <ObjectDefinitionDialog
          object={{ schema: 'gaussdb', name: 'order_seq', kind: 'sequence', id: '16390' }}
          connection={connection}
          onClose={() => {}}
        />
      );
    });

    const terms = [...container.querySelectorAll('dt')].map((node) => node.textContent);
    const values = [...container.querySelectorAll('dd')].map((node) => node.textContent);
    expect(terms).toEqual(['start_value', 'increment_by']);
    expect(values).toEqual(['5', '3']);
    expect(container.textContent).not.toContain('pg_sequences');
  });
});
