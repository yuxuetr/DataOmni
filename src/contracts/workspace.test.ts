import { describe, expect, it } from 'vitest';
import {
  createSqlWorkspaceTab,
  createTableWorkspaceTab,
  markWorkspaceTabProfileDeleted,
  updateSqlWorkspaceTabDraft,
  workspaceTabId
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

describe('workspaceTabId', () => {
  it('为同一个连接的同一个对象生成稳定的身份', () => {
    const first = workspaceTabId('profile-1', 'table-data', { schema: 'public', table: 'users' });
    const second = workspaceTabId('profile-1', 'table-data', { schema: 'public', table: 'users' });

    expect(first).toBe(second);
  });

  it('区分连接、标签类型、schema 和表名', () => {
    const base = workspaceTabId('profile-1', 'table-data', { schema: 'public', table: 'users' });

    expect(workspaceTabId('profile-2', 'table-data', { schema: 'public', table: 'users' })).not.toBe(base);
    expect(workspaceTabId('profile-1', 'table-structure', { schema: 'public', table: 'users' })).not.toBe(base);
    expect(workspaceTabId('profile-1', 'table-data', { schema: 'other', table: 'users' })).not.toBe(base);
    expect(workspaceTabId('profile-1', 'table-data', { schema: 'public', table: 'orders' })).not.toBe(base);
  });

  it('没有 schema 的表不会与 schema 为空串的表混淆边界', () => {
    expect(workspaceTabId('p', 'table-data', { schema: null, table: 'users' }))
      .toBe(workspaceTabId('p', 'table-data', { schema: '', table: 'users' }));
  });

  it('SQL 标签的身份只由连接决定', () => {
    expect(workspaceTabId('profile-1', 'sql')).toBe('profile-1:sql');
    expect(workspaceTabId('profile-1', 'sql')).not.toBe(workspaceTabId('profile-2', 'sql'));
  });
});
