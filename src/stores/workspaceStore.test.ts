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
      activeTabId: null
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
