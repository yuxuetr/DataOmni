/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '../contracts';
import { useAppStore } from '../stores/appStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useLanguageStore } from '../stores/languageStore';
import type { DatabaseHandle } from '../utils/databaseHandle';

/** 一张表：列名 → [类型, 是否主键] */
type FakeTable = Record<string, [string, boolean]>;

/** 按查询的名字回目录行：两边各一份，结构由用例给 */
function fakeHandle(tables: Record<string, FakeTable>, ddl: Record<string, string> = {}): DatabaseHandle & { close: ReturnType<typeof vi.fn> } {
  return {
    select: (async (sql: string, params: unknown[] = []) => {
      if (sql === 'ER_COLS') {
        return Object.entries(tables).flatMap(([table, columns]) =>
          Object.entries(columns).map(([column, [type, primary]], ordinal) => ({
            table_name: table, column_name: column, data_type: type, is_primary_key: primary, is_nullable: !primary, ordinal
          })));
      }
      if (sql === 'COLS') {
        return Object.entries(tables[String(params[0])] ?? {}).map(([column, [type, primary]]) => ({
          column_name: column, data_type: type, is_nullable: !primary, is_primary_key: primary, primary_key_ordinal: primary ? 1 : 0
        }));
      }
      if (sql === 'DDL') return ddl[String(params[0])] ? [{ sql: ddl[String(params[0])] }] : [];
      return [];
    }) as DatabaseHandle['select'],
    close: vi.fn(async () => true)
  };
}

const invoke = vi.fn();
let otherHandle = fakeHandle({});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args), Channel: class {} }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => otherHandle } }));

const { SchemaCompareDialog } = await import('./SchemaCompareDialog');

const profile = (id: string, name: string): ConnectionProfile => ({
  id, name, db_type: 'sqlite', host: '', port: 0, database: `/data/${id}.db`, username: '', password: '', ssl: false,
  save_password: false, options: {}, tags: [], environment: 'development', created_at: '', updated_at: ''
}) as ConnectionProfile;
const dev = profile('dev', 'Dev');
const prod = profile('prod', 'Prod');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useLanguageStore.getState().setPreference('en');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useConnectionStore.setState({ connections: [dev, prod] });
  useAppStore.setState({ activeConnection: { config: dev, connectionString: 'sqlite:/data/dev.db' } } as never);
  invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case 'test_connection':
        return 'sqlite:/data/prod.db';
      case 'get_er_diagram_queries':
        return { columns: 'ER_COLS', foreign_keys: 'ER_FK', parameter_count: 0 };
      case 'get_schema_metadata_queries':
        return {
          columns: 'COLS', indexes: 'IDX', foreign_keys: 'FK', check_constraints: null,
          ddl: { kind: 'bound', sql: 'DDL' }, triggers: '', triggers_by_show: null, parameter_count: 1
        };
      default:
        throw new Error(command);
    }
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const button = (label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label));

async function compare(currentTables: Record<string, FakeTable>, onOpenSql = vi.fn()) {
  await act(async () => {
    root.render(<SchemaCompareDialog current={dev} currentHandle={fakeHandle(currentTables)} onOpenSql={onOpenSql} onClose={() => {}} />);
  });
  await act(async () => {
    button('Compare')?.click();
  });
  return onOpenSql;
}

describe('SchemaCompareDialog', () => {
  beforeEach(() => {
    otherHandle = fakeHandle(
      { users: { id: ['INTEGER', true], email: ['TEXT', false], name: ['TEXT', false] }, tags: { id: ['INTEGER', true] } },
      { tags: 'CREATE TABLE tags (id INTEGER PRIMARY KEY)' }
    );
  });

  it('lists what differs and puts the script for this database into the editor', async () => {
    const onOpenSql = await compare({ users: { id: ['INTEGER', true], email: ['TEXT', false] } });
    const text = container.textContent ?? '';
    expect(text).toContain('Source Prod → target Dev');
    expect(text).toContain('Add column name TEXT');
    expect(text).toContain('Create table');
    await act(async () => {
      button('Open in editor')?.click();
    });
    const [script, title] = onOpenSql.mock.calls[0];
    expect(script).toContain('CREATE TABLE tags (id INTEGER PRIMARY KEY);');
    expect(script).toContain('ALTER TABLE "users" ADD COLUMN "name" TEXT;');
    expect(title).toBe('Sync Dev');
  });

  it('leaves a table that only the target has alone until it is ticked', async () => {
    await compare({ users: { id: ['INTEGER', true], email: ['TEXT', false], name: ['TEXT', false] }, tags: { id: ['INTEGER', true] }, old: { id: ['INTEGER', true] } });
    expect(container.textContent).toContain('Nothing is selected to sync.');
    const checkbox = [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find((item) => !item.checked);
    await act(async () => {
      checkbox?.click();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('DROP TABLE "old";');
    expect(text).toContain('Deleted together with their data');
  });

  it('only offers to copy or save when the target is the other connection, and closes that connection afterwards', async () => {
    await act(async () => {
      root.render(<SchemaCompareDialog current={dev} currentHandle={fakeHandle({ users: { id: ['INTEGER', true] } })} onOpenSql={vi.fn()} onClose={() => {}} />);
    });
    await act(async () => {
      button('Make it match this database')?.click();
    });
    await act(async () => {
      button('Compare')?.click();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Source Dev → target Prod');
    expect(text).toContain('The target is not the current connection');
    expect(button('Open in editor')).toBeUndefined();
    act(() => root.unmount());
    expect(otherHandle.close).toHaveBeenCalled();
    root = createRoot(container);
  });
});
