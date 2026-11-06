import { closeCompletion } from '@codemirror/autocomplete';
import { Prec, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { SHORTCUTS, type Shortcut } from './shortcuts';

/** `SHORTCUTS` 里的写法 → CodeMirror 键位表的写法（`Shift-Mod-Enter`） */
export function codemirrorKey(shortcut: Shortcut): string {
  return [shortcut.shift && 'Shift', shortcut.alt && 'Alt', shortcut.mod && 'Mod', shortcut.key].filter(Boolean).join('-');
}

export interface RunShortcutHandlers {
  runCurrent: () => void;
  runAll: () => void;
}

/**
 * 「运行当前」「运行全部」绑在编辑器自己的键位表里、优先级最高。
 *
 * 绑在编辑器外面（React 的 onKeyDown）不行：CodeMirror 默认把 Mod-Enter 绑成「插入空行」，
 * 而它先于 React 处理——先插了空行、光标挪到空行上，「运行光标所在的那条」就什么也没跑；
 * 有好几条时跑的是下一条。
 *
 * 跑之前先收起补全弹窗：键位被我们截走之后它不会自己关，弹窗一直挂在结果上面，
 * 看起来像这次按键没生效。`closeCompletion` 在没有弹窗时什么也不做。
 *
 * 收的是一个 ref：扩展只建一次，处理函数每次渲染都换成新的
 */
export function runShortcutKeymap(handlers: { readonly current: RunShortcutHandlers }): Extension {
  return Prec.highest(keymap.of([
    { key: codemirrorKey(SHORTCUTS.runCurrent), run: (view) => { closeCompletion(view); handlers.current.runCurrent(); return true; } },
    { key: codemirrorKey(SHORTCUTS.runAll), run: (view) => { closeCompletion(view); handlers.current.runAll(); return true; } }
  ]));
}
