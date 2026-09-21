/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { gotoLine, openSearchPanel, search } from '@codemirror/search';
import { translate, type TranslationKey } from '../i18n/translate';
import { EDITOR_PHRASE_KEYS, editorPhrases } from './editorPhrases';

const zh = (key: TranslationKey) => translate('zh', key);
const en = (key: TranslationKey) => translate('en', key);

/**
 * 起一个真的编辑器，打开面板，把渲染出来的每一处面向用户的文字读回来。
 *
 * 对着 `EDITOR_PHRASE_KEYS` 自己比对是没用的：那只能证明「我写的键翻译了」，
 * 证明不了「面板上的字都来自我写的键」。漏一个键、或者库改了某处措辞，
 * 面板上就留一句英文，而这种漏不会引发任何报错。
 */
const panelText = (
  t: (key: TranslationKey) => string,
  open: (view: EditorView) => void
): string[] => {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: 'SELECT 1',
      extensions: [search(), EditorState.phrases.of(editorPhrases(t))]
    })
  });

  open(view);

  const texts = new Set<string>();
  for (const node of parent.querySelectorAll('.cm-panel *')) {
    if (node instanceof HTMLInputElement && node.placeholder) {
      texts.add(node.placeholder);
    }
    const label = node.getAttribute('aria-label');
    if (label) {
      texts.add(label);
    }
    // 只取自己的文字节点，避免把容器的整段文字重复收进来
    for (const child of node.childNodes) {
      if (child.nodeType === 3 && child.textContent?.trim()) {
        texts.add(child.textContent.trim());
      }
    }
  }

  view.destroy();
  parent.remove();
  return [...texts].sort();
};

describe('查找 / 替换面板的文案', () => {
  it('中文界面下没有一处英文残留', () => {
    expect(panelText(zh, openSearchPanel)).toEqual(
      [
        zh('editor.search.find'),
        zh('editor.search.next'),
        zh('editor.search.previous'),
        zh('editor.search.all'),
        zh('editor.search.matchCase'),
        zh('editor.search.regexp'),
        zh('editor.search.byWord'),
        zh('editor.search.replaceField'),
        zh('editor.search.replaceOne'),
        zh('editor.search.replaceAll'),
        zh('common.close'),
        // 关闭按钮的字形本身，它的 aria-label 才是「关闭」。
        // 留在期望里是为了让这条断言钉住面板渲染出来的**全部**文字——
        // 库哪天把它换成一个英文单词，这里就该红。
        '\u00d7'
      ].sort()
    );
  });

  it('英文界面下同样走我们的文案，不是库的默认值', () => {
    // 「全选」在库里写作 all，照搬会让人以为是「全部替换」
    const texts = panelText(en, openSearchPanel);
    expect(texts).toContain(en('editor.search.all'));
    expect(texts).not.toContain('all');
  });
});

describe('跳转到行面板的文案', () => {
  it('中文界面下没有一处英文残留', () => {
    expect(panelText(zh, gotoLine)).toEqual(
      [
        zh('editor.search.gotoLine'),
        zh('editor.search.go'),
        zh('common.close'),
        // 标签和输入框之间的分隔符，以及关闭按钮的字形
        ':',
        '\u00d7'
      ].sort()
    );
  });
});

describe('EDITOR_PHRASE_KEYS', () => {
  it('每个键在两种语言里都有文案', () => {
    for (const key of Object.values(EDITOR_PHRASE_KEYS)) {
      expect(zh(key).trim()).not.toBe('');
      expect(en(key).trim()).not.toBe('');
    }
  });

  it('带 $ 的播报文案两种语言都留着占位符', () => {
    // $ 是 CodeMirror 的占位符，本项目 {name} 那套的一致性检查管不到它
    for (const key of ['editor.search.replacedMatches', 'editor.search.replacedOnLine'] as const) {
      expect(zh(key)).toContain('$');
      expect(en(key)).toContain('$');
    }
  });
});
