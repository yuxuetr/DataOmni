import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 遍历 src 下所有 .ts / .tsx，测试文件除外 */
function sourceFiles(): Array<[string, string]> {
  const root = new URL('../..', import.meta.url).pathname;
  const found: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push([path.slice(root.length), readFileSync(path, 'utf8')]);
      }
    }
  };
  walk(join(root, 'src'));
  return found;
}

/** 从 `@tauri-apps/plugin-dialog` 引进来的名字 */
function importedFromDialogPlugin(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@tauri-apps\/plugin-dialog['"]/g)) {
    names.push(...match[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0]).filter(Boolean));
  }
  return names;
}

describe('系统对话框', () => {
  it('不用插件的 confirm / ask / message：打包版在 macOS 上它们不弹框', () => {
    // 2026-09-24 实测：点侧边栏的「删除连接」什么都不发生，窗口列表里也没有那个框，
    // Promise 不回来——那个连接一直删不掉。要问「是或否」用 `useConfirmPrompt`。
    // 文件选择（open / save）不受影响，照常用
    const offenders = sourceFiles().flatMap(([path, source]) =>
      importedFromDialogPlugin(source)
        .filter((name) => ['confirm', 'ask', 'message'].includes(name))
        .map((name) => `${path}: ${name}`));
    expect(offenders).toEqual([]);
  });

  it('这道门认得出一次违规', () => {
    expect(importedFromDialogPlugin("import { confirm } from '@tauri-apps/plugin-dialog';")).toEqual(['confirm']);
    expect(importedFromDialogPlugin("import { open, ask as askUser } from \"@tauri-apps/plugin-dialog\";"))
      .toEqual(['open', 'ask']);
  });
});
