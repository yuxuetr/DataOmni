import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const pluginClose = vi.fn(async () => true);
vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async (path: string) => ({ path, select: vi.fn(), close: pluginClose }) }
}));

const { openDatabase, opensOwnPool } = await import('./databaseHandle');

/** 后端 `sqlx_pool::handles` 认的那几个 scheme，直接从源码里读 */
function backendSchemes(): string[] {
  const source = readFileSync('src-tauri/src/services/sqlx_pool.rs', 'utf8');
  const list = source.match(/pub fn handles[\s\S]*?\[([^\]]+)\]/)?.[1] ?? '';
  return [...list.matchAll(/"([a-z]+):\/\/"/g)].map((match) => match[1]);
}

describe('哪些连接的池子由后端开', () => {
  it('和后端认的是同一组 scheme', () => {
    const schemes = backendSchemes();
    expect(schemes.length).toBeGreaterThan(0);
    for (const scheme of schemes) {
      expect(opensOwnPool(`${scheme}://u:p@h/db`), scheme).toBe(true);
    }
  });

  it('SQLite 仍走插件，SQL Server / Oracle 走各自的后端命令', () => {
    expect(opensOwnPool('sqlite:/tmp/a.db')).toBe(false);
    expect(opensOwnPool('sqlserver://h')).toBe(false);
    expect(opensOwnPool('oracle://h')).toBe(false);
  });
});

describe('SQLite 句柄', () => {
  it('关的时候只关自己：插件的 close() 不带库名会关掉所有 SQLite 池子', async () => {
    const handle = await openDatabase('sqlite:/tmp/other.db');
    await handle.close();
    expect(pluginClose).toHaveBeenCalledWith('sqlite:/tmp/other.db');
  });
});
