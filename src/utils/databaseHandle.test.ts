import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}));

const { openDatabase, opensOwnPool } = await import('./databaseHandle');

/** 后端 `sqlx_pool::handles` 认的那几个 scheme，直接从源码里读 */
function backendSchemes(): string[] {
  const source = readFileSync('src-tauri/src/services/sqlx_pool.rs', 'utf8');
  const list = source.match(/pub fn handles[\s\S]*?\[([^\]]+)\]/)?.[1] ?? '';
  return [...list.matchAll(/"([a-z]+:(?:\/\/)?)"/g)].map((match) => match[1]);
}

describe('哪些连接的池子由后端开', () => {
  it('和后端认的是同一组 scheme', () => {
    const schemes = backendSchemes();
    expect(schemes).toContain('sqlite:');
    for (const scheme of schemes) {
      const sample = scheme.endsWith('://') ? `${scheme}u:p@h/db` : `${scheme}/tmp/a.db`;
      expect(opensOwnPool(sample), scheme).toBe(true);
    }
  });

  it('SQL Server / Oracle 走各自的后端命令', () => {
    expect(opensOwnPool('sqlserver://h')).toBe(false);
    expect(opensOwnPool('oracle://h')).toBe(false);
  });
});

describe('SQLite 句柄', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(true);
  });

  it('走后端 sqlx 池且关的时候只按自身连接串关，不影响其他 SQLite 句柄', async () => {
    const handle = await openDatabase('sqlite:/tmp/other.db');
    expect(invokeMock).toHaveBeenCalledWith('open_database_pool', { connectionString: 'sqlite:/tmp/other.db' });
    await handle.close();
    expect(invokeMock).toHaveBeenCalledWith('close_sqlx_pool', { connectionString: 'sqlite:/tmp/other.db' });
  });
});
