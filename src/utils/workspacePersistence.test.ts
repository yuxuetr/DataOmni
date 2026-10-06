import { beforeEach, describe, expect, it, vi } from 'vitest';
import ON_DISK_0_5 from '../../fixtures/on-disk-0.5/workspace.json?raw';
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

  it('标题的文案键与参数能往返——否则重启后标签标题卡在上一次的语言', () => {
    const tab = createSqlWorkspaceTab('profile-a', {
      id: 'sql-1',
      titleKey: 'tab.queryTitle',
      titleParams: { connection: 'T1' }
    });

    saveWorkspaceSnapshot({ tabs: [tab], activeTabId: 'sql-1', drafts: {}, closedTabs: [] });
    const restored = loadWorkspaceSnapshot()?.tabs[0];

    expect(restored?.titleKey).toBe('tab.queryTitle');
    expect(restored?.titleParams).toEqual({ connection: 'T1' });
  });

  it('表标签不带文案键——表名是数据库里的标识符，不该被翻译', () => {
    const tab = createTableWorkspaceTab('profile-a', 'users', { id: 'table-1' });
    expect(tab.titleKey).toBeUndefined();
    expect(tab.title).toBe('users');
  });

  /**
   * 这一条是「欢迎页不做最近工作区」那个决定的判据。
   *
   * 不做的理由不是「暂时不需要」，是**多工作区这个概念不存在**：快照就一份，
   * 存在一个固定的键上，没有 id 也没有名字。列一个只有一项、而且每次启动都会
   * 自动恢复的「最近工作区」，是在给一个不存在的选择做界面。
   *
   * 哪天快照改成按 id 存多份，这条会红——那时候欢迎页才真的有东西可列。
   */
  it('同一时刻只有一份工作区，所以没有「最近工作区」可列', () => {
    saveWorkspaceSnapshot({
      tabs: [createSqlWorkspaceTab('profile-1')],
      activeTabId: null,
      drafts: {},
      closedTabs: []
    });
    saveWorkspaceSnapshot({
      tabs: [createSqlWorkspaceTab('profile-2')],
      activeTabId: null,
      drafts: {},
      closedTabs: []
    });

    // 后写的覆盖前一份，不是并存两份
    expect([...storage.keys()]).toEqual([STORAGE_KEY]);
    expect(loadWorkspaceSnapshot()?.tabs[0].binding.profileId).toBe('profile-2');
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

  it('固定状态往返保留，旧快照缺 pinned 时归一为 false', () => {
    const pinned = { ...createSqlWorkspaceTab('profile-a', { id: 'sql-1' }), pinned: true };
    saveWorkspaceSnapshot({ tabs: [pinned], activeTabId: 'sql-1', drafts: {}, closedTabs: [] });
    expect(loadWorkspaceSnapshot()?.tabs[0].pinned).toBe(true);

    const legacy = createSqlWorkspaceTab('profile-a', { id: 'sql-2' });
    const withoutPinned = { ...legacy } as Record<string, unknown>;
    delete withoutPinned.pinned;
    storage.set(STORAGE_KEY, JSON.stringify({
      version: 1,
      tabs: [withoutPinned],
      activeTabId: 'sql-2',
      drafts: {}
    }));
    expect(loadWorkspaceSnapshot()?.tabs[0].pinned).toBe(false);
  });

  it('来源文件往返保留；残缺的链接丢掉，标签照常恢复', () => {
    const linked = createSqlWorkspaceTab('profile-a', { id: 'sql-1', file: { path: '/w/a.sql', contentHash: 'abc' } });
    const broken = { ...createSqlWorkspaceTab('profile-a', { id: 'sql-2' }), file: { path: '/w/b.sql' } };
    storage.set(STORAGE_KEY, JSON.stringify({ version: 1, tabs: [linked, broken], activeTabId: 'sql-1', drafts: {} }));

    const tabs = loadWorkspaceSnapshot()?.tabs ?? [];
    expect(tabs.map((tab) => tab.id)).toEqual(['sql-1', 'sql-2']);
    expect(tabs[0].kind === 'sql' && tabs[0].file).toEqual({ path: '/w/a.sql', contentHash: 'abc' });
    expect(tabs[1]).not.toHaveProperty('file');
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

// 0.5 写下的快照。1.0 之后它必须一直恢复得出来：这条红了，就是改了快照格式而没写迁移

describe('跨版本的工作区快照', () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    vi.restoreAllMocks();
    storage = installMemoryStorage();
  });

  it('0.5 写下的快照恢复得出全部标签、草稿与最近关闭', () => {
    storage.set(STORAGE_KEY, ON_DISK_0_5);
    const snapshot = loadWorkspaceSnapshot();

    expect(snapshot?.tabs.map((tab) => tab.kind)).toEqual([
      'sql', 'table-data', 'table-structure', 'er-diagram', 'ai-design'
    ]);
    expect(snapshot?.activeTabId).toBe('table-data:7f0c2a52:public.orders');
    expect(snapshot?.drafts['sql:7f0c2a52:1']).toContain('未保存的改动');
    expect(snapshot?.closedTabs[0]?.draft).toBe('DELETE FROM sessions WHERE expired;');
    const sql = snapshot?.tabs[0];
    expect(sql?.kind === 'sql' ? sql.file : undefined).toEqual({
      path: '/Users/someone/sql/report.sql', contentHash: 'a1b2c3', crlf: true, bom: true
    });
    expect(sql?.pinned).toBe(true);
    expect(sql?.binding.sessionId).toBeNull();
  });

  it('更新的版本写下的快照不被这一版覆盖：退回旧版再升回去，标签还在', () => {
    const newer = JSON.stringify({ ...JSON.parse(ON_DISK_0_5), version: 2 });
    storage.set(STORAGE_KEY, newer);

    expect(loadWorkspaceSnapshot()).toBeNull();
    saveWorkspaceSnapshot({ tabs: [], activeTabId: null, drafts: {}, closedTabs: [] });

    expect(storage.get(STORAGE_KEY)).toBe(newer);
  });
});
