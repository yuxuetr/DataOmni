import type { TranslationKey } from '../i18n/translate';

/**
 * CodeMirror 查找 / 替换 / 跳转面板里的英文原串到本项目文案键的对应。
 *
 * 这些面板是 `@codemirror/search` 画的，文字通过 `EditorState.phrases` 查表
 * 替换：查不到就原样显示英文。整个界面都是双语的，唯独按下 ⌘F 之后弹出来的
 * 那一条是英文，不像是「还没翻」，像是「这块不是我们的」。
 *
 * 键是**库里写死的英文原串**，改一个字就对不上。`editorPhrases.test.ts` 起一个
 * 真的面板把渲染出来的文字全读回来比对，库改了措辞会直接红。
 */
export const EDITOR_PHRASE_KEYS: Record<string, TranslationKey> = {
  // 查找 / 替换面板
  Find: 'editor.search.find',
  Replace: 'editor.search.replaceField',
  next: 'editor.search.next',
  previous: 'editor.search.previous',
  all: 'editor.search.all',
  'match case': 'editor.search.matchCase',
  regexp: 'editor.search.regexp',
  'by word': 'editor.search.byWord',
  replace: 'editor.search.replaceOne',
  'replace all': 'editor.search.replaceAll',
  close: 'common.close',

  // 跳转到行
  'Go to line': 'editor.search.gotoLine',
  go: 'editor.search.go',

  // 读屏播报。看不见，但它们同样是面向用户的文字
  'current match': 'editor.search.currentMatch',
  'on line': 'editor.search.onLine',
  'replaced $ matches': 'editor.search.replacedMatches',
  'replaced match on line $': 'editor.search.replacedOnLine'
};

/**
 * `$` 是 CodeMirror 的占位符，翻译里必须原样留着——它在播报时会被替换成
 * 数字。这和本项目 `{name}` 那套占位符是两回事，i18n 的占位符一致性检查
 * 管不到它，所以这里单独说明。
 */
export function editorPhrases(
  t: (key: TranslationKey) => string
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(EDITOR_PHRASE_KEYS).map(([phrase, key]) => [phrase, t(key)])
  );
}
