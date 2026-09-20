import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqlWorkspaceTab, createTableWorkspaceTab } from '../contracts/workspace';
import {
  clearWorkspaceSnapshot,
  loadWorkspaceSnapshot,
  saveWorkspaceSnapshot
} from './workspacePersistence';

const STORAGE_KEY = 'dataomni_workspace';

function installMemoryStorage(): Map<string, string> {
  const store = new Map<string, string>();

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    }
  });

  return store;
}

describe('工作区快照', () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    vi.restoreAllMocks();
    storage = installMemoryStorage();
  });

  it('往返保存与读取标签、活动标签和草稿', () => {
    const sqlTab = createSqlWorkspaceTab('profile-a', { id: 'sql-1' });
    const tableTab = createTableWorkspaceTab('profile-a', 'users', {
      id: 'table-1',
      schema: 'public'
    });

    saveWorkspaceSnapshot({
      tabs: [sqlTab, tableTab],
      activeTabId: 'table-1',
      drafts: { 'sql-1': 'SELECT 1;' },
      closedTabs: []
    });

    const restored = loadWorkspaceSnapshot();
    expect(restored?.tabs.map((tab) => tab.id)).toEqual(['sql-1', 'table-1']);
    expect(restored?.activeTabId).toBe('table-1');
    expect(restored?.drafts).toEqual({ 'sql-1': 'SELECT 1;' });
  });

  it('恢复时作废运行期会话，保留连接归属', () => {
    const tab = createSqlWorkspaceTab('profile-a', {
      id: 'sql-1',
      sessionId: 'session-from-last-run'
    });

    saveWorkspaceSnapshot({ tabs: [tab], activeTabId: 'sql-1', drafts: {}, closedTabs: [] });

    expect(loadWorkspaceSnapshot()?.tabs[0].binding).toEqual({
      profileId: 'profile-a',
      sessionId: null
    });
  });

  it('没有快照时返回 null', () => {
    expect(loadWorkspaceSnapshot()).toBeNull();
  });

  it('内容不是合法 JSON 时返回 null 而不抛', () => {
    storage.set(STORAGE_KEY, '{ 这不是 JSON');
    expect(() => loadWorkspaceSnapshot()).not.toThrow();
    expect(loadWorkspaceSnapshot()).toBeNull();
  });

  it('版本不匹配时整份丢弃', () => {
    storage.set(STORAGE_KEY, JSON.stringify({
      version: 999,
      tabs: [createSqlWorkspaceTab('profile-a', { id: 'sql-1' })],
      activeTabId: 'sql-1',
      drafts: {}
    }));

    expect(loadWorkspaceSnapshot()).toBeNull();
  });

  it('坏掉的标签被单独丢弃，不连累其余标签', () => {
    const good = createSqlWorkspaceTab('profile-a', { id: 'sql-1' });

    storage.set(STORAGE_KEY, JSON.stringify({
      version: 1,
      tabs: [
        good,
        null,
        { id: 'missing-kind', title: 'x', binding: { profileId: 'p' } },
        { id: 'bad-kind', kind: 'mystery', title: 'x', binding: { profileId: 'p' } },
        // 表标签缺 object，恢复出来会是打不开的空壳
        { id: 'no-object', kind: 'table-data', title: 'x', binding: { profileId: 'p' } }
      ],
      activeTabId: 'sql-1',
      drafts: {}
    }));

    expect(loadWorkspaceSnapshot()?.tabs.map((tab) => tab.id)).toEqual(['sql-1']);
  });

  it('丢弃没有对应标签的草稿', () => {
    const tab = createSqlWorkspaceTab('profile-a', { id: 'sql-1' });

    saveWorkspaceSnapshot({
      tabs: [tab],
      activeTabId: 'sql-1',
      drafts: { 'sql-1': 'SELECT 1;', 'closed-tab': 'SELECT 2;' },
      closedTabs: []
    });

    expect(loadWorkspaceSnapshot()?.drafts).toEqual({ 'sql-1': 'SELECT 1;' });
  });

  it('活动标签已不存在时回落到第一个标签', () => {
    const tab = createSqlWorkspaceTab('profile-a', { id: 'sql-1' });

    saveWorkspaceSnapshot({ tabs: [tab], activeTabId: 'gone', drafts: {}, closedTabs: [] });

    expect(loadWorkspaceSnapshot()?.activeTabId).toBe('sql-1');
  });

  it('往返保存与读取最近关闭的标签', () => {
    const open = createSqlWorkspaceTab('profile-a', { id: 'sql-1' });
    const closed = createSqlWorkspaceTab('profile-a', { id: 'sql-2' });

    saveWorkspaceSnapshot({
      tabs: [open],
      activeTabId: 'sql-1',
      drafts: {},
      closedTabs: [{ tab: closed, draft: 'SELECT 2;', closedAt: '2026-09-20T00:00:00.000Z' }]
    });

    const restored = loadWorkspaceSnapshot();
    expect(restored?.closedTabs).toHaveLength(1);
    expect(restored?.closedTabs[0].tab.id).toBe('sql-2');
    expect(restored?.closedTabs[0].draft).toBe('SELECT 2;');
  });

  it('旧版没有 closedTabs 字段的快照仍然可读，其余内容不丢', () => {
    // 加 closedTabs 时刻意没有提升版本号，否则现有快照会被整份丢弃
    const tab = createSqlWorkspaceTab('profile-a', { id: 'sql-1' });
    storage.set(STORAGE_KEY, JSON.stringify({
      version: 1,
      tabs: [tab],
      activeTabId: 'sql-1',
      drafts: { 'sql-1': 'SELECT 1;' }
    }));

    const restored = loadWorkspaceSnapshot();
    expect(restored?.tabs.map((each) => each.id)).toEqual(['sql-1']);
    expect(restored?.drafts).toEqual({ 'sql-1': 'SELECT 1;' });
    expect(restored?.closedTabs).toEqual([]);
  });

  it('坏掉的最近关闭条目被单独丢弃', () => {
    const good = createSqlWorkspaceTab('profile-a', { id: 'sql-1' });
    storage.set(STORAGE_KEY, JSON.stringify({
      version: 1,
      tabs: [],
      activeTabId: null,
      drafts: {},
      closedTabs: [
        { tab: good, draft: 'SELECT 1;', closedAt: '2026-09-20T00:00:00.000Z' },
        null,
        { draft: 'no tab' },
        { tab: good, draft: 42 }
      ]
    }));

    expect(loadWorkspaceSnapshot()?.closedTabs.map((closed) => closed.tab.id)).toEqual(['sql-1']);
  });

  it('localStorage 抛错时读取返回 null、写入不抛', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {
        throw new Error('storage disabled');
      }
    });

    expect(loadWorkspaceSnapshot()).toBeNull();
    expect(() => saveWorkspaceSnapshot({ tabs: [], activeTabId: null, drafts: {}, closedTabs: [] }))
      .not.toThrow();
    expect(() => clearWorkspaceSnapshot()).not.toThrow();
  });
});
