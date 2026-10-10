import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RUST_ROOT = fileURLToPath(new URL('../../src-tauri/src', import.meta.url));

/** 每个 .rs 文件去掉 `#[cfg(test)]` 之后的部分：测试里打印什么都行 */
function rustSources(): { file: string; source: string }[] {
  return readdirSync(RUST_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.rs'))
    .map((file) => {
      const lines = readFileSync(join(RUST_ROOT, file), 'utf8').split('\n');
      const testsFrom = lines.findIndex((line) => line.trim().startsWith('#[cfg(test)]'));
      return { file, source: (testsFrom === -1 ? lines : lines.slice(0, testsFrom)).join('\n') };
    });
}

describe('后端的日志', () => {
  // 打包版没有控制台：macOS 从 Finder 打开、Windows 双击图标，标准输出谁也看不到。
  // 要留下来给人看的走 `log::`，进日志文件。
  // 命令行（`src-tauri/src/cli/`）例外：它是从终端或 Agent 调起的，stdout 与 stderr 就是它的输出
  // （`rfcs/agent-cli.md` §7）。`dbg!` 哪里都不行
  it('不往标准输出打印', () => {
    const offenders = rustSources().flatMap(({ file, source }) => {
      const printing = file.startsWith(`cli${sep}`) ? /\bdbg!\(/g : /\b(?:println|eprintln|dbg)!\(/g;
      return [...source.matchAll(printing)].map(() => file);
    });
    expect(offenders).toEqual([]);
  });

  // 日志文件会被贴进 issue。口令一类的值连变量名都不该出现在日志宏的参数里，
  // 要记连接串就先过 `redact_connection_string`
  it('日志宏的参数里没有口令一类的值', () => {
    const offenders = rustSources().flatMap(({ file, source }) =>
      [...source.matchAll(/\b(?:log::)?(?:trace|debug|info|warn|error)!\(([\s\S]*?)\);/g)]
        .map((match) => match[1] ?? '')
        .filter((args) => /password|passwd|secret|api_?key|token/i.test(args))
        .map((args) => `${file}: ${args.trim()}`)
    );
    expect(offenders).toEqual([]);
  });
});
