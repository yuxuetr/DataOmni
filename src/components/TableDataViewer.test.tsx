/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseType, type ConnectionProfile } from '../contracts/connection';
import { useLanguageStore } from '../stores/languageStore';
import { useQueryStore } from '../stores/queryStore';
import { useSettingsStore } from '../stores/settingsStore';
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
      byTitle('Delete').click();
    });

    const [change] = Object.values(useTableEditStore.getState().changes).flat();
    expect(change?.kind).toBe('delete');
    expect(change && 'key' in change ? change.key.columns : null).toEqual(['id', 'note']);
  });

  // 打包版上看到的：四个翻页按钮只有图标，读屏与自动化都只拿到一个空名字
  it('翻页按钮有名字', async () => {
    readQuery.mockImplementation(async (sql: string) => (
      sql.startsWith('SELECT COUNT(*)') ? [{ total: 120 }] : [{ id: 1, fs: 'a', note: 'x' }]
    ));
    await act(async () => {
      root.render(<TableDataViewer connection={connection} tableName="t" schema="db" initialTab="data" />);
    });

    const labels = [...container.querySelectorAll('button[aria-label]')].map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual(expect.arrayContaining(['First page', 'Previous page', 'Next page', 'Last page']));
  });

  // 打包版上看到的：设成「紧凑」后表数据页的行高纹丝不动——操作列那一格写死了 py-1，
  // 里面的图标按钮把整行撑住了。结果网格的操作列跟着设置走，这里也要
  it('行高设置也管操作列', async () => {
    useSettingsStore.setState({ gridDensity: 'compact' });
    readQuery.mockImplementation(async (sql: string) => (
      sql.startsWith('SELECT COUNT(*)') ? [{ total: 1 }] : [{ id: 1, fs: 'a', note: 'x' }]
    ));
    try {
      await act(async () => {
        root.render(<TableDataViewer connection={connection} tableName="t" schema="db" initialTab="data" />);
      });
      const cells = [...container.querySelectorAll('tbody tr:first-child > td')];
      expect(cells.length).toBeGreaterThan(1);
      expect(cells.filter((cell) => cell.classList.contains('py-1'))).toEqual([]);
    } finally {
      useSettingsStore.setState({ gridDensity: 'default' });
    }
  });

  // 打包版上撞到的：AggregateFunction 列点了排序，查询报错、行清空，表头跟着没了，
  // 刷新还带着这个排序——只能关掉标签重开
  it('按某列排序失败时取消排序重读，报错仍然看得到', async () => {
    readQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT COUNT(*)')) return [{ total: 1 }];
      if (sql.includes('ORDER BY `note`')) throw new Error('Data type is not allowed in ORDER BY keys');
      return [{ id: 1, fs: 'a', note: 'x' }];
    });
    await act(async () => {
      root.render(<TableDataViewer connection={connection} tableName="t" schema="db" initialTab="data" />);
    });
    await act(async () => {
      byTitle('note: click to sort ascending').click();
    });

    expect(container.textContent).toContain('not allowed in ORDER BY keys');
    expect(container.textContent).toContain('note');
    // 行回来了，表头还在、排序已取消
    expect([...container.querySelectorAll('input, td')].some((cell) => cell.textContent === 'x')).toBe(true);
    byTitle('note: click to sort ascending');
    const dataQueries = readQuery.mock.calls.map(([sql]) => sql as string).filter((sql) => !sql.startsWith('SELECT COUNT(*)'));
    expect(dataQueries[dataQueries.length - 1]).not.toContain('ORDER BY `note`');
  });

  // 回归时看到的：「已提交 1 项」在翻页、排序、改完结构之后还挂着，像是刚又提交了一次
  it('「已提交」只说刚才那一次：之后重读了表就收起', async () => {
    await act(async () => {
      root.render(<TableDataViewer connection={connection} tableName="t" schema="db" initialTab="data" />);
    });
    await act(async () => {
      byTitle('Delete').click();
    });
    const commit = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Commit 1');
    if (!commit) throw new Error('没有提交按钮');
    await act(async () => {
      commit.click();
    });
    expect(container.textContent).toContain('Committed 1 change.');

    await act(async () => {
      byTitle('note: click to sort ascending').click();
    });
    expect(container.textContent).not.toContain('Committed 1 change.');
  });
});
