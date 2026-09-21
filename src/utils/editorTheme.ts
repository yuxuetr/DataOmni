import { EditorView } from '@codemirror/view';

/**
 * 把 CodeMirror 自带的那几块界面对齐到应用的设计令牌。
 *
 * 需要它是因为这些界面不是我们画的：补全弹窗来自 `@codemirror/autocomplete`，
 * 查找 / 替换 / 跳转面板来自 `@codemirror/search`。它们各自带一套默认样式——
 * 浅色下是浏览器默认的灰色立体按钮，深色下是 oneDark 的一套，两套都跟应用
 * 其余部分不是一个东西。
 *
 * 选择器统统多带一个 `&.cm-editor`：主题规则的特异性本来和 oneDark 一样，
 * 同优先级时谁的样式表在后面谁赢，而 oneDark 在后面。多一个类就不用赌顺序。
 */
export const appEditorTheme = EditorView.theme({
  // 补全弹窗的选中项。oneDark 给的背景是 #2c313a，压在 #21252b 的弹窗上
  // 几乎分辨不出来——而这个列表是用上下键翻的，看不见光标就不知道回车会
  // 插入哪一条。
  '&.cm-editor .cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--color-accent)',
    color: 'var(--color-fg-on-accent)'
  },

  '&.cm-editor .cm-panels': {
    backgroundColor: 'var(--color-surface-sunken)',
    color: 'var(--color-fg)'
  },
  // oneDark 这里是 2px solid black，比应用里任何一条分隔线都重
  '&.cm-editor .cm-panels.cm-panels-bottom': {
    borderTop: '1px solid var(--color-line)'
  },
  '&.cm-editor .cm-panels.cm-panels-top': {
    borderBottom: '1px solid var(--color-line)'
  },
  '&.cm-editor .cm-panel': {
    padding: '6px 8px'
  },

  '&.cm-editor .cm-textfield': {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-fg)',
    border: '1px solid var(--color-line-strong)',
    borderRadius: 'var(--radius-control)',
    padding: '3px 8px'
  },
  '&.cm-editor .cm-textfield:focus-visible': {
    outline: '2px solid var(--color-accent)',
    outlineOffset: '-1px'
  },

  '&.cm-editor .cm-button': {
    // 默认是个 linear-gradient，不清掉背景色压不住它
    backgroundImage: 'none',
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-fg-muted)',
    border: '1px solid var(--color-line-strong)',
    borderRadius: 'var(--radius-control)',
    padding: '3px 10px',
    cursor: 'pointer'
  },
  '&.cm-editor .cm-button:hover': {
    backgroundColor: 'var(--color-surface-hover)',
    color: 'var(--color-fg)'
  },
  '&.cm-editor .cm-button:active': {
    backgroundImage: 'none',
    backgroundColor: 'var(--color-surface-active)'
  },

  '&.cm-editor .cm-panel label': {
    color: 'var(--color-fg-muted)'
  },
  // 复选框在深色下是刺眼的纯白方块
  '&.cm-editor .cm-panel input[type=checkbox]': {
    accentColor: 'var(--color-accent)'
  },
  '&.cm-editor .cm-panel button[name=close]': {
    color: 'var(--color-fg-subtle)',
    cursor: 'pointer'
  },
  '&.cm-editor .cm-panel button[name=close]:hover': {
    color: 'var(--color-fg)'
  }
});
