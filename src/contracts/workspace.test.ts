import { describe, expect, it } from 'vitest';
import {
  createSqlWorkspaceTab,
  createTableWorkspaceTab,
  markWorkspaceTabProfileDeleted,
  updateSqlWorkspaceTabDraft
} from './workspace';

const now = '2026-09-17T06:30:00.000Z';

describe('WorkspaceTab', () => {
  it('keeps its connection binding when a SQL draft changes', () => {
    const tab = createSqlWorkspaceTab('profile-1', {
      id: 'tab-1',
      sessionId: 'session-1',
      now
    });

    const updated = updateSqlWorkspaceTabDraft(tab, 'SELECT * FROM users;');

    expect(updated.binding).toEqual({
      profileId: 'profile-1',
      sessionId: 'session-1'
    });
    expect(updated.draft.sql).toBe('SELECT * FROM users;');
    expect(updated.dirty).toBe(true);
  });

  it('marks a restored SQL draft as unsaved', () => {
    const tab = createSqlWorkspaceTab('profile-1', {
      sql: 'SELECT 1;',
      now
    });

    expect(tab.dirty).toBe(true);
  });

  it('stores the schema and table for table tabs', () => {
    const tab = createTableWorkspaceTab('profile-1', 'users', {
      id: 'tab-2',
      kind: 'table-structure',
      schema: 'public',
      now
    });

    expect(tab.kind).toBe('table-structure');
    expect(tab.object).toEqual({
      schema: 'public',
      table: 'users'
    });
    expect(tab.dirty).toBe(false);
  });

  it('preserves the profile origin but clears a deleted profile session', () => {
    const tab = createSqlWorkspaceTab('profile-1', {
      id: 'tab-1',
      sessionId: 'session-1',
      sql: 'SELECT 1;',
      now
    });

    const orphanedTab = markWorkspaceTabProfileDeleted(tab);

    expect(orphanedTab.availability).toBe('profile-deleted');
    expect(orphanedTab.binding).toEqual({
      profileId: 'profile-1',
      sessionId: null
    });
    expect(orphanedTab).toMatchObject({
      dirty: true,
      draft: { sql: 'SELECT 1;' }
    });
  });
});
