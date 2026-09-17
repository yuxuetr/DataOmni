import { describe, expect, it } from 'vitest';
import {
  cancelQueryExecution,
  completeQueryExecution,
  createQueryExecution,
  failQueryExecution,
  requestQueryExecutionCancellation,
  startQueryExecution
} from './queryExecution';
import { DatabaseSession } from './session';

const session: DatabaseSession = {
  id: 'session-1',
  profileId: 'profile-1',
  database: 'app',
  connectedAt: '2026-09-17T06:00:00.000Z',
  capabilities: {
    schemas: true,
    transactions: true,
    cancellation: true,
    explain: true,
    dataEditing: true
  },
  transaction: {
    status: 'idle',
    startedAt: null
  }
};

describe('QueryExecution', () => {
  it('captures immutable SQL and session snapshots', () => {
    const execution = createQueryExecution(
      'tab-1',
      'SELECT * FROM users;',
      session,
      'postgresql',
      {
        id: 'execution-1',
        now: '2026-09-17T06:30:00.000Z'
      }
    );

    expect(execution.sqlSnapshot).toBe('SELECT * FROM users;');
    expect(execution.dialect).toBe('postgresql');
    expect(execution.session).toEqual({
      profileId: 'profile-1',
      sessionId: 'session-1',
      database: 'app'
    });
    expect(execution.status).toBe('queued');
  });

  it('records real lifecycle timing and result references', () => {
    const queued = createQueryExecution('tab-1', 'SELECT 1;', session, 'postgresql', {
      id: 'execution-1',
      now: '2026-09-17T06:30:00.000Z'
    });
    const running = startQueryExecution(queued, '2026-09-17T06:30:01.000Z');
    const completed = completeQueryExecution(
      running,
      ['result-set-1'],
      '2026-09-17T06:30:01.125Z'
    );

    expect(completed.status).toBe('succeeded');
    expect(completed.durationMs).toBe(125);
    expect(completed.resultSetIds).toEqual(['result-set-1']);
    expect(completed.error).toBeNull();
  });

  it('tracks cancellation requests and acknowledgement separately', () => {
    const queued = createQueryExecution('tab-1', 'SELECT pg_sleep(10);', session, 'postgresql');
    const running = startQueryExecution(queued, '2026-09-17T06:30:01.000Z');
    const requested = requestQueryExecutionCancellation(
      running,
      '2026-09-17T06:30:02.000Z'
    );
    const cancelled = cancelQueryExecution(requested, '2026-09-17T06:30:02.100Z');

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellation).toEqual({
      requestedAt: '2026-09-17T06:30:02.000Z',
      acknowledgedAt: '2026-09-17T06:30:02.100Z'
    });
    expect(cancelled.durationMs).toBe(1100);
  });

  it('keeps structured failure details', () => {
    const queued = createQueryExecution('tab-1', 'SELECT missing;', session, 'postgresql');
    const running = startQueryExecution(queued, '2026-09-17T06:30:01.000Z');
    const failed = failQueryExecution(
      running,
      {
        code: '42703',
        message: 'column "missing" does not exist'
      },
      '2026-09-17T06:30:01.050Z'
    );

    expect(failed.status).toBe('failed');
    expect(failed.error).toEqual({
      code: '42703',
      message: 'column "missing" does not exist'
    });
    expect(failed.durationMs).toBe(50);
  });
});
