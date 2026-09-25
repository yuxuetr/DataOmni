/**
 * @vitest-environment happy-dom
 */
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { describe, expect, it, vi } from 'vitest';
import { codemirrorKey, runShortcutKeymap } from './runShortcutKeymap';
import { SHORTCUTS, shortcutKeyEvent } from './shortcuts';

describe('runShortcutKeymap', () => {
  it('SHORTCUTS 的写法换成 CodeMirror 的', () => {
    expect(codemirrorKey(SHORTCUTS.runCurrent)).toBe('Mod-Enter');
    expect(codemirrorKey(SHORTCUTS.runAll)).toBe('Shift-Mod-Enter');
  });

  // 默认键位表里 Mod-Enter 是「插入空行」：跑之前光标就挪到了空行上
  it('Mod-Enter 跑查询，不再插入空行', () => {
    const runCurrent = vi.fn();
    const handlers = { current: { runCurrent, runAll: vi.fn() } };
    const view = new EditorView({
      state: EditorState.create({
        doc: 'SELECT 1',
        selection: { anchor: 8 },
        extensions: [runShortcutKeymap(handlers), keymap.of(defaultKeymap)]
      }),
      parent: document.body
    });
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { ...shortcutKeyEvent(SHORTCUTS.runCurrent), bubbles: true }));
    expect(runCurrent).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe('SELECT 1');
    view.destroy();
  });
});
