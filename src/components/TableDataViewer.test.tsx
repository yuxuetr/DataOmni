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

function openContextMenuOn(text: string) {
  const cell = [...container.querySelectorAll('td')].find((td) => td.textContent === text);
  if (!cell) throw new Error(`没有内容是「${text}」的格子`);
  cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
}

function menuLabels(): string[] {
  return [...document.querySelectorAll('div.fixed button')].map((button) => button.firstElementChild?.textContent ?? '');
}

function menuItem(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('div.fixed button')]
    .find((button) => button.firstElementChild?.textContent === label);
  if (!found) throw new Error(`菜单里没有「${label}」，只有 ${menuLabels().join(' / ')}`);
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

  // 用户反馈：操作列在最右边，列一多就被挤出屏幕，右键菜单里又只有复制，找不到怎么改一行
  it('右键菜单里可以编辑这一行', async () => {
    await act(async () => {
      root.render(<TableDataViewer connection={connection} tableName="t" schema="db" initialTab="data" />);
    });
    expect(container.querySelectorAll('input[value="x"]').length).toBe(0);
    await act(async () => {
      openContextMenuOn('x');
    });
    await act(async () => {
      menuItem('Edit this row').click();
    });

    const inputs = [...container.querySelectorAll('input')].map((input) => input.value);
    expect(inputs).toContain('x');
  });

  it('已经排进待提交的行，右键菜单不给编辑', async () => {
    await act(async () => {
      root.render(<TableDataViewer connection={connection} tableName="t" schema="db" initialTab="data" />);
    });
    await act(async () => {
      byTitle('Delete').click();
    });
    await act(async () => {
      openContextMenuOn('x');
    });

    expect(menuLabels()).toContain('Copy row');
    expect(menuLabels()).not.toContain('Edit this row');
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

describe('TableDataViewer（ClickHouse MergeTree 表按物理位置定位）', () => {
  it('读表时带上位置、网格里不显示，删一行时键里带着它', async () => {
    const merge = COLUMNS.map((column) => ({ ...column, table_engine: 'MergeTree' }));
    const select = vi.fn(async (sql: string) => (sql === 'COLUMNS' ? merge : []));
    useQueryStore.setState({ connectionId: 'ch', database: { select } as never });
    const sent: string[] = [];
    readQuery.mockImplementation(async (sql: string) => {
      sent.push(sql);
      return sql.startsWith('SELECT COUNT(*)')
        ? [{ total: 1 }]
        : [{ id: 1, fs: 'a', note: 'x', __dataomni_part: 'all_1_1_0', __dataomni_part_offset: { type: 'bigint', value: '3' } }];
    });
    await act(async () => {
      root.render(<TableDataViewer connection={connection} tableName="tpos" schema="db" initialTab="data" />);
    });

    expect(sent.find((sql) => sql.includes('_part_offset AS `__dataomni_part_offset`'))).toBeDefined();
    expect(container.textContent).not.toContain('__dataomni');
    expect(container.textContent).not.toContain('all_1_1_0');
    await act(async () => {
      byTitle('Delete').click();
    });
    const [change] = Object.values(useTableEditStore.getState().changes).flat();
    expect(change && 'key' in change ? change.key.position : null).toEqual({ part: 'all_1_1_0', offset: '3' });
  });

  it('不是 MergeTree 的表照旧只读表自己的列', async () => {
    const memory = COLUMNS.map((column) => ({ ...column, table_engine: 'Memory' }));
    const select = vi.fn(async (sql: string) => (sql === 'COLUMNS' ? memory : []));
    useQueryStore.setState({ connectionId: 'ch', database: { select } as never });
    const sent: string[] = [];
    readQuery.mockImplementation(async (sql: string) => {
      sent.push(sql);
      return sql.startsWith('SELECT COUNT(*)') ? [{ total: 1 }] : [{ id: 1, fs: 'a', note: 'x' }];
    });
    await act(async () => {
      root.render(<TableDataViewer connection={connection} tableName="t2" schema="db" initialTab="data" />);
    });
    expect(sent.some((sql) => sql.includes('_part'))).toBe(false);
  });
});

describe('TableDataViewer（CockroachDB 的触发器）', () => {
  // CockroachDB 没有 pg_get_triggerdef()，目录查询报 42883；它的触发器只有 SHOW 看得见
  it('目录查询报缺函数时改走 SHOW，画出触发器原文', async () => {
    const crdb = { ...connection, id: 'crdb', name: 'crdb', db_type: DatabaseType.PostgreSQL };
    const select = vi.fn(async (sql: string) => {
      if (sql === 'COLUMNS') return COLUMNS;
      if (sql === 'TRIGGERS') {
        throw Object.assign(new Error('unknown function: pg_get_triggerdef()'), { code: '42883' });
      }
      if (sql === 'SHOW TRIGGERS FROM "public"."t"') return [{ trigger_name: 'audit', enabled: true }];
      if (sql === 'SHOW CREATE TRIGGER "audit" ON "public"."t"') {
        return [{ trigger_name: 'audit', create_statement: 'CREATE TRIGGER audit BEFORE INSERT ON db.public.t' }];
      }
      return [];
    });
    useQueryStore.setState({ connectionId: 'crdb', database: { select } as never });
    invoke.mockImplementation(async (command: string) => (
      command === 'get_schema_metadata_queries'
        ? {
          columns: 'COLUMNS', indexes: 'INDEXES', foreign_keys: 'FKS', check_constraints: null, ddl: null,
          triggers: 'TRIGGERS',
          triggers_by_show: { list: 'SHOW TRIGGERS FROM {table}', definition: 'SHOW CREATE TRIGGER {trigger} ON {table}' },
          parameter_count: 2
        }
        : null
    ));

    await act(async () => {
      root.render(<TableDataViewer connection={crdb} tableName="t" schema="public" initialTab="schema" />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('CREATE TRIGGER audit BEFORE INSERT ON db.public.t');
    expect(container.textContent).not.toContain('pg_get_triggerdef');
  });
});
