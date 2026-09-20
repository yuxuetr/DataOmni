import { beforeEach, describe, expect, it } from 'vitest';
import {
  createSqlWorkspaceTab,
  createTableWorkspaceTab,
  workspaceTabId
} from '../contracts/workspace';
import { useWorkspaceStore } from './workspaceStore';

describe('workspace store', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      sidebarProfileId: null,
      tabs: [],
      activeTabId: null,
      closedTabs: []
    });
  });

  it('keeps open tab bindings when the sidebar connection changes', () => {
    const tab = createSqlWorkspaceTab('profile-a', {
      id: 'tab-a',
      sessionId: 'session-a',
      now: '2026-09-17T00:00:00.000Z'
    });

    useWorkspaceStore.getState().registerTab(tab);
    useWorkspaceStore.getState().selectSidebarProfile('profile-b');

    const state = useWorkspaceStore.getState();
    expect(state.sidebarProfileId).toBe('profile-b');
    expect(state.tabs[0].binding).toEqual({
      profileId: 'profile-a',
      sessionId: 'session-a'
    });
  });

  it('preserves tabs when the active sidebar connection is cleared', () => {
    const tab = createSqlWorkspaceTab('profile-a', {
      id: 'tab-a',
      sessionId: 'session-a'
    });

    useWorkspaceStore.getState().registerTab(tab);
    useWorkspaceStore.getState().selectSidebarProfile('profile-a');
    useWorkspaceStore.getState().selectSidebarProfile(null);

    expect(useWorkspaceStore.getState().tabs).toEqual([tab]);
  });

  it('does not rebind an existing tab when it is registered again', () => {
    const tab = createSqlWorkspaceTab('profile-a', {
      id: 'tab-a',
      sessionId: 'session-a'
    });
    const reboundTab = createSqlWorkspaceTab('profile-b', {
      id: 'tab-a',
      sessionId: 'session-b'
    });

    useWorkspaceStore.getState().registerTab(tab);
    useWorkspaceStore.getState().registerTab(reboundTab);

    expect(useWorkspaceStore.getState().tabs).toEqual([tab]);
  });

  it('activates a neighboring tab after closing the active tab', () => {
    const firstTab = createSqlWorkspaceTab('profile-a', { id: 'tab-a' });
    const secondTab = createSqlWorkspaceTab('profile-b', { id: 'tab-b' });

    useWorkspaceStore.getState().registerTab(firstTab);
    useWorkspaceStore.getState().registerTab(secondTab);
    useWorkspaceStore.getState().closeTab('tab-b');

    expect(useWorkspaceStore.getState().activeTabId).toBe('tab-a');
  });

  it('preserves dirty SQL drafts and closes clean tabs for a deleted profile', () => {
    const dirtySqlTab = createSqlWorkspaceTab('profile-a', {
      id: 'sql-a',
      sessionId: 'session-a',
      sql: 'SELECT 1;'
    });
    const cleanTableTab = createTableWorkspaceTab('profile-a', 'users', {
      id: 'table-a',
      sessionId: 'session-a'
    });
    const otherProfileTab = createSqlWorkspaceTab('profile-b', {
      id: 'sql-b',
      sessionId: 'session-b'
    });

    useWorkspaceStore.getState().registerTab(dirtySqlTab);
    useWorkspaceStore.getState().registerTab(cleanTableTab);
    useWorkspaceStore.getState().registerTab(otherProfileTab);
    useWorkspaceStore.getState().selectSidebarProfile('profile-a');
    useWorkspaceStore.getState().handleProfileDeleted('profile-a');

    const state = useWorkspaceStore.getState();
    expect(state.sidebarProfileId).toBeNull();
    expect(state.tabs.map((tab) => tab.id)).toEqual(['sql-a', 'sql-b']);
    expect(state.tabs[0]).toMatchObject({
      availability: 'profile-deleted',
      dirty: true,
      binding: {
        profileId: 'profile-a',
        sessionId: null
      },
      draft: { sql: 'SELECT 1;' }
    });
    expect(state.tabs[1]).toEqual(otherProfileTab);
  });

  it('re-opening the same table activates the existing tab instead of duplicating it', () => {
    // 与 App.openTableTab 相同的路径：身份由 workspaceTabId 决定
    const openTable = (profileId: string, table: string, schema: string | null) =>
      useWorkspaceStore.getState().registerTab(
        createTableWorkspaceTab(profileId, table, {
          id: workspaceTabId(profileId, 'table-data', { schema, table }),
          schema
        })
      );

    openTable('profile-a', 'users', 'public');
    openTable('profile-a', 'orders', 'public');
    openTable('profile-a', 'users', 'public');

    const state = useWorkspaceStore.getState();
    expect(state.tabs.map((tab) => (tab.kind === 'sql' ? null : tab.object.table)))
      .toEqual(['users', 'orders']);
    expect(state.activeTabId).toBe(workspaceTabId('profile-a', 'table-data', {
      schema: 'public',
      table: 'users'
    }));
  });

  it('keeps same-named tables on different connections as separate tabs', () => {
    const openTable = (profileId: string, table: string) =>
      useWorkspaceStore.getState().registerTab(
        createTableWorkspaceTab(profileId, table, {
          id: workspaceTabId(profileId, 'table-data', { schema: null, table }),
          schema: null
        })
      );

    openTable('profile-a', 'users');
    openTable('profile-b', 'users');

    const state = useWorkspaceStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs.map((tab) => tab.binding.profileId)).toEqual(['profile-a', 'profile-b']);
  });

  it('keeps a SQL tab whose draft only exists in the query store', () => {
    // tab.dirty 只在创建时设过一次，带草稿的标签必须靠 tabIdsWithDrafts 保住
    const tabWithDraft = createSqlWorkspaceTab('profile-a', { id: 'sql-a' });
    const emptyTab = createSqlWorkspaceTab('profile-a', { id: 'sql-empty' });

    useWorkspaceStore.getState().registerTab(tabWithDraft);
    useWorkspaceStore.getState().registerTab(emptyTab);
    expect(tabWithDraft.dirty).toBe(false);

    useWorkspaceStore.getState().handleProfileDeleted('profile-a', new Set(['sql-a']));

    const state = useWorkspaceStore.getState();
    expect(state.tabs.map((workspaceTab) => workspaceTab.id)).toEqual(['sql-a']);
    expect(state.tabs[0].availability).toBe('profile-deleted');
  });

  it('retains a closed tab with its draft and reopens the most recent one', () => {
    const first = createSqlWorkspaceTab('profile-a', { id: 'sql-1' });
    const second = createSqlWorkspaceTab('profile-a', { id: 'sql-2' });

    useWorkspaceStore.getState().retainClosedTab(first, 'SELECT 1;');
    useWorkspaceStore.getState().retainClosedTab(second, 'SELECT 2;');

    const reopened = useWorkspaceStore.getState().reopenLastClosedTab();

    expect(reopened?.tab.id).toBe('sql-2');
    expect(reopened?.draft).toBe('SELECT 2;');

    const state = useWorkspaceStore.getState();
    expect(state.tabs.map((tab) => tab.id)).toEqual(['sql-2']);
    expect(state.activeTabId).toBe('sql-2');
    // 取回过的不该还留在列表里
    expect(state.closedTabs.map((closed) => closed.tab.id)).toEqual(['sql-1']);
  });

  it('没有可取回的标签时返回 null', () => {
    expect(useWorkspaceStore.getState().reopenLastClosedTab()).toBeNull();
  });

  it('同一个标签重复关闭只保留最新的一条', () => {
    const tab = createSqlWorkspaceTab('profile-a', { id: 'sql-1' });

    useWorkspaceStore.getState().retainClosedTab(tab, 'SELECT 1;');
    useWorkspaceStore.getState().retainClosedTab(tab, 'SELECT 2;');

    const { closedTabs } = useWorkspaceStore.getState();
    expect(closedTabs).toHaveLength(1);
    expect(closedTabs[0].draft).toBe('SELECT 2;');
  });

  it('最近关闭列表有上限，挤掉最旧的', () => {
    for (let index = 0; index < 12; index += 1) {
      useWorkspaceStore.getState().retainClosedTab(
        createSqlWorkspaceTab('profile-a', { id: `sql-${index}` }),
        `SELECT ${index};`
      );
    }

    const { closedTabs } = useWorkspaceStore.getState();
    expect(closedTabs).toHaveLength(10);
    // 最新的在前，最旧的两个被挤掉
    expect(closedTabs[0].tab.id).toBe('sql-11');
    expect(closedTabs.map((closed) => closed.tab.id)).not.toContain('sql-0');
  });

  it('moves focus when a deleted profile closes the active clean tab', () => {
    const retainedTab = createSqlWorkspaceTab('profile-b', { id: 'sql-b' });
    const deletedTab = createTableWorkspaceTab('profile-a', 'users', {
      id: 'table-a'
    });

    useWorkspaceStore.getState().registerTab(retainedTab);
    useWorkspaceStore.getState().registerTab(deletedTab);
    useWorkspaceStore.getState().handleProfileDeleted('profile-a');

    expect(useWorkspaceStore.getState().activeTabId).toBe('sql-b');
  });
});
