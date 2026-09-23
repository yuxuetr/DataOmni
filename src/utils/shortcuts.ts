/**
 * 快捷键：一处声明，两处消费——判定按键和画出提示。
 *
 * 分成两件事是因为此前只做对了一件。判定处处写的是
 * `event.metaKey || event.ctrlKey`，两个平台都能按出来；而提示是把 `⌘C`
 * 直接写进了文案。于是 Windows 上界面写着 ⌘C，要按的却是 Ctrl+C——
 * **能用但写着假的**，比按不出来更难被发现，因为它不报错。
 *
 * 「命令键」按平台**独占**判定，不是两个都认：macOS 上 ⌃K 是文本框里
 * 「删到行尾」的系统绑定，Windows 上 Win+K 是投屏，两边都不该被这个应用抢走。
 */

export type ShortcutPlatform = 'mac' | 'other';

export interface Shortcut {
  /** 与 `KeyboardEvent.key` 比对，字母不分大小写 */
  key: string;
  /** 命令键：macOS 的 ⌘，其余平台的 Ctrl */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** 判定只需要这四个字段，传整个 KeyboardEvent 或 React 的合成事件都行 */
export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * 从平台标识里认出 macOS。
 *
 * 单独抽出来是因为这是整个模块唯一没法在本机验证的部分——另外两个平台的
 * 真实取值只能拿字符串喂进来断言。见 `shortcuts.test.ts` 里三个平台的实测值。
 */
export function detectPlatform(source: string): ShortcutPlatform {
  return /mac/i.test(source) ? 'mac' : 'other';
}

export function currentPlatform(): ShortcutPlatform {
  if (typeof navigator === 'undefined') {
    return 'other';
  }
  // `userAgentData` 只有 Chromium 系有（Windows 的 WebView2 有，
  // macOS 的 WKWebView 和 Linux 的 WebKitGTK 没有）；`platform` 虽已废弃但
  // 三个平台的 webview 都还在给值，比从 UA 串里猜稳
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  return detectPlatform(data?.platform || navigator.platform || navigator.userAgent);
}

export function matchesShortcut(
  event: ShortcutEvent,
  shortcut: Shortcut,
  platform: ShortcutPlatform = currentPlatform()
): boolean {
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) {
    return false;
  }

  const mac = platform === 'mac';
  const commandKey = mac ? event.metaKey : event.ctrlKey;
  // 另一个修饰键按下时不算命中：⌃⌘K 和 ⌘K 是两个组合，前者多半是系统或
  // 第三方占着的，替人家做决定不合适
  const otherKey = mac ? event.ctrlKey : event.metaKey;

  return commandKey === Boolean(shortcut.mod)
    && !otherKey
    && event.shiftKey === Boolean(shortcut.shift)
    && event.altKey === Boolean(shortcut.alt);
}

/** 方向键这类要和 Shift 自由组合的，只问命令键按没按 */
export function hasCommandModifier(
  event: Pick<ShortcutEvent, 'metaKey' | 'ctrlKey'>,
  platform: ShortcutPlatform = currentPlatform()
): boolean {
  return platform === 'mac' ? event.metaKey : event.ctrlKey;
}

/** 不是字母的键在两个平台各有各的写法，差一个就得在这里补一行 */
const KEY_LABELS: Record<string, { mac: string; other: string }> = {
  enter: { mac: '⏎', other: 'Enter' },
  ' ': { mac: 'Space', other: 'Space' },
  escape: { mac: 'Esc', other: 'Esc' }
};

export function formatShortcut(
  shortcut: Shortcut,
  platform: ShortcutPlatform = currentPlatform()
): string {
  const mac = platform === 'mac';
  const label = KEY_LABELS[shortcut.key.toLowerCase()];
  const keyText = label ? (mac ? label.mac : label.other) : shortcut.key.toUpperCase();

  // 修饰键的顺序是各平台的惯例，不是随手排的：macOS 是 ⌃⌥⇧⌘，
  // Windows 惯例把 Ctrl 放最前
  if (mac) {
    return [
      shortcut.alt ? '⌥' : '',
      shortcut.shift ? '⇧' : '',
      shortcut.mod ? '⌘' : '',
      keyText
    ].join('');
  }

  const parts: string[] = [];
  if (shortcut.mod) parts.push('Ctrl');
  if (shortcut.alt) parts.push('Alt');
  if (shortcut.shift) parts.push('Shift');
  parts.push(keyText);
  return parts.join('+');
}

/** 原生菜单「Close Tab」发给前端的事件，与 `app_menu.rs` 的 `CLOSE_TAB_EVENT` 一致 */
export const CLOSE_TAB_MENU_EVENT = 'menu://close-tab';

/**
 * 全部快捷键。
 *
 * 集中在这里不是为了整齐：「完整支持两个平台」这句话只有在有一份清单时
 * 才检查得了，散在各个组件里的 `metaKey ||` 是数不清的。
 * `shortcuts.test.ts` 有一道门守着 `metaKey` / `ctrlKey` 不许出现在本文件之外。
 */
export const SHORTCUTS = {
  commandPalette: { key: 'k', mod: true },
  reopenClosedTab: { key: 't', mod: true, shift: true },
  // macOS 上这一下由原生菜单接住（`src-tauri/src/app_menu.rs`），webview 听不到；
  // 另外两个平台没有菜单，由 App 的 keydown 处理。两边按的必须是同一个组合
  closeTab: { key: 'w', mod: true },
  toggleSidebar: { key: 'b', mod: true },
  runCurrent: { key: 'Enter', mod: true },
  runAll: { key: 'Enter', mod: true, shift: true },
  saveToFile: { key: 's', mod: true },
  formatSql: { key: 'f', mod: true, shift: true },
  copySelection: { key: 'c', mod: true },
  copyWithHeaders: { key: 'c', mod: true, shift: true },
  selectAll: { key: 'a', mod: true },
  // 这两条只用于画提示：判定处比的是 `event.code === 'Space'`，因为 macOS 上
  // ⌥Space 产生的是不换行空格（U+00A0），按 `key` 比会漏掉它
  copyRow: { key: ' ', shift: true },
  copyColumn: { key: ' ', alt: true }
} as const satisfies Record<string, Shortcut>;
