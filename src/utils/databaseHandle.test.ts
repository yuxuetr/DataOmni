import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { opensOwnPool } from './databaseHandle';

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
