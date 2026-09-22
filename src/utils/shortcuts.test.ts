import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SHORTCUTS,
  detectPlatform,
  formatShortcut,
  hasCommandModifier,
  matchesShortcut,
  type Shortcut,
  type ShortcutEvent
} from './shortcuts';

function press(key: string, held: Partial<Omit<ShortcutEvent, 'key'>> = {}): ShortcutEvent {
  return { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...held };
}

describe('平台识别', () => {
  // 另外两个平台的取值本机验不了，只能把真实字符串钉在这里
  it('三个平台的 navigator.platform 实际取值', () => {
    expect(detectPlatform('MacIntel')).toBe('mac');
    expect(detectPlatform('Win32')).toBe('other');
    expect(detectPlatform('Linux x86_64')).toBe('other');
  });

  it('Chromium 的 userAgentData.platform 取值', () => {
    expect(detectPlatform('macOS')).toBe('mac');
    expect(detectPlatform('Windows')).toBe('other');
    expect(detectPlatform('Linux')).toBe('other');
  });

  it('兜底到 UA 串时也认得出来', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac');
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('other');
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('other');
  });
});

describe('命令键按平台独占判定', () => {
  it('mac 上认 ⌘ 不认 ⌃', () => {
    expect(matchesShortcut(press('k', { metaKey: true }), SHORTCUTS.commandPalette, 'mac')).toBe(true);
    // ⌃K 在 macOS 的文本框里是「删到行尾」，抢过来会让人在输入时莫名弹出面板
    expect(matchesShortcut(press('k', { ctrlKey: true }), SHORTCUTS.commandPalette, 'mac')).toBe(false);
  });

  it('其余平台认 Ctrl 不认 Win 键', () => {
    expect(matchesShortcut(press('k', { ctrlKey: true }), SHORTCUTS.commandPalette, 'other')).toBe(true);
    expect(matchesShortcut(press('k', { metaKey: true }), SHORTCUTS.commandPalette, 'other')).toBe(false);
  });

  it('两个修饰键一起按下不算命中', () => {
    expect(matchesShortcut(press('k', { metaKey: true, ctrlKey: true }), SHORTCUTS.commandPalette, 'mac'))
      .toBe(false);
  });

  it('多按一个 Shift 或 Alt 就不是同一个组合', () => {
    expect(matchesShortcut(press('k', { metaKey: true, shiftKey: true }), SHORTCUTS.commandPalette, 'mac'))
      .toBe(false);
    expect(matchesShortcut(press('k', { metaKey: true, altKey: true }), SHORTCUTS.commandPalette, 'mac'))
      .toBe(false);
  });

  it('要 Shift 的组合缺了 Shift 也不算', () => {
    expect(matchesShortcut(press('t', { metaKey: true, shiftKey: true }), SHORTCUTS.reopenClosedTab, 'mac'))
      .toBe(true);
    expect(matchesShortcut(press('t', { metaKey: true }), SHORTCUTS.reopenClosedTab, 'mac')).toBe(false);
  });

  it('按住 Shift 时 event.key 是大写，仍要命中', () => {
    // macOS 上 ⇧⌘T 的 key 是 'T' 不是 't'
    expect(matchesShortcut(press('T', { metaKey: true, shiftKey: true }), SHORTCUTS.reopenClosedTab, 'mac'))
      .toBe(true);
  });

  it('不带命令键的组合不会被任何命令键组合命中', () => {
    expect(matchesShortcut(press(' ', { shiftKey: true }), SHORTCUTS.copyRow, 'mac')).toBe(true);
    expect(matchesShortcut(press(' ', { shiftKey: true, metaKey: true }), SHORTCUTS.copyRow, 'mac'))
      .toBe(false);
  });

  it('hasCommandModifier 只问命令键，不管 Shift', () => {
    expect(hasCommandModifier({ metaKey: true, ctrlKey: false }, 'mac')).toBe(true);
    expect(hasCommandModifier({ metaKey: false, ctrlKey: true }, 'mac')).toBe(false);
    expect(hasCommandModifier({ metaKey: false, ctrlKey: true }, 'other')).toBe(true);
    expect(hasCommandModifier({ metaKey: true, ctrlKey: false }, 'other')).toBe(false);
  });
});

describe('提示文字按平台写', () => {
  it('mac 用符号且不带分隔符', () => {
    expect(formatShortcut(SHORTCUTS.commandPalette, 'mac')).toBe('⌘K');
    expect(formatShortcut(SHORTCUTS.copyWithHeaders, 'mac')).toBe('⇧⌘C');
    expect(formatShortcut(SHORTCUTS.runAll, 'mac')).toBe('⇧⌘⏎');
    expect(formatShortcut(SHORTCUTS.copyColumn, 'mac')).toBe('⌥Space');
  });

  it('其余平台写全名用加号', () => {
    expect(formatShortcut(SHORTCUTS.commandPalette, 'other')).toBe('Ctrl+K');
    expect(formatShortcut(SHORTCUTS.copyWithHeaders, 'other')).toBe('Ctrl+Shift+C');
    expect(formatShortcut(SHORTCUTS.runAll, 'other')).toBe('Ctrl+Shift+Enter');
    expect(formatShortcut(SHORTCUTS.copyColumn, 'other')).toBe('Alt+Space');
  });

  it('macOS 的修饰键顺序是 ⌥⇧⌘', () => {
    const all: Shortcut = { key: 'x', mod: true, shift: true, alt: true };
    expect(formatShortcut(all, 'mac')).toBe('⌥⇧⌘X');
    expect(formatShortcut(all, 'other')).toBe('Ctrl+Alt+Shift+X');
  });

  it('每一条都能画出来，没有空修饰或原样吐出的键名', () => {
    for (const [name, shortcut] of Object.entries(SHORTCUTS)) {
      for (const platform of ['mac', 'other'] as const) {
        const text = formatShortcut(shortcut, platform);
        expect(text.length, `${name} 在 ${platform} 上画不出来`).toBeGreaterThan(0);
        expect(text, `${name} 在 ${platform} 上漏了修饰键`).not.toMatch(/^[A-Z]$/);
      }
    }
  });
});

/** 遍历 src 下所有 .ts / .tsx */
function sourceFiles(): Array<[string, string]> {
  const root = new URL('../..', import.meta.url).pathname;
  const found: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push([path.slice(root.length), readFileSync(path, 'utf8')]);
      }
    }
  };
  walk(join(root, 'src'));
  return found;
}

describe('两个平台的差异只许出现在这一个文件里', () => {
  it('别处不许直接读 metaKey / ctrlKey', () => {
    // 散在各组件里的 `metaKey || ctrlKey` 是数不清的，而「完整支持两个平台」
    // 这句话只有在能数清时才检查得了。新加一个快捷键请往 SHORTCUTS 里加。
    const offenders = sourceFiles()
      .filter(([file]) => !/^src\/utils\/shortcuts(\.test)?\.ts$/.test(file))
      .filter(([, source]) => /\b(metaKey|ctrlKey)\b/.test(source))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('文案里不许写死 macOS 的符号', () => {
    // Windows 上界面写着 ⌘C、要按的是 Ctrl+C——不报错，只是印着假的。
    // 要在文案里提快捷键就留 {shortcut} 占位符，由 formatShortcut 填。
    //
    // 转义写法一起扫：第一版只认字面量，而 en.ts 里那条恰恰写成 \u2318，
    // 门开着却放它过去了——只认一种写法的门，等于只挡得住写得明显的那些
    const offenders = sourceFiles()
      .filter(([file]) => /^src\/i18n\/(zh|en)\.ts$/.test(file))
      .flatMap(([file, source]) =>
        source.split('\n')
          .map((line, index): [string, number, string] => [file, index + 1, line])
          .filter(([, , line]) => /[⌘⇧⌥⌃⏎]|\\u(?:2318|21e7|2325|2303|23ce)/i.test(line))
          .map(([f, n, line]) => `${f}:${n} ${line.trim()}`)
      );
    expect(offenders).toEqual([]);
  });
});
