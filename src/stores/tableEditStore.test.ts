import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceTab } from '../contracts/workspace';
import type { PendingChange } from '../utils/pendingChanges';
import {
  isLastTabForTable,
  pendingChangeCount,
  tableEditKey,
  tableKeyOfTab,
  useTableEditStore
} from './tableEditStore';

function change(id: string): PendingChange {
  return {
    id,
    kind: 'update',
    rowId: `["${id}"]`,
    key: { columns: ['id'], values: { id: id } },
    original: { id: id },
    values: { name: { kind: 'value', value: 'x' } }
  } as PendingChange;
}

function tableTab(
  id: string,
  kind: 'table-data' | 'table-structure',
  table: string,
  schema: string | null = 'public'
): WorkspaceTab {
  const now = new Date().toISOString();
  return {
    id, kind, title: table,
    binding: { profileId: 'c1', sessionId: null },
    availability: 'available', pinned: false, dirty: false,
    createdAt: now, lastActivatedAt: now,
    object: { schema, table }
  };
}

function sqlTab(id: string): WorkspaceTab {
  const now = new Date().toISOString();
  return {
    id, kind: 'sql', title: 'Query',
    binding: { profileId: 'c1', sessionId: null },
    availability: 'available', pinned: false, dirty: false,
    createdAt: now, lastActivatedAt: now,
    draft: { sql: '' }
  };
}

beforeEach(() => {
  useTableEditStore.setState({ changes: {} });
});

describe('待提交的改动按表存', () => {
  const key = tableEditKey('c1', 'public', 'orders');

  it('存进去再读出来，就是切走标签又切回来那一下', () => {
    useTableEditStore.getState().setChanges(key, [change('a'), change('b')]);
    // 组件卸载不影响 store：这正是「切一下标签改动就没了」的修法
    expect(useTableEditStore.getState().changes[key]).toHaveLength(2);
    expect(pendingChangeCount(key)).toBe(2);
  });

  it('两张表互不影响', () => {
    const other = tableEditKey('c1', 'public', 'invoices');
    useTableEditStore.getState().setChanges(key, [change('a')]);
    useTableEditStore.getState().setChanges(other, [change('b'), change('c')]);
    expect(pendingChangeCount(key)).toBe(1);
    expect(pendingChangeCount(other)).toBe(2);
  });

  it('同名表在两个连接下是两张表', () => {
    expect(tableEditKey('c1', 'public', 'orders'))
      .not.toBe(tableEditKey('c2', 'public', 'orders'));
  });

  it('没有 schema 与 schema 为空串算同一张表', () => {
    expect(tableEditKey('c1', null, 'orders')).toBe(tableEditKey('c1', undefined, 'orders'));
  });

  it('清空之后键本身也不留下，否则关过的表会一直攒着空条目', () => {
    useTableEditStore.getState().setChanges(key, [change('a')]);
    useTableEditStore.getState().setChanges(key, []);
    expect(key in useTableEditStore.getState().changes).toBe(false);
  });

  it('函数式更新拿得到当前值', () => {
    useTableEditStore.getState().setChanges(key, [change('a')]);
    useTableEditStore.getState().setChanges(key, (current) => [...current, change('b')]);
    expect(pendingChangeCount(key)).toBe(2);
  });
});

describe('哪个标签指着哪张表', () => {
  it('SQL 标签不指向任何表', () => {
    expect(tableKeyOfTab(sqlTab('t1'))).toBeNull();
  });

  it('数据页和结构页指的是同一张表', () => {
    expect(tableKeyOfTab(tableTab('a', 'table-data', 'orders')))
      .toBe(tableKeyOfTab(tableTab('b', 'table-structure', 'orders')));
  });

  /**
   * 这一条挡的是一个很容易写出来的错版本：关掉结构页时顺手把改动清掉。
   * 数据页还开着，上面画着「3 项待提交」，而 store 里已经空了。
   */
  it('同一张表还有别的标签开着时，不算最后一个', () => {
    const tabs = [
      tableTab('a', 'table-data', 'orders'),
      tableTab('b', 'table-structure', 'orders')
    ];
    expect(isLastTabForTable(tabs, 'b')).toBe(false);
  });

  it('只剩这一个标签时才算最后一个', () => {
    const tabs = [tableTab('a', 'table-data', 'orders'), sqlTab('q')];
    expect(isLastTabForTable(tabs, 'a')).toBe(true);
  });

  it('别的表的标签不算数', () => {
    const tabs = [
      tableTab('a', 'table-data', 'orders'),
      tableTab('c', 'table-data', 'invoices')
    ];
    expect(isLastTabForTable(tabs, 'a')).toBe(true);
  });

  it('关的是 SQL 标签时不当成表', () => {
    expect(isLastTabForTable([sqlTab('q')], 'q')).toBe(false);
  });
});

describe('改动不许退回组件状态', () => {
  /**
   * store 建好了，组件却还留着一份 `useState`，是这类改动最常见的半途而废：
   * 单测全绿，界面上切一下标签改动照样没。所以这里直接盯着源码。
   */
  it('TableDataViewer 不再用 useState 存待提交改动', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/TableDataViewer.tsx'),
      'utf8'
    );
    expect(source).not.toMatch(/useState<PendingChange\[\]>/);
    expect(source).toContain('useTableEditStore');
  });
});
