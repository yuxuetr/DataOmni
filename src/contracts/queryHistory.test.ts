import { describe, expect, it } from 'vitest';
import {
  completeQueryExecution,
  createQueryExecution,
  failQueryExecution,
  cancelQueryExecution,
  requestQueryExecutionCancellation,
  startQueryExecution,
  type QueryExecution
} from './queryExecution';
import type { DatabaseSession } from './session';
import { annotateEntry, historyEntryFromExecution, isAnnotated, normalizeTags } from './queryHistory';

const SESSION = {
  id: 's1',
  profileId: 'p1',
  database: 'app'
} as DatabaseSession;

const CONTEXT = { connectionName: '本地 MySQL', rowsAffected: 7 };

function running(sql: string): QueryExecution {
  return startQueryExecution(createQueryExecution('tab-1', sql, SESSION, 'mysql'));
}

describe('historyEntryFromExecution', () => {
  it('记下时间、连接、数据库、SQL、耗时、状态和影响行数', () => {
    const entry = historyEntryFromExecution(
      completeQueryExecution(running('SELECT * FROM orders'), ['result:1']),
      CONTEXT
    );

    expect(entry).toMatchObject({
      connectionName: '本地 MySQL',
      database: 'app',
      profileId: 'p1',
      sql: 'SELECT * FROM orders',
      status: 'succeeded',
      rowsAffected: 7
    });
    expect(typeof entry?.startedAt).toBe('string');
    expect(typeof entry?.durationMs).toBe('number');
  });

  it('还在跑的执行不进历史', () => {
    expect(historyEntryFromExecution(running('SELECT 1'), CONTEXT)).toBeNull();
    expect(
      historyEntryFromExecution(createQueryExecution('tab-1', 'SELECT 1', SESSION, 'mysql'), CONTEXT)
    ).toBeNull();
  });

  it('失败的执行照记，并带上数据库说的那句话', () => {
    const entry = historyEntryFromExecution(
      failQueryExecution(running('SELECT * FROM missing'), {
        message: 'relation "missing" does not exist',
        code: '42P01'
      }),
      { ...CONTEXT, rowsAffected: null }
    );

    expect(entry?.status).toBe('failed');
    expect(entry?.errorMessage).toBe('relation "missing" does not exist');
  });

  it('取消与超时的影响行数是 null 而不是 0', () => {
    const cancelled = historyEntryFromExecution(
      cancelQueryExecution(requestQueryExecutionCancellation(running('DELETE FROM big'))),
      CONTEXT
    );
    // 0 会被读成「一行都没删」，而事实是不知道删了几行
    expect(cancelled?.rowsAffected).toBeNull();

    const timedOut = historyEntryFromExecution(
      failQueryExecution(running('SELECT pg_sleep(60)'), { message: '超时' }, undefined, 'timed-out'),
      CONTEXT
    );
    expect(timedOut?.rowsAffected).toBeNull();
  });

  it('SQL 里的口令在入库前就被换掉，并标出不能原样重跑', () => {
    const entry = historyEntryFromExecution(
      completeQueryExecution(running("CREATE USER a IDENTIFIED BY 'hunter2'"), []),
      CONTEXT
    );

    expect(entry?.sql).toBe("CREATE USER a IDENTIFIED BY '***'");
    expect(entry?.sql).not.toContain('hunter2');
    expect(entry?.redacted).toBe(true);
  });

  it('记录里没有任何承载结果行的字段', () => {
    const entry = historyEntryFromExecution(
      completeQueryExecution(running('SELECT * FROM orders'), ['result:1']),
      CONTEXT
    );

    // 写死一份字段清单：以后谁往记录里塞 rows / result / columns，这条会红。
    // 结果进 localStorage 既撑配额又留下一份过期数据，是这个模块的底线
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      [
        'connectionName',
        'database',
        'durationMs',
        'errorMessage',
        'id',
        'profileId',
        'redacted',
        'rowsAffected',
        'sql',
        'startedAt',
        'status'
      ].sort()
    );
  });
});

describe('isAnnotated', () => {
  const base = {
    id: 'a',
    startedAt: '2026-09-21T00:00:00.000Z',
    profileId: 'p1',
    connectionName: 'c',
    database: null,
    sql: 'SELECT 1',
    redacted: false,
    durationMs: 1,
    status: 'succeeded' as const,
    rowsAffected: 1
  };

  it('收藏、命名、打标签任意一项都算标注过', () => {
    expect(isAnnotated(base)).toBe(false);
    expect(isAnnotated({ ...base, favorite: true })).toBe(true);
    expect(isAnnotated({ ...base, name: '对账' })).toBe(true);
    expect(isAnnotated({ ...base, tags: ['日常'] })).toBe(true);
  });

  it('空名字和空标签不算', () => {
    expect(isAnnotated({ ...base, name: '', tags: [], favorite: false })).toBe(false);
  });
});

describe('normalizeTags', () => {
  it('去空白、丢空项', () => {
    expect(normalizeTags('  对账 , ,财务  ')).toEqual(['对账', '财务']);
    expect(normalizeTags('   ')).toEqual([]);
  });

  it('忽略大小写去重，保留先出现那个的写法', () => {
    // 用户看不出 `SQL` 和 `sql` 的差别，却会得到两个筛不到一起的标签
    expect(normalizeTags('SQL, sql, Sql')).toEqual(['SQL']);
  });
});

describe('annotateEntry', () => {
  const base = {
    id: 'a',
    startedAt: '2026-09-21T00:00:00.000Z',
    profileId: 'p1',
    connectionName: 'c',
    database: null,
    sql: 'SELECT 1',
    redacted: false,
    durationMs: 1,
    status: 'succeeded' as const,
    rowsAffected: 1
  };

  it('只改传进来的那几项', () => {
    const named = annotateEntry(base, { name: '对账' });
    expect(named.name).toBe('对账');
    expect(named.favorite).toBeUndefined();

    const starred = annotateEntry(named, { favorite: true });
    expect(starred.name).toBe('对账');
    expect(starred.favorite).toBe(true);
  });

  it('清空标注后这条记录不再算「标注过」', () => {
    // 留下 '' 或 [] 会让 isAnnotated 继续为真，于是这条记录永远不过期，
    // 而用户以为自己已经把标注取消了
    const annotated = annotateEntry(base, { favorite: true, name: '对账', tags: ['财务'] });
    expect(isAnnotated(annotated)).toBe(true);

    const cleared = annotateEntry(annotated, { favorite: false, name: '   ', tags: [] });
    expect(cleared.name).toBeUndefined();
    expect(cleared.tags).toBeUndefined();
    expect(cleared.favorite).toBeUndefined();
    expect(isAnnotated(cleared)).toBe(false);
  });

  it('不改原对象', () => {
    annotateEntry(base, { favorite: true });
    expect(base).not.toHaveProperty('favorite');
  });
});
