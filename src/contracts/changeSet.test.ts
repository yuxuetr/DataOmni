import { describe, expect, it } from 'vitest';
import {
  completeChangeSetCommit,
  createChangeSet,
  stageDelete,
  stageInsert,
  stageUpdate,
  startChangeSetCommit
} from './changeSet';

const target = {
  profileId: 'profile-1',
  sessionId: 'session-1',
  schema: 'public',
  table: 'users'
};

const originalRow = {
  keyValues: {
    tenant_id: 7,
    id: { type: 'bigint' as const, value: '9007199254740993' }
  },
  originalValues: {
    tenant_id: 7,
    id: { type: 'bigint' as const, value: '9007199254740993' },
    name: 'Ada'
  }
};

describe('ChangeSet', () => {
  it('stages inserts, updates, and deletes against one fixed target', () => {
    const empty = createChangeSet('result-set-1', target, {
      id: 'change-set-1',
      now: '2026-09-17T06:30:00.000Z'
    });
    const withInsert = stageInsert(
      empty,
      { tenant_id: 7, name: 'Grace' },
      { id: 'change-1' },
      '2026-09-17T06:30:01.000Z'
    );
    const withUpdate = stageUpdate(
      withInsert,
      originalRow,
      { name: 'Ada Lovelace' },
      { id: 'change-2' },
      '2026-09-17T06:30:02.000Z'
    );
    const withDelete = stageDelete(
      withUpdate,
      originalRow,
      { id: 'change-3' },
      '2026-09-17T06:30:03.000Z'
    );

    expect(withDelete.target).toEqual(target);
    expect(withDelete.changes.map(change => change.kind)).toEqual([
      'insert',
      'update',
      'delete'
    ]);
    expect(withDelete.changes[1]).toMatchObject({
      kind: 'update',
      row: {
        keyValues: {
          tenant_id: 7,
          id: { type: 'bigint', value: '9007199254740993' }
        }
      }
    });
  });

  it('requires real key metadata for updates and deletes', () => {
    const changeSet = createChangeSet('result-set-1', target);

    expect(() =>
      stageUpdate(
        changeSet,
        { keyValues: {}, originalValues: { name: 'Ada' } },
        { name: 'Grace' }
      )
    ).toThrow('至少一个键列');
  });

  it('tracks the commit lifecycle and affected rows', () => {
    const empty = createChangeSet('result-set-1', target, {
      id: 'change-set-1',
      now: '2026-09-17T06:30:00.000Z'
    });
    const staged = stageUpdate(
      empty,
      originalRow,
      { name: 'Ada Lovelace' },
      { id: 'change-1' },
      '2026-09-17T06:30:01.000Z'
    );
    const committing = startChangeSetCommit(staged, '2026-09-17T06:30:02.000Z');
    const committed = completeChangeSetCommit(
      committing,
      1,
      '2026-09-17T06:30:02.100Z'
    );

    expect(committed.status).toBe('committed');
    expect(committed.commit).toEqual({
      startedAt: '2026-09-17T06:30:02.000Z',
      finishedAt: '2026-09-17T06:30:02.100Z',
      affectedRows: 1,
      error: null
    });
  });

  it('does not allow empty change sets to look committed', () => {
    const changeSet = createChangeSet('result-set-1', target, {
      id: 'change-set-1'
    });

    expect(() => startChangeSetCommit(changeSet)).toThrow('空变更集无法提交');
  });
});
