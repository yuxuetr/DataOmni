import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 发版打包时 `tauri.oracle.conf.json` 合并到主配置上，而合并对数组是整个换掉：
 * 主配置里声明的 Linux 依赖，Oracle 那份不重写一遍，CI 打出的包里就没有。
 *
 * 主配置里的 `ca-certificates` 就是这样的：reqwest 读系统根证书，最小安装的 Ubuntu 22.04
 * 没有它时，检查更新、Elasticsearch / ClickHouse 的 HTTPS 与 AI 请求都在建客户端那一步失败。
 */
type LinuxDepends = { deb?: { depends?: string[] }; rpm?: { depends?: string[] } };

function linuxDepends(path: string): LinuxDepends {
  return JSON.parse(readFileSync(path, 'utf8')).bundle?.linux ?? {};
}

function missingAfterMerge(base: LinuxDepends, overlay: LinuxDepends): string[] {
  return (['deb', 'rpm'] as const).flatMap((kind) => {
    const merged = overlay[kind]?.depends ?? base[kind]?.depends ?? [];
    return (base[kind]?.depends ?? []).filter((name) => !merged.includes(name)).map((name) => `${kind}: ${name}`);
  });
}

describe('Linux 包的依赖经得起合并', () => {
  it('判据能看出被换掉的依赖', () => {
    const base = { deb: { depends: ['ca-certificates'] }, rpm: { depends: ['ca-certificates'] } };
    expect(missingAfterMerge(base, { deb: { depends: ['libaio1'] } })).toEqual(['deb: ca-certificates']);
    expect(missingAfterMerge(base, { rpm: { depends: ['libaio', 'ca-certificates'] } })).toEqual([]);
  });

  it('Oracle 那份配置保留主配置声明的依赖', () => {
    const base = linuxDepends('src-tauri/tauri.conf.json');
    expect(base.deb?.depends).toContain('ca-certificates');
    expect(missingAfterMerge(base, linuxDepends('src-tauri/tauri.oracle.conf.json'))).toEqual([]);
  });
});
