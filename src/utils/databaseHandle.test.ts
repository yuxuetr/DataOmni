import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('Tauri 安全边界配置', () => {
  it('capabilities 不开放任何 sql:* 前端权限，且 tauri.conf.json 启用了 CSP', () => {
    const capability = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8')) as {
      permissions: string[];
    };
    expect(capability.permissions.filter((permission) => permission.startsWith('sql:'))).toEqual([]);

    const tauriConfig = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
      app?: { security?: { csp?: string | null } };
    };
    const csp = tauriConfig.app?.security?.csp ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
  });
  // 权限和前端依赖都要有消费者：插件的 JS 包在 src 里没人 import，前端就调不到它的命令，
  // 那条权限只是白白放大一旦脚本注入后能做的事（opener / window-state 都是这样留下来的）
  it('每条插件权限和每个 @tauri-apps/plugin-* 依赖都在 src 里有 import', () => {
    const imported = new Set(
      [...readdirSync('src', { recursive: true, encoding: 'utf8' })]
        .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
        .flatMap((file) => [...readFileSync(join('src', file), 'utf8').matchAll(/@tauri-apps\/plugin-([a-z-]+)/g)])
        .map((match) => match[1])
    );
    const capability = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8')) as {
      permissions: string[];
    };
    const pluginsWithPermission = capability.permissions
      .map((permission) => permission.split(':')[0])
      .filter((plugin) => plugin !== 'core');
    expect(pluginsWithPermission.filter((plugin) => !imported.has(plugin))).toEqual([]);

    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
    const pluginDependencies = Object.keys(manifest.dependencies)
      .filter((name) => name.startsWith('@tauri-apps/plugin-'))
      .map((name) => name.slice('@tauri-apps/plugin-'.length));
    expect(pluginDependencies.filter((plugin) => !imported.has(plugin))).toEqual([]);
  });
});
