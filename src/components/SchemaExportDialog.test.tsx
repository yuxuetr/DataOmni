/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseType, type ConnectionProfile } from '../contracts/connection';
import { useLanguageStore } from '../stores/languageStore';
import { useQueryStore } from '../stores/queryStore';
import type { DatabaseObject } from '../utils/databaseObjects';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args), Channel: class {} }));
const save = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (...args: unknown[]) => save(...args) }));

const { SchemaExportDialog } = await import('./SchemaExportDialog');

const connection: ConnectionProfile = {
  id: 'my',
  name: 'claw',
  db_type: DatabaseType.MySQL,
  host: '127.0.0.1',
  port: 3306,
  username: 'root',
  password: '',
  database: 'shop',
  ssl: false,
  save_password: false,
  options: {},
  tags: [],
  environment: 'development',
  created_at: '',
  updated_at: ''
};

const table = (name: string): DatabaseObject => ({ schema: 'shop', name, kind: 'table', id: name });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useLanguageStore.getState().setPreference('en');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  invoke.mockReset();
  save.mockReset();
  save.mockResolvedValue('/tmp/out');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const button = (text: string) => {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent?.startsWith(text));
  if (!found) throw new Error(`no button ${text}`);
  return found;
};

const typeFilter = async (value: string) => {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]');
  if (!input) throw new Error('no filter');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const written = () => {
  const call = invoke.mock.calls.find(([command]) => command === 'write_text_file');
  return (call?.[1] as { path: string; contents: string } | undefined);
};

describe('SchemaExportDialog', () => {
  it('筛选后全选，没画出来的也算；SQL 按树的次序拼，读不到的列在开头', async () => {
    // 250 张 t000…t249，加两张不匹配筛选的
    const tables = [
      ...Array.from({ length: 250 }, (_, index) => table(`t${String(index).padStart(3, '0')}`)),
      table('users'),
      table('logs')
    ];
    const select = vi.fn(async (sql: string) => {
      if (sql === 'SHOW CREATE TABLE `shop`.`t007`') {
        throw new Error('Table \'shop.t007\' doesn\'t exist');
      }
      const name = /`shop`\.`([^`]+)`/.exec(sql)?.[1];
      return [{ Table: name, 'Create Table': `CREATE TABLE \`${name}\` (id int)` }];
    });
    useQueryStore.setState({ connectionId: 'my', database: { select } as never });
    invoke.mockImplementation(async (command: string) => (
      command === 'get_schema_metadata_queries'
        ? { ddl: { kind: 'interpolated', sql: 'SHOW CREATE TABLE {table}' }, parameter_count: 2 }
        : null
    ));

    await act(async () => {
      root.render(<SchemaExportDialog connection={connection} tables={tables} onClose={() => {}} />);
    });
    await typeFilter('t');

    // 筛出 250 张，只画 200 张
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(200);
    expect(container.textContent).toContain('50 more not listed');

    await act(async () => button('Select all (250)').click());
    expect(container.textContent).toContain('Selected: 250 of 252');

    await act(async () => button('Export').click());

    expect(select).toHaveBeenCalledTimes(250);
    const file = written();
    expect(file?.path).toBe('/tmp/out');
    const contents = file?.contents ?? '';
    expect(contents.split('\n')[0]).toMatch(/^-- claw · shop · CREATE statements for 249 tables · exported from DataOmni on \d{4}-\d{2}-\d{2}$/);
    expect(contents).toContain('--   shop.t007: Table \'shop.t007\' doesn\'t exist');
    expect(contents).not.toContain('users');
    expect(contents.indexOf('CREATE TABLE `t000`')).toBeLessThan(contents.indexOf('CREATE TABLE `t249`'));
    expect(container.textContent).toContain('Exported 249 tables: /tmp/out');
    expect(container.textContent).toContain('shop.t007:');
  });

  it('数据字典只写选中的表', async () => {
    const select = vi.fn(async (sql: string) => {
      if (sql === 'COLUMNS') {
        return ['orders', 'users', 'logs'].map((name) => ({
          table_schema: 'shop', table_name: name, column_name: 'id', data_type: 'int', ordinal: 1, is_primary_key: 1, is_nullable: 0
        }));
      }
      return [];
    });
    useQueryStore.setState({ connectionId: 'my', database: { select } as never });
    invoke.mockImplementation(async (command: string) => (
      command === 'get_er_diagram_queries'
        ? { columns: 'COLUMNS', foreign_keys: 'FKS', parameter_count: 1 }
        : null
    ));

    await act(async () => {
      root.render(<SchemaExportDialog connection={connection} tables={[table('logs'), table('orders'), table('users')]} onClose={() => {}} />);
    });
    const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await act(async () => boxes[1].click());
    await act(async () => boxes[2].click());
    const markdown = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1];
    await act(async () => markdown.click());
    await act(async () => button('Export').click());

    expect(select).toHaveBeenCalledWith('COLUMNS', ['shop']);
    expect(save.mock.calls[0][0]).toMatchObject({ defaultPath: expect.stringMatching(/^shop-schema-.*\.md$/) });
    const contents = written()?.contents ?? '';
    expect(contents).toContain('## shop.orders');
    expect(contents).toContain('## shop.users');
    expect(contents).not.toContain('## shop.logs');
  });
});
