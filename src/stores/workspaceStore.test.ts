import { beforeEach, describe, expect, it } from 'vitest';
import { createSqlWorkspaceTab } from '../contracts/workspace';
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
});
