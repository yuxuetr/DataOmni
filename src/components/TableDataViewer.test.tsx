/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseType, type ConnectionProfile } from '../contracts/connection';
import { useLanguageStore } from '../stores/languageStore';
import { useQueryStore } from '../stores/queryStore';
import { useTableEditStore } from '../stores/tableEditStore';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args), Channel: class {} }));

const readQuery = vi.fn();
vi.mock('../stores/queryStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stores/queryStore')>()),
  runReadQuery: (sql: string) => readQuery(sql)
}));

const { default: TableDataViewer } = await import('./TableDataViewer');

const connection: ConnectionProfile = {
  id: 'ch',
  name: 'ch',
  db_type: DatabaseType.ClickHouse,
  host: '127.0.0.1',
  port: 8123,
  username: 'default',
  password: '',
  ssl: false,
  save_password: false,
  options: {},
  tags: [],
  environment: 'development',
  created_at: '',
  updated_at: ''
};

const COLUMNS = [
  { column_name: 'id', data_type: 'UInt32', is_nullable: false, is_primary_key: true, primary_key_ordinal: 1 },
  { column_name: 'fs', data_type: 'FixedString(4)', is_nullable: false, is_primary_key: false },
  { column_name: 'note', data_type: 'String', is_nullable: false, is_primary_key: false }
];

let container: HTMLDivElement;
let root: Root;

function byTitle(title: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  if (!found) throw new Error(`没有「${title}」按钮`);
  return found;
}

beforeEach(() => {
  useLanguageStore.getState().setPreference('en');
  useTableEditStore.setState({ changes: {} });
  const select = vi.fn(async (sql: string) => (sql === 'COLUMNS' ? COLUMNS : []));
  useQueryStore.setState({ connectionId: 'ch', database: { select } as never });
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === 'get_schema_metadata_queries') {
      return { columns: 'COLUMNS', indexes: 'INDEXES', foreign_keys: 'FKS', check_constraints: null, ddl: null, triggers: 'TRIGGERS', parameter_count: 2 };
    }
    return null;
  });
  readQuery.mockReset();
  readQuery.mockImplementation(async (sql: string) => (
    sql.startsWith('SELECT COUNT(*)')
      ? [{ total: 1 }]
      : [{ id: 1, fs: { type: 'binary', value: 'ff000102' }, note: 'x' }]
  ));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('TableDataViewer（ClickHouse）', () => {
  // 打包版上撞到的：编辑前值已经拆了包，rowKeyOf 看不出哪一列是二进制，
  // 定位条件里照样带着 fs = 'ff000102'，服务端报 TOO_LARGE_STRING_SIZE
  it('改一行时，显示成二进制的值不进定位条件', async () => {
    await act(async () => {
      root.render(<TableDataViewer connection={connection} tableName="t" schema="db" initialTab="data" />);
    });
    await act(async () => {
      byTitle('Edit').click();
    });
    const note = [...container.querySelectorAll('input')].find((input) => input.value === 'x');
    if (!note) throw new Error('没有 note 的输入框');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(note, 'y');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      byTitle('Save').click();
    });

    const [change] = Object.values(useTableEditStore.getState().changes).flat();
    expect(change?.kind).toBe('update');
    expect(change && 'key' in change ? change.key.columns : null).toEqual(['id', 'note']);
  });

  it('删一行时同样', async () => {
    await act(async () => {
      root.render(<TableDataViewer connection={connection} tableName="t" schema="db" initialTab="data" />);
    });
    await act(async () => {
      byTitle('delete').click();
    });

    const [change] = Object.values(useTableEditStore.getState().changes).flat();
    expect(change?.kind).toBe('delete');
    expect(change && 'key' in change ? change.key.columns : null).toEqual(['id', 'note']);
  });
});
